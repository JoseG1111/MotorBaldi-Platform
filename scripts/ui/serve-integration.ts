/** LOCAL-only real Worker/D1 browser harness. Fixtures never represent remote evidence. */
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { hashPassword } from "better-auth/crypto";
import admin from "../../apps/admin/src/index.js";
import portal from "../../apps/portal/src/index.js";
import type { AdminBindings, PortalBindings } from "@motorbaldi/config";

const root = resolve(".local/qa");
const runtime = resolve(root, "runtime");
const configPath = resolve(root, "wrangler.integration.json");
const config = JSON.parse(
  (await readFile("apps/api/wrangler.jsonc", "utf8")).replace(
    /,\s*([}\]])/g,
    "$1",
  ),
);
delete config.env;
config.main = resolve("apps/api/src/index.ts");
config.name = "motorbaldi-api-local-browser-qa";
config.observability = { enabled: false };
config.vars = {
  ENVIRONMENT: "local",
  AUTH_BASE_URL: "http://127.0.0.1:8787",
  CORS_ORIGINS: "http://127.0.0.1:4183,http://127.0.0.1:4184",
  EMAIL_PROVIDER: "DEVELOPMENT_SINK",
  AUTH_SECRET: "synthetic-local-browser-qa-secret-only-2026",
  AUTH_SECRETS: JSON.stringify([
    { version: 1, value: "synthetic-local-browser-qa-rotation-only-2026" },
  ]),
};
for (const database of config.d1_databases)
  database.migrations_dir = resolve("migrations");
// Refuse to reset fixture state while another local server owns these ports.
for (const port of [4183, 4184, 8787]) {
  const occupied = await new Promise<boolean>((done) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      done(true);
    });
    socket.once("error", () => done(false));
  });
  if (occupied)
    throw new Error(`LOCAL integration port ${port} is already occupied`);
}
await mkdir(root, { recursive: true });
await rm(runtime, { recursive: true, force: true });
await writeFile(configPath, JSON.stringify(config));
async function wrangler(args: string[]) {
  await new Promise<void>((accept, reject) => {
    const child = spawn(
      "pnpm",
      ["exec", "wrangler", ...args, "--config", configPath],
      { stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0
        ? accept()
        : reject(new Error("LOCAL harness initialization failed")),
    );
  });
}
await wrangler([
  "d1",
  "migrations",
  "apply",
  "motorbaldi-core-dev",
  "--local",
  "--persist-to",
  runtime,
]);
const password = await hashPassword("Local-browser-QA-password-2026!");
const sql = [
  "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local');",
];
for (const [suffix, name] of [
  ["81", "Portal"],
  ["82", "Admin"],
] as const) {
  const account = "018f0000-0000-7000-8000-0000000000" + suffix;
  const person = "018f0000-0000-7000-8000-0000000001" + suffix;
  sql.push(
    `INSERT INTO auth_users(id,name,email,email_verified) VALUES('${account}','LOCAL ${name} QA','local-${name.toLowerCase()}@example.test',1);`,
    `INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES('local-${suffix}','${account}','${account}','credential','${password}');`,
    `INSERT INTO iam_people(id,status,given_name,family_name,display_name) VALUES('${person}','ACTIVE','LOCAL','${name}','LOCAL ${name} QA');`,
    `INSERT INTO iam_accounts(id,person_id,status) VALUES('${account}','${person}','ACTIVE');`,
    `INSERT INTO iam_signup_consents(auth_user_id,terms_version,privacy_version,request_id) VALUES('${account}','1','1','local-browser-qa');`,
  );
  if (name === "Admin")
    sql.push(
      `INSERT INTO platform_person_roles(person_id,role_id) VALUES('${person}','platform-superadmin');`,
    );
}
sql.push(
  "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES('018f0000-0000-7000-8000-000000000099','WORKSHOP','LOCAL Synthetic Workshop','LOCAL Taller QA','CO','VERIFIED','018f0000-0000-7000-8000-000000000182');",
);
const seedPath = resolve(root, "seed.sql");
await writeFile(seedPath, sql.join("\n"));
await wrangler([
  "d1",
  "execute",
  "motorbaldi-core-dev",
  "--local",
  "--persist-to",
  runtime,
  "--file",
  seedPath,
]);
await rm(seedPath);
const api = spawn(
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    configPath,
    "--local",
    "--persist-to",
    runtime,
    "--port",
    "8787",
    "--ip",
    "127.0.0.1",
  ],
  { stdio: "ignore", detached: true },
);
const servers: ReturnType<typeof createServer>[] = [];
function stop() {
  for (const server of servers) server.close();
  if (api.pid) {
    try {
      process.kill(-api.pid, "SIGTERM");
    } catch {
      /* Already stopped. */
    }
  }
}
process.on("SIGTERM", () => {
  stop();
  process.exit(0);
});
process.on("SIGINT", () => {
  stop();
  process.exit(0);
});
api.on("exit", () => {
  stop();
  process.exit(1);
});
const deadline = Date.now() + 120000;
while (true) {
  try {
    const response = await fetch("http://127.0.0.1:8787/health");
    if (!response.ok) throw new Error("LOCAL API is not ready");
    break;
  } catch {
    if (Date.now() > deadline) throw new Error("LOCAL API startup timed out");
    await new Promise((done) => setTimeout(done, 200));
  }
}
for (const [port, worker] of [
  [4183, admin],
  [4184, portal],
] as const) {
  const service = {
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      return fetch("http://127.0.0.1:8787" + url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        ...(request.method !== "GET" && request.method !== "HEAD"
          ? { body: await request.arrayBuffer() }
          : {}),
        redirect: "manual",
      });
    },
  };
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers))
        if (value !== undefined && name !== "host")
          for (const item of Array.isArray(value) ? value : [value])
            headers.append(name, item);
      const request = new Request(`http://127.0.0.1:${port}${incoming.url}`, {
        method: incoming.method,
        headers,
        ...(incoming.method !== "GET" && incoming.method !== "HEAD"
          ? { body: Buffer.concat(chunks) }
          : {}),
      });
      const bindings = {
        ENVIRONMENT: "local",
        API_SERVICE: service,
      } as unknown as AdminBindings & PortalBindings;
      const response = await worker.fetch(request, bindings);
      outgoing.statusCode = response.status;
      // Node fetch decodes compressed upstream bodies; do not forward their wire headers.
      response.headers.forEach((value, name) => {
        if (
          !["set-cookie", "content-encoding", "content-length"].includes(name)
        )
          outgoing.setHeader(name, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) outgoing.setHeader("set-cookie", cookies);
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end("LOCAL integration harness request failed");
    }
  });
  servers.push(server);
  server.listen(port, "127.0.0.1");
}
console.log(
  "LOCAL browser integration ready on 4183/4184; isolated D1, real API on 8787.",
);

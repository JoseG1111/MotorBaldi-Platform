import { spawnSync } from "node:child_process";

const environment = process.argv[2];
const allowed = new Set(["local", "development", "staging", "production"]);
if (!allowed.has(environment))
  throw new Error("Expected local, development, staging, or production");

const remote = environment !== "local";
const database =
  environment === "local" || environment === "development"
    ? "motorbaldi-core-dev"
    : environment === "production"
      ? "motorbaldi-core-prod"
      : "motorbaldi-core-staging";
const args = [
  "exec",
  "wrangler",
  "d1",
  "execute",
  database,
  remote ? "--remote" : "--local",
];
if (remote) args.push("--env", environment);
args.push(
  "--config",
  "apps/api/wrangler.jsonc",
  "--json",
  "--command",
  `INSERT INTO governance_environment_metadata(singleton, environment) VALUES (1, '${environment}') ON CONFLICT(singleton) DO NOTHING; SELECT environment FROM governance_environment_metadata WHERE singleton = 1;`,
);
const result = spawnSync("pnpm", args, {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
}
let output;
try {
  output = JSON.parse(result.stdout);
} catch {
  throw new Error("Wrangler returned invalid JSON");
}
const encoded = JSON.stringify(output);
if (!encoded.includes(`\"environment\":\"${environment}\"`)) {
  process.stderr.write(`D1 environment mismatch: expected ${environment}\n`);
  process.exit(1);
}
process.stdout.write(
  `D1 environment initialized and verified as ${environment}.\n`,
);

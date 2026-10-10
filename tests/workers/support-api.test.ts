import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import m1 from "../../migrations/0001_foundation.sql?raw";
import m2 from "../../migrations/0002_phase1.sql?raw";
import m3 from "../../migrations/0003_phase1_closeout.sql?raw";
import m4 from "../../migrations/0004_vehicle_core.sql?raw";
import m5 from "../../migrations/0005_vehicle_access.sql?raw";
import m6 from "../../migrations/0006_vehicle_history.sql?raw";
import m7 from "../../migrations/0007_vehicle_commands.sql?raw";
import m8 from "../../migrations/0008_workshop_operations.sql?raw";
import m9 from "../../migrations/0009_workshop_files.sql?raw";
import m10 from "../../migrations/0010_inspection_media.sql?raw";
import m11 from "../../migrations/0011_inspection_workflow.sql?raw";
import m12 from "../../migrations/0012_billing_membership.sql?raw";
import m13 from "../../migrations/0013_payment_provider_evidence.sql?raw";

import m14 from "../../migrations/0014_notifications.sql?raw";
import m15 from "../../migrations/0015_support.sql?raw";
import m16 from "../../migrations/0016_support_history_boundary.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const worker = (
  workerExports as unknown as { default: ExportedHandler<ApiBindings> }
).default;
const password = "local-support-api-password-123";
type Client = {
  accountId: string;
  personId: string;
  cookies: Map<string, string>;
  ip: number;
};
let owner: Client, other: Client, admin: Client, noMfa: Client;
let clientCase = 1;
beforeEach(() => {
  clientCase++;
});

async function request(
  client: Client | null,
  path: string,
  body?: object,
  key?: string,
) {
  const response = await worker.fetch!(
    new Request(`https://api.test/api/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: "https://portal.test",
        "cf-connecting-ip": `192.0.2.${(client?.ip ?? 1) + clientCase}`,
        ...(body ? { "content-type": "application/json" } : {}),
        ...(key ? { "idempotency-key": key } : {}),
        ...(client?.cookies.size
          ? {
              cookie: [...client.cookies]
                .map(([n, v]) => `${n}=${v}`)
                .join("; "),
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) as never,
    env as unknown as ApiBindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0]!,
      separator = pair.indexOf("="),
      name = pair.slice(0, separator),
      value = pair.slice(separator + 1);
    if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(header))
      client?.cookies.delete(name);
    else client?.cookies.set(name, value);
  }
  return response;
}
async function rawRequest(
  path: string,
  init: RequestInit,
  client: Client | null = null,
) {
  const headers = new Headers(init.headers);
  headers.set("cf-connecting-ip", `192.0.2.${(client?.ip ?? 1) + clientCase}`);
  if (client?.cookies.size)
    headers.set(
      "cookie",
      [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    );
  return worker.fetch!(
    new Request(`https://api.test/api/v1${path}`, {
      ...init,
      headers,
    }) as never,
    env as unknown as ApiBindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
}

async function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replaceAll("=", "")) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(Math.floor(Date.now() / 30000)));
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = digest[digest.length - 1]! & 15;
  const code =
    (((digest[offset]! & 127) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) %
    1_000_000;
  return String(code).padStart(6, "0");
}

async function authenticate(ip: number, mfa = false): Promise<Client> {
  const accountId = newId(),
    email = `${accountId}@example.test`;
  const client = {
    accountId,
    personId: "",
    cookies: new Map<string, string>(),
    ip,
  };
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Support API',?,1)",
    )
    .bind(accountId, email)
    .run();
  await db
    .prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES(?,?,?,'credential',?)",
    )
    .bind(newId(), accountId, accountId, await hashPassword(password))
    .run();
  expect(
    (await request(client, "/auth/sign-in/email", { email, password })).status,
  ).toBe(200);
  if (mfa) {
    const enrollment = await request(client, "/auth/two-factor/enable", {
      password,
      method: "totp",
    });
    expect(enrollment.status).toBe(200);
    const secret = new URL(
      ((await enrollment.json()) as { totpURI: string }).totpURI,
    ).searchParams.get("secret")!;
    expect(
      (
        await request(client, "/auth/two-factor/verify-totp", {
          code: await totp(secret),
          trustDevice: false,
        })
      ).status,
    ).toBe(200);
    await request(client, "/auth/sign-out", {});
    expect(
      (await request(client, "/auth/sign-in/email", { email, password }))
        .status,
    ).toBe(200);
    expect(
      (
        await request(client, "/auth/two-factor/verify-totp", {
          code: await totp(secret),
          trustDevice: false,
        })
      ).status,
    ).toBe(200);
  }
  const me = await request(client, "/me");
  expect(me.status).toBe(200);
  client.personId = ((await me.json()) as { personId: string }).personId;
  return client;
}

beforeAll(async () => {
  for (const migration of [
    m1,
    m2,
    m3,
    m4,
    m5,
    m6,
    m7,
    m8,
    m9,
    m10,
    m11,
    m12,
    m13,
    m14,
    m15,
    m16,
  ])
    await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  owner = await authenticate(10);
  other = await authenticate(40);
  admin = await authenticate(70, true);
  noMfa = await authenticate(100);
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-support'),(?,'platform-support')",
    )
    .bind(admin.personId, noMfa.personId)
    .run();
}, 30_000);
const customer = "/me/support-cases",
  staff = "/admin/support-cases";
const creation = {
  subject: "Solicitud general",
  body: "Necesito ayuda con mi cuenta.",
};
async function create(client = owner) {
  const response = await request(client, customer, creation, newId());
  expect(response.status).toBe(200);
  return (await response.json()) as {
    caseId: string;
    version: number;
    replayed: boolean;
  };
}
describe("support API with current customer and verified MFA staff sessions", () => {
  it("requires authentication and trusted Origin/idempotency for mutations", async () => {
    expect((await request(null, customer)).status).toBe(401);
    expect((await request(null, staff)).status).toBe(401);
    for (const origin of [null, "https://untrusted.example.test"]) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "idempotency-key": newId(),
      };
      if (origin) headers.origin = origin;
      expect(
        (
          await rawRequest(
            customer,
            { method: "POST", headers, body: JSON.stringify(creation) },
            owner,
          )
        ).status,
      ).toBe(403);
    }
    expect((await request(owner, customer, creation)).status).toBe(400);
    expect(
      (await request(owner, customer, { ...creation, staff: true }, newId()))
        .status,
    ).toBe(400);
    expect(
      (
        await request(
          owner,
          customer,
          { ...creation, accountId: other.accountId },
          newId(),
        )
      ).status,
    ).toBe(400);
  });
  it("allows free non-MFA support and keeps customer reads and replies private", async () => {
    expect(await (await request(owner, "/principal")).json()).toMatchObject({
      mfaEnabled: false,
    });
    const created = await create(),
      path = `${customer}/${created.caseId}`;
    const detail = await request(owner, path);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    expect((await request(other, path)).status).toBe(404);
    expect(
      (
        await request(
          other,
          `${path}/reply`,
          { version: 1, body: "Intrusion" },
          newId(),
        )
      ).status,
    ).toBe(404);
    expect(
      (await request(other, `${customer}?cursor=${created.caseId}`)).status,
    ).toBe(404);
    expect(
      (
        await request(
          owner,
          `${path}/reply`,
          { version: 1, body: "Más información", caseId: newId() },
          newId(),
        )
      ).status,
    ).toBe(400);
    for (const query of ["?cursor=bad", "?limit=0", "?limit=51", "?limit=1.5"])
      expect((await request(owner, customer + query)).status).toBe(400);
  });
  it("replays mutations exactly once, rejects altered keys and stale versions, and never reopens closed cases", async () => {
    const key = newId(),
      first = await request(owner, customer, creation, key);
    expect(first.status).toBe(200);
    const accepted = (await first.json()) as {
      caseId: string;
      replayed: boolean;
    };
    expect(
      await (await request(owner, customer, creation, key)).json(),
    ).toEqual({ ...accepted, replayed: true });
    expect(
      (await request(owner, customer, { ...creation, body: "changed" }, key))
        .status,
    ).toBe(409);
    const path = `${customer}/${accepted.caseId}`,
      replyKey = newId();
    const reply = await request(
      owner,
      `${path}/reply`,
      { version: 1, body: "Información adicional" },
      replyKey,
    );
    expect(reply.status).toBe(200);
    const replied = (await reply.json()) as object;
    expect(
      await (
        await request(
          owner,
          `${path}/reply`,
          { version: 1, body: "Información adicional" },
          replyKey,
        )
      ).json(),
    ).toEqual({ ...replied, replayed: true });
    expect(
      (
        await request(
          owner,
          `${path}/reply`,
          { version: 1, body: "stale" },
          newId(),
        )
      ).status,
    ).toBe(409);
    expect(
      (await request(owner, `${path}/close`, { version: 2 }, newId())).status,
    ).toBe(200);
    expect(
      (
        await request(
          owner,
          `${path}/reply`,
          { version: 3, body: "reopen" },
          newId(),
        )
      ).status,
    ).toBe(409);
    expect(
      (await request(owner, `${path}/close`, { version: 3 }, newId())).status,
    ).toBe(409);
    const detail = (await (await request(owner, path)).json()) as {
      status: string;
      version: number;
      messages: unknown[];
      history: unknown[];
    };
    expect(detail).toMatchObject({ status: "CLOSED", version: 3 });
    expect(detail.messages).toHaveLength(2);
    expect(detail.history).toHaveLength(3);
    const audits = await db
      .prepare(
        "SELECT action FROM governance_audit_events WHERE resource_id=? AND action LIKE 'support.case.%'",
      )
      .bind(accepted.caseId)
      .all<{ action: string }>();
    expect(audits.results.map((row) => row.action).sort()).toEqual([
      "support.case.close",
      "support.case.create",
      "support.case.reply",
    ]);
    const events = await db
      .prepare(
        "SELECT payload_json AS payload FROM integration_outbox_events WHERE aggregate_id=? AND event_type LIKE 'support.case.%'",
      )
      .bind(accepted.caseId)
      .all<{ payload: string }>();
    expect(events.results).toHaveLength(3);
    for (const event of events.results)
      expect(JSON.parse(event.payload)).toEqual({
        caseId: accepted.caseId,
        accountId: owner.accountId,
      });
    expect(
      (
        await request(
          owner,
          customer,
          { ...creation, previousCaseId: accepted.caseId },
          newId(),
        )
      ).status,
    ).toBe(200);
  });
  it("requires a platform support role and current MFA for staff reads and commands", async () => {
    const created = await create(),
      path = `${staff}/${created.caseId}`;
    expect((await request(owner, staff)).status).toBe(403);
    expect((await request(noMfa, staff)).status).toBe(403);
    expect(await (await request(noMfa, staff)).json()).toMatchObject({
      code: "MFA_REQUIRED",
    });
    expect((await request(admin, staff)).status).toBe(200);
    expect((await request(admin, path)).status).toBe(200);
    expect(
      (
        await request(
          noMfa,
          `${path}/reply`,
          { version: 1, body: "Unauthorized" },
          newId(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          owner,
          `${path}/assign`,
          { version: 1, assigneePersonId: admin.personId },
          newId(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          admin,
          `${path}/assign`,
          { version: 1, assigneePersonId: other.personId },
          newId(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          admin,
          `${path}/assign`,
          { version: 1, assigneePersonId: admin.personId },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          admin,
          `${path}/reply`,
          { version: 2, body: "Respuesta privada" },
          newId(),
        )
      ).status,
    ).toBe(200);
    const key = newId(),
      body = { version: 3, resolution: "Solicitud resuelta" };
    expect((await request(admin, `${path}/close`, body, key)).status).toBe(200);
    await db
      .prepare(
        "DELETE FROM platform_person_roles WHERE person_id=? AND role_id='platform-support'",
      )
      .bind(admin.personId)
      .run();
    expect((await request(admin, `${path}/close`, body, key)).status).toBe(403);
    expect((await request(admin, path)).status).toBe(403);
  });
});

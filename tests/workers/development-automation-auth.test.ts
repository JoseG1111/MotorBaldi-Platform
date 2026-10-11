import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import { apiConfig, type ApiBindings } from "@motorbaldi/config";
import { assessAuthenticatedSession } from "@motorbaldi/auth";
import {
  authenticateDevelopmentAutomation,
  issueDevelopmentAutomationAuthorization,
  assessDevelopmentAutomationCommand,
} from "@motorbaldi/auth";
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
import m17 from "../../migrations/0017_parts_catalog.sql?raw";
import m18 from "../../migrations/0018_development_automation.sql?raw";
const db = (env as unknown as ApiBindings).DB;
const accountId = "018f0000-0000-7000-8000-000000008001";
const personId = "018f0000-0000-7000-8000-000000008002";
const organizationId = "018f0000-0000-7000-8000-000000008003";
const locationId = "018f0000-0000-7000-8000-000000008004";
const keyId = "018f0000-0000-7000-8000-000000008005";
const secret = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const base = "https://motorbaldi-api-development.josegbarrios2.workers.dev";
const credential = { keyId, version: 1, secret };
const bindings = {
  ...(env as unknown as ApiBindings),
  ENVIRONMENT: "development",
  AUTH_BASE_URL: base,
  DEVELOPMENT_AUTOMATION_ENABLED: "true",
  DEVELOPMENT_AUTOMATION_CREDENTIAL: JSON.stringify(credential),
} as ApiBindings;
const encoder = new TextEncoder();
const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
async function signed(
  options: {
    path?: string;
    method?: string;
    body?: string;
    timestamp?: number;
    nonce?: string;
    version?: number;
    keyId?: string;
  } = {},
) {
  const path = options.path ?? "/api/v1/parts/canonical?limit=2";
  const method = options.method ?? "POST";
  const body = options.body ?? '{"name":"Synthetic"}';
  const timestamp = options.timestamp ?? Date.now();
  const nonce = options.nonce ?? crypto.randomUUID();
  const hash = hex(await crypto.subtle.digest("SHA-256", encoder.encode(body)));
  const canonical = `${timestamp}\n${nonce}\n${method}\n${path}\n${hash}`;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = hex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(canonical)),
  );
  return new Request(`${base}${path}`, {
    method,
    headers: {
      authorization: `MotorBaldi-Development ${options.keyId ?? keyId}:${options.version ?? 1}:${timestamp}:${nonce}:${signature}`,
      origin: "https://motorbaldi-admin-development.josegbarrios2.workers.dev",
      "content-type": "application/json",
    },
    body,
  });
}
const authenticate = (request: Request, overrides: Partial<ApiBindings> = {}) =>
  authenticateDevelopmentAutomation(
    request,
    { ...bindings, ...overrides },
    crypto.randomUUID(),
  );
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
    m17,
    m18,
  ])
    await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'development')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES(?,'Development automation','automation@example.test',1,0)",
    )
    .bind(accountId)
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Development','Automation')",
    )
    .bind(personId)
    .run();
  await db
    .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
    .bind(accountId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES(?,'WORKSHOP','Synthetic Workshop','MotorBaldi Development Validation Workshop','CO','VERIFIED',?)",
    )
    .bind(organizationId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'MotorBaldi Development Workshop Site','SERVICE_SITE','CO','Test','Test','Synthetic')",
    )
    .bind(locationId, organizationId)
    .run();
  await db
    .prepare(
      "INSERT INTO development_automation_identities(key_id,name,account_id,credential_version,status,organization_id,location_id,expires_at) VALUES(?,'development-validation',?,1,'ACTIVE',?,?,?)",
    )
    .bind(
      keyId,
      accountId,
      organizationId,
      locationId,
      new Date(Date.now() + 3600000).toISOString(),
    )
    .run();
});
beforeEach(async () => {
  await db
    .prepare(
      "UPDATE development_automation_identities SET status='ACTIVE',credential_version=1 WHERE key_id=?",
    )
    .bind(keyId)
    .run();
});
describe("Development signed machine authentication", () => {
  it("authenticates without human MFA and prevents nonce replay", async () => {
    const request = await signed();
    const actor = await authenticate(request.clone() as never);
    expect(actor?.accountId).toBe(accountId);
    expect(actor?.personId).toBe(personId);
    expect(actor?.mfaEnabled).toBe(false);
    await expect(authenticate(request.clone() as never)).rejects.toThrow();
  });
  it("retains future-clock nonce claims for the full signature validity window", async () => {
    const timestamp = Date.now() + 30000,
      nonce = crypto.randomUUID();
    await authenticate(await signed({ timestamp, nonce }));
    const row = await db
      .prepare(
        "SELECT expires_at FROM development_automation_nonces WHERE key_id=? AND nonce=?",
      )
      .bind(keyId, nonce)
      .first<{ expires_at: string }>();
    expect(Date.parse(row!.expires_at)).toBeGreaterThan(timestamp + 60000);
  });
  it("rejects oversized signed bodies without waiting for an unread tee stream", async () => {
    await expect(
      authenticate(await signed({ body: "x".repeat(16385) })),
    ).rejects.toMatchObject({ code: "DEVELOPMENT_AUTOMATION_DENIED" });
  });
  it("leaves anonymous requests unsigned", async () => {
    expect(
      await authenticate(new Request(`${base}/api/v1/parts/canonical`)),
    ).toBeNull();
  });
  it("rejects disabled, unconfigured and nondevelopment environments", async () => {
    for (const overrides of [
      { ENVIRONMENT: "local" },
      { ENVIRONMENT: "staging" },
      { ENVIRONMENT: "production" },
      { DEVELOPMENT_AUTOMATION_ENABLED: "false" },
      { DEVELOPMENT_AUTOMATION_CREDENTIAL: undefined },
      { AUTH_BASE_URL: "https://api.test" },
    ]) {
      await expect(
        authenticate(await signed(), overrides as Partial<ApiBindings>),
      ).rejects.toThrow();
    }
  });
  it("binds signatures to body, path, query and method", async () => {
    const original = await signed();
    for (const [path, method, body] of [
      ["/api/v1/parts/canonical?limit=3", "POST", '{"name":"Synthetic"}'],
      ["/api/v1/parts/offerings?limit=2", "POST", '{"name":"Synthetic"}'],
      ["/api/v1/parts/canonical?limit=2", "PUT", '{"name":"Synthetic"}'],
      ["/api/v1/parts/canonical?limit=2", "POST", '{"name":"Changed"}'],
    ])
      await expect(
        authenticate(
          new Request(`${base}${path}`, {
            method,
            body,
            headers: original.headers,
          }),
        ),
      ).rejects.toThrow();
  });
  it("rejects stale and future timestamps and cookie mixing", async () => {
    await expect(
      authenticate(await signed({ timestamp: Date.now() - 61000 })),
    ).rejects.toThrow();
    await expect(
      authenticate(await signed({ timestamp: Date.now() + 61000 })),
    ).rejects.toThrow();
    const request = await signed();
    request.headers.set("cookie", "human-session=synthetic");
    await expect(authenticate(request)).rejects.toThrow();
  });
  it("rejects revoked identities and obsolete or unknown credentials", async () => {
    await expect(authenticate(await signed({ version: 2 }))).rejects.toThrow();
    await expect(
      authenticate(await signed({ keyId: crypto.randomUUID() })),
    ).rejects.toThrow();
    await db
      .prepare(
        "UPDATE development_automation_identities SET status='REVOKED' WHERE key_id=?",
      )
      .bind(keyId)
      .run();
    await expect(authenticate(await signed())).rejects.toThrow();
  });
  it("does not turn a normal password session into human MFA", async () => {
    const human = "018f0000-0000-7000-8000-000000008099";
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES(?,'Human','human@example.test',1,0)",
      )
      .bind(human)
      .run();
    await db
      .prepare(
        "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES('ordinary-session',?,'ordinary-token',?)",
      )
      .bind(human, new Date(Date.now() + 3600000).toISOString())
      .run();
    expect(
      await assessAuthenticatedSession(db, human, "ordinary-session"),
    ).toEqual({ mfaEnabled: false });
  });
  it("binds command assurance to actor, operation, canonical body and expiry", async () => {
    const actor = await authenticate(await signed());
    expect(actor).not.toBeNull();
    const body = { name: "Synthetic", count: 1 };
    const context = await issueDevelopmentAutomationAuthorization(
      db,
      actor!,
      "parts.canonical.create",
      body,
    );
    expect(
      (
        await assessDevelopmentAutomationCommand(
          bindings,
          context,
          accountId,
          "parts.canonical.create",
          { count: 1, name: "Synthetic" },
        )
      ).accountId,
    ).toBe(accountId);
    await expect(
      assessDevelopmentAutomationCommand(
        { ...bindings, AUTH_BASE_URL: "https://api.test" },
        context,
        accountId,
        "parts.canonical.create",
        body,
      ),
    ).rejects.toThrow();
    await expect(
      assessDevelopmentAutomationCommand(
        bindings,
        context,
        accountId,
        "parts.canonical.update",
        body,
      ),
    ).rejects.toThrow();
    await expect(
      assessDevelopmentAutomationCommand(
        bindings,
        context,
        personId,
        "parts.canonical.create",
        body,
      ),
    ).rejects.toThrow();
    await expect(
      assessDevelopmentAutomationCommand(
        bindings,
        context,
        accountId,
        "parts.canonical.create",
        { ...body, count: 2 },
      ),
    ).rejects.toThrow();
    await db
      .prepare(
        "UPDATE development_automation_authorizations SET expires_at=? WHERE id=?",
      )
      .bind(new Date(Date.now() - 1000).toISOString(), context)
      .run();
    await expect(
      assessDevelopmentAutomationCommand(
        bindings,
        context,
        accountId,
        "parts.canonical.create",
        body,
      ),
    ).rejects.toThrow();
  });
  it("records accepted and denied security evidence without credential material", async () => {
    await authenticate(await signed());
    await expect(
      authenticate(await signed({ timestamp: Date.now() - 61000 })),
    ).rejects.toThrow();
    const records = await db
      .prepare(
        "SELECT * FROM governance_security_events WHERE code LIKE 'DEVELOPMENT_AUTOMATION_%'",
      )
      .all();
    expect(
      records.results.some(
        (row) => row.code === "DEVELOPMENT_AUTOMATION_AUTHENTICATED",
      ),
    ).toBe(true);
    expect(
      records.results.some(
        (row) => row.code === "DEVELOPMENT_AUTOMATION_DENIED",
      ),
    ).toBe(true);
    expect(JSON.stringify(records.results).includes(secret)).toBe(false);
  });
  it("blocks forged human sessions for the registered machine identity", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES('forged-machine-session',?,'forged-machine-token',?)",
        )
        .bind(accountId, new Date(Date.now() + 3600000).toISOString())
        .run(),
    ).rejects.toThrow("DEVELOPMENT_AUTOMATION_HUMAN_AUTH_BOUNDARY");
    expect(
      await assessAuthenticatedSession(db, accountId, "forged-machine-session"),
    ).toBeNull();
  });
  it("rejects automation flag or credential injection into staging and production config", () => {
    for (const environment of ["staging", "production"] as const) {
      for (const automation of [
        { DEVELOPMENT_AUTOMATION_ENABLED: "true" },
        { DEVELOPMENT_AUTOMATION_CREDENTIAL: JSON.stringify(credential) },
      ]) {
        expect(() =>
          apiConfig({
            ...(env as unknown as ApiBindings),
            ENVIRONMENT: environment,
            ...automation,
          }),
        ).toThrow("Development automation is forbidden outside Development");
      }
    }
    const humanConfig = apiConfig(env as unknown as ApiBindings);
    expect(humanConfig.environment).toBe("local");
  });
});

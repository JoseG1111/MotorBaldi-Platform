import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import { getMigrations } from "better-auth/db/migration";
import { apiConfig, type ApiBindings } from "@motorbaldi/config";
import { authOptions } from "@motorbaldi/auth";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { createOrganization, addLocation } from "@motorbaldi/organizations";
import migration from "../../migrations/0001_foundation.sql?raw";
import phase1Migration from "../../migrations/0002_phase1.sql?raw";
import closeoutMigration from "../../migrations/0003_phase1_closeout.sql?raw";

const testEnv = env as unknown as ApiBindings;
const worker = (
  workerExports as unknown as { default: ExportedHandler<ApiBindings> }
).default;
const call = (path: string, init?: RequestInit, addDefaultOrigin = true) => {
  const headers = new Headers(init?.headers);
  if (
    addDefaultOrigin &&
    init?.method &&
    ["POST", "PUT", "PATCH", "DELETE"].includes(init.method) &&
    path.startsWith("/api/v1/") &&
    !path.startsWith("/api/v1/auth/") &&
    path !== "/api/v1/public/leads" &&
    !headers.has("origin")
  )
    headers.set("origin", "https://portal.test");
  return worker.fetch!(
    new Request("https://api.test" + path, { ...init, headers }) as never,
    testEnv,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
};

beforeAll(async () => {
  await testEnv.DB.exec(migration.replace(/\n/g, " "));
  await testEnv.DB.exec(phase1Migration.replace(/\n/g, " "));
  await testEnv.DB.exec(closeoutMigration.replace(/\n/g, " "));
  await testEnv.DB.prepare(
    "INSERT INTO governance_environment_metadata(singleton, environment) VALUES (1, 'local')",
  ).run();
  await testEnv.DB.prepare(
    "INSERT INTO governance_feature_flags(id,key,environment,enabled) VALUES('phase1-lead-flag','PUBLIC_LEAD_INTAKE','local',1)",
  ).run();
  await testEnv.DB.prepare(
    "INSERT INTO governance_feature_flags(id,key,environment,enabled) VALUES('phase1-org-flag','ORGANIZATION_CREATION','local',1)",
  ).run();
  await testEnv.DB.prepare(
    "INSERT INTO governance_feature_flags(id,key,environment,enabled) VALUES('phase1-signup-flag','PUBLIC_SIGNUP','local',1)",
  ).run();
  const password = await hashPassword("correct-password-123");
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES ('018f0000-0000-7000-8000-000000000001','Verified','verified@example.test',1,0)",
    ),
    testEnv.DB.prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES ('cred-verified','018f0000-0000-7000-8000-000000000001','018f0000-0000-7000-8000-000000000001','credential',?)",
    ).bind(password),
    testEnv.DB.prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES ('018f0000-0000-7000-8000-000000000002','Unverified','unverified@example.test',0)",
    ),
    testEnv.DB.prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES ('cred-unverified','018f0000-0000-7000-8000-000000000002','018f0000-0000-7000-8000-000000000002','credential',?)",
    ).bind(password),
  ]);
});

let signInRequest = 0;
async function signIn(
  email = "verified@example.test",
  password = "correct-password-123",
) {
  return call("/api/v1/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://api.test",
      "cf-connecting-ip": `192.0.2.${++signInRequest}`,
    },
    body: JSON.stringify({ email, password }),
  });
}

describe("real D1 migration", () => {
  it("fails closed when Worker and D1 environments differ", async () => {
    const { assertDatabaseEnvironment } =
      await import("@motorbaldi/db/environment");
    await expect(
      assertDatabaseEnvironment(testEnv.DB, "production"),
    ).rejects.toMatchObject({
      status: 503,
      code: "DATABASE_ENVIRONMENT_MISMATCH",
    });
  });

  it("creates STRICT tables and enforces immutable governance history", async () => {
    const strict = await testEnv.DB.prepare(
      "SELECT strict FROM pragma_table_list WHERE name = 'auth_users'",
    ).first<{ strict: number }>();
    expect(strict?.strict).toBe(1);
    await expect(
      testEnv.DB.prepare(
        "UPDATE governance_environment_metadata SET environment='production'",
      ).run(),
    ).rejects.toThrow(/immutable/);
    await testEnv.DB.prepare(
      "INSERT INTO governance_audit_events(id,action,resource_type,resource_id,request_id) VALUES ('audit-1','test','test','one','request-1')",
    ).run();
    await expect(
      testEnv.DB.prepare(
        "DELETE FROM governance_audit_events WHERE id='audit-1'",
      ).run(),
    ).rejects.toThrow(/append-only/);
    await testEnv.DB.prepare(
      "INSERT INTO governance_security_events(id,code,request_id) VALUES ('security-1','TEST','request-1')",
    ).run();
    await expect(
      testEnv.DB.prepare(
        "UPDATE governance_security_events SET code='CHANGED' WHERE id='security-1'",
      ).run(),
    ).rejects.toThrow(/append-only/);
  });

  it("matches Better Auth's configured schema", async () => {
    const plan = await getMigrations(
      authOptions(testEnv, apiConfig(testEnv), "schema-test"),
      { throwOnUnsafe: false },
    );
    expect(plan.toBeCreated).toEqual([]);
    expect(plan.toBeAdded).toEqual([]);
    expect(plan.schemaProblems).toEqual([]);
  });
});

describe("API and Better Auth runtime", () => {
  it("accepts local signup with explicit terms and a real verification sink", async () => {
    const response = await call("/api/v1/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://api.test",
      },
      body: JSON.stringify({
        name: "New Customer",
        email: "new-customer@example.test",
        password: "correct-password-123",
        termsAccepted: true,
        privacyAccepted: true,
        termsVersion: "1",
        privacyVersion: "1",
      }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true });
    const user = await testEnv.DB.prepare(
      "SELECT id,email_verified FROM auth_users WHERE email='new-customer@example.test'",
    ).first<{ id: string; email_verified: number }>();
    expect(user?.email_verified).toBe(0);
    const sink = await testEnv.DB.prepare(
      "SELECT kind,action_url FROM integration_local_email_sink WHERE auth_user_id=?",
    )
      .bind(user?.id)
      .first<{ kind: string; action_url: string }>();
    expect(sink?.kind).toBe("VERIFY_EMAIL");
    const verificationUrl = new URL(sink!.action_url);
    expect(
      (
        await call(verificationUrl.pathname + verificationUrl.search, {
          redirect: "manual",
        })
      ).status,
    ).toBe(302);
    const signedIn = await signIn("new-customer@example.test");
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const principal = await call("/api/v1/me", { headers: { cookie } });
    expect(principal.status).toBe(200);
    const personId = ((await principal.json()) as { personId: string })
      .personId;
    const consents = await testEnv.DB.prepare(
      "SELECT purpose FROM iam_consent_events WHERE person_id=? ORDER BY purpose",
    )
      .bind(personId)
      .all<{ purpose: string }>();
    expect(consents.results.map((row) => row.purpose)).toEqual([
      "PRIVACY",
      "TERMS",
    ]);
  });
  it("accepts public leads without exposing identity matches and replays safely", async () => {
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "public-lead-key",
      },
      body: JSON.stringify({
        email: "verified@example.test",
        givenName: "Interested",
      }),
    };
    const first = await call("/api/v1/public/leads", init);
    const second = await call("/api/v1/public/leads", init);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: true });
    expect(second.status).toBe(202);
    const row = await testEnv.DB.prepare(
      "SELECT count(*) AS n FROM crm_lead_intakes WHERE email='verified@example.test'",
    ).first<{ n: number }>();
    expect(row?.n).toBe(1);
  });
  it("creates one organization through the existing idempotency coordinator", async () => {
    const signedIn = await signIn();
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const init = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "org-create-key",
        cookie,
      },
      body: JSON.stringify({
        type: "WORKSHOP",
        legalName: "Test Workshop",
        displayName: "Test Workshop",
        countryCode: "US",
      }),
    };
    const results = await Promise.all([
      call("/api/v1/organizations", init),
      call("/api/v1/organizations", init),
    ]);
    expect(results.map((response) => response.status)).toEqual([201, 201]);
    const a = (await results[0]!.json()) as { organizationId: string };
    const b = (await results[1]!.json()) as { organizationId: string };
    expect(a.organizationId).toBe(b.organizationId);
    const workspaces = await call("/api/v1/me/workspaces", {
      headers: { cookie },
    });
    expect(workspaces.status).toBe(200);
    expect(
      ((await workspaces.json()) as { id: string }[]).map((w) => w.id),
    ).toContain(a.organizationId);
    const members = await call(
      `/api/v1/organizations/${a.organizationId}/members?limit=1`,
      { headers: { cookie } },
    );
    expect(members.status).toBe(200);
    expect(((await members.json()) as { items: unknown[] }).items).toHaveLength(
      1,
    );
  });
  it("requires trusted mutation origins and JSON media types", async () => {
    const signedIn = await signIn();
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const body = JSON.stringify({
      type: "WORKSHOP",
      legalName: "Origin Workshop",
      displayName: "Origin Workshop",
      countryCode: "US",
    });
    const create = (
      origin: string | null,
      key: string,
      contentType = "application/json",
    ) =>
      call(
        "/api/v1/organizations",
        {
          method: "POST",
          headers: {
            cookie,
            "idempotency-key": key,
            "content-type": contentType,
            ...(origin === null ? {} : { origin }),
          },
          body,
        },
        origin !== null,
      );
    expect(
      (await create("https://portal.test", "origin-portal-key")).status,
    ).toBe(201);
    expect(
      (await create("https://admin.test", "origin-admin-key")).status,
    ).toBe(201);
    expect((await create("https://evil.test", "origin-evil-key")).status).toBe(
      403,
    );
    expect((await create(null, "origin-missing-key")).status).toBe(403);
    expect(
      (await create("https://portal.test", "origin-plain-key", "text/plain"))
        .status,
    ).toBe(415);
    const count = await testEnv.DB.prepare(
      "SELECT count(*) AS n FROM org_organizations WHERE legal_name='Origin Workshop'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(2);
  });
  it("blocks self-revocation of legal policy acceptance", async () => {
    const signedIn = await signIn();
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    for (const purpose of ["TERMS", "PRIVACY"]) {
      const response = await call("/api/v1/me/consents", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          purpose,
          policyVersion: "v1",
          status: "REVOKED",
        }),
      });
      expect(response.status).toBe(400);
    }
    const marketing = await call("/api/v1/me/consents", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        purpose: "MARKETING_EMAIL",
        policyVersion: "v1",
        status: "REVOKED",
      }),
    });
    expect(marketing.status).toBe(201);
  });
  it("rejects privileged self-request roles through the API", async () => {
    const signedIn = await signIn();
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    for (const role of ["ADMIN", "FINANCE"]) {
      const response = await call(
        "/api/v1/organizations/018f0000-0000-7000-8000-000000000010/membership-requests",
        {
          method: "POST",
          headers: {
            cookie,
            "content-type": "application/json",
            "idempotency-key": `self-${role.toLowerCase()}-key`,
          },
          body: JSON.stringify({
            roles: [role],
            scope: { type: "ALL_LOCATIONS", locationIds: [] },
          }),
        },
      );
      expect(response.status).toBe(403);
    }
  });
  it("lists only selected locations for a location-scoped member", async () => {
    const owner = await ensureMotorBaldiAccount(
      testEnv.DB,
      "018f0000-0000-7000-8000-000000000001",
      "location-scope-owner",
    );
    const created = await createOrganization(
      testEnv.DB,
      {
        accountId: owner.accountId,
        personId: owner.personId,
        mfaEnabled: false,
      },
      {
        type: "WORKSHOP",
        legalName: "Scoped Workshop",
        displayName: "Scoped Workshop",
        countryCode: "US",
      },
      "location-scope-org",
    );
    const locations = [];
    for (const name of ["Allowed", "Private"]) {
      locations.push(
        await addLocation(
          testEnv.DB,
          {
            accountId: owner.accountId,
            personId: owner.personId,
            mfaEnabled: false,
          },
          created.organizationId,
          {
            name,
            locationType: "BRANCH",
            countryCode: "US",
            administrativeArea: "State",
            city: "City",
            addressLine1: `${name} Street`,
          },
          `location-scope-${name}`,
        ),
      );
    }
    const memberAccountId = "018f0000-0000-7000-8000-000000000098";
    const password = await hashPassword("scoped-password-123");
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,?,?,1)",
      ).bind(memberAccountId, "Scoped Member", "scoped-member@example.test"),
      testEnv.DB.prepare(
        "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES(?,?,?,'credential',?)",
      ).bind("cred-scoped", memberAccountId, memberAccountId, password),
    ]);
    const member = await ensureMotorBaldiAccount(
      testEnv.DB,
      memberAccountId,
      "scope-member",
    );
    const membershipId = "018f0000-0000-7000-8000-000000000099";
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,'SELECTED_LOCATIONS')",
      ).bind(membershipId, created.organizationId, member.personId),
      testEnv.DB.prepare(
        "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-admin')",
      ).bind(membershipId),
      testEnv.DB.prepare(
        "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
      ).bind(membershipId, created.organizationId, locations[0]),
    ]);
    const signedIn = await signIn(
      "scoped-member@example.test",
      "scoped-password-123",
    );
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const response = await call(
      `/api/v1/organizations/${created.organizationId}/locations`,
      { headers: { cookie } },
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as { items: { id: string }[] }).items.map(
        (item) => item.id,
      ),
    ).toEqual([locations[0]]);
  });
  it("uses one request ID, correct methods, and CORS on errors", async () => {
    expect((await call("/health")).status).toBe(200);
    expect((await call("/health", { method: "POST" })).status).toBe(405);
    const denied = await call("/api/v1/principal", {
      headers: { origin: "https://api.test" },
    });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("access-control-allow-origin")).toBe(
      "https://api.test",
    );
    expect(((await denied.json()) as { requestId: string }).requestId).toBe(
      denied.headers.get("x-request-id"),
    );
  });

  it("does not treat a session created before MFA enrollment as privileged", async () => {
    const signedIn = await signIn();
    expect(signedIn.status).toBe(200);
    const cookie = signedIn.headers
      .getSetCookie()
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    expect(cookie).toBeTruthy();
    const session = await call("/api/v1/auth/get-session", {
      headers: { cookie },
    });
    expect(session.status).toBe(200);
    await testEnv.DB.prepare(
      "UPDATE auth_users SET two_factor_enabled = 1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 seconds') WHERE id = '018f0000-0000-7000-8000-000000000001'",
    ).run();
    await testEnv.DB.prepare(
      "INSERT INTO auth_two_factors(id,user_id,secret,backup_codes,verified) VALUES('factor-verified','018f0000-0000-7000-8000-000000000001','synthetic-test-secret','[]',1)",
    ).run();
    const principal = await call("/api/v1/principal", { headers: { cookie } });
    expect(principal.status).toBe(200);
    expect(await principal.json()).toMatchObject({
      accountId: "018f0000-0000-7000-8000-000000000001",
      mfaEnabled: false,
    });
    await testEnv.DB.prepare(
      "UPDATE auth_sessions SET created_at=(SELECT updated_at FROM auth_users WHERE id=user_id) WHERE user_id='018f0000-0000-7000-8000-000000000001'",
    ).run();
    const subsequent = await call("/api/v1/principal", { headers: { cookie } });
    expect(await subsequent.json()).toMatchObject({ mfaEnabled: true });
    expect(
      (
        await call("/api/v1/auth/sign-out", {
          method: "POST",
          headers: { cookie, origin: "https://api.test" },
        })
      ).status,
    ).toBe(200);
    expect(
      (await call("/api/v1/principal", { headers: { cookie } })).status,
    ).toBe(401);
  });

  it("rejects invalid passwords and unverified principals", async () => {
    expect(
      (await signIn("verified@example.test", "wrong-password-123")).status,
    ).toBeGreaterThanOrEqual(400);
    const response = await signIn("unverified@example.test");
    const cookie = response.headers.get("set-cookie");
    if (cookie)
      expect(
        (await call("/api/v1/principal", { headers: { cookie } })).status,
      ).toBe(401);
    else expect(response.status).toBeGreaterThanOrEqual(400);
  });
});

describe("idempotency coordinator", () => {
  const headers = {
    "content-type": "application/json",
    "idempotency-key": "same-key-123",
  };
  it("serializes ten requests around one logical effect", async () => {
    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        call("/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers,
          body: JSON.stringify({ value: "same" }),
        }),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const payloads = await Promise.all(
      responses.map(
        (response) =>
          response.json() as Promise<{
            replayed: boolean;
            effectNumber: number;
          }>,
      ),
    );
    expect(payloads.filter((value) => !value.replayed)).toHaveLength(1);
    expect(new Set(payloads.map((value) => value.effectNumber)).size).toBe(1);
  });

  it("rejects conflicts, unknown operations, and oversized responses", async () => {
    expect(
      (
        await call("/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers,
          body: JSON.stringify({ value: "different" }),
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers: { ...headers, "idempotency-key": "unknown-op-key" },
          body: JSON.stringify({ operation: "unknown.operation" }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call("/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers: { ...headers, "idempotency-key": "oversize-key" },
          body: JSON.stringify({ responseBytes: 9000 }),
        })
      ).status,
    ).toBe(413);
  });

  it("isolates account and organization scopes and safely reuses expired keys", async () => {
    const key = "scope-isolation-key";
    const first = await call("/api/v1/foundation/idempotency-test", {
      method: "POST",
      headers: { ...headers, "idempotency-key": key },
      body: JSON.stringify({
        accountId: "018f0000-0000-7000-8000-000000000001",
        organizationId: "018f0000-0000-7000-8000-000000000010",
      }),
    });
    const second = await call("/api/v1/foundation/idempotency-test", {
      method: "POST",
      headers: { ...headers, "idempotency-key": key },
      body: JSON.stringify({
        accountId: "018f0000-0000-7000-8000-000000000002",
        organizationId: "018f0000-0000-7000-8000-000000000011",
      }),
    });
    expect([first.status, second.status]).toEqual([200, 200]);
    await testEnv.DB.prepare(
      "UPDATE governance_idempotency_records SET expires_at='2000-01-01T00:00:00.000Z' WHERE key=?",
    )
      .bind(key)
      .run();
    expect(
      (
        await call("/api/v1/foundation/idempotency-test", {
          method: "POST",
          headers: { ...headers, "idempotency-key": key },
          body: JSON.stringify({
            accountId: "018f0000-0000-7000-8000-000000000001",
            organizationId: "018f0000-0000-7000-8000-000000000010",
            reused: true,
          }),
        })
      ).status,
    ).toBe(200);
  });
});

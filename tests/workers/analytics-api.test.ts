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
import m17 from "../../migrations/0017_parts_catalog.sql?raw";
import m18 from "../../migrations/0018_development_automation.sql?raw";
import m19 from "../../migrations/0019_marketplace_discovery.sql?raw";

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
    m17,
    m18,
    m19,
  ])
    await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  owner = await authenticate(10, true);
  other = await authenticate(40, true);
  admin = await authenticate(70, true);
  noMfa = await authenticate(100);
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-catalog'),(?,'platform-catalog')",
    )
    .bind(admin.personId, noMfa.personId)
    .run();
}, 30_000);
const staff = "/admin/parts";
const data = (manufacturerReference = newId()) => ({
  name: "Oil filter",
  category: "Filters",
  brand: "Example Brand",
  manufacturerReference,
  unit: "UNIT",
  description: "Informational catalog entry",
  compatibility: [{ vehicleKind: "MOTORCYCLE", verified: false }],
});
async function canonical() {
  const input = { ...data(), reason: "Manual catalog creation" };
  const key = newId();
  const response = await request(admin, staff, input, key);
  expect(response.status).toBe(200);
  const created = (await response.json()) as {
    partId: string;
    version: number;
  };
  return { ...created, input, key };
}
async function organization(client: Client, selected = false) {
  const organizationId = newId(),
    membershipId = newId(),
    locationId = newId(),
    otherLocationId = newId();
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES(?,'OTHER','Parts API','Parts API','CO','VERIFIED',?)",
    )
    .bind(organizationId, client.personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,?)",
    )
    .bind(
      membershipId,
      organizationId,
      client.personId,
      selected ? "SELECTED_LOCATIONS" : "ALL_LOCATIONS",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-admin')",
    )
    .bind(membershipId)
    .run();
  for (const id of [locationId, otherLocationId])
    await db
      .prepare(
        "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'Parts Site','BRANCH','CO','Test','Test','Synthetic')",
      )
      .bind(id, organizationId)
      .run();
  if (selected)
    await db
      .prepare(
        "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
      )
      .bind(membershipId, organizationId, locationId)
      .run();
  await db
    .prepare(
      "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'PARTS')",
    )
    .bind(organizationId)
    .run();
  return {
    organizationId,
    membershipId,
    locationId,
    otherLocationId,
    path: `/organizations/${organizationId}/parts-offerings`,
  };
}
async function fixture() {
  const part = await canonical(),
    org = await organization(owner);
  expect(
    (
      await request(
        admin,
        `${staff}/${part.partId}/transition`,
        { version: 1, toStatus: "ACTIVE", reason: "Approved canonical" },
        newId(),
      )
    ).status,
  ).toBe(200);
  const response = await request(
    owner,
    org.path,
    {
      ...part.input,
      canonicalPartId: part.partId,
      locationId: org.locationId,
      partnerSku: "PRIVATE-PARTNER-SKU",
      priceMinor: 45000,
      availability: "AVAILABLE",
    },
    newId(),
  );
  expect(response.status).toBe(200);
  const offering = (await response.json()) as { offeringId: string };
  expect(
    (
      await request(
        owner,
        `${org.path}/${offering.offeringId}/transition`,
        {
          version: 1,
          toStatus: "ACTIVE",
          reason: "Activated partner offering",
        },
        newId(),
      )
    ).status,
  ).toBe(200);
  return {
    part,
    org,
    offering,
    path: `/organizations/${org.organizationId}/marketplace-listings`,
  };
}
async function create(f: Awaited<ReturnType<typeof fixture>>, key = newId()) {
  const body = {
    offeringId: f.offering.offeringId,
    generalLocation: "Test, Test",
    reason: "Explicit partner submission",
  };
  const response = await request(owner, f.path, body, key);
  expect(response.status).toBe(200);
  return {
    ...((await response.json()) as {
      listingId: string;
      version: number;
      status: string;
    }),
    key,
    body,
  };
}
async function publish() {
  const f = await fixture(),
    l = await create(f);
  expect(
    (
      await request(
        owner,
        `${f.path}/${l.listingId}/submit`,
        { version: 1, reason: "Request staff review" },
        newId(),
      )
    ).status,
  ).toBe(200);
  expect(
    (
      await request(
        admin,
        `/admin/marketplace/listings/${l.listingId}/approve`,
        {
          organizationId: f.org.organizationId,
          version: 2,
          reason: "Staff approved public snapshot",
        },
        newId(),
      )
    ).status,
  ).toBe(200);
  return { ...f, l };
}
describe("Private current operational analytics API", () => {
  it("uses assured current catalog access, no-store responses and strict non-PII source measures", async () => {
    const f = await fixture();
    const response = await request(admin, "/admin/analytics/parts");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const report = (await response.json()) as {
      counts: { DRAFT: number; ACTIVE: number; ARCHIVED: number };
    };
    const direct = await db
      .prepare(
        "SELECT status,count(*) AS count FROM parts_canonical GROUP BY status",
      )
      .all<{ status: string; count: number }>();
    for (const status of ["DRAFT", "ACTIVE", "ARCHIVED"] as const)
      expect(report.counts[status]).toBe(
        direct.results.find((row) => row.status === status)?.count ?? 0,
      );
    const serialized = JSON.stringify(report);
    for (const value of [
      f.part.input.manufacturerReference,
      admin.accountId,
      admin.personId,
      "PRIVATE-PARTNER-SKU",
      "Synthetic",
    ])
      expect(serialized).not.toContain(value);
    expect(report).toMatchObject({
      schemaVersion: 1,
      classification: "INTERNAL",
      scope: { type: "PLATFORM", resourceScope: "AUTHORIZED" },
      provenance: { mode: "CURRENT_STATE", sourceTables: ["parts_canonical"] },
    });
  });
  it("requires exact audit staff authority for global Queue metrics without granting it to catalog or partner accounts", async () => {
    expect((await request(admin, "/admin/analytics/queue")).status).toBe(403);
    expect((await request(owner, "/admin/analytics/queue")).status).toBe(403);
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-auditor')",
      )
      .bind(other.personId)
      .run();
    try {
      const response = await request(other, "/admin/analytics/queue");
      expect(response.status).toBe(200);
      const report = await response.json();
      expect(report).toMatchObject({
        kind: "PLATFORM_QUEUE",
        scope: { type: "PLATFORM", resourceScope: "AUTHORIZED" },
      });
      expect(response.headers.get("cache-control")).toBe("no-store");
    } finally {
      await db
        .prepare(
          "DELETE FROM platform_person_roles WHERE person_id=? AND role_id='platform-auditor'",
        )
        .bind(other.personId)
        .run();
    }
    expect((await request(other, "/admin/analytics/queue")).status).toBe(403);
  });
  it("denies anonymous, ordinary organization, unrelated staff and missing human MFA", async () => {
    for (const path of ["/admin/analytics/parts", "/admin/analytics/queue"])
      expect((await request(null, path)).status).toBe(401);
    expect((await request(owner, "/admin/analytics/parts")).status).toBe(403);
    expect((await request(noMfa, "/admin/analytics/parts")).status).toBe(403);
    const ordinary = await organization(other);
    await db
      .prepare(
        "UPDATE org_membership_roles SET role_id='org-viewer' WHERE membership_id=?",
      )
      .bind(ordinary.membershipId)
      .run();
    expect(
      (
        await request(
          other,
          `/organizations/${ordinary.organizationId}/analytics/parts`,
        )
      ).status,
    ).toBe(404);
    const org = await organization(noMfa);
    expect(
      (
        await request(
          noMfa,
          `/organizations/${org.organizationId}/analytics/parts`,
        )
      ).status,
    ).toBe(403);
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-support')",
      )
      .bind(other.personId)
      .run();
    expect((await request(other, "/admin/analytics/parts")).status).toBe(403);
    expect((await request(other, "/admin/analytics/queue")).status).toBe(403);
  });
  it("returns authentic zero counts for an authorized empty organization and excludes all foreign organizations", async () => {
    const f = await fixture(),
      org = await organization(other);
    const response = await request(
      other,
      `/organizations/${org.organizationId}/analytics/parts`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      counts: {
        offerings: { DRAFT: 0, ACTIVE: 0, INACTIVE: 0 },
        listings: { DRAFT: 0, PENDING_REVIEW: 0, PUBLISHED: 0, SUSPENDED: 0 },
        discoverable: 0,
      },
    });
    expect(
      (
        await request(
          other,
          `/organizations/${f.org.organizationId}/analytics/parts`,
        )
      ).status,
    ).toBe(404);
  });
  it("keeps selected-location analytics within current selected scopes and rechecks revoked scope", async () => {
    const f = await fixture();
    await db
      .prepare(
        "UPDATE org_memberships SET location_scope_type='SELECTED_LOCATIONS' WHERE id=?",
      )
      .bind(f.org.membershipId)
      .run();
    await db
      .prepare(
        "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
      )
      .bind(f.org.membershipId, f.org.organizationId, f.org.locationId)
      .run();
    const path = `/organizations/${f.org.organizationId}/analytics/parts`;
    expect((await request(owner, path)).status).toBe(404);
    expect(
      (await request(owner, `${path}?locationId=${f.org.otherLocationId}`))
        .status,
    ).toBe(404);
    const response = await request(
      owner,
      `${path}?locationId=${f.org.locationId}`,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      scope: {
        organizationId: f.org.organizationId,
        locationId: f.org.locationId,
      },
      counts: { offerings: { DRAFT: 0, ACTIVE: 1, INACTIVE: 0 } },
    });
    await db
      .prepare("DELETE FROM org_membership_locations WHERE membership_id=?")
      .bind(f.org.membershipId)
      .run();
    expect(
      (await request(owner, `${path}?locationId=${f.org.locationId}`)).status,
    ).toBe(404);
  });
  it("counts published lifecycle separately from discoverability after source eligibility changes", async () => {
    const f = await publish(),
      path = `/organizations/${f.org.organizationId}/analytics/parts`;
    const before = await request(owner, path);
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({
      counts: { listings: { PUBLISHED: 1 }, discoverable: 1 },
    });
    expect(
      (
        await request(
          owner,
          `${f.org.path}/${f.offering.offeringId}/transition`,
          { version: 2, toStatus: "INACTIVE", reason: "Removed availability" },
          newId(),
        )
      ).status,
    ).toBe(200);
    const after = await request(owner, path);
    expect(after.status).toBe(200);
    expect(await after.json()).toMatchObject({
      counts: { listings: { PUBLISHED: 1 }, discoverable: 0 },
    });
  });
  it("rejects extra, duplicate and malformed queries and never exposes analytics mutation commands", async () => {
    const f = await fixture(),
      orgPath = `/organizations/${f.org.organizationId}/analytics/parts`;
    for (const query of [
      "vin=PRIVATE",
      "export=true",
      "limit=1",
      "locationId=x",
      "locationId=x&locationId=y",
    ])
      expect((await request(owner, `${orgPath}?${query}`)).status).toBe(400);
    for (const query of [
      "q=anything",
      "organizationId=foreign",
      "locationId=anything",
      "q=a&q=b",
    ])
      expect(
        (await request(admin, `/admin/analytics/parts?${query}`)).status,
      ).toBe(400);
    expect((await request(owner, orgPath, {}, newId())).status).toBe(405);
    expect(
      (await request(admin, "/admin/analytics/parts", {}, newId())).status,
    ).toBe(405);
  });
  it("rejects a privileged human session issued before MFA enrollment", async () => {
    const client = await authenticate(130),
      oldSession = { ...client, cookies: new Map(client.cookies) };
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-catalog')",
      )
      .bind(client.personId)
      .run();
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
    expect((await request(oldSession, "/admin/analytics/parts")).status).toBe(
      401,
    );
  });
  it("revokes catalog report access when the current authorized role is removed", async () => {
    expect((await request(admin, "/admin/analytics/parts")).status).toBe(200);
    await db
      .prepare(
        "DELETE FROM platform_person_roles WHERE person_id=? AND role_id='platform-catalog'",
      )
      .bind(admin.personId)
      .run();
    try {
      expect((await request(admin, "/admin/analytics/parts")).status).toBe(403);
    } finally {
      await db
        .prepare(
          "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-catalog')",
        )
        .bind(admin.personId)
        .run();
    }
  });
});

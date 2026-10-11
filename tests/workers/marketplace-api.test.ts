import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import type { Event } from "@motorbaldi/db";
import {
  marketplaceEventHandlers,
  marketplaceCommandEventRegistry,
} from "@motorbaldi/parts";
import apiWorker from "../../apps/api/src/index.js";
import { processEvent } from "../../packages/messaging/src/queue.js";
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
describe("Approved public Parts discovery API", () => {
  it("serves anonymous discovery but leaves active offerings, drafts and pending reviews private", async () => {
    const f = await fixture();
    expect((await request(null, "/public/parts")).status).toBe(200);
    const l = await create(f);
    expect((await request(null, `/public/parts/${l.listingId}`)).status).toBe(
      404,
    );
    expect(
      (
        await request(
          owner,
          `${f.path}/${l.listingId}/submit`,
          { version: 1, reason: "Review request" },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect((await request(null, `/public/parts/${l.listingId}`)).status).toBe(
      404,
    );
    const reviews = await request(admin, "/admin/marketplace/listings");
    expect(reviews.status).toBe(200);
    expect(JSON.stringify(await reviews.json())).toContain(l.listingId);
    expect(
      (
        await request(
          admin,
          `/admin/marketplace/listings/${l.listingId}/approve`,
          {
            organizationId: f.org.organizationId,
            version: 2,
            reason: "Staff review complete",
          },
          newId(),
        )
      ).status,
    ).toBe(200);
    const publishedReview = await request(
      admin,
      "/admin/marketplace/listings?status=PUBLISHED",
    );
    expect(publishedReview.status).toBe(200);
    expect(JSON.stringify(await publishedReview.json())).toContain(l.listingId);
    expect(
      (await request(owner, "/admin/marketplace/listings?status=PUBLISHED"))
        .status,
    ).toBe(403);
    expect(
      (await request(admin, "/admin/marketplace/listings?status=ALL")).status,
    ).toBe(400);
    const detail = await request(null, `/public/parts/${l.listingId}`);
    expect(detail.status).toBe(200);
    expect(detail.headers.get("cache-control")).toBe("no-store");
    const serialized = JSON.stringify(await detail.json());
    expect(serialized).not.toContain("PRIVATE-PARTNER-SKU");
    expect(serialized).not.toContain('"Synthetic"');
    expect(serialized).not.toContain(owner.personId);
    expect(serialized).not.toContain(f.org.organizationId);
    expect(serialized).toContain("Test, Test");
    expect(serialized).toContain('"priceIndicative":true');
    const search = await request(
      null,
      "/public/parts?q=oil&category=Filters&limit=1",
    );
    expect(search.status).toBe(200);
    expect(((await search.json()) as { items: unknown[] }).items).toHaveLength(
      1,
    );
    expect(
      (
        await request(
          owner,
          `${f.path}/${l.listingId}/withdraw`,
          { version: 3, reason: "Withdrawn by partner" },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect((await request(null, `/public/parts/${l.listingId}`)).status).toBe(
      404,
    );
  });
  it("allows staff to discover published listings and revoke them without exposing unreviewed records", async () => {
    const f = await publish(),
      l = f.l;
    const reviews = await request(
      admin,
      "/admin/marketplace/listings?status=PUBLISHED",
    );
    expect(reviews.status).toBe(200);
    expect(JSON.stringify(await reviews.json())).toContain(l.listingId);
    expect(
      (
        await request(
          admin,
          `/admin/marketplace/listings/${l.listingId}/suspend`,
          {
            organizationId: f.org.organizationId,
            version: 3,
            reason: "Moderation revocation",
          },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect((await request(null, `/public/parts/${l.listingId}`)).status).toBe(
      404,
    );
    const suspended = await request(
      admin,
      "/admin/marketplace/listings?status=SUSPENDED",
    );
    expect(JSON.stringify(await suspended.json())).toContain(l.listingId);
  });
  it("denies anonymous, nonstaff and unassured human moderation", async () => {
    expect((await request(null, "/admin/marketplace/listings")).status).toBe(
      401,
    );
    expect((await request(owner, "/admin/marketplace/listings")).status).toBe(
      403,
    );
    expect((await request(noMfa, "/admin/marketplace/listings")).status).toBe(
      403,
    );
    const f = await fixture(),
      l = await create(f);
    expect((await request(null, f.path, l.body, newId())).status).toBe(401);
    expect(
      (
        await request(
          noMfa,
          `/admin/marketplace/listings/${l.listingId}/approve`,
          {
            organizationId: f.org.organizationId,
            version: 1,
            reason: "No assurance",
          },
          newId(),
        )
      ).status,
    ).toBe(403);
  });
  it("enforces foreign organization scope for private reads, writes and historical replay", async () => {
    const f = await fixture(),
      l = await create(f);
    await organization(other);
    expect((await request(other, f.path)).status).toBe(404);
    expect((await request(other, `${f.path}/${l.listingId}`)).status).toBe(404);
    expect(
      (
        await request(
          other,
          `${f.path}/${l.listingId}/submit`,
          { version: 1, reason: "Wrong partner" },
          newId(),
        )
      ).status,
    ).toBe(404);
    expect((await request(other, f.path, l.body, l.key)).status).toBe(404);
  });
  it("replays the same command and rejects mismatches and revoked current authority", async () => {
    const f = await fixture(),
      l = await create(f);
    const replay = await request(owner, f.path, l.body, l.key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      listingId: l.listingId,
      version: 1,
    });
    expect(
      (
        await request(
          owner,
          f.path,
          { ...l.body, reason: "Changed replay" },
          l.key,
        )
      ).status,
    ).toBe(409);
    await db
      .prepare("UPDATE org_memberships SET status='SUSPENDED' WHERE id=?")
      .bind(f.org.membershipId)
      .run();
    expect((await request(owner, f.path, l.body, l.key)).status).toBe(404);
    const p = await publish();
    const approval = {
      organizationId: p.org.organizationId,
      version: 2,
      reason: "Staff approved public snapshot",
    };
    const pending = await request(
      owner,
      `${p.path}/${p.l.listingId}/submit`,
      { version: 3, reason: "Re-review" },
      newId(),
    );
    expect(pending.status).toBe(200);
    const key = newId(),
      body = { ...approval, version: 4 };
    expect(
      (
        await request(
          admin,
          `/admin/marketplace/listings/${p.l.listingId}/approve`,
          body,
          key,
        )
      ).status,
    ).toBe(200);
    await db
      .prepare(
        "DELETE FROM platform_person_roles WHERE person_id=? AND role_id='platform-catalog'",
      )
      .bind(admin.personId)
      .run();
    try {
      expect(
        (
          await request(
            admin,
            `/admin/marketplace/listings/${p.l.listingId}/approve`,
            body,
            key,
          )
        ).status,
      ).toBe(403);
    } finally {
      await db
        .prepare(
          "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-catalog')",
        )
        .bind(admin.personId)
        .run();
    }
  });
  it("rejects invalid and duplicate public query parameters and unsupported methods", async () => {
    for (const query of [
      `q=${"a".repeat(101)}`,
      "limit=0",
      "limit=51",
      "cursor=wrong",
      "q=a&q=b",
      "vin=private",
      "plate=private",
      "customerId=private",
    ]) {
      const response = await request(null, `/public/parts?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "INVALID_MARKETPLACE_QUERY",
      });
    }
    expect((await request(null, "/public/parts", {}, newId())).status).toBe(
      405,
    );
    expect(
      (await request(null, "/public/parts/capabilities?extra=1")).status,
    ).toBe(400);
  });
  it("rejects injected private VIN, SKU and media fields, path/body scope substitution and unsafe origins", async () => {
    const f = await fixture();
    const body = {
      offeringId: f.offering.offeringId,
      generalLocation: "Test, Test",
      reason: "Review only",
    };
    for (const extra of [
      { vin: "PRIVATE" },
      { plate: "PRIVATE" },
      { partnerSku: "PRIVATE" },
      { images: [] },
      { mediaId: newId() },
      { organizationId: newId() },
      { generalLocation: "Synthetic exact address" },
    ])
      expect(
        (await request(owner, f.path, { ...body, ...extra }, newId())).status,
      ).toBe(400);
    const hostile = await rawRequest(
      f.path,
      {
        method: "POST",
        headers: {
          origin: "https://hostile.test",
          "content-type": "application/json",
          "idempotency-key": newId(),
        },
        body: JSON.stringify(body),
      },
      owner,
    );
    expect(hostile.status).toBe(403);
    const missing = await rawRequest(
      f.path,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": newId(),
        },
        body: JSON.stringify(body),
      },
      owner,
    );
    expect(missing.status).toBe(403);
    expect((await request(owner, f.path, body)).status).toBe(400);
  });
  it("advertises disabled commerce honestly and exposes no VIN or plate lookup", async () => {
    const response = await request(null, "/public/parts/capabilities");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      discovery: true,
      orders: false,
      checkout: false,
      payments: false,
      wompi: false,
      reservations: false,
      inventoryDeductions: false,
      commissions: false,
      transactionFees: false,
      media: false,
      automaticFulfillment: false,
    });
    for (const path of [
      "/public/parts/vin/private",
      "/public/parts/plate/private",
      "/public/parts/orders",
      "/public/parts/checkout",
    ]) {
      expect((await request(null, path)).status).toBe(
        path.includes("/vin/") || path.includes("/plate/") ? 404 : 400,
      );
    }
  });
});
async function persistedEvent(
  listingId: string,
  type = "marketplace.listing.create.v1",
) {
  return (await db
    .prepare(
      "SELECT * FROM integration_outbox_events WHERE aggregate_id=? AND event_type=?",
    )
    .bind(listingId, type)
    .first<Event>())!;
}
describe("Marketplace transport and human assurance boundaries", () => {
  it("applies the existing public API rate limiter before discovery", async () => {
    const limit = vi.fn(async () => ({ success: false }));
    const response = await apiWorker.fetch!(
      new Request("https://api.test/api/v1/public/parts", {
        headers: { "cf-connecting-ip": "192.0.2.200" },
      }) as never,
      { ...env, API_RATE_LIMITER: { limit } } as unknown as ApiBindings,
      {
        waitUntil() {},
        passThroughOnException() {},
        props: {},
      } as unknown as ExecutionContext,
    );
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(limit).toHaveBeenCalledWith({ key: "public:192.0.2.200" });
  });
  it("rejects a privileged session issued before human MFA enrollment", async () => {
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
    expect(
      (await request(oldSession, "/admin/marketplace/listings")).status,
    ).toBe(401);
  });
});
describe("Marketplace persisted Queue contract", () => {
  it("processes concurrent duplicate delivery once and preserves listing/history without external effects", async () => {
    const f = await publish(),
      event = await persistedEvent(f.l.listingId),
      before = await db
        .prepare("SELECT * FROM marketplace_listings WHERE id=?")
        .bind(f.l.listingId)
        .first();
    const handlers = marketplaceEventHandlers(db),
      calls = vi.fn(handlers.get(event.event_type)!),
      fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(
        (
          await Promise.all([
            processEvent(
              db,
              event.id,
              new Map([[event.event_type, calls]]),
              marketplaceCommandEventRegistry,
            ),
            processEvent(
              db,
              event.id,
              new Map([[event.event_type, calls]]),
              marketplaceCommandEventRegistry,
            ),
          ])
        ).sort(),
      ).toEqual(["ignored", "processed"]);
      expect(calls).toHaveBeenCalledTimes(1);
      expect(
        await processEvent(
          db,
          event.id,
          handlers,
          marketplaceCommandEventRegistry,
        ),
      ).toBe("ignored");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
    expect(
      await db
        .prepare("SELECT * FROM marketplace_listings WHERE id=?")
        .bind(f.l.listingId)
        .first(),
    ).toEqual(before);
    expect(
      await db
        .prepare(
          "SELECT status,attempts,last_error_code FROM integration_outbox_events WHERE id=?",
        )
        .bind(event.id)
        .first(),
    ).toMatchObject({
      status: "PROCESSED",
      attempts: 1,
      last_error_code: null,
    });
  });
  it("processes legitimate historical approval even after offering inactivation hides it", async () => {
    const f = await publish(),
      event = await persistedEvent(
        f.l.listingId,
        "marketplace.listing.approve.v1",
      );
    expect(
      (
        await request(
          owner,
          `${f.org.path}/${f.offering.offeringId}/transition`,
          {
            version: 2,
            toStatus: "INACTIVE",
            reason: "Partner removed availability",
          },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect((await request(null, `/public/parts/${f.l.listingId}`)).status).toBe(
      404,
    );
    expect(
      await processEvent(
        db,
        event.id,
        marketplaceEventHandlers(db),
        marketplaceCommandEventRegistry,
      ),
    ).toBe("processed");
  });
  it("dead-letters forged source versions, organizations and request references using sanitized codes", async () => {
    for (const mutation of ["version", "organization", "request"]) {
      const f = await publish(),
        event = await persistedEvent(f.l.listingId);
      const payload = JSON.parse(event.payload_json) as {
        version: number;
        organizationId: string;
      };
      if (mutation === "version") payload.version++;
      if (mutation === "organization") payload.organizationId = newId();
      await db
        .prepare(
          "UPDATE integration_outbox_events SET payload_json=?,request_id=? WHERE id=?",
        )
        .bind(
          JSON.stringify(payload),
          mutation === "request" ? newId() : event.request_id,
          event.id,
        )
        .run();
      expect(
        await processEvent(
          db,
          event.id,
          marketplaceEventHandlers(db),
          marketplaceCommandEventRegistry,
        ),
      ).toBe("dead");
      const dead = await db
        .prepare(
          "SELECT error_code FROM integration_dead_letters WHERE outbox_id=?",
        )
        .bind(event.id)
        .first();
      expect(dead).toMatchObject({ error_code: "INVALID_MARKETPLACE_EVENT" });
      expect(JSON.stringify(dead)).not.toContain("PRIVATE-PARTNER-SKU");
    }
  });
});

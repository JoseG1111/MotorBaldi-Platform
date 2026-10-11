import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import type { Event } from "@motorbaldi/db";
import {
  partsEventHandlers,
  partsCommandEventRegistry,
} from "@motorbaldi/parts";
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
describe("Parts API uses current authenticated scopes and manual catalog commands", () => {
  it("denies anonymous, noncatalog and pre-MFA sessions", async () => {
    expect((await request(null, staff)).status).toBe(401);
    expect((await request(owner, staff)).status).toBe(403);
    expect(
      (
        await request(
          noMfa,
          staff,
          { ...data(), reason: "Denied unassured session" },
          newId(),
        )
      ).status,
    ).toBe(403);
  });
  it("rejects old sessions issued before MFA enrollment even after MFA is enabled", async () => {
    const client = await authenticate(130);
    const oldSession = { ...client, cookies: new Map(client.cookies) };
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
      (
        await request(
          oldSession,
          staff,
          { ...data(), reason: "Unassured old session attempt" },
          newId(),
        )
      ).status,
    ).toBe(401);
  });
  it("allows organization-scoped catalog reads and manual offering updates without canonical privilege", async () => {
    const part = await canonical(),
      org = await organization(owner);
    expect(
      (
        await request(
          owner,
          `${staff}/${part.partId}/update`,
          { ...part.input, version: 1 },
          newId(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          owner,
          `/organizations/${org.organizationId}/parts-catalog`,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          other,
          `/organizations/${org.organizationId}/parts-catalog`,
        )
      ).status,
    ).toBe(404);
    const input = {
      ...data(),
      priceMinor: 10000,
      availability: "UNKNOWN",
      reason: "Create informational offering",
    };
    const created = await request(owner, org.path, input, newId());
    expect(created.status).toBe(200);
    const { offeringId } = (await created.json()) as { offeringId: string };
    expect(
      (
        await request(
          owner,
          `${org.path}/${offeringId}/transition`,
          {
            version: 1,
            toStatus: "ACTIVE",
            reason: "Manual offering activation",
          },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          owner,
          `${org.path}/${offeringId}/update`,
          {
            ...input,
            priceMinor: 20000,
            availability: "AVAILABLE",
            version: 2,
          },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          owner,
          `${org.path}/${offeringId}/transition`,
          {
            version: 3,
            toStatus: "INACTIVE",
            reason: "Manual offering deactivation",
          },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect(
      await db
        .prepare(
          "SELECT status,price_minor,availability,version FROM parts_offerings WHERE id=?",
        )
        .bind(offeringId)
        .first(),
    ).toMatchObject({
      status: "INACTIVE",
      price_minor: 20000,
      availability: "AVAILABLE",
      version: 4,
    });
  });
  it("requires trusted Origin and rejects identity injection", async () => {
    for (const origin of [null, "https://untrusted.example.test"]) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "idempotency-key": newId(),
      };
      if (origin) headers.origin = origin;
      expect(
        (
          await rawRequest(
            staff,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                ...data(),
                reason: "Manual catalog creation",
              }),
            },
            admin,
          )
        ).status,
      ).toBe(403);
    }
    expect(
      (
        await request(admin, staff, {
          ...data(),
          reason: "Manual catalog creation",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(
          admin,
          staff,
          {
            ...data(),
            reason: "Manual catalog creation",
            accountId: other.accountId,
          },
          newId(),
        )
      ).status,
    ).toBe(400);
    const part = await canonical();
    expect(
      (
        await request(
          admin,
          `${staff}/${part.partId}/transition`,
          {
            partId: newId(),
            version: 1,
            toStatus: "ACTIVE",
            reason: "Manual catalog activation",
          },
          newId(),
        )
      ).status,
    ).toBe(400);
  });
  it("creates drafts, replays exact commands, applies CAS and manual transitions", async () => {
    const part = await canonical();
    expect((await request(admin, `${staff}/${part.partId}`)).status).toBe(200);
    const replay = await request(admin, staff, part.input, part.key);
    expect(replay.status).toBe(200);
    expect(
      (await replay.json()) as { partId: string; replayed: boolean },
    ).toMatchObject({ partId: part.partId, replayed: true });
    expect(
      (
        await request(
          admin,
          staff,
          { ...part.input, name: "Changed payload" },
          part.key,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          admin,
          `${staff}/${part.partId}/transition`,
          {
            version: 1,
            toStatus: "ACTIVE",
            reason: "Manual catalog activation",
          },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          admin,
          `${staff}/${part.partId}/update`,
          { ...data(), version: 1, reason: "Stale catalog update" },
          newId(),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await request(
          admin,
          `${staff}/${part.partId}/transition`,
          {
            version: 2,
            toStatus: "ARCHIVED",
            reason: "Manual catalog archival",
          },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect(
      await db
        .prepare("SELECT status,version FROM parts_canonical WHERE id=?")
        .bind(part.partId)
        .first(),
    ).toMatchObject({ status: "ARCHIVED", version: 3 });
  });
  it("matches normalized brand/reference exactly without punctuation guessing", async () => {
    const part = await canonical();
    const query = (brand: string, ref: string) =>
      `${staff}/match?brand=${encodeURIComponent(brand)}&manufacturerReference=${encodeURIComponent(ref)}`;
    const exact = await request(
      admin,
      query(" example brand ", part.input.manufacturerReference.toUpperCase()),
    );
    expect(exact.status).toBe(200);
    expect(JSON.stringify(await exact.json())).toContain(part.partId);
    const different = await request(
      admin,
      query(
        part.input.brand,
        part.input.manufacturerReference.replaceAll("-", ""),
      ),
    );
    expect(different.status).toBe(200);
    expect(JSON.stringify(await different.json())).not.toContain(part.partId);
  });
  it("limits organization offerings to selected locations and reevaluates revoked access before replay", async () => {
    const org = await organization(owner, true),
      unrelated = await organization(other);
    const input = {
      ...data(),
      locationId: org.locationId,
      priceMinor: 25000,
      reason: "Manual offering creation",
    };
    const key = newId(),
      created = await request(owner, org.path, input, key);
    expect(created.status).toBe(200);
    const offering = (await created.json()) as { offeringId: string };
    expect(
      (await request(other, `${org.path}/${offering.offeringId}`)).status,
    ).toBe(404);
    expect(
      (
        await request(
          owner,
          unrelated.path,
          { ...data(), reason: "Cross organization creation" },
          newId(),
        )
      ).status,
    ).toBe(404);
    for (const locationId of [null, org.otherLocationId])
      expect(
        (
          await request(
            owner,
            org.path,
            { ...input, manufacturerReference: newId(), locationId },
            newId(),
          )
        ).status,
      ).toBe(404);
    expect(
      (
        await request(
          owner,
          org.path,
          { ...input, organizationId: unrelated.organizationId },
          newId(),
        )
      ).status,
    ).toBe(400);
    await db
      .prepare("UPDATE org_memberships SET status='SUSPENDED' WHERE id=?")
      .bind(org.membershipId)
      .run();
    expect((await request(owner, org.path, input, key)).status).toBe(404);
    expect(
      (await request(owner, `${org.path}/${offering.offeringId}`)).status,
    ).toBe(404);
  });
});
async function persistedPartEvent(partId: string) {
  return (await db
    .prepare(
      "SELECT * FROM integration_outbox_events WHERE aggregate_id=? AND event_type='parts.canonical.create.v1'",
    )
    .bind(partId)
    .first<Event>())!;
}
describe("Parts persisted outbox processing", () => {
  it("processes concurrent duplicate delivery once without domain changes or external transport", async () => {
    const part = await canonical(),
      event = await persistedPartEvent(part.partId);
    const before = await db
      .prepare("SELECT * FROM parts_canonical WHERE id=?")
      .bind(part.partId)
      .first();
    const handlers = partsEventHandlers(db),
      calls = vi.fn(handlers.get(event.event_type)!);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      expect(
        (
          await Promise.all([
            processEvent(
              db,
              event.id,
              new Map([[event.event_type, calls]]),
              partsCommandEventRegistry,
            ),
            processEvent(
              db,
              event.id,
              new Map([[event.event_type, calls]]),
              partsCommandEventRegistry,
            ),
          ])
        ).sort(),
      ).toEqual(["ignored", "processed"]);
      expect(calls).toHaveBeenCalledTimes(1);
      expect(calls.mock.calls[0]![1].idempotencyKey).toBe(event.id);
      expect(
        await processEvent(db, event.id, handlers, partsCommandEventRegistry),
      ).toBe("ignored");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
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
    expect(
      await db
        .prepare("SELECT * FROM parts_canonical WHERE id=?")
        .bind(part.partId)
        .first(),
    ).toEqual(before);
  });
  it("permanently rejects forged versions and request references with sanitized dead letters", async () => {
    for (const mutation of ["version", "request"]) {
      const part = await canonical(),
        event = await persistedPartEvent(part.partId);
      const payload = JSON.parse(event.payload_json) as { version: number };
      if (mutation === "version") payload.version++;
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
          partsEventHandlers(db),
          partsCommandEventRegistry,
        ),
      ).toBe("dead");
      expect(
        await db
          .prepare(
            "SELECT status,last_error_code FROM integration_outbox_events WHERE id=?",
          )
          .bind(event.id)
          .first(),
      ).toMatchObject({
        status: "DEAD",
        last_error_code: "INVALID_PARTS_EVENT",
      });
      const dead = await db
        .prepare("SELECT * FROM integration_dead_letters WHERE outbox_id=?")
        .bind(event.id)
        .first();
      expect(dead).toMatchObject({
        error_code: "INVALID_PARTS_EVENT",
        attempts: 1,
        resolved_at: null,
      });
      expect(JSON.stringify(dead)).not.toContain(part.input.name);
      expect(JSON.stringify(dead)).not.toContain(
        part.input.manufacturerReference,
      );
    }
  });
});
describe("Workshop Parts HTTP immutable informational snapshots", () => {
  it("attaches scoped offerings, preserves captured price and rejects revoked grants before replay", async () => {
    const org = await organization(owner),
      vehicleId = newId(),
      orderId = newId(),
      grantId = newId();
    await db
      .prepare(
        "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'GENERAL_MAINTENANCE')",
      )
      .bind(org.organizationId)
      .run();
    await db
      .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
      .bind(vehicleId)
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,organization_id,location_id,permission_code,granted_by_account_id) VALUES(?,?,?,?,'vehicle.workshop.write',?)",
      )
      .bind(
        grantId,
        vehicleId,
        org.organizationId,
        org.locationId,
        owner.accountId,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_access_grants(id,vehicle_id,organization_id,location_id,permission_code,granted_by_account_id) VALUES(?,?,?,?,'vehicle.workshop.read',?)",
      )
      .bind(
        newId(),
        vehicleId,
        org.organizationId,
        org.locationId,
        owner.accountId,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO workshop_orders(id,vehicle_id,organization_id,location_id,description,created_by_account_id) VALUES(?,?,?,?,'Synthetic parts job',?)",
      )
      .bind(
        orderId,
        vehicleId,
        org.organizationId,
        org.locationId,
        owner.accountId,
      )
      .run();
    const input = {
      ...data(),
      locationId: org.locationId,
      priceMinor: 12000,
      reason: "Create workshop offering",
    };
    const created = await request(owner, org.path, input, newId());
    expect(created.status).toBe(200);
    const { offeringId } = (await created.json()) as { offeringId: string };
    expect(
      (
        await request(
          owner,
          `${org.path}/${offeringId}/transition`,
          {
            version: 1,
            toStatus: "ACTIVE",
            reason: "Manual workshop offering activation",
          },
          newId(),
        )
      ).status,
    ).toBe(200);
    const path = `/organizations/${org.organizationId}/workshop/orders/${orderId}/parts`;
    expect((await request(owner, `${path}/offerings`)).status).toBe(200);
    expect((await request(other, `${path}/offerings`)).status).toBe(404);
    expect(
      (
        await request(
          owner,
          path,
          {
            offeringId,
            orderId: newId(),
            version: 1,
            reason: "Forged order attachment",
          },
          newId(),
        )
      ).status,
    ).toBe(400);
    const attach = {
        offeringId,
        version: 1,
        reason: "Selected informational workshop part",
      },
      key = newId();
    const response = await request(owner, path, attach, key);
    expect(response.status).toBe(200);
    const { snapshotId } = (await response.json()) as { snapshotId: string };
    const frozen = await db
      .prepare("SELECT snapshot_json FROM parts_workshop_snapshots WHERE id=?")
      .bind(snapshotId)
      .first<{ snapshot_json: string }>();
    expect(JSON.parse(frozen!.snapshot_json)).toMatchObject({
      priceMinor: 12000,
      currency: "COP",
      offeringVersion: 2,
      orderVersion: 2,
    });
    expect((await request(owner, path)).status).toBe(200);
    expect((await request(other, path)).status).toBe(404);
    expect(
      (
        await request(
          owner,
          `${org.path}/${offeringId}/update`,
          { ...input, priceMinor: 24000, version: 2 },
          newId(),
        )
      ).status,
    ).toBe(200);
    expect(
      await db
        .prepare(
          "SELECT snapshot_json FROM parts_workshop_snapshots WHERE id=?",
        )
        .bind(snapshotId)
        .first(),
    ).toEqual(frozen);
    const snapshots = await request(owner, path);
    expect(JSON.stringify(await snapshots.json())).toContain("12000");
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE vehicle_id=?",
      )
      .bind(vehicleId)
      .run();
    expect((await request(owner, path, attach, key)).status).toBe(404);
    expect((await request(owner, path)).status).toBe(404);
  });
});

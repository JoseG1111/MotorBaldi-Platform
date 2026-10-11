import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import {
  commitPreparedCommand,
  commitIdempotentCommand,
  buildIdempotencyScope,
  readReplay,
} from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import {
  preparePartsCommand,
  type PartsOperation,
  type PartsActor,
  prepareMarketplaceCommand,
  authorizeMarketplaceCommand,
  listMarketplacePublic,
  getMarketplacePublic,
  listMarketplaceOwned,
  listMarketplaceReview,
  type MarketplaceOperation,
} from "@motorbaldi/parts";
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
const migrations = [
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
];
const db = (env as unknown as ApiBindings).DB;
beforeAll(async () => {
  for (const migration of migrations)
    await db.exec(migration.replace(/--[^\n]*/g, "").replace(/\n/g, " "));
});
async function actor(role?: string, verified = true): Promise<PartsActor> {
  const accountId = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES(?,'Parts Fixture',?,1,1)",
    )
    .bind(accountId, `${accountId}@example.test`)
    .run();
  const personId = (await ensureMotorBaldiAccount(db, accountId, newId()))
    .personId;
  await db
    .prepare(
      "INSERT INTO auth_two_factors(id,user_id,secret,backup_codes,verified) VALUES(?,?,'synthetic-fixture','[]',?)",
    )
    .bind(newId(), accountId, verified ? 1 : 0)
    .run();
  if (role)
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,?)",
      )
      .bind(personId, role)
      .run();
  return { accountId, personId, mfaEnabled: true };
}
async function organization(
  owner: PartsActor,
  role = "org-owner",
  selected = false,
) {
  const organizationId = newId(),
    membershipId = newId(),
    locationId = newId(),
    otherLocationId = newId();
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES(?,'OTHER','Parts Fixture','Parts Fixture','CO','VERIFIED',?)",
    )
    .bind(organizationId, owner.personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,?)",
    )
    .bind(
      membershipId,
      organizationId,
      owner.personId,
      selected ? "SELECTED_LOCATIONS" : "ALL_LOCATIONS",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,?)",
    )
    .bind(membershipId, role)
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
  return { organizationId, membershipId, locationId, otherLocationId };
}
const data = (reference = newId()) => ({
  name: "Oil filter",
  category: "Filters",
  brand: "Synthetic Brand",
  manufacturerReference: reference,
  unit: "each",
  reason: "Fixture catalog review",
});
async function partsCommand(
  a: PartsActor,
  op: PartsOperation,
  body: Record<string, Json>,
) {
  return (await commitPreparedCommand(
    db,
    await preparePartsCommand(db, a, op, body, newId()),
  )) as {
    partId: string;
    offeringId: string;
    version: number;
    status: string;
    snapshotId: string;
  };
}

async function command(
  a: PartsActor,
  op: MarketplaceOperation,
  body: Record<string, Json>,
) {
  return (await commitPreparedCommand(
    db,
    await prepareMarketplaceCommand(db, a, op, body, newId()),
  )) as { listingId: string; version: number; status: string };
}
async function fixture() {
  const staff = await actor("platform-catalog"),
    owner = await actor(),
    org = await organization(owner);
  const input = data();
  const canonical = await partsCommand(staff, "parts.canonical.create", input);
  await partsCommand(staff, "parts.canonical.transition", {
    partId: canonical.partId,
    version: 1,
    toStatus: "ACTIVE",
    reason: "Approved reference",
  });
  const offering = await partsCommand(owner, "parts.offering.create", {
    ...input,
    organizationId: org.organizationId,
    locationId: org.locationId,
    canonicalPartId: canonical.partId,
    partnerSku: "PRIVATE-SUPPLIER-SKU",
    availability: "AVAILABLE",
    priceMinor: 123400,
  });
  await partsCommand(owner, "parts.offering.transition", {
    organizationId: org.organizationId,
    offeringId: offering.offeringId,
    version: 1,
    toStatus: "ACTIVE",
    reason: "Partner activation",
  });
  return { staff, owner, org, canonical, offering, input };
}
async function listing(f: Awaited<ReturnType<typeof fixture>>) {
  return command(f.owner, "marketplace.listing.create", {
    organizationId: f.org.organizationId,
    offeringId: f.offering.offeringId,
    generalLocation: "Test, Test",
    reason: "Synthetic listing submission",
  });
}
async function transition(
  f: Awaited<ReturnType<typeof fixture>>,
  id: string,
  version: number,
  op: MarketplaceOperation,
  a = f.owner,
) {
  return command(a, op, {
    organizationId: f.org.organizationId,
    listingId: id,
    version,
    reason: "Reviewed synthetic listing",
  });
}
async function published() {
  const f = await fixture(),
    l = await listing(f);
  await transition(f, l.listingId, 1, "marketplace.listing.submit");
  await transition(f, l.listingId, 2, "marketplace.listing.approve", f.staff);
  return { ...f, l };
}
describe("Reviewed public marketplace discovery", () => {
  it("keeps active offerings, drafts and pending submissions private until current staff approval", async () => {
    const f = await fixture();
    expect(await listMarketplacePublic(db, {})).toEqual([]);
    const l = await listing(f);
    await expect(getMarketplacePublic(db, l.listingId)).rejects.toMatchObject({
      status: 404,
    });
    await transition(f, l.listingId, 1, "marketplace.listing.submit");
    await expect(getMarketplacePublic(db, l.listingId)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      transition(f, l.listingId, 2, "marketplace.listing.approve"),
    ).rejects.toMatchObject({ status: 403 });
    await transition(f, l.listingId, 2, "marketplace.listing.approve", f.staff);
    expect(await getMarketplacePublic(db, l.listingId)).toBeTruthy();
  });
  it("requires exact assured staff roles and prevents cross-organization partner reads", async () => {
    const f = await fixture(),
      l = await listing(f);
    await transition(f, l.listingId, 1, "marketplace.listing.submit");
    for (const role of [
      undefined,
      "platform-support",
      "platform-operations",
      "platform-finance",
    ]) {
      const denied = await actor(role);
      await expect(listMarketplaceReview(db, denied, {})).rejects.toMatchObject(
        { status: 403 },
      );
      await expect(
        transition(f, l.listingId, 2, "marketplace.listing.approve", denied),
      ).rejects.toMatchObject({ status: 403 });
    }
    await expect(
      transition(
        f,
        l.listingId,
        2,
        "marketplace.listing.approve",
        await actor("platform-catalog", false),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const other = await actor();
    await organization(other);
    await expect(
      listMarketplaceOwned(db, other, f.org.organizationId, {}),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      authorizeMarketplaceCommand(db, other, "marketplace.listing.withdraw", {
        organizationId: f.org.organizationId,
        listingId: l.listingId,
        version: 2,
        reason: "Unauthorized",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("publishes an allowlist without SKU, exact address, identity, customer or vehicle fields", async () => {
    const f = await published();
    const dto = await getMarketplacePublic(db, f.l.listingId);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain("PRIVATE-SUPPLIER-SKU");
    expect(serialized).not.toContain('"Synthetic"');
    for (const field of [
      "partnerSku",
      "accountId",
      "personId",
      "membershipId",
      "addressLine1",
      "snapshotJson",
      "lastActorAccountId",
      "vehicleId",
      "customerId",
      "vin",
      "plate",
    ])
      expect(serialized).not.toContain(`"${field}"`);
    expect(serialized).toContain("Test, Test");
  });
  it.each([
    "offering-version",
    "offering-inactive",
    "canonical-archived",
    "organization-unverified",
    "capability-revoked",
    "location-inactive",
  ])("hides previously approved claims immediately after %s", async (kind) => {
    const f = await published();
    if (kind === "offering-version")
      await db
        .prepare("UPDATE parts_offerings SET version=version+1 WHERE id=?")
        .bind(f.offering.offeringId)
        .run();
    if (kind === "offering-inactive")
      await partsCommand(f.owner, "parts.offering.transition", {
        organizationId: f.org.organizationId,
        offeringId: f.offering.offeringId,
        version: 2,
        toStatus: "INACTIVE",
        reason: "Unavailable",
      });
    if (kind === "canonical-archived")
      await partsCommand(f.staff, "parts.canonical.transition", {
        partId: f.canonical.partId,
        version: 2,
        toStatus: "ARCHIVED",
        reason: "Archived reference",
      });
    if (kind === "organization-unverified")
      await db
        .prepare(
          "UPDATE org_organizations SET verification_status='SUSPENDED' WHERE id=?",
        )
        .bind(f.org.organizationId)
        .run();
    if (kind === "capability-revoked")
      await db
        .prepare(
          "DELETE FROM org_capabilities WHERE organization_id=? AND code='PARTS'",
        )
        .bind(f.org.organizationId)
        .run();
    if (kind === "location-inactive")
      await db
        .prepare("UPDATE org_locations SET status='INACTIVE' WHERE id=?")
        .bind(f.org.locationId)
        .run();
    await expect(getMarketplacePublic(db, f.l.listingId)).rejects.toMatchObject(
      { status: 404 },
    );
  });
  it("withdraws or suspends public listings through audited versioned commands", async () => {
    for (const op of [
      "marketplace.listing.withdraw",
      "marketplace.listing.suspend",
    ] as const) {
      const f = await published();
      await transition(
        f,
        f.l.listingId,
        3,
        op,
        op.endsWith("suspend") ? f.staff : f.owner,
      );
      await expect(
        getMarketplacePublic(db, f.l.listingId),
      ).rejects.toMatchObject({ status: 404 });
    }
  });
  it("rejects pending listings without publishing and cannot approve an unsubmitted draft", async () => {
    const f = await fixture(),
      l = await listing(f);
    await expect(
      transition(f, l.listingId, 1, "marketplace.listing.approve", f.staff),
    ).rejects.toThrow();
    await transition(f, l.listingId, 1, "marketplace.listing.submit");
    await transition(f, l.listingId, 2, "marketplace.listing.reject", f.staff);
    await expect(getMarketplacePublic(db, l.listingId)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("rolls back all effects if current approval authority is revoked after preparation", async () => {
    const f = await fixture(),
      l = await listing(f);
    await transition(f, l.listingId, 1, "marketplace.listing.submit");
    const requestId = newId();
    const body = {
      organizationId: f.org.organizationId,
      listingId: l.listingId,
      version: 2,
      reason: "Staff review",
    };
    const prepared = await prepareMarketplaceCommand(
      db,
      f.staff,
      "marketplace.listing.approve",
      body,
      requestId,
    );
    await db
      .prepare(
        "DELETE FROM platform_person_roles WHERE person_id=? AND role_id='platform-catalog'",
      )
      .bind(f.staff.personId)
      .run();
    await expect(commitPreparedCommand(db, prepared)).rejects.toThrow();
    for (const table of [
      "governance_audit_events",
      "integration_outbox_events",
      "marketplace_listing_history",
    ])
      expect(
        await db
          .prepare(`SELECT 1 FROM ${table} WHERE request_id=?`)
          .bind(requestId)
          .first(),
      ).toBeNull();
    await expect(getMarketplacePublic(db, l.listingId)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("persists one immutable creation and exact idempotent replay while rejecting body changes", async () => {
    const f = await fixture(),
      requestId = newId();
    const body = {
      organizationId: f.org.organizationId,
      offeringId: f.offering.offeringId,
      generalLocation: "Test, Test",
      reason: "Synthetic listing submission",
    };
    const scope = buildIdempotencyScope({
      accountId: f.owner.accountId,
      operation: "marketplace.listing.create",
      organizationId: f.org.organizationId,
    });
    const prepared = await prepareMarketplaceCommand(
      db,
      f.owner,
      "marketplace.listing.create",
      body,
      requestId,
    );
    const result = await commitIdempotentCommand(
      db,
      scope,
      "public-listing-create",
      body,
      requestId,
      prepared,
    );
    expect(
      (await readReplay(db, scope, "public-listing-create", body))?.response,
    ).toEqual(result);
    await expect(
      readReplay(db, scope, "public-listing-create", {
        ...body,
        generalLocation: "Changed location",
      }),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE marketplace_listing_history SET request_id=? WHERE request_id=?",
        )
        .bind(newId(), requestId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare("DELETE FROM marketplace_listing_history WHERE request_id=?")
        .bind(requestId)
        .run(),
    ).rejects.toThrow();
  });
  it("refuses to approve a snapshot whose offering changed while awaiting review", async () => {
    const f = await fixture(),
      l = await listing(f);
    await transition(f, l.listingId, 1, "marketplace.listing.submit");
    await db
      .prepare("UPDATE parts_offerings SET version=version+1 WHERE id=?")
      .bind(f.offering.offeringId)
      .run();
    await expect(
      transition(f, l.listingId, 2, "marketplace.listing.approve", f.staff),
    ).rejects.toThrow();
    await expect(getMarketplacePublic(db, l.listingId)).rejects.toMatchObject({
      status: 404,
    });
  });
  it("rejects stale listing versions without accepting an event or changing publication", async () => {
    const f = await published(),
      requestId = newId();
    const body = {
      organizationId: f.org.organizationId,
      listingId: f.l.listingId,
      version: 2,
      reason: "Stale partner command",
    };
    await expect(
      prepareMarketplaceCommand(
        db,
        f.owner,
        "marketplace.listing.withdraw",
        body,
        requestId,
      ).then((prepared) => commitPreparedCommand(db, prepared)),
    ).rejects.toThrow();
    for (const table of [
      "governance_audit_events",
      "integration_outbox_events",
      "marketplace_listing_history",
    ])
      expect(
        await db
          .prepare(`SELECT 1 FROM ${table} WHERE request_id=?`)
          .bind(requestId)
          .first(),
      ).toBeNull();
    expect(await getMarketplacePublic(db, f.l.listingId)).toBeTruthy();
  });
  it("rechecks partner scope and capability at the atomic mutation boundary", async () => {
    for (const invalidation of ["membership", "mfa", "capability"]) {
      const f = await fixture(),
        requestId = newId();
      const body = {
        organizationId: f.org.organizationId,
        offeringId: f.offering.offeringId,
        generalLocation: "Test, Test",
        reason: "Synthetic listing submission",
      };
      const prepared = await prepareMarketplaceCommand(
        db,
        f.owner,
        "marketplace.listing.create",
        body,
        requestId,
      );
      if (invalidation === "membership")
        await db
          .prepare(
            "UPDATE org_memberships SET location_scope_type='SELECTED_LOCATIONS' WHERE id=?",
          )
          .bind(f.org.membershipId)
          .run();
      if (invalidation === "mfa")
        await db
          .prepare("UPDATE auth_two_factors SET verified=0 WHERE user_id=?")
          .bind(f.owner.accountId)
          .run();
      if (invalidation === "capability")
        await db
          .prepare(
            "DELETE FROM org_capabilities WHERE organization_id=? AND code='PARTS'",
          )
          .bind(f.org.organizationId)
          .run();
      await expect(commitPreparedCommand(db, prepared)).rejects.toThrow();
      for (const table of [
        "governance_audit_events",
        "integration_outbox_events",
        "marketplace_listing_history",
      ])
        expect(
          await db
            .prepare(`SELECT 1 FROM ${table} WHERE request_id=?`)
            .bind(requestId)
            .first(),
        ).toBeNull();
    }
  });
  it("rejects forged private fields at SQL insertion and preserves the published snapshot", async () => {
    const f = await fixture();
    await expect(
      db
        .prepare(
          `INSERT INTO marketplace_listings(id,organization_id,offering_id,location_id,status,version,offering_version,canonical_version,snapshot_json,general_location,last_actor_account_id,last_operation)
      SELECT ?,organization_id,offering_id,location_id,'DRAFT',1,offering_version,canonical_version,json_set(source_json,'$.partnerSku','PRIVATE-INJECTION'),'Test, Test',?,'marketplace.listing.create' FROM marketplace_eligible_sources WHERE offering_id=?`,
        )
        .bind(newId(), f.owner.accountId, f.offering.offeringId)
        .run(),
    ).rejects.toThrow(/MARKETPLACE_BOUNDARY/);
    const l = await listing(f);
    await transition(f, l.listingId, 1, "marketplace.listing.submit");
    await transition(f, l.listingId, 2, "marketplace.listing.approve", f.staff);
    const original = await getMarketplacePublic(db, l.listingId);
    await expect(
      db
        .prepare(
          "UPDATE marketplace_listings SET version=version+1,status='SUSPENDED',last_operation='marketplace.listing.withdraw',last_actor_account_id=?,snapshot_json=json_set(snapshot_json,'$.partnerSku','PRIVATE-INJECTION') WHERE id=?",
        )
        .bind(f.owner.accountId, l.listingId)
        .run(),
    ).rejects.toThrow(/MARKETPLACE_BOUNDARY/);
    expect(await getMarketplacePublic(db, l.listingId)).toEqual(original);
    await expect(
      db
        .prepare("DELETE FROM marketplace_listings WHERE id=?")
        .bind(l.listingId)
        .run(),
    ).rejects.toThrow(/MARKETPLACE_IMMUTABLE/);
  });
  it("rejects history fabrication without the matching accepted domain audit", async () => {
    const f = await fixture(),
      l = await listing(f);
    await expect(
      db
        .prepare(
          `INSERT INTO marketplace_listing_history(id,listing_id,organization_id,version,status,operation,snapshot_json,actor_account_id,reason,request_id)
      SELECT ?,id,organization_id,version,status,last_operation,snapshot_json,last_actor_account_id,'Forged receipt',? FROM marketplace_listings WHERE id=?`,
        )
        .bind(newId(), newId(), l.listingId)
        .run(),
    ).rejects.toThrow(/MARKETPLACE_BOUNDARY/);
  });
  it.each(["business-name", "general-location"])(
    "hides public claims after unreviewed %s changes",
    async (kind) => {
      const f = await published();
      if (kind === "business-name")
        await db
          .prepare(
            "UPDATE org_organizations SET display_name='Changed public business' WHERE id=?",
          )
          .bind(f.org.organizationId)
          .run();
      else
        await db
          .prepare("UPDATE org_locations SET city='Changed city' WHERE id=?")
          .bind(f.org.locationId)
          .run();
      await expect(
        getMarketplacePublic(db, f.l.listingId),
      ).rejects.toMatchObject({ status: 404 });
    },
  );
  it("returns bounded public discovery results and keeps category and cursor filtering scoped to approved entries", async () => {
    const cursor = newId();
    const a = await published(),
      b = await published();
    const list = await listMarketplacePublic(db, {
      cursor,
      limit: 1,
      query: "oil",
      category: "Filters",
    });
    expect(list).toHaveLength(1);
    const next = await listMarketplacePublic(db, {
      limit: 1,
      cursor: String(list[0]!.listingId),
      query: "oil",
      category: "Filters",
    });
    expect(next).toHaveLength(1);
    expect(next[0]!.listingId).not.toBe(list[0]!.listingId);
    expect(new Set([list[0]!.listingId, next[0]!.listingId])).toEqual(
      new Set([a.l.listingId, b.l.listingId]),
    );
    expect(
      await listMarketplacePublic(db, { category: "Unpublished category" }),
    ).toEqual([]);
    expect(
      await listMarketplacePublic(db, { query: "PRIVATE-SUPPLIER-SKU" }),
    ).toEqual([]);
  });
  it("refreshes the reviewed general location only through resubmission and staff approval", async () => {
    const f = await published();
    await db
      .prepare("UPDATE org_locations SET city='New approved city' WHERE id=?")
      .bind(f.org.locationId)
      .run();
    await expect(getMarketplacePublic(db, f.l.listingId)).rejects.toMatchObject(
      { status: 404 },
    );
    await transition(f, f.l.listingId, 3, "marketplace.listing.submit");
    await expect(getMarketplacePublic(db, f.l.listingId)).rejects.toMatchObject(
      { status: 404 },
    );
    await transition(
      f,
      f.l.listingId,
      4,
      "marketplace.listing.approve",
      f.staff,
    );
    expect(
      JSON.stringify(await getMarketplacePublic(db, f.l.listingId)),
    ).toContain("New approved city, Test");
  });
  it("refreshes a moved offering only after the partner controls both the prior and current site", async () => {
    const f = await published();
    await db
      .prepare("UPDATE org_locations SET city='New offering site' WHERE id=?")
      .bind(f.org.otherLocationId)
      .run();
    await partsCommand(f.owner, "parts.offering.update", {
      ...f.input,
      organizationId: f.org.organizationId,
      locationId: f.org.otherLocationId,
      canonicalPartId: f.canonical.partId,
      offeringId: f.offering.offeringId,
      version: 2,
      availability: "AVAILABLE",
      reason: "Moved offering site",
    });
    await expect(getMarketplacePublic(db, f.l.listingId)).rejects.toMatchObject(
      { status: 404 },
    );
    await transition(f, f.l.listingId, 3, "marketplace.listing.submit");
    await transition(
      f,
      f.l.listingId,
      4,
      "marketplace.listing.approve",
      f.staff,
    );
    expect(
      JSON.stringify(await getMarketplacePublic(db, f.l.listingId)),
    ).toContain("New offering site, Test");
  });
  it.each(["previous", "current"])(
    "denies moved listing resubmission when the %s site is outside selected scope",
    async (outside) => {
      const f = await published();
      await partsCommand(f.owner, "parts.offering.update", {
        ...f.input,
        organizationId: f.org.organizationId,
        locationId: f.org.otherLocationId,
        canonicalPartId: f.canonical.partId,
        offeringId: f.offering.offeringId,
        version: 2,
        availability: "AVAILABLE",
        reason: "Moved offering site",
      });
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
        .bind(
          f.org.membershipId,
          f.org.organizationId,
          outside === "previous" ? f.org.otherLocationId : f.org.locationId,
        )
        .run();
      await expect(
        transition(f, f.l.listingId, 3, "marketplace.listing.submit"),
      ).rejects.toMatchObject({ status: 404 });
      await expect(
        getMarketplacePublic(db, f.l.listingId),
      ).rejects.toMatchObject({ status: 404 });
    },
  );
});

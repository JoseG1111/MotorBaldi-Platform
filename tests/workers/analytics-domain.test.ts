import {
  queryCanonicalPartsReport,
  queryOrganizationPartsReport,
  queryPlatformQueueReport,
} from "@motorbaldi/analytics";
import {
  marketplaceEventHandlers,
  marketplaceCommandEventRegistry,
} from "@motorbaldi/parts";
import { processEvent } from "../../packages/messaging/src/queue.js";
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { commitPreparedCommand } from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import {
  preparePartsCommand,
  type PartsOperation,
  type PartsActor,
  prepareMarketplaceCommand,
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
function aggregateProxy(
  override: (statement: D1PreparedStatement) => Promise<unknown>,
) {
  return {
    prepare(sql: string) {
      const statement = db.prepare(sql);
      if (!sql.includes("observed_at")) return statement;
      return {
        bind(...values: unknown[]) {
          return { first: () => override(statement.bind(...values)) };
        },
      };
    },
  } as unknown as D1Database;
}
async function sourceCount(table: string, where = "", args: unknown[] = []) {
  return (
    await db
      .prepare(
        `SELECT status,count(*) AS count FROM ${table} ${where} GROUP BY status`,
      )
      .bind(...args)
      .all<{ status: string; count: number }>()
  ).results;
}
async function activeOffering(
  f: Awaited<ReturnType<typeof fixture>>,
  locationId: string | null = f.org.locationId,
) {
  const made = await partsCommand(f.owner, "parts.offering.create", {
    ...data(),
    organizationId: f.org.organizationId,
    locationId,
    availability: "UNKNOWN",
  });
  await partsCommand(f.owner, "parts.offering.transition", {
    organizationId: f.org.organizationId,
    offeringId: made.offeringId,
    version: 1,
    toStatus: "ACTIVE",
    reason: "Active synthetic offering",
  });
  return made;
}
describe("Current scoped operational D1 reports", () => {
  it("reproduces canonical current state counts without source rows or commercial data", async () => {
    const f = await fixture();
    await partsCommand(f.staff, "parts.canonical.create", data());
    const report = await queryCanonicalPartsReport(db, f.staff);
    const source = await sourceCount("parts_canonical");
    for (const status of ["DRAFT", "ACTIVE", "ARCHIVED"] as const)
      expect(report.counts[status]).toBe(
        source.find((row) => row.status === status)?.count ?? 0,
      );
    expect(report).toMatchObject({
      schemaVersion: 1,
      classification: "INTERNAL",
      scope: { type: "PLATFORM", resourceScope: "AUTHORIZED" },
      provenance: { mode: "CURRENT_STATE", sourceTables: ["parts_canonical"] },
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(f.staff.accountId);
    expect(serialized).not.toContain(f.input.manufacturerReference);
    expect(serialized).not.toContain("PRIVATE-SUPPLIER-SKU");
  });
  it("reports true zero for an authorized empty organization and excludes foreign offerings", async () => {
    const f = await fixture(),
      other = await actor(),
      org = await organization(other);
    const report = await queryOrganizationPartsReport(
      db,
      other,
      org.organizationId,
      null,
    );
    expect(report.counts).toEqual({
      offerings: { DRAFT: 0, ACTIVE: 0, INACTIVE: 0 },
      listings: { DRAFT: 0, PENDING_REVIEW: 0, PUBLISHED: 0, SUSPENDED: 0 },
      discoverable: 0,
    });
    await expect(
      queryOrganizationPartsReport(db, other, f.org.organizationId, null),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("distinguishes publication lifecycle state from source-qualified public discovery", async () => {
    const f = await published();
    const before = await queryOrganizationPartsReport(
      db,
      f.owner,
      f.org.organizationId,
      null,
    );
    expect(before.counts).toMatchObject({
      offerings: { ACTIVE: 1 },
      listings: { PUBLISHED: 1 },
      discoverable: 1,
    });
    await partsCommand(f.owner, "parts.offering.transition", {
      organizationId: f.org.organizationId,
      offeringId: f.offering.offeringId,
      version: 2,
      toStatus: "INACTIVE",
      reason: "Availability removed",
    });
    const after = await queryOrganizationPartsReport(
      db,
      f.owner,
      f.org.organizationId,
      null,
    );
    expect(after.counts).toMatchObject({
      offerings: { ACTIVE: 0, INACTIVE: 1 },
      listings: { PUBLISHED: 1 },
      discoverable: 0,
    });
  });
  it("reports all authorized offering and listing states once per resource", async () => {
    const f = await fixture();
    await listing(f);
    const pending = await activeOffering(f),
      publicOffer = await activeOffering(f),
      withdrawn = await activeOffering(f);
    for (const [offer, final] of [
      [pending, "pending"],
      [publicOffer, "public"],
      [withdrawn, "withdrawn"],
    ] as const) {
      const l = await command(f.owner, "marketplace.listing.create", {
        organizationId: f.org.organizationId,
        offeringId: offer.offeringId,
        generalLocation: "Test, Test",
      });
      await transition(f, l.listingId, 1, "marketplace.listing.submit");
      if (final !== "pending")
        await transition(
          f,
          l.listingId,
          2,
          "marketplace.listing.approve",
          f.staff,
        );
      if (final === "withdrawn")
        await transition(f, l.listingId, 3, "marketplace.listing.withdraw");
    }
    await partsCommand(f.owner, "parts.offering.create", {
      ...data(),
      organizationId: f.org.organizationId,
      locationId: f.org.locationId,
      availability: "UNKNOWN",
    });
    await partsCommand(f.owner, "parts.offering.transition", {
      organizationId: f.org.organizationId,
      offeringId: withdrawn.offeringId,
      version: 2,
      toStatus: "INACTIVE",
      reason: "Retired synthetic offering",
    });
    const report = await queryOrganizationPartsReport(
      db,
      f.owner,
      f.org.organizationId,
      null,
    );
    expect(report.counts).toEqual({
      offerings: { DRAFT: 1, ACTIVE: 3, INACTIVE: 1 },
      listings: { DRAFT: 1, PENDING_REVIEW: 1, PUBLISHED: 1, SUSPENDED: 1 },
      discoverable: 1,
    });
  });
  it("restricts selected-location managers to the selected site without organization-wide or other-site counts", async () => {
    const f = await fixture();
    await activeOffering(f, f.org.otherLocationId);
    await activeOffering(f, null);
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
    const report = await queryOrganizationPartsReport(
      db,
      f.owner,
      f.org.organizationId,
      f.org.locationId,
    );
    expect(report.counts.offerings).toEqual({
      DRAFT: 0,
      ACTIVE: 1,
      INACTIVE: 0,
    });
    expect(report.scope.locationId).toBe(f.org.locationId);
    await expect(
      queryOrganizationPartsReport(db, f.owner, f.org.organizationId, null),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      queryOrganizationPartsReport(
        db,
        f.owner,
        f.org.organizationId,
        f.org.otherLocationId,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("preserves exact current catalog, own-parts and human audit authority", async () => {
    const f = await fixture();
    for (const role of [
      undefined,
      "platform-support",
      "platform-finance",
      "platform-operations",
    ]) {
      const denied = await actor(role);
      await expect(queryCanonicalPartsReport(db, denied)).rejects.toMatchObject(
        { status: 403 },
      );
      await expect(queryPlatformQueueReport(db, denied)).rejects.toMatchObject({
        status: 403,
      });
    }
    await expect(
      queryCanonicalPartsReport(db, await actor("platform-catalog", false)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(queryPlatformQueueReport(db, f.staff)).rejects.toMatchObject({
      status: 403,
    });
    await expect(queryCanonicalPartsReport(db, f.owner)).rejects.toMatchObject({
      status: 403,
    });
    for (const role of ["platform-auditor", "platform-superadmin"])
      expect(
        (await queryPlatformQueueReport(db, await actor(role))).scope,
      ).toEqual({ type: "PLATFORM", resourceScope: "AUTHORIZED" });
  });
  it("rechecks current staff authority inside the aggregate after the preliminary authorization", async () => {
    const f = await fixture();
    const raced = aggregateProxy(async (statement) => {
      await db
        .prepare(
          "DELETE FROM platform_person_roles WHERE person_id=? AND role_id='platform-catalog'",
        )
        .bind(f.staff.personId)
        .run();
      return statement.first();
    });
    await expect(
      queryCanonicalPartsReport(raced, f.staff),
    ).rejects.toMatchObject({
      status: 503,
      code: "ANALYTICS_EVIDENCE_UNAVAILABLE",
    });
  });
  it("rechecks current organization scope inside the aggregate after preliminary authorization", async () => {
    const f = await fixture();
    const raced = aggregateProxy(async (statement) => {
      await db
        .prepare(
          "UPDATE org_memberships SET location_scope_type='SELECTED_LOCATIONS' WHERE id=?",
        )
        .bind(f.org.membershipId)
        .run();
      return statement.first();
    });
    await expect(
      queryOrganizationPartsReport(raced, f.owner, f.org.organizationId, null),
    ).rejects.toMatchObject({
      status: 503,
      code: "ANALYTICS_EVIDENCE_UNAVAILABLE",
    });
  });
  it("rejects absent, malformed and failed query evidence using sanitized unavailable errors", async () => {
    const f = await fixture();
    for (const invalid of [
      null,
      {},
      { observed_at: "invalid", DRAFT: 0, ACTIVE: 0, ARCHIVED: 0 },
      {
        observed_at: "2026-10-11T03:00:00.000Z",
        DRAFT: -1,
        ACTIVE: 0,
        ARCHIVED: 0,
      },
    ])
      await expect(
        queryCanonicalPartsReport(
          aggregateProxy(async () => invalid),
          f.staff,
        ),
      ).rejects.toMatchObject({
        status: 503,
        code: "ANALYTICS_EVIDENCE_UNAVAILABLE",
      });
    await expect(
      queryCanonicalPartsReport(
        aggregateProxy(async () => {
          throw new Error("PRIVATE-VIN-DATABASE-ERROR");
        }),
        f.staff,
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "ANALYTICS_EVIDENCE_UNAVAILABLE",
      message: "Operational analytics evidence unavailable",
    });
  });
  it("does not multiply resource measures under duplicate at-least-once Queue delivery", async () => {
    const f = await published();
    const before = await queryOrganizationPartsReport(
      db,
      f.owner,
      f.org.organizationId,
      null,
    );
    const event = await db
      .prepare(
        "SELECT id FROM integration_outbox_events WHERE aggregate_id=? AND event_type='marketplace.listing.approve.v1'",
      )
      .bind(f.l.listingId)
      .first<{ id: string }>();
    const results = await Promise.all([
      processEvent(
        db,
        event!.id,
        marketplaceEventHandlers(db),
        marketplaceCommandEventRegistry,
      ),
      processEvent(
        db,
        event!.id,
        marketplaceEventHandlers(db),
        marketplaceCommandEventRegistry,
      ),
    ]);
    expect(results.sort()).toEqual(["ignored", "processed"]);
    const after = await queryOrganizationPartsReport(
      db,
      f.owner,
      f.org.organizationId,
      null,
    );
    expect(after.counts).toEqual(before.counts);
  });
  it("reproduces Queue current-state, live-lease and unresolved-dead-letter source measures", async () => {
    await fixture();
    const records = await db
      .prepare(
        "SELECT id,request_id FROM integration_outbox_events WHERE aggregate_type='parts' ORDER BY id DESC LIMIT 4",
      )
      .all<{ id: string; request_id: string }>();
    const [processing, expired, processed, dead] = records.results;
    for (const [row, state] of [
      [processing, "PROCESSING"],
      [expired, "EXPIRED"],
      [processed, "PROCESSED"],
      [dead, "DEAD"],
    ] as const) {
      const running = state === "PROCESSING" || state === "EXPIRED";
      await db
        .prepare(
          "UPDATE integration_outbox_events SET status=?,processing_token=?,lease_until=? WHERE id=?",
        )
        .bind(
          running ? "PROCESSING" : state,
          running ? newId() : null,
          running
            ? state === "EXPIRED"
              ? "2000-01-01T00:00:00.000Z"
              : "2099-01-01T00:00:00.000Z"
            : null,
          row!.id,
        )
        .run();
    }
    await db
      .prepare(
        "INSERT INTO integration_dead_letters(id,outbox_id,error_code,attempts,request_id) VALUES(?,?,'SANITIZED_TEST',1,?)",
      )
      .bind(newId(), dead!.id, dead!.request_id)
      .run();
    const report = await queryPlatformQueueReport(
      db,
      await actor("platform-auditor"),
    );
    const direct = await sourceCount("integration_outbox_events");
    for (const state of ["PENDING", "PROCESSING", "PROCESSED", "DEAD"] as const)
      expect(report.counts[state]).toBe(
        direct.find((row) => row.status === state)?.count ?? 0,
      );
    expect(report.counts.liveLeases).toBe(1);
    expect(report.counts.unresolvedDeadLetters).toBe(1);
  });
  it("limits Development machine reports to owned synthetic sources and exact current read assurance", async () => {
    const f = await fixture();
    await db
      .prepare(
        "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'development')",
      )
      .run();
    await db
      .prepare(
        "UPDATE org_organizations SET type='WORKSHOP',display_name='MotorBaldi Development Validation Workshop' WHERE id=?",
      )
      .bind(f.org.organizationId)
      .run();
    await db
      .prepare(
        "UPDATE org_locations SET name='MotorBaldi Development Workshop Site' WHERE id=?",
      )
      .bind(f.org.locationId)
      .run();
    const accountId = newId();
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES(?,'Synthetic machine',?,1,0)",
      )
      .bind(accountId, `${accountId}@example.test`)
      .run();
    const personId = (await ensureMotorBaldiAccount(db, accountId, newId()))
        .personId,
      keyId = newId(),
      contextId = newId(),
      membershipId = newId();
    await db
      .prepare(
        "INSERT INTO development_automation_identities(key_id,name,account_id,credential_version,status,organization_id,location_id,expires_at) VALUES(?,'development-validation',?,1,'ACTIVE',?,?,'2099-01-01T00:00:00.000Z')",
      )
      .bind(keyId, accountId, f.org.organizationId, f.org.locationId)
      .run();
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-development-automation')",
      )
      .bind(personId)
      .run();
    await db
      .prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,'SELECTED_LOCATIONS')",
      )
      .bind(membershipId, f.org.organizationId, personId)
      .run();
    await db
      .prepare(
        "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-development-automation')",
      )
      .bind(membershipId)
      .run();
    await db
      .prepare(
        "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
      )
      .bind(membershipId, f.org.organizationId, f.org.locationId)
      .run();
    await db
      .prepare(
        "INSERT INTO development_automation_authorizations(id,account_id,credential_version,operation,request_hash,expires_at) VALUES(?,?,1,'parts.canonical.create',?,'2099-01-01T00:00:00.000Z')",
      )
      .bind(contextId, accountId, "0".repeat(64))
      .run();
    const machine = {
      accountId,
      personId,
      mfaEnabled: false,
      automationAuthorizationId: contextId,
    };
    for (const operation of [
      "parts.canonical.create",
      "parts.offering.create",
    ] as const) {
      await db
        .prepare(
          "UPDATE development_automation_authorizations SET operation=? WHERE id=?",
        )
        .bind(operation, contextId)
        .run();
      const prepared = await preparePartsCommand(
        db,
        machine,
        operation,
        operation === "parts.canonical.create"
          ? data()
          : {
              ...data(),
              organizationId: f.org.organizationId,
              locationId: f.org.locationId,
              availability: "UNKNOWN",
            },
        newId(),
      );
      const output = prepared.response as Record<string, Json>;
      prepared.statements.unshift(
        db
          .prepare(
            "INSERT INTO development_automation_resources(account_id,resource_type,resource_id) VALUES(?,?,?)",
          )
          .bind(
            accountId,
            operation === "parts.canonical.create" ? "canonical" : "offering",
            operation === "parts.canonical.create"
              ? output.partId
              : output.offeringId,
          ),
      );
      await commitPreparedCommand(db, prepared);
    }
    await db
      .prepare(
        "UPDATE development_automation_authorizations SET operation='http.read' WHERE id=?",
      )
      .bind(contextId)
      .run();
    expect(await queryCanonicalPartsReport(db, machine)).toMatchObject({
      scope: { resourceScope: "OWNED_SYNTHETIC" },
      counts: { DRAFT: 1, ACTIVE: 0, ARCHIVED: 0 },
    });
    expect(
      await queryOrganizationPartsReport(
        db,
        machine,
        f.org.organizationId,
        f.org.locationId,
      ),
    ).toMatchObject({
      scope: { resourceScope: "OWNED_SYNTHETIC" },
      counts: {
        offerings: { DRAFT: 1, ACTIVE: 0, INACTIVE: 0 },
        discoverable: 0,
      },
    });
    await expect(queryPlatformQueueReport(db, machine)).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      queryOrganizationPartsReport(
        db,
        machine,
        f.org.organizationId,
        f.org.otherLocationId,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await db
      .prepare(
        "UPDATE development_automation_authorizations SET operation='parts.canonical.create' WHERE id=?",
      )
      .bind(contextId)
      .run();
    await expect(queryCanonicalPartsReport(db, machine)).rejects.toMatchObject({
      status: 503,
      code: "ANALYTICS_EVIDENCE_UNAVAILABLE",
    });
    await db
      .prepare(
        "UPDATE development_automation_authorizations SET operation='http.read' WHERE id=?",
      )
      .bind(contextId)
      .run();
    const raced = aggregateProxy(async (statement) => {
      await db
        .prepare(
          "UPDATE development_automation_identities SET credential_version=2 WHERE key_id=?",
        )
        .bind(keyId)
        .run();
      return statement.first();
    });
    await expect(
      queryCanonicalPartsReport(raced, machine),
    ).rejects.toMatchObject({
      status: 503,
      code: "ANALYTICS_EVIDENCE_UNAVAILABLE",
    });
    await expect(queryCanonicalPartsReport(db, machine)).rejects.toMatchObject({
      status: 403,
    });
  });
});

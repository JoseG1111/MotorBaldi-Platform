import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import {
  commitPreparedCommand,
  commitIdempotentCommand,
  buildIdempotencyScope,
  readReplay,
  type Event,
} from "@motorbaldi/db";
import { newId, type Json } from "@motorbaldi/shared";
import {
  preparePartsCommand,
  authorizePartsCommand,
  getCanonicalPart,
  listCanonicalParts,
  matchCanonicalParts,
  getPartsOffering,
  listPartsOfferings,
  getWorkshopPartSnapshot,
  validatePartsEvent,
  type PartsOperation,
  type PartsActor,
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

const db = (env as unknown as ApiBindings).DB;
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
async function command(
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
async function absent(requestId: string) {
  for (const table of [
    "governance_audit_events",
    "integration_outbox_events",
    "parts_change_history",
  ])
    expect(
      await db
        .prepare(`SELECT 1 FROM ${table} WHERE request_id=?`)
        .bind(requestId)
        .first(),
    ).toBeNull();
}
describe("Parts catalog and organization offerings", () => {
  it("restricts canonical catalog to exact current MFA platform roles", async () => {
    for (const role of ["platform-catalog", "platform-superadmin"]) {
      const staff = await actor(role);
      const created = await command(staff, "parts.canonical.create", data());
      expect(await getCanonicalPart(db, staff, created.partId)).toMatchObject({
        version: 1,
        status: "DRAFT",
      });
    }
    for (const role of [
      undefined,
      "platform-operations",
      "platform-support",
      "platform-finance",
      "platform-crm",
      "platform-verification",
      "platform-auditor",
    ]) {
      const denied = await actor(role);
      await expect(
        authorizePartsCommand(db, denied, "parts.canonical.create", data()),
      ).rejects.toMatchObject({ status: 403 });
      await expect(listCanonicalParts(db, denied, {})).rejects.toMatchObject({
        status: 403,
      });
    }
    await expect(
      authorizePartsCommand(
        db,
        await actor("platform-catalog", false),
        "parts.canonical.create",
        data(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    const owner = await actor();
    await organization(owner);
    await expect(
      authorizePartsCommand(db, owner, "parts.canonical.create", data()),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("reviews drafts, preserves distinct references, and rejects normalized duplicates atomically", async () => {
    const staff = await actor("platform-catalog"),
      input = data("AB-123"),
      a = await command(staff, "parts.canonical.create", input);
    const b = await command(staff, "parts.canonical.create", {
      ...input,
      manufacturerReference: "AB123",
    });
    expect(b.partId).not.toBe(a.partId);
    const requestId = newId();
    const duplicate = await preparePartsCommand(
      db,
      staff,
      "parts.canonical.create",
      {
        ...input,
        brand: "  synthetic   brand ",
        manufacturerReference: " ab-123 ",
      },
      requestId,
    );
    await expect(commitPreparedCommand(db, duplicate)).rejects.toThrow();
    await absent(requestId);
    await command(staff, "parts.canonical.transition", {
      partId: a.partId,
      version: 1,
      toStatus: "ACTIVE",
      reason: "Reviewed reference identity",
    });
    expect(await getCanonicalPart(db, staff, a.partId)).toMatchObject({
      status: "ACTIVE",
      version: 2,
    });
    const matches = await matchCanonicalParts(db, staff, {
      brand: input.brand,
      manufacturerReference: input.manufacturerReference,
    });
    expect(JSON.stringify(matches)).toContain(a.partId);
    expect(JSON.stringify(matches)).not.toContain(b.partId);
    const history = await db
      .prepare(
        "SELECT version,status FROM parts_change_history WHERE resource_id=? ORDER BY version",
      )
      .bind(a.partId)
      .all();
    expect(history.results).toEqual([
      { version: 1, status: "DRAFT" },
      { version: 2, status: "ACTIVE" },
    ]);
  });
  it("rolls back stale versions including idempotent receipt, history and outbox", async () => {
    const staff = await actor("platform-catalog"),
      input = data(),
      a = await command(staff, "parts.canonical.create", input),
      requestId = newId(),
      body = { ...input, partId: a.partId, version: 1, name: "Stale update" };
    const prepared = await preparePartsCommand(
        db,
        staff,
        "parts.canonical.update",
        body,
        requestId,
      ),
      scope = buildIdempotencyScope({
        accountId: staff.accountId,
        operation: "parts.canonical.update",
      });
    await command(staff, "parts.canonical.update", {
      ...body,
      name: "Winning update",
    });
    await expect(
      commitIdempotentCommand(
        db,
        scope,
        "stale-parts",
        body,
        requestId,
        prepared,
      ),
    ).rejects.toMatchObject({ status: 409 });
    await absent(requestId);
    expect(await readReplay(db, scope, "stale-parts", body)).toBeNull();
    expect(await getCanonicalPart(db, staff, a.partId)).toMatchObject({
      name: "Winning update",
      version: 2,
    });
  });
  it("rechecks staff suspension, verified MFA and catalog role after preparation", async () => {
    for (const revoke of [
      "UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?",
      "UPDATE auth_two_factors SET verified=0 WHERE user_id=?",
      "DELETE FROM platform_person_roles WHERE person_id=?",
    ]) {
      const staff = await actor("platform-catalog"),
        requestId = newId(),
        input = data(),
        prepared = await preparePartsCommand(
          db,
          staff,
          "parts.canonical.create",
          input,
          requestId,
        );
      await db
        .prepare(revoke)
        .bind(revoke.includes("person_id") ? staff.personId : staff.accountId)
        .run();
      await expect(commitPreparedCommand(db, prepared)).rejects.toThrow();
      await absent(requestId);
      expect(
        await db
          .prepare(
            "SELECT 1 FROM parts_canonical WHERE manufacturer_reference=?",
          )
          .bind(input.manufacturerReference)
          .first(),
      ).toBeNull();
    }
  });
  it("allows owner/admin nullable, zero and maximum COP prices within own scope", async () => {
    for (const role of ["org-owner", "org-admin"]) {
      const owner = await actor(),
        org = await organization(owner, role);
      for (const priceMinor of [null, 0, Number.MAX_SAFE_INTEGER]) {
        const offering = await command(owner, "parts.offering.create", {
          ...data(),
          organizationId: org.organizationId,
          priceMinor,
        });
        expect(
          await getPartsOffering(
            db,
            owner,
            org.organizationId,
            offering.offeringId,
          ),
        ).toMatchObject({
          status: "DRAFT",
          priceMinor,
          currency: "COP",
          canonicalPartId: null,
        });
      }
      expect(
        JSON.stringify(
          await listPartsOfferings(db, owner, org.organizationId, {}),
        ),
      ).toContain("Oil filter");
    }
  });
  it("denies other organizations, selected location escapes and unverified MFA", async () => {
    const owner = await actor(),
      org = await organization(owner, "org-owner", true),
      other = await actor(),
      otherOrg = await organization(other);
    const created = await command(owner, "parts.offering.create", {
      ...data(),
      organizationId: org.organizationId,
      locationId: org.locationId,
    });
    for (const locationId of [null, org.otherLocationId, otherOrg.locationId])
      await expect(
        command(owner, "parts.offering.create", {
          ...data(),
          organizationId: org.organizationId,
          locationId,
        }),
      ).rejects.toThrow();
    await expect(
      getPartsOffering(db, other, org.organizationId, created.offeringId),
    ).rejects.toThrow();
    await expect(
      command(owner, "parts.offering.create", {
        ...data(),
        organizationId: otherOrg.organizationId,
      }),
    ).rejects.toThrow();
    await db
      .prepare("UPDATE auth_two_factors SET verified=0 WHERE user_id=?")
      .bind(owner.accountId)
      .run();
    await expect(
      listPartsOfferings(db, owner, org.organizationId, {
        locationId: org.locationId,
      }),
    ).rejects.toThrow();
  });
  it("requires reviewed matching canonical mapping before activation", async () => {
    const staff = await actor("platform-catalog"),
      owner = await actor(),
      org = await organization(owner),
      input = data(),
      canonical = await command(staff, "parts.canonical.create", input);
    const offering = await command(owner, "parts.offering.create", {
      ...input,
      organizationId: org.organizationId,
      canonicalPartId: canonical.partId,
      availability: "AVAILABLE",
    });
    await expect(
      command(owner, "parts.offering.transition", {
        organizationId: org.organizationId,
        offeringId: offering.offeringId,
        version: 1,
        toStatus: "ACTIVE",
        reason: "Reviewed partner offering",
      }),
    ).rejects.toThrow();
    await command(staff, "parts.canonical.transition", {
      partId: canonical.partId,
      version: 1,
      toStatus: "ACTIVE",
      reason: "Catalog review approved",
    });
    await command(owner, "parts.offering.transition", {
      organizationId: org.organizationId,
      offeringId: offering.offeringId,
      version: 1,
      toStatus: "ACTIVE",
      reason: "Reviewed partner offering",
    });
    expect(
      await getPartsOffering(
        db,
        owner,
        org.organizationId,
        offering.offeringId,
      ),
    ).toMatchObject({
      status: "ACTIVE",
      availability: "AVAILABLE",
      priceMinor: null,
    });
    await expect(
      command(owner, "parts.offering.create", {
        ...data(),
        organizationId: org.organizationId,
        canonicalPartId: canonical.partId,
      }),
    ).rejects.toThrow();
  });
  it("rechecks expired membership, capability, membership role, MFA and actor suspension atomically", async () => {
    for (const target of ["expiry", "capability", "role", "account", "mfa"]) {
      const owner = await actor(),
        org = await organization(owner, "org-admin"),
        requestId = newId(),
        body = { ...data(), organizationId: org.organizationId },
        prepared = await preparePartsCommand(
          db,
          owner,
          "parts.offering.create",
          body,
          requestId,
        ),
        scope = buildIdempotencyScope({
          accountId: owner.accountId,
          organizationId: org.organizationId,
          operation: "parts.offering.create",
        });
      if (target === "expiry")
        await db
          .prepare(
            "UPDATE org_memberships SET status='ENDED',valid_to=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE id=?",
          )
          .bind(org.membershipId)
          .run();
      if (target === "capability")
        await db
          .prepare("DELETE FROM org_capabilities WHERE organization_id=?")
          .bind(org.organizationId)
          .run();
      if (target === "role")
        await db
          .prepare("DELETE FROM org_membership_roles WHERE membership_id=?")
          .bind(org.membershipId)
          .run();
      if (target === "mfa")
        await db
          .prepare("UPDATE auth_two_factors SET verified=0 WHERE user_id=?")
          .bind(owner.accountId)
          .run();
      if (target === "account")
        await db
          .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
          .bind(owner.accountId)
          .run();
      await expect(
        commitIdempotentCommand(
          db,
          scope,
          `revoke-${target}`,
          body,
          requestId,
          prepared,
        ),
      ).rejects.toThrow();
      await absent(requestId);
      expect(await readReplay(db, scope, `revoke-${target}`, body)).toBeNull();
      expect(
        await db
          .prepare("SELECT 1 FROM parts_offerings WHERE organization_id=?")
          .bind(org.organizationId)
          .first(),
      ).toBeNull();
    }
  });
  it("commits one replay and receipt under concurrent duplicate submissions", async () => {
    const staff = await actor("platform-catalog"),
      body = data(),
      scope = buildIdempotencyScope({
        accountId: staff.accountId,
        operation: "parts.canonical.create",
      }),
      requestId = newId(),
      secondRequestId = newId();
    const first = await preparePartsCommand(
        db,
        staff,
        "parts.canonical.create",
        body,
        requestId,
      ),
      second = await preparePartsCommand(
        db,
        staff,
        "parts.canonical.create",
        body,
        secondRequestId,
      );
    const results = await Promise.allSettled([
      commitIdempotentCommand(db, scope, "one-part", body, requestId, first),
      commitIdempotentCommand(
        db,
        scope,
        "one-part",
        body,
        secondRequestId,
        second,
      ),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await readReplay(db, scope, "one-part", body))?.response).toEqual(
      results.find((result) => result.status === "fulfilled")!.value,
    );
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM parts_canonical WHERE manufacturer_reference=?",
        )
        .bind(body.manufacturerReference)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM governance_audit_events WHERE request_id IN (?,?) AND action='command.accepted'",
        )
        .bind(requestId, secondRequestId)
        .first(),
    ).toEqual({ count: 1 });
    await expect(
      readReplay(db, scope, "one-part", { ...body, name: "Different command" }),
    ).rejects.toMatchObject({ status: 409 });
    for (const table of ["parts_change_history", "integration_outbox_events"])
      expect(
        await db
          .prepare(
            `SELECT count(*) AS count FROM ${table} WHERE request_id IN (?,?)`,
          )
          .bind(requestId, secondRequestId)
          .first(),
      ).toEqual({ count: 1 });
  });
  it("rejects forged history JSON with otherwise valid source metadata", async () => {
    const staff = await actor("platform-catalog"),
      owner = await actor(),
      org = await organization(owner);
    for (const resourceType of ["canonical", "offering"] as const) {
      const editor = resourceType === "canonical" ? staff : owner;
      const prepared = await preparePartsCommand(
        db,
        editor,
        resourceType === "canonical"
          ? "parts.canonical.create"
          : "parts.offering.create",
        {
          ...data(),
          ...(resourceType === "offering"
            ? { organizationId: org.organizationId }
            : {}),
        },
        newId(),
      );
      await prepared.statements[0]!.run();
      const response = prepared.response as {
          partId?: string;
          offeringId?: string;
        },
        resourceId = response.partId ?? response.offeringId!;
      const source =
        resourceType === "canonical"
          ? await getCanonicalPart(db, editor, resourceId)
          : await getPartsOffering(db, editor, org.organizationId, resourceId);
      const forgeries = [
        {},
        { ...source, name: "Forged source name" },
        { ...source, version: 99 },
        ...(resourceType === "offering"
          ? [
              { ...source, organizationId: newId() },
              { ...source, locationId: newId() },
              {
                ...source,
                compatibility: [{ vehicleKind: "CAR", verified: true }],
              },
            ]
          : []),
      ];
      for (const forged of forgeries)
        await expect(
          db
            .prepare(
              "INSERT INTO parts_change_history(id,resource_type,resource_id,version,status,snapshot_json,actor_account_id,reason,request_id) VALUES(?,?,?,1,'DRAFT',?,?,?,?)",
            )
            .bind(
              newId(),
              resourceType,
              resourceId,
              JSON.stringify(forged),
              editor.accountId,
              "Direct history forgery regression",
              newId(),
            )
            .run(),
        ).rejects.toThrow("PARTS_HISTORY_BOUNDARY");
      expect(
        await db
          .prepare(
            "SELECT count(*) AS count FROM parts_change_history WHERE resource_id=?",
          )
          .bind(resourceId)
          .first(),
      ).toEqual({ count: 0 });
    }
  });
  it("retains canonical records, offerings and immutable history", async () => {
    const staff = await actor("platform-catalog"),
      owner = await actor(),
      org = await organization(owner),
      canonical = await command(staff, "parts.canonical.create", data()),
      offering = await command(owner, "parts.offering.create", {
        ...data(),
        organizationId: org.organizationId,
      });
    for (const [table, id] of [
      ["parts_canonical", canonical.partId],
      ["parts_offerings", offering.offeringId],
    ])
      await expect(
        db.prepare(`DELETE FROM ${table} WHERE id=?`).bind(id).run(),
      ).rejects.toThrow();
    await expect(
      db
        .prepare("DELETE FROM parts_change_history WHERE resource_id=?")
        .bind(canonical.partId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE parts_change_history SET reason='Overwrite history' WHERE resource_id=?",
        )
        .bind(offering.offeringId)
        .run(),
    ).rejects.toThrow();
  });
  it("freezes workshop price snapshots and rechecks revoked vehicle grants at commit", async () => {
    const owner = await actor(),
      org = await organization(owner),
      input = data(),
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
    const offering = await command(owner, "parts.offering.create", {
      ...input,
      organizationId: org.organizationId,
      locationId: org.locationId,
      priceMinor: 12000,
    });
    await command(owner, "parts.offering.transition", {
      organizationId: org.organizationId,
      offeringId: offering.offeringId,
      version: 1,
      toStatus: "ACTIVE",
      reason: "Workshop offering reviewed",
    });
    const snapshot = await command(owner, "parts.workshop.snapshot.add", {
      organizationId: org.organizationId,
      orderId,
      offeringId: offering.offeringId,
      version: 1,
      reason: "Selected for workshop job",
    });
    const frozen = await db
      .prepare("SELECT snapshot_json FROM parts_workshop_snapshots WHERE id=?")
      .bind(snapshot.snapshotId)
      .first<{ snapshot_json: string }>();
    expect(JSON.parse(frozen!.snapshot_json)).toMatchObject({
      priceMinor: 12000,
      currency: "COP",
      offeringVersion: 2,
      orderVersion: 2,
    });
    const original = JSON.parse(frozen!.snapshot_json) as Record<string, Json>;
    for (const forged of [
      {},
      { ...original, offeringId: newId() },
      { ...original, organizationId: newId() },
      { ...original, compatibility: [{ vehicleKind: "CAR", verified: true }] },
      { ...original, orderVersion: 99 },
      { ...original, category: "Forged category" },
    ]) {
      await expect(
        db
          .prepare(
            "INSERT INTO parts_workshop_snapshots(id,order_id,organization_id,location_id,offering_id,canonical_part_id,offering_version,canonical_version,order_version,snapshot_json,actor_account_id) SELECT ?,order_id,organization_id,location_id,offering_id,canonical_part_id,offering_version,canonical_version,order_version,?,actor_account_id FROM parts_workshop_snapshots WHERE id=?",
          )
          .bind(newId(), JSON.stringify(forged), snapshot.snapshotId)
          .run(),
      ).rejects.toThrow("PARTS_SNAPSHOT_BOUNDARY");
    }
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM parts_workshop_snapshots WHERE order_id=?",
        )
        .bind(orderId)
        .first(),
    ).toEqual({ count: 1 });
    await command(owner, "parts.offering.update", {
      ...input,
      organizationId: org.organizationId,
      locationId: org.locationId,
      offeringId: offering.offeringId,
      version: 2,
      priceMinor: 24000,
    });
    await command(owner, "parts.offering.transition", {
      organizationId: org.organizationId,
      offeringId: offering.offeringId,
      version: 3,
      toStatus: "INACTIVE",
      reason: "Offering no longer available",
    });
    expect(
      await db
        .prepare(
          "SELECT snapshot_json FROM parts_workshop_snapshots WHERE id=?",
        )
        .bind(snapshot.snapshotId)
        .first(),
    ).toEqual(frozen);
    for (const sql of [
      "UPDATE parts_workshop_snapshots SET snapshot_json='{}' WHERE id=?",
      "DELETE FROM parts_workshop_snapshots WHERE id=?",
    ])
      await expect(
        db.prepare(sql).bind(snapshot.snapshotId).run(),
      ).rejects.toThrow();
    const outsider = await actor();
    await expect(
      getWorkshopPartSnapshot(
        db,
        outsider,
        org.organizationId,
        orderId,
        snapshot.snapshotId,
      ),
    ).rejects.toThrow();
    await command(owner, "parts.offering.transition", {
      organizationId: org.organizationId,
      offeringId: offering.offeringId,
      version: 4,
      toStatus: "ACTIVE",
      reason: "Offering available again",
    });
    const requestId = newId(),
      prepared = await preparePartsCommand(
        db,
        owner,
        "parts.workshop.snapshot.add",
        {
          organizationId: org.organizationId,
          orderId,
          offeringId: offering.offeringId,
          version: 2,
          reason: "Second selection attempt",
        },
        requestId,
      );
    await db
      .prepare(
        "UPDATE vehicle_access_grants SET revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      )
      .bind(grantId)
      .run();
    await expect(commitPreparedCommand(db, prepared)).rejects.toThrow();
    await absent(requestId);
    expect(
      await db
        .prepare("SELECT version FROM workshop_orders WHERE id=?")
        .bind(orderId)
        .first(),
    ).toEqual({ version: 2 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM parts_workshop_snapshots WHERE order_id=?",
        )
        .bind(orderId)
        .first(),
    ).toEqual({ count: 1 });
  });
  it("denies stale canonical reference links during snapshot preparation and commit", async () => {
    for (const field of ["brand", "manufacturerReference"] as const) {
      const owner = await actor(),
        staff = await actor("platform-catalog"),
        org = await organization(owner),
        input = data(),
        vehicleId = newId(),
        orderId = newId();
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
          newId(),
          vehicleId,
          org.organizationId,
          org.locationId,
          owner.accountId,
        )
        .run();
      await db
        .prepare(
          "INSERT INTO workshop_orders(id,vehicle_id,organization_id,location_id,description,created_by_account_id) VALUES(?,?,?,?,'Synthetic canonical mapping job',?)",
        )
        .bind(
          orderId,
          vehicleId,
          org.organizationId,
          org.locationId,
          owner.accountId,
        )
        .run();
      const canonical = await command(staff, "parts.canonical.create", input);
      await command(staff, "parts.canonical.transition", {
        partId: canonical.partId,
        version: 1,
        toStatus: "ACTIVE",
        reason: "Reviewed catalog identity",
      });
      const offering = await command(owner, "parts.offering.create", {
        ...input,
        organizationId: org.organizationId,
        locationId: org.locationId,
        canonicalPartId: canonical.partId,
      });
      await command(owner, "parts.offering.transition", {
        organizationId: org.organizationId,
        offeringId: offering.offeringId,
        version: 1,
        toStatus: "ACTIVE",
        reason: "Reviewed offering identity",
      });
      const body = {
          organizationId: org.organizationId,
          orderId,
          offeringId: offering.offeringId,
          version: 1,
          reason: "Snapshot requires matching canonical identity",
        },
        requestId = newId();
      const prepared = await preparePartsCommand(
        db,
        owner,
        "parts.workshop.snapshot.add",
        body,
        requestId,
      );
      await command(staff, "parts.canonical.update", {
        ...input,
        partId: canonical.partId,
        version: 2,
        [field]: newId(),
      });
      await expect(
        preparePartsCommand(
          db,
          owner,
          "parts.workshop.snapshot.add",
          body,
          newId(),
        ),
      ).rejects.toThrow();
      await expect(commitPreparedCommand(db, prepared)).rejects.toThrow();
      await absent(requestId);
      expect(
        await db
          .prepare("SELECT version FROM workshop_orders WHERE id=?")
          .bind(orderId)
          .first(),
      ).toEqual({ version: 1 });
      expect(
        await db
          .prepare(
            "SELECT count(*) AS count FROM parts_workshop_snapshots WHERE order_id=?",
          )
          .bind(orderId)
          .first(),
      ).toEqual({ count: 0 });
      expect(
        await db
          .prepare(
            "SELECT count(*) AS count FROM workshop_order_events WHERE order_id=?",
          )
          .bind(orderId)
          .first(),
      ).toEqual({ count: 0 });
    }
  });
  it("validates historical events after editor revocation and rejects forged evidence", async () => {
    const staff = await actor("platform-catalog"),
      requestId = newId();
    await commitPreparedCommand(
      db,
      await preparePartsCommand(
        db,
        staff,
        "parts.canonical.create",
        data(),
        requestId,
      ),
    );
    const event = await db
      .prepare("SELECT * FROM integration_outbox_events WHERE request_id=?")
      .bind(requestId)
      .first<Event>();
    expect(event).not.toBeNull();
    await db
      .prepare("DELETE FROM platform_person_roles WHERE person_id=?")
      .bind(staff.personId)
      .run();
    await expect(validatePartsEvent(db, event!)).resolves.toBeUndefined();
    for (const forged of [
      { ...event!, request_id: newId() },
      { ...event!, aggregate_id: newId() },
      { ...event!, event_version: 99 },
      {
        ...event!,
        payload_json: JSON.stringify({
          ...JSON.parse(event!.payload_json),
          version: 99,
        }),
      },
      {
        ...event!,
        payload_json: JSON.stringify({
          ...JSON.parse(event!.payload_json),
          organizationId: newId(),
        }),
      },
    ])
      await expect(validatePartsEvent(db, forged)).rejects.toThrow();
  });
  it("rejects organization roles without owner/admin parts authority and invalid prices", async () => {
    for (const role of [
      "org-service-advisor",
      "org-mechanic",
      "org-inspector",
      "org-finance",
      "org-viewer",
    ]) {
      const member = await actor(),
        org = await organization(member, role);
      await expect(
        command(member, "parts.offering.create", {
          ...data(),
          organizationId: org.organizationId,
        }),
      ).rejects.toThrow();
    }
    const owner = await actor(),
      org = await organization(owner);
    const invalidPrices: Record<string, Json>[] = [
      { priceMinor: -1 },
      { priceMinor: 1.5 },
      { priceMinor: Number.MAX_SAFE_INTEGER + 1 },
      { currency: "USD" },
    ];
    for (const extra of invalidPrices)
      await expect(
        command(owner, "parts.offering.create", {
          ...data(),
          organizationId: org.organizationId,
          ...extra,
        }),
      ).rejects.toMatchObject({ status: 400 });
  });
  it("rechecks current permission grants rather than trusting role names", async () => {
    const staff = await actor("platform-catalog"),
      requestId = newId(),
      prepared = await preparePartsCommand(
        db,
        staff,
        "parts.canonical.create",
        data(),
        requestId,
      );
    await db
      .prepare(
        "DELETE FROM authz_role_permissions WHERE role_id='platform-catalog' AND permission_code='platform.catalog.manage'",
      )
      .run();
    try {
      await expect(commitPreparedCommand(db, prepared)).rejects.toThrow();
      await absent(requestId);
    } finally {
      await db
        .prepare(
          "INSERT INTO authz_role_permissions(role_id,permission_code) VALUES('platform-catalog','platform.catalog.manage')",
        )
        .run();
    }
    const owner = await actor(),
      org = await organization(owner),
      otherId = newId(),
      other = await preparePartsCommand(
        db,
        owner,
        "parts.offering.create",
        { ...data(), organizationId: org.organizationId },
        otherId,
      );
    await db
      .prepare(
        "DELETE FROM authz_role_permissions WHERE role_id='org-owner' AND permission_code='org.parts.manage'",
      )
      .run();
    try {
      await expect(commitPreparedCommand(db, other)).rejects.toThrow();
      await absent(otherId);
    } finally {
      await db
        .prepare(
          "INSERT INTO authz_role_permissions(role_id,permission_code) VALUES('org-owner','org.parts.manage')",
        )
        .run();
    }
  });
});

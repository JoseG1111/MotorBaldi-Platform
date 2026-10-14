import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { createOrganization, setCapabilities } from "@motorbaldi/organizations";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { commitPreparedCommand } from "@motorbaldi/db";
import {
  parseCommissionCommand,
  prepareCommissionCommand,
} from "@motorbaldi/payments";
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
const owner = { accountId: newId(), personId: "", mfaEnabled: true };
const outsider = { accountId: newId(), personId: "", mfaEnabled: true };
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
  for (const [index, actor] of [owner, outsider].entries()) {
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,?,?,1)",
      )
      .bind(
        actor.accountId,
        "Capability Test",
        `capability-${index}@example.test`,
      )
      .run();
    actor.personId = (
      await ensureMotorBaldiAccount(db, actor.accountId, newId())
    ).personId;
  }
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin')",
    )
    .bind(owner.personId)
    .run();
});
async function workshop() {
  return (
    await createOrganization(
      db,
      owner,
      {
        type: "WORKSHOP",
        legalName: "Synthetic Multi Capability Workshop",
        displayName: "Synthetic Multi Capability Workshop",
        countryCode: "CO",
      },
      newId(),
    )
  ).organizationId;
}
async function snapshot(organizationId: string) {
  const organization = await db
    .prepare("SELECT type,version FROM org_organizations WHERE id=?")
    .bind(organizationId)
    .first();
  const capabilities = (
    await db
      .prepare(
        "SELECT code FROM org_capabilities WHERE organization_id=? ORDER BY code",
      )
      .bind(organizationId)
      .all()
  ).results;
  const audits = (
    await db
      .prepare(
        "SELECT id,request_id FROM governance_audit_events WHERE organization_id=? ORDER BY id",
      )
      .bind(organizationId)
      .all()
  ).results;
  return { organization, capabilities, audits };
}
describe("partner capabilities on existing organizations", () => {
  it("allows a workshop owner to combine parts, towing and inspection without changing organization type", async () => {
    const organizationId = await workshop();
    await setCapabilities(
      db,
      owner,
      organizationId,
      ["PARTS", "TOWING", "INSPECTION"],
      newId(),
    );
    const saved = await snapshot(organizationId);
    expect(saved.organization).toMatchObject({ type: "WORKSHOP", version: 1 });
    expect(saved.capabilities).toEqual([
      { code: "INSPECTION" },
      { code: "PARTS" },
      { code: "TOWING" },
    ]);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM commission_agreements WHERE organization_id=?",
        )
        .bind(organizationId)
        .first(),
    ).toEqual({ n: 0 });
  });
  it("denies outsiders and suspended members without changing capabilities or audit", async () => {
    const organizationId = await workshop();
    await setCapabilities(db, owner, organizationId, ["PARTS"], newId());
    const before = await snapshot(organizationId);
    await expect(
      setCapabilities(db, outsider, organizationId, ["TOWING"], newId()),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    const membershipId = newId();
    await db.batch([
      db
        .prepare(
          "INSERT INTO org_memberships(id,organization_id,person_id,status) VALUES(?,?,?,'SUSPENDED')",
        )
        .bind(membershipId, organizationId, outsider.personId),
      db
        .prepare(
          "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-admin')",
        )
        .bind(membershipId),
    ]);
    await expect(
      setCapabilities(db, outsider, organizationId, ["TOWING"], newId()),
    ).rejects.toMatchObject({ status: 403, code: "FORBIDDEN" });
    expect(await snapshot(organizationId)).toEqual(before);
  });
  it("rolls replacement back for unknown codes and rejects duplicates without audit effects", async () => {
    const organizationId = await workshop();
    await setCapabilities(
      db,
      owner,
      organizationId,
      ["INSPECTION", "PARTS"],
      newId(),
    );
    const before = await snapshot(organizationId);
    // A valid insertion precedes the invalid FK, exercising D1 batch rollback after DELETE.
    await expect(
      setCapabilities(
        db,
        owner,
        organizationId,
        ["TOWING", "UNKNOWN_CAPABILITY"],
        newId(),
      ),
    ).rejects.toThrow();
    expect(await snapshot(organizationId)).toEqual(before);
    await expect(
      setCapabilities(db, owner, organizationId, ["PARTS", "PARTS"], newId()),
    ).rejects.toMatchObject({ status: 400, code: "INVALID_CAPABILITIES" });
    expect(await snapshot(organizationId)).toEqual(before);
  });
  it("keeps commercial agreements independent from capability replacement and removal", async () => {
    const organizationId = await workshop();
    const operation = "commission.agreement.create";
    const body = parseCommissionCommand(operation, {
      organizationId,
      agreementVersion: 1,
      validFrom: "2020-01-01T00:00:00.000Z",
      validUntil: null,
      rules: [
        {
          serviceCode: "MAINTENANCE",
          calculation: "PERCENTAGE",
          basisPoints: 1250,
          currency: "COP",
          rounding: "FLOOR",
        },
      ],
      reason: "Synthetic partner capability independence",
    });
    const result = (await commitPreparedCommand(
      db,
      await prepareCommissionCommand(db, owner, operation, body, newId()),
    )) as { id: string };
    const agreement = await db
      .prepare("SELECT * FROM commission_agreements WHERE id=?")
      .bind(result.id)
      .first();
    expect(agreement).toMatchObject({
      organization_id: organizationId,
      status: "DRAFT",
      settlement_approved: 0,
    });
    await setCapabilities(
      db,
      owner,
      organizationId,
      ["PARTS", "TOWING", "INSPECTION"],
      newId(),
    );
    await setCapabilities(db, owner, organizationId, [], newId());
    expect(
      await db
        .prepare("SELECT * FROM commission_agreements WHERE id=?")
        .bind(result.id)
        .first(),
    ).toEqual(agreement);
    expect((await snapshot(organizationId)).capabilities).toEqual([]);
    expect((await snapshot(organizationId)).organization).toMatchObject({
      type: "WORKSHOP",
    });
  });
});

// These fixtures interpose immediately before the atomic D1 batch, after all preparation reads.
function beforeCommit(action: () => Promise<void>): D1Database {
  return {
    prepare: db.prepare.bind(db),
    batch: async (statements: D1PreparedStatement[]) => {
      await action();
      return db.batch(statements);
    },
  } as D1Database;
}
it.each([
  "membership",
  "role",
  "account",
  "person",
  "validity",
  "organization",
])(
  "rolls capability replacement back when current %s authority disappears before commit",
  async (revocation) => {
    const organizationId = await workshop();
    const memberId = newId();
    await db
      .prepare(
        "INSERT INTO org_memberships(id,organization_id,person_id) VALUES(?,?,?)",
      )
      .bind(memberId, organizationId, outsider.personId)
      .run();
    await db
      .prepare(
        "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-admin')",
      )
      .bind(memberId)
      .run();
    await setCapabilities(db, owner, organizationId, ["PARTS"], newId());
    const before = await snapshot(organizationId);
    const racing = beforeCommit(async () => {
      if (revocation === "membership")
        await db
          .prepare(
            "UPDATE org_memberships SET status='SUSPENDED' WHERE organization_id=? AND person_id=?",
          )
          .bind(organizationId, outsider.personId)
          .run();
      if (revocation === "role")
        await db
          .prepare(
            "DELETE FROM org_membership_roles WHERE membership_id IN (SELECT id FROM org_memberships WHERE organization_id=? AND person_id=?)",
          )
          .bind(organizationId, outsider.personId)
          .run();
      if (revocation === "account")
        await db
          .prepare("UPDATE iam_accounts SET status='SUSPENDED' WHERE id=?")
          .bind(outsider.accountId)
          .run();
      if (revocation === "person")
        await db
          .prepare("UPDATE iam_people SET status='PROVISIONAL' WHERE id=?")
          .bind(outsider.personId)
          .run();
      if (revocation === "validity")
        await db
          .prepare(
            "UPDATE org_memberships SET valid_from='2099-01-01T00:00:00.000Z' WHERE organization_id=? AND person_id=?",
          )
          .bind(organizationId, outsider.personId)
          .run();
      if (revocation === "organization")
        await db
          .prepare("UPDATE org_organizations SET status='SUSPENDED' WHERE id=?")
          .bind(organizationId)
          .run();
    });
    await expect(
      setCapabilities(racing, outsider, organizationId, ["TOWING"], newId()),
    ).rejects.toMatchObject({
      status: 409,
      code: "ORGANIZATION_CAPABILITIES_CONFLICT",
    });
    expect((await snapshot(organizationId)).capabilities).toEqual(
      before.capabilities,
    );
    expect((await snapshot(organizationId)).audits).toEqual(before.audits);
    await db
      .prepare("UPDATE iam_accounts SET status='ACTIVE' WHERE id=?")
      .bind(outsider.accountId)
      .run();
    await db
      .prepare("UPDATE iam_people SET status='ACTIVE' WHERE id=?")
      .bind(outsider.personId)
      .run();
  },
);
it("rejects a stale replacement after another authorized writer commits instead of erasing its set", async () => {
  const organizationId = await workshop();
  await setCapabilities(db, owner, organizationId, ["PARTS"], newId());
  const winningRequestId = newId(),
    staleRequestId = newId();
  const racing = beforeCommit(() =>
    setCapabilities(
      db,
      owner,
      organizationId,
      ["INSPECTION"],
      winningRequestId,
    ),
  );
  await expect(
    setCapabilities(racing, owner, organizationId, [], staleRequestId),
  ).rejects.toMatchObject({ code: "ORGANIZATION_CAPABILITIES_CONFLICT" });
  const saved = await snapshot(organizationId);
  expect(saved.capabilities).toEqual([{ code: "INSPECTION" }]);
  expect(saved.audits.some((row) => row.request_id === winningRequestId)).toBe(
    true,
  );
  expect(saved.audits.some((row) => row.request_id === staleRequestId)).toBe(
    false,
  );
});
it("does not accept a person/account mismatch or authority held only in another organization", async () => {
  const organizationId = await workshop();
  const before = await snapshot(organizationId);
  await expect(
    setCapabilities(
      db,
      { ...owner, accountId: outsider.accountId },
      organizationId,
      ["PARTS"],
      newId(),
    ),
  ).rejects.toMatchObject({ code: "ORGANIZATION_CAPABILITIES_CONFLICT" });
  await expect(
    setCapabilities(db, outsider, organizationId, ["PARTS"], newId()),
  ).rejects.toMatchObject({ code: "FORBIDDEN" });
  expect(await snapshot(organizationId)).toEqual(before);
});

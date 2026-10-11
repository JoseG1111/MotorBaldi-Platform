import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import { hasDevelopmentAutomationAssurance } from "@motorbaldi/db";
import { authorizePartsCommand, type PartsActor } from "@motorbaldi/parts";
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
const db = (env as unknown as ApiBindings).DB;
const expires = "2099-01-01T00:00:00.000Z";
let machine: PartsActor;
let org: string;
let site: string;
let context: string;
let key: string;
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
  const accountId = newId();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES(?,'Dedicated validation',?,1,0)",
    )
    .bind(accountId, `${accountId}@example.test`)
    .run();
  const personId = (await ensureMotorBaldiAccount(db, accountId, newId()))
    .personId;
  org = newId();
  site = newId();
  key = newId();
  context = newId();
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,verification_status,created_by_person_id) VALUES(?,'WORKSHOP','Synthetic fixture','MotorBaldi Development Validation Workshop','CO','VERIFIED',?)",
    )
    .bind(org, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_locations(id,organization_id,name,location_type,country_code,administrative_area,city,address_line_1) VALUES(?,?,'MotorBaldi Development Workshop Site','SERVICE_SITE','CO','Synthetic','Synthetic','Synthetic')",
    )
    .bind(site, org)
    .run();
  await db
    .prepare(
      "INSERT INTO development_automation_identities(key_id,name,account_id,credential_version,status,organization_id,location_id,expires_at) VALUES(?,'development-validation',?,1,'ACTIVE',?,?,?)",
    )
    .bind(key, accountId, org, site, expires)
    .run();
  await db
    .prepare(
      "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-development-automation')",
    )
    .bind(personId)
    .run();
  const membership = newId();
  await db
    .prepare(
      "INSERT INTO org_memberships(id,organization_id,person_id,location_scope_type) VALUES(?,?,?,'SELECTED_LOCATIONS')",
    )
    .bind(membership, org, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_membership_roles(membership_id,role_id) VALUES(?,'org-development-automation')",
    )
    .bind(membership)
    .run();
  await db
    .prepare(
      "INSERT INTO org_membership_locations(membership_id,organization_id,location_id) VALUES(?,?,?)",
    )
    .bind(membership, org, site)
    .run();
  await db
    .prepare(
      "INSERT INTO org_capabilities(organization_id,code) VALUES(?,'PARTS')",
    )
    .bind(org)
    .run();
  await db
    .prepare(
      "INSERT INTO development_automation_authorizations(id,account_id,credential_version,operation,request_hash,expires_at) VALUES(?,?,1,'parts.canonical.create',?,?)",
    )
    .bind(context, accountId, "a".repeat(64), expires)
    .run();
  machine = {
    accountId,
    personId,
    mfaEnabled: false,
    automationAuthorizationId: context,
  };
});
const data = {
  name: "Synthetic filter",
  category: "Synthetic",
  brand: "Synthetic",
  manufacturerReference: "synthetic",
  unit: "each",
  reason: "Synthetic Development validation",
};
async function insertCanonical(id: string) {
  return db
    .prepare(
      "INSERT INTO parts_canonical(id,name,category,brand,manufacturer_reference,brand_key,reference_key,unit,last_actor_account_id) VALUES(?,'Synthetic','Synthetic','Synthetic',?,'synthetic',?,'each',?)",
    )
    .bind(id, id, id, machine.accountId)
    .run();
}
describe("Development machine assurance and Parts D1 boundaries", () => {
  it("authorizes a scoped machine without manufacturing human MFA", async () => {
    expect(machine.mfaEnabled).toBe(false);
    expect(await hasDevelopmentAutomationAssurance(db, machine)).toBe(true);
    await expect(
      authorizePartsCommand(db, machine, "parts.canonical.create", data),
    ).resolves.toBeUndefined();
    await expect(
      authorizePartsCommand(db, machine, "parts.offering.create", {
        ...data,
        organizationId: org,
        locationId: site,
      }),
    ).resolves.toBeUndefined();
    await expect(
      authorizePartsCommand(db, machine, "parts.offering.create", {
        ...data,
        organizationId: org,
        locationId: newId(),
      }),
    ).rejects.toThrow();
  });
  it("requires owned synthetic resources and a matching mutation operation", async () => {
    const id = newId();
    await expect(insertCanonical(id)).rejects.toThrow("PARTS_BOUNDARY");
    await db
      .prepare(
        "INSERT INTO development_automation_resources(account_id,resource_type,resource_id) VALUES(?,'canonical',?)",
      )
      .bind(machine.accountId, id)
      .run();
    await insertCanonical(id);
    await db
      .prepare(
        "UPDATE development_automation_authorizations SET operation='parts.canonical.read' WHERE id=?",
      )
      .bind(context)
      .run();
    await expect(
      db
        .prepare("UPDATE parts_canonical SET name='Other',version=2 WHERE id=?")
        .bind(id)
        .run(),
    ).rejects.toThrow("PARTS_BOUNDARY");
    await db
      .prepare(
        "UPDATE development_automation_authorizations SET operation='parts.canonical.update' WHERE id=?",
      )
      .bind(context)
      .run();
    await db
      .prepare("UPDATE parts_canonical SET name='Other',version=2 WHERE id=?")
      .bind(id)
      .run();
  });
  it("enforces scoped owned offering mutations at the D1 boundary", async () => {
    const id = newId();
    await db
      .prepare(
        "UPDATE development_automation_authorizations SET operation='parts.offering.create' WHERE id=?",
      )
      .bind(context)
      .run();
    await db
      .prepare(
        "INSERT INTO development_automation_resources(account_id,resource_type,resource_id) VALUES(?,'offering',?)",
      )
      .bind(machine.accountId, id)
      .run();
    const insert = (location: string) =>
      db
        .prepare(
          "INSERT INTO parts_offerings(id,organization_id,location_id,name,category,brand,manufacturer_reference,brand_key,reference_key,unit,last_actor_account_id) VALUES(?,?,?,'Synthetic','Synthetic','Synthetic',?,'synthetic',?,'each',?)",
        )
        .bind(id, org, location, id, id, machine.accountId)
        .run();
    await expect(insert(newId())).rejects.toThrow();
    await insert(site);
    await db
      .prepare(
        "UPDATE development_automation_authorizations SET operation='parts.offering.update' WHERE id=?",
      )
      .bind(context)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE parts_offerings SET location_id=NULL,version=2 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow("PARTS_BOUNDARY");
    await db
      .prepare(
        "UPDATE parts_offerings SET name='Synthetic update',version=2 WHERE id=?",
      )
      .bind(id)
      .run();
    await db
      .prepare(
        "UPDATE development_automation_identities SET status='REVOKED' WHERE key_id=?",
      )
      .bind(key)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE parts_offerings SET name='Revoked',version=3 WHERE id=?",
        )
        .bind(id)
        .run(),
    ).rejects.toThrow("PARTS_BOUNDARY");
  });
  it("rejects revoked identities, stale versions, missing or expired context", async () => {
    expect(
      await hasDevelopmentAutomationAssurance(db, {
        ...machine,
        automationAuthorizationId: undefined,
      }),
    ).toBe(false);
    await db
      .prepare(
        "UPDATE development_automation_identities SET status='REVOKED' WHERE key_id=?",
      )
      .bind(key)
      .run();
    expect(await hasDevelopmentAutomationAssurance(db, machine)).toBe(false);
    await db
      .prepare(
        "UPDATE development_automation_identities SET status='ACTIVE',credential_version=2 WHERE key_id=?",
      )
      .bind(key)
      .run();
    expect(await hasDevelopmentAutomationAssurance(db, machine)).toBe(false);
    await db
      .prepare(
        "UPDATE development_automation_authorizations SET credential_version=2,expires_at='2000-01-01T00:00:00.000Z' WHERE id=?",
      )
      .bind(context)
      .run();
    expect(await hasDevelopmentAutomationAssurance(db, machine)).toBe(false);
  });
  it("blocks scope changes and escalation to ordinary human authority", async () => {
    await expect(
      db
        .prepare(
          "UPDATE development_automation_identities SET key_id=? WHERE key_id=?",
        )
        .bind(newId(), key)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "UPDATE development_automation_identities SET organization_id=? WHERE key_id=?",
        )
        .bind(newId(), key)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin')",
        )
        .bind(machine.personId)
        .run(),
    ).rejects.toThrow("DEVELOPMENT_AUTOMATION_ROLE_BOUNDARY");
    await expect(
      authorizePartsCommand(
        db,
        { ...machine, automationAuthorizationId: undefined },
        "parts.canonical.create",
        data,
      ),
    ).rejects.toMatchObject({ code: "MFA_REQUIRED" });
  });
  it("rejects adopting an existing human resource", async () => {
    const account = newId();
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled) VALUES(?,'Human fixture',?,1,1)",
      )
      .bind(account, `${account}@example.test`)
      .run();
    const person = (await ensureMotorBaldiAccount(db, account, newId()))
      .personId;
    await db
      .prepare(
        "INSERT INTO auth_two_factors(id,user_id,secret,backup_codes,verified) VALUES(?,?,'synthetic','[]',1)",
      )
      .bind(newId(), account)
      .run();
    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-catalog')",
      )
      .bind(person)
      .run();
    const id = newId();
    await db
      .prepare(
        "INSERT INTO parts_canonical(id,name,category,brand,manufacturer_reference,brand_key,reference_key,unit,last_actor_account_id) VALUES(?,'Human fixture','Synthetic','Synthetic',?,'synthetic',?,'each',?)",
      )
      .bind(id, id, id, account)
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO development_automation_resources(account_id,resource_type,resource_id) VALUES(?,'canonical',?)",
        )
        .bind(machine.accountId, id)
        .run(),
    ).rejects.toThrow("DEVELOPMENT_AUTOMATION_RESOURCE_BOUNDARY");
  });
  it("prevents machine identities from acquiring human credentials, sessions or MFA", async () => {
    await expect(
      db
        .prepare(
          "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES(?,?,?,?)",
        )
        .bind(newId(), machine.accountId, newId(), expires)
        .run(),
    ).rejects.toThrow("DEVELOPMENT_AUTOMATION_HUMAN_AUTH_BOUNDARY");
    await expect(
      db
        .prepare(
          "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES(?,?,?,'credential','synthetic')",
        )
        .bind(newId(), machine.accountId, machine.accountId)
        .run(),
    ).rejects.toThrow("DEVELOPMENT_AUTOMATION_HUMAN_AUTH_BOUNDARY");
    await expect(
      db
        .prepare(
          "INSERT INTO auth_two_factors(id,user_id,secret,backup_codes,verified) VALUES(?,?,'synthetic','[]',1)",
        )
        .bind(newId(), machine.accountId)
        .run(),
    ).rejects.toThrow("DEVELOPMENT_AUTOMATION_HUMAN_AUTH_BOUNDARY");
    await expect(
      db
        .prepare("UPDATE auth_users SET two_factor_enabled=1 WHERE id=?")
        .bind(machine.accountId)
        .run(),
    ).rejects.toThrow("DEVELOPMENT_AUTOMATION_HUMAN_AUTH_BOUNDARY");
  });
  it("denies provisioning outside Development metadata", async () => {
    // Metadata is immutable; remove only its update trigger in this isolated regression database.
    await db.exec("DROP TRIGGER governance_environment_metadata_no_update");
    await db
      .prepare(
        "UPDATE governance_environment_metadata SET environment='production' WHERE singleton=1",
      )
      .run();
    expect(await hasDevelopmentAutomationAssurance(db, machine)).toBe(false);
    await expect(
      db
        .prepare(
          "UPDATE development_automation_identities SET expires_at=? WHERE key_id=?",
        )
        .bind(expires, key)
        .run(),
    ).rejects.toThrow("DEVELOPMENT_AUTOMATION_BOUNDARY");
  });
});

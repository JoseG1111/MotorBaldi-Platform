import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import {
  automationRoute,
  validateAutomationCommand,
  automationResourceClaim,
} from "../../apps/api/src/development-automation-scope.js";
const db = (env as unknown as ApiBindings).DB;
const actor = {
  accountId: "machine",
  personId: "machine-person",
  mfaEnabled: false,
  automationAuthorizationId: "authorization",
};
const org = "11111111-1111-4111-8111-111111111111",
  site = "22222222-2222-4222-8222-222222222222";
beforeAll(async () => {
  await db.exec(
    `CREATE TABLE governance_environment_metadata(singleton INTEGER,environment TEXT); CREATE TABLE org_organizations(id TEXT,type TEXT,display_name TEXT,status TEXT,verification_status TEXT); CREATE TABLE org_locations(id TEXT,organization_id TEXT,name TEXT,status TEXT); CREATE TABLE org_capabilities(organization_id TEXT,code TEXT); CREATE TABLE development_automation_identities(name TEXT,account_id TEXT,credential_version INTEGER,status TEXT,organization_id TEXT,location_id TEXT,expires_at TEXT); CREATE TABLE development_automation_authorizations(id TEXT,account_id TEXT,credential_version INTEGER,operation TEXT,expires_at TEXT); CREATE TABLE development_automation_resources(account_id TEXT,resource_type TEXT,resource_id TEXT,PRIMARY KEY(resource_type,resource_id)); CREATE TABLE iam_accounts(id TEXT,person_id TEXT,status TEXT); CREATE TABLE iam_people(id TEXT,status TEXT); CREATE TABLE auth_users(id TEXT,email_verified INTEGER,two_factor_enabled INTEGER); CREATE TABLE auth_two_factors(user_id TEXT,verified INTEGER); CREATE TABLE platform_person_roles(person_id TEXT,role_id TEXT); CREATE TABLE authz_roles(id TEXT,scope TEXT,code TEXT); CREATE TABLE authz_role_permissions(role_id TEXT,permission_code TEXT); CREATE TABLE org_memberships(id TEXT,person_id TEXT,organization_id TEXT,status TEXT,valid_from TEXT,valid_to TEXT,location_scope_type TEXT); CREATE TABLE org_membership_roles(membership_id TEXT,role_id TEXT); CREATE TABLE org_membership_locations(membership_id TEXT,organization_id TEXT,location_id TEXT); CREATE TABLE org_location_capabilities(organization_id TEXT,location_id TEXT,code TEXT); CREATE TABLE parts_canonical(id TEXT,name TEXT,status TEXT,brand_key TEXT,reference_key TEXT,compatibility_json TEXT);`,
  );
  await db.batch([
    db.prepare(
      "INSERT INTO iam_accounts VALUES('machine','machine-person','ACTIVE')",
    ),
    db.prepare("INSERT INTO iam_people VALUES('machine-person','ACTIVE')"),
    db.prepare(
      "INSERT INTO authz_roles VALUES('platform','PLATFORM','DEVELOPMENT_AUTOMATION'),('org','ORGANIZATION','DEVELOPMENT_AUTOMATION')",
    ),
    db.prepare(
      "INSERT INTO authz_role_permissions VALUES('platform','platform.catalog.manage'),('org','org.parts.manage'),('org','org.read')",
    ),
    db.prepare(
      "INSERT INTO platform_person_roles VALUES('machine-person','platform')",
    ),
    db
      .prepare(
        "INSERT INTO org_memberships VALUES('membership','machine-person',?,'ACTIVE','2000-01-01T00:00:00.000Z',NULL,'SELECTED_LOCATIONS')",
      )
      .bind(org),
    db.prepare("INSERT INTO org_membership_roles VALUES('membership','org')"),
    db
      .prepare("INSERT INTO org_membership_locations VALUES('membership',?,?)")
      .bind(org, site),
    db.prepare("INSERT INTO org_capabilities VALUES(?,'PARTS')").bind(org),
    db.prepare(
      "INSERT INTO governance_environment_metadata VALUES(1,'development')",
    ),
    db
      .prepare(
        "INSERT INTO org_organizations VALUES(?,'WORKSHOP','MotorBaldi Development Validation Workshop','ACTIVE','VERIFIED')",
      )
      .bind(org),
    db
      .prepare(
        "INSERT INTO org_locations VALUES(?,?,'MotorBaldi Development Workshop Site','ACTIVE')",
      )
      .bind(site, org),
    db
      .prepare(
        "INSERT INTO development_automation_identities VALUES('development-validation','machine',1,'ACTIVE',?,?,'2099-01-01T00:00:00.000Z')",
      )
      .bind(org, site),
    db.prepare(
      "INSERT INTO development_automation_authorizations VALUES('authorization','machine',1,'parts.canonical.create','2099-01-01T00:00:00.000Z')",
    ),
    db.prepare(
      "INSERT INTO parts_canonical VALUES('owned','Synthetic owned','ACTIVE','SYNTHETIC DEVELOPMENT','REFERENCE','[]'),('foreign','Private customer','ACTIVE','SYNTHETIC DEVELOPMENT','REFERENCE','[]')",
    ),
    db.prepare(
      "INSERT INTO development_automation_resources VALUES('machine','canonical','owned')",
    ),
  ]);
});
const request = (path: string, method = "GET") =>
  new Request("https://api.test/api/v1" + path, { method });
describe("Development automation scope", () => {
  it("preserves human route behavior and reports machine assurance without MFA", async () => {
    expect(
      await automationRoute(db, request("/me"), {
        ...actor,
        automationAuthorizationId: undefined,
      }),
    ).toBeNull();
    const response = await automationRoute(db, request("/me"), actor);
    expect(await response!.json()).toMatchObject({
      mfaEnabled: false,
      authenticationMethod: "DEVELOPMENT_AUTOMATION",
      accountId: "machine",
    });
  });
  it("denies unrelated private routes and foreign fixture ids", async () => {
    for (const path of [
      "/admin/accounts",
      "/billing/subscriptions",
      "/support",
      "/admin/vehicles/search",
    ])
      await expect(
        automationRoute(db, request(path), actor),
      ).rejects.toMatchObject({ status: path.endsWith("search") ? 404 : 403 });
    await expect(
      automationRoute(
        db,
        request("/organizations/foreign/parts-offerings"),
        actor,
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      automationRoute(
        db,
        request(`/organizations/${org}/locations?locationId=foreign`),
        actor,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("filters canonical listing and strong matches to owned resources", async () => {
    for (const path of [
      "/admin/parts",
      "/admin/parts/match?brand=Synthetic%20Development&manufacturerReference=REFERENCE",
      `/organizations/${org}/parts-catalog?locationId=${site}`,
    ]) {
      const response = await automationRoute(db, request(path), actor);
      expect(await response!.json()).toEqual([
        {
          id: "owned",
          name: "Synthetic owned",
          status: "ACTIVE",
          compatibility: [],
        },
      ]);
    }
    await expect(
      automationRoute(db, request("/admin/parts/foreign"), actor),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      automationRoute(db, request("/admin/parts?cursor=foreign"), actor),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("rechecks current permissions before intercepted reads", async () => {
    const response = await automationRoute(
      db,
      request(`/organizations/${org}/permissions`),
      actor,
    );
    expect(await response!.json()).toEqual({
      permissions: ["org.parts.manage", "org.read"],
    });
    await db.prepare("UPDATE org_memberships SET status='SUSPENDED'").run();
    await expect(
      automationRoute(db, request(`/organizations/${org}/permissions`), actor),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      automationRoute(
        db,
        request(`/organizations/${org}/parts-catalog?locationId=${site}`),
        actor,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await db.prepare("UPDATE org_memberships SET status='ACTIVE'").run();
    await db.prepare("DELETE FROM platform_person_roles").run();
    await expect(
      automationRoute(db, request("/admin/parts"), actor),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .prepare(
        "INSERT INTO platform_person_roles VALUES('machine-person','platform')",
      )
      .run();
  });
  it("requires current registered operation and synthetic inputs", async () => {
    const body = {
      name: "Synthetic fixture",
      brand: "Synthetic Development",
      category: "VALIDATION",
      compatibility: [],
      reason: "Synthetic Development validation",
    };
    await expect(
      validateAutomationCommand(db, actor, "parts.canonical.create", body),
    ).resolves.toBeUndefined();
    await expect(
      validateAutomationCommand(db, actor, "parts.canonical.create", {
        ...body,
        brand: "Customer",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      validateAutomationCommand(db, actor, "parts.canonical.transition", {
        partId: "owned",
        reason: "Synthetic cleanup",
        toStatus: "ARCHIVED",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      validateAutomationCommand(db, actor, "billing.subscription.create", body),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("claims creation in D1 and rejects credential rotation and revocation", async () => {
    const claims = automationResourceClaim(
      db,
      actor,
      "parts.canonical.create",
      { partId: "new-owned" },
    );
    const results = await db.batch(claims);
    expect(results[0]!.meta.changes).toBe(1);
    await db
      .prepare(
        "UPDATE development_automation_identities SET credential_version=2",
      )
      .run();
    await expect(
      automationRoute(db, request("/me"), actor),
    ).rejects.toMatchObject({ status: 403 });
    const stale = await db.batch(
      automationResourceClaim(db, actor, "parts.canonical.create", {
        partId: "stale",
      }),
    );
    expect(stale[0]!.meta.changes).toBe(0);
    await db
      .prepare(
        "UPDATE development_automation_identities SET credential_version=1,status='SUSPENDED'",
      )
      .run();
    await expect(
      validateAutomationCommand(db, actor, "parts.canonical.create", {
        reason: "Synthetic validation",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await db
      .prepare("UPDATE development_automation_identities SET status='ACTIVE'")
      .run();
  });
});

import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const db = (env as unknown as ApiBindings).DB;
describe("Phase 1 D1 migration upgrade", () => {
  it("preserves Foundation rows and installs strict domain constraints and seeds", async () => {
    await db.exec(foundation.replace(/\n/g, " "));
    await db
      .prepare(
        "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES('018f0000-0000-7000-8000-000000000301','Existing','existing@example.test',1)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO governance_audit_events(id,action,resource_type,resource_id,request_id) VALUES('existing-audit','foundation.test','test','existing','upgrade')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO integration_outbox_events(id,aggregate_type,aggregate_id,event_type,event_version,payload_json,request_id,external_effect_policy) VALUES('existing-event','foundation','existing','foundation.event',1,'{}','upgrade','IDEMPOTENT')",
      )
      .run();
    await db.exec(phase1.replace(/\n/g, " "));
    await db.exec(closeout.replace(/\n/g, " "));
    const audit = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM governance_audit_events WHERE id='existing-audit'",
      )
      .first<{ n: number }>();
    const outbox = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM integration_outbox_events WHERE id='existing-event'",
      )
      .first<{ n: number }>();
    const user = await db
      .prepare(
        "SELECT COUNT(*) AS n FROM auth_users WHERE id='018f0000-0000-7000-8000-000000000301'",
      )
      .first<{ n: number }>();
    expect([audit?.n, outbox?.n, user?.n]).toEqual([1, 1, 1]);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM authz_roles")
          .first<{ n: number }>()
      )?.n,
    ).toBe(15);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM crm_pipelines")
          .first<{ n: number }>()
      )?.n,
    ).toBe(3);
    expect(
      await db
        .prepare(
          "SELECT 1 FROM authz_role_permissions WHERE role_id='org-admin' AND permission_code='org.member.role.manage'",
        )
        .first(),
    ).toBeTruthy();
    const indexes = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('org_invitations_expiry','org_membership_requests_expiry','professional_credentials_expiry')",
      )
      .all();
    expect(indexes.results).toHaveLength(3);
    await expect(
      db
        .prepare(
          "INSERT INTO iam_accounts(id,person_id) VALUES('missing-user','missing-person')",
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO iam_people(id,status,given_name,family_name) VALUES('bad','INVALID','A','B')",
        )
        .run(),
    ).rejects.toThrow();
    const strict = await db
      .prepare("SELECT strict FROM pragma_table_list WHERE name='iam_people'")
      .first<{ strict: number }>();
    expect(strict?.strict).toBe(1);
    const fk = await db.prepare("PRAGMA foreign_key_check").all();
    expect(fk.results).toEqual([]);
  });
});

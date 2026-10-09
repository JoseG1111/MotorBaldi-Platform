import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import { newId } from "@motorbaldi/shared";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";
import vehicleCore from "../../migrations/0004_vehicle_core.sql?raw";
import vehicleAccess from "../../migrations/0005_vehicle_access.sql?raw";
import vehicleHistory from "../../migrations/0006_vehicle_history.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const accountId = newId();
const personId = newId();
const organizationId = newId();
const vehicleId = newId();
const otherVehicleId = newId();

beforeAll(async () => {
  for (const sql of [
    foundation,
    phase1,
    closeout,
    vehicleCore,
    vehicleAccess,
    vehicleHistory,
  ])
    await db.exec(sql.replace(/\n/g, " "));
  await db
    .prepare("INSERT INTO auth_users(id,name,email) VALUES(?,?,?)")
    .bind(accountId, "History Test", "history-test@example.test")
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','History','Test')",
    )
    .bind(personId)
    .run();
  await db
    .prepare("INSERT INTO iam_accounts(id,person_id) VALUES(?,?)")
    .bind(accountId, personId)
    .run();
  await db
    .prepare(
      "INSERT INTO org_organizations(id,type,legal_name,display_name,country_code,created_by_person_id) VALUES(?,'WORKSHOP','History Workshop','History Workshop','US',?)",
    )
    .bind(organizationId, personId)
    .run();
  for (const id of [vehicleId, otherVehicleId])
    await db
      .prepare("INSERT INTO vehicle_vehicles(id,kind_code) VALUES(?,'CAR')")
      .bind(id)
      .run();
});

describe("Vehicle odometer history", () => {
  it("keeps readings and corrections as separate immutable events", async () => {
    const originalId = newId();
    await db
      .prepare(
        "INSERT INTO vehicle_odometer_readings(id,vehicle_id,reading_value,unit,observed_at,recorded_by_account_id) VALUES(?,?,10000,'KILOMETERS','2026-01-01T00:00:00.000Z',?)",
      )
      .bind(originalId, vehicleId, accountId)
      .run();
    await db
      .prepare(
        "INSERT INTO vehicle_odometer_readings(id,vehicle_id,reading_value,unit,observed_at,recorded_by_account_id,corrects_reading_id,correction_reason) VALUES(?,?,1000,'KILOMETERS','2026-01-01T00:00:00.000Z',?,?,'Transcription error')",
      )
      .bind(newId(), vehicleId, accountId, originalId)
      .run();
    const rows = await db
      .prepare(
        "SELECT reading_value,corrects_reading_id FROM vehicle_odometer_readings WHERE vehicle_id=? ORDER BY recorded_at,id",
      )
      .bind(vehicleId)
      .all<{ reading_value: number; corrects_reading_id: string | null }>();
    expect(rows.results.map((row) => row.reading_value).sort()).toEqual([
      1000, 10000,
    ]);
    expect(
      rows.results.some((row) => row.corrects_reading_id === originalId),
    ).toBe(true);
    await expect(
      db
        .prepare(
          "UPDATE vehicle_odometer_readings SET reading_value=5 WHERE id=?",
        )
        .bind(originalId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare("DELETE FROM vehicle_odometer_readings WHERE id=?")
        .bind(originalId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO vehicle_odometer_readings(id,vehicle_id,reading_value,unit,observed_at,recorded_by_account_id,corrects_reading_id,correction_reason) VALUES(?,?,1000,'KILOMETERS','2026-01-01T00:00:00.000Z',?,?,'Wrong vehicle')",
        )
        .bind(newId(), otherVehicleId, accountId, originalId)
        .run(),
    ).rejects.toThrow();
  });
});

describe("Vehicle professional records", () => {
  it("freezes final content and preserves corrections as amendments", async () => {
    const recordId = newId();
    await db
      .prepare(
        "INSERT INTO vehicle_professional_records(id,vehicle_id,organization_id,author_person_id,record_type,content_json) VALUES(?,?,?,?,'SERVICE','{\"finding\":\"draft\"}')",
      )
      .bind(recordId, vehicleId, organizationId, personId)
      .run();
    const amendment = (id: string) =>
      db
        .prepare(
          "INSERT INTO vehicle_professional_amendments(id,record_id,author_person_id,reason,content_json) VALUES(?,?,?,'Corrected finding','{\"finding\":\"corrected\"}')",
        )
        .bind(id, recordId, personId)
        .run();
    await expect(amendment(newId())).rejects.toThrow();
    await db
      .prepare(
        'UPDATE vehicle_professional_records SET content_json=\'{"finding":"final"}\',version=version+1 WHERE id=? AND version=1',
      )
      .bind(recordId)
      .run();
    await db
      .prepare(
        "UPDATE vehicle_professional_records SET status='FINAL',finalized_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1 WHERE id=? AND version=2",
      )
      .bind(recordId)
      .run();
    await expect(
      db
        .prepare(
          "UPDATE vehicle_professional_records SET content_json='{}',version=version+1 WHERE id=?",
        )
        .bind(recordId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare("DELETE FROM vehicle_professional_records WHERE id=?")
        .bind(recordId)
        .run(),
    ).rejects.toThrow();
    const amendmentId = newId();
    await amendment(amendmentId);
    await expect(
      db
        .prepare(
          "UPDATE vehicle_professional_amendments SET reason='Altered reason' WHERE id=?",
        )
        .bind(amendmentId)
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare("DELETE FROM vehicle_professional_amendments WHERE id=?")
        .bind(amendmentId)
        .run(),
    ).rejects.toThrow();
    const original = await db
      .prepare(
        "SELECT content_json,status,version FROM vehicle_professional_records WHERE id=?",
      )
      .bind(recordId)
      .first<{ content_json: string; status: string; version: number }>();
    expect(original).toEqual({
      content_json: '{"finding":"final"}',
      status: "FINAL",
      version: 3,
    });
  });
});

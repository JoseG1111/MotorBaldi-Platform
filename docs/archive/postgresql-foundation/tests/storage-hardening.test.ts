import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { files, type ObjectStorage } from "@motorbaldi/storage";
import { newId } from "@motorbaldi/shared";

// Migrations/grants are provisioned by the integration runner. All service queries
// use the real runtime login; the owner connection is only an administrative fixture.
const runtime = new pg.Pool({
  connectionString:
    process.env.TEST_RUNTIME_DATABASE_URL ??
    "postgresql://motorbaldi_runtime:motorbaldi_local_runtime@127.0.0.1:55432/motorbaldi_test",
  application_name: "storage-hardening-test",
});
const owner = new pg.Pool({
  connectionString:
    process.env.TEST_MIGRATION_DATABASE_URL ??
    "postgresql://motorbaldi_owner@127.0.0.1:55432/motorbaldi_test",
});
const actor = newId(),
  requestId = newId();
const bytes = Buffer.from("%PDF-1.7\nfixture");
before(async () => {
  await owner.query(
    'INSERT INTO iam.auth_users(id,name,email,"emailVerified") VALUES ($1,$2,$3,true)',
    [actor, "Fixture", actor + "@example.test"],
  );
});
after(async () => {
  await runtime.end();
  await owner.end();
});
function fixture() {
  const objects = new Map<string, Uint8Array>();
  const store: ObjectStorage = {
    health: async () => {},
    signUpload: async (key) => "https://private/" + key,
    signRead: async (key) => "https://private/" + key,
    read: async (key) => {
      const data = objects.get(key);
      if (!data) throw Error("missing");
      return data;
    },
    put: async (key, data) => {
      objects.set(key, data);
    },
    delete: async (key) => {
      objects.delete(key);
    },
  };
  return { store, objects };
}
test("slow scanner holds no transaction; concurrent scanner denied; uploader is not owner", async () => {
  const { store, objects } = fixture();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const service = files(runtime, store, {
    scan: async () => {
      entered();
      await blocked;
      return "CLEAN";
    },
  });
  const upload = await service.requestUpload(
    actor,
    "application/pdf",
    bytes.length,
    requestId,
  );
  objects.set("quarantine/" + upload.id, bytes);
  const scanning = service.scan(upload.id, requestId);
  try {
    await started;
    const activity = await owner.query(
      "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='storage-hardening-test' AND xact_start IS NOT NULL AND state<>'idle'",
    );
    assert.equal(activity.rows[0].count, 0);
    await assert.rejects(() => service.scan(upload.id, requestId), {
      code: "FILE_STATE",
    });
  } finally {
    release();
  }
  assert.equal(await scanning, "ACTIVE");
  await assert.rejects(() => service.download(upload.id, actor, requestId), {
    status: 404,
  });
  const authorized = files(
    runtime,
    store,
    { scan: async () => "CLEAN" },
    { authorizeDownload: async (who, id) => who === actor && id === upload.id },
  );
  assert.match(
    await authorized.download(upload.id, actor, requestId),
    /active/,
  );
});
test("expired scan lease recovers; scanner timeout quarantines; stale token cannot finalize", async () => {
  const { store, objects } = fixture();
  const service = files(
    runtime,
    store,
    { scan: async () => new Promise(() => {}) },
    { ioTimeoutMs: 20, leaseMs: 100 },
  );
  const upload = await service.requestUpload(
    actor,
    "application/pdf",
    bytes.length,
    requestId,
  );
  objects.set("quarantine/" + upload.id, bytes);
  await runtime.query(
    "UPDATE governance.files SET status='SCANNING',scan_token=$2,scan_started_at=now()-interval '1 minute',scan_lease_until=now()-interval '1 second' WHERE id=$1",
    [upload.id, newId()],
  );
  assert.ok((await service.recoverStaleScans()) >= 1);
  assert.equal(await service.scan(upload.id, requestId), "QUARANTINED");
  const row = (
    await runtime.query(
      "SELECT scan_token,last_error_code,uploaded_by_account_id FROM governance.files WHERE id=$1",
      [upload.id],
    )
  ).rows[0];
  assert.equal(row.scan_token, null);
  assert.equal(row.uploaded_by_account_id, actor);
  assert.equal(row.last_error_code, "STORAGE_SCAN_UNAVAILABLE");
  const loseLease = files(runtime, store, {
    scan: async () => {
      await runtime.query(
        "UPDATE governance.files SET scan_lease_until=now()-interval '1 second' WHERE id=$1",
        [upload.id],
      );
      return "CLEAN";
    },
  });
  await assert.rejects(() => loseLease.scan(upload.id, requestId), {
    code: "FILE_LEASE_LOST",
  });
  await service.recoverStaleScans();
  assert.equal(
    (
      await runtime.query("SELECT status FROM governance.files WHERE id=$1", [
        upload.id,
      ])
    ).rows[0].status,
    "QUARANTINED",
  );
});
test("cleanup removes only technical orphan promotions; retained metadata and active content survive", async () => {
  const { store, objects } = fixture();
  const service = files(runtime, store, { scan: async () => "CLEAN" });
  const upload = await service.requestUpload(
    actor,
    "application/pdf",
    bytes.length,
    requestId,
  );
  objects.set("quarantine/" + upload.id, bytes);
  assert.equal(await service.scan(upload.id, requestId), "ACTIVE");
  const active = (
    await runtime.query("SELECT active_key FROM governance.files WHERE id=$1", [
      upload.id,
    ])
  ).rows[0].active_key;
  const orphan = "active/" + upload.id + "/" + newId();
  objects.set(orphan, bytes);
  await runtime.query(
    "INSERT INTO governance.file_promotions(object_key,file_id,scan_token,created_at) VALUES ($1,$2,$3,now()-interval '2 days')",
    [orphan, upload.id, newId()],
  );
  await runtime.query(
    "UPDATE governance.file_promotions SET created_at=now()-interval '2 days' WHERE file_id=$1",
    [upload.id],
  );
  await service.cleanupOrphanPromotions(requestId);
  assert.equal(objects.has(orphan), false);
  assert.equal(objects.has(active), true);
  assert.equal(
    (
      await runtime.query("SELECT status FROM governance.files WHERE id=$1", [
        upload.id,
      ])
    ).rows[0].status,
    "ACTIVE",
  );
  const pending = await service.requestUpload(
    actor,
    "application/pdf",
    bytes.length,
    requestId,
  );
  await runtime.query(
    "UPDATE governance.files SET updated_at=now()-interval '2 days' WHERE id=$1",
    [pending.id],
  );
  assert.ok(
    (await service.detectCleanupCandidates()).some(
      (row) => row.id === pending.id && row.classification === "EXPIRED_UPLOAD",
    ),
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { database } from "@motorbaldi/db";
import { assertRuntimeRole } from "@motorbaldi/db/runtime";
import { migrationDatabase } from "@motorbaldi/db/migration-pool";
import { migrate } from "@motorbaldi/db/migrate";
import {
  ensureTestRuntimeRole,
  testMigrationDatabaseUrl,
  testRuntimeDatabaseUrl,
  testConfig,
} from "@motorbaldi/testing";

const migrationOptions = {
  environment: "test" as const,
  initializeEnvironment: true,
  runtimeRole: "motorbaldi_runtime",
};

async function withDatabase(
  fn: (urls: { ownerUrl: string; runtimeUrl: string }) => Promise<void>,
) {
  const admin = await ensureTestRuntimeRole(
    migrationDatabase(testMigrationDatabaseUrl),
  );
  const name =
    "migration_test_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
  await admin.query("CREATE DATABASE " + name);
  const owner = new URL(testMigrationDatabaseUrl);
  owner.pathname = "/" + name;
  const runtime = new URL(testRuntimeDatabaseUrl);
  runtime.pathname = "/" + name;
  try {
    await fn({ ownerUrl: owner.toString(), runtimeUrl: runtime.toString() });
  } finally {
    await admin.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1",
      [name],
    );
    await admin.query("DROP DATABASE " + name);
    await admin.end();
  }
}

test("fresh DB initialization applies all migrations and runtime grants", async () => {
  await withDatabase(async ({ ownerUrl, runtimeUrl }) => {
    const owner = migrationDatabase(ownerUrl);
    try {
      await migrate(owner, undefined, migrationOptions);
      assert.equal(
        (await owner.query("SELECT count(*) FROM public.motorbaldi_migrations"))
          .rows[0].count,
        "6",
      );
      assert.equal(
        (
          await owner.query(
            "SELECT environment FROM governance.environment_metadata",
          )
        ).rows[0].environment,
        "test",
      );
    } finally {
      await owner.end();
    }
    const { pool: runtime } = database({
      ...testConfig(),
      DATABASE_URL: runtimeUrl,
    });
    try {
      await assertRuntimeRole(runtime);
      await runtime.query(
        "INSERT INTO governance.audit_events(id,action,resource_type,resource_id,request_id) VALUES ('01900000-0000-7000-8000-000000000101','grant','fixture','fixture','01900000-0000-7000-8000-000000000102')",
      );
      await assert.rejects(() =>
        runtime.query(
          "INSERT INTO public.motorbaldi_migrations(name,checksum) VALUES ('x','y')",
        ),
      );
    } finally {
      await runtime.end();
    }
  });
});

test("0002 to current upgrade preserves data", async () => {
  await withDatabase(async ({ ownerUrl }) => {
    const owner = migrationDatabase(ownerUrl);
    try {
      await migrate(owner, "0002_auth.sql", migrationOptions);
      await owner.query(
        "INSERT INTO governance.feature_flags(id,key,environment) VALUES ('01900000-0000-7000-8000-000000000201','upgrade','test')",
      );
      await migrate(owner, undefined, migrationOptions);
      await migrate(owner, undefined, migrationOptions);
      assert.equal(
        (await owner.query("SELECT key FROM governance.feature_flags")).rows[0]
          .key,
        "upgrade",
      );
    } finally {
      await owner.end();
    }
  });
});

test("0003 applied with zero metadata repairs only with explicit initialization", async () => {
  await withDatabase(async ({ ownerUrl }) => {
    const owner = migrationDatabase(ownerUrl);
    try {
      await migrate(owner, "0003_environment.sql", migrationOptions);
      await owner.query(
        "ALTER TABLE governance.environment_metadata DISABLE TRIGGER environment_metadata_immutable",
      );
      await owner.query("DELETE FROM governance.environment_metadata");
      await owner.query(
        "ALTER TABLE governance.environment_metadata ENABLE TRIGGER environment_metadata_immutable",
      );
      await assert.rejects(
        () =>
          migrate(owner, undefined, {
            ...migrationOptions,
            initializeEnvironment: false,
          }),
        /initialization required/i,
      );
      await migrate(owner, undefined, migrationOptions);
      assert.equal(
        (
          await owner.query(
            "SELECT environment FROM governance.environment_metadata",
          )
        ).rows[0].environment,
        "test",
      );
    } finally {
      await owner.end();
    }
  });
});

test("environment mismatch, attempted change and checksum mismatch fail closed", async () => {
  await withDatabase(async ({ ownerUrl }) => {
    const owner = migrationDatabase(ownerUrl);
    try {
      await migrate(owner, undefined, {
        environment: "staging",
        initializeEnvironment: true,
        runtimeRole: "motorbaldi_runtime",
      });
      await assert.rejects(
        () =>
          migrate(owner, undefined, {
            environment: "production",
            initializeEnvironment: true,
            runtimeRole: "motorbaldi_runtime",
          }),
        /environment mismatch/i,
      );
      await assert.rejects(
        () =>
          owner.query(
            "UPDATE governance.environment_metadata SET environment='test'",
          ),
        /Append-only|trigger/i,
      );
      await owner.query(
        "UPDATE public.motorbaldi_migrations SET checksum='tampered' WHERE name='0001_foundation.sql'",
      );
      await assert.rejects(
        () =>
          migrate(owner, undefined, {
            environment: "staging",
            initializeEnvironment: true,
            runtimeRole: "motorbaldi_runtime",
          }),
        /checksum mismatch/i,
      );
    } finally {
      await owner.end();
    }
  });
});

test("production metadata with production passes", async () => {
  await withDatabase(async ({ ownerUrl }) => {
    const owner = migrationDatabase(ownerUrl);
    try {
      await migrate(owner, undefined, {
        environment: "production",
        initializeEnvironment: true,
        runtimeRole: "motorbaldi_runtime",
      });
      await migrate(owner, undefined, {
        environment: "production",
        initializeEnvironment: false,
        runtimeRole: "motorbaldi_runtime",
      });
    } finally {
      await owner.end();
    }
  });
});

test("migration without initialize on unknown DB fails", async () => {
  await withDatabase(async ({ ownerUrl }) => {
    const owner = migrationDatabase(ownerUrl);
    try {
      await assert.rejects(
        () =>
          migrate(owner, undefined, {
            environment: "test",
            initializeEnvironment: false,
            runtimeRole: "motorbaldi_runtime",
          }),
        /initialization required/i,
      );
    } finally {
      await owner.end();
    }
  });
});

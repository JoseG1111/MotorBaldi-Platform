import { migrationDatabase } from "@motorbaldi/db/migration-pool";
import { runCanonicalMigrations } from "@motorbaldi/db/migrate";
import { S3Client, CreateBucketCommand } from "@aws-sdk/client-s3";
import { config } from "@motorbaldi/config";
const c = config();
if (c.APP_ENV !== "local") throw new Error("Local setup only");
if (!process.env.MIGRATION_DATABASE_URL)
  throw new Error("MIGRATION_DATABASE_URL required");
const pool = migrationDatabase(process.env.MIGRATION_DATABASE_URL);
try {
  await runCanonicalMigrations(pool, {
    environment: "local",
    initializeEnvironment: true,
    runtimeRole: process.env.RUNTIME_DATABASE_ROLE ?? "motorbaldi_runtime",
  });
} finally {
  await pool.end();
}
const client = new S3Client({
  endpoint: c.STORAGE_ENDPOINT,
  region: c.STORAGE_REGION,
  forcePathStyle: true,
  credentials: {
    accessKeyId: c.STORAGE_ACCESS_KEY,
    secretAccessKey: c.STORAGE_SECRET_KEY,
  },
});
try {
  await client.send(new CreateBucketCommand({ Bucket: c.STORAGE_BUCKET }));
} catch (error) {
  if (
    !(error instanceof Error) ||
    !["BucketAlreadyOwnedByYou", "BucketAlreadyExists"].includes(error.name)
  )
    throw error;
} finally {
  client.destroy();
}
console.log(
  "Local migrations, runtime grants and private bucket ready. No business seed or accounts created.",
);

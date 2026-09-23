import { test } from "node:test";
import assert from "node:assert/strict";
import {
  S3Client,
  CreateBucketCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { s3Storage } from "@motorbaldi/storage";
import { testConfig } from "@motorbaldi/testing";
import { newId } from "@motorbaldi/shared";
test("S3 integration: signed PUT/GET, anonymous denied, private immutable promotion", async () => {
  const c = testConfig();
  const storage = s3Storage(c);
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
  }
  const key = "quarantine/" + newId();
  const activeKey = "active/" + newId();
  try {
    await storage.health();
    const bytes = Buffer.from("%PDF-1.7\nprivate");
    const upload = await storage.signUpload(
      key,
      "application/pdf",
      bytes.length,
    );
    assert.equal(new URL(upload).searchParams.get("X-Amz-Expires"), "120");
    const put = await fetch(upload, {
      method: "PUT",
      headers: {
        "content-type": "application/pdf",
        "content-length": String(bytes.length),
      },
      body: bytes,
    });
    assert.equal(put.status, 200, await put.text());
    assert.deepEqual(Buffer.from(await storage.read(key)), bytes);
    await storage.put(activeKey, bytes, "application/pdf");
    const download = await storage.signRead(activeKey);
    assert.equal(new URL(download).searchParams.get("X-Amz-Expires"), "60");
    assert.equal(await (await fetch(download)).text(), bytes.toString());
    const anonymous = new URL(download);
    anonymous.search = "";
    assert.equal((await fetch(anonymous)).status, 403);
  } finally {
    for (const Key of [key, activeKey])
      await client.send(
        new DeleteObjectCommand({ Bucket: c.STORAGE_BUCKET, Key }),
      );
    client.destroy();
  }
});

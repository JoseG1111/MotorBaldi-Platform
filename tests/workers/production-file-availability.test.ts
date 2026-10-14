import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import type { ApiBindings } from "@motorbaldi/config";
import { files, unavailableScanner } from "@motorbaldi/storage";
import apiWorker from "../../apps/api/src/index.js";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const account = "018f0000-0000-7000-8000-000000000041",
  person = "018f0000-0000-7000-8000-000000000141",
  historicalFile = "018f0000-0000-7000-8000-000000000241";
const password = "synthetic-production-simulation-password-123456";
const production: ApiBindings = {
  ...(env as unknown as ApiBindings),
  ENVIRONMENT: "production",
  AUTH_BASE_URL: "https://api.test",
  CORS_ORIGINS: "https://portal.test",
  EMAIL_PROVIDER: "UNCONFIGURED",
};
let cookie = "",
  client = 41;
function request(
  path: string,
  init: RequestInit = {},
  bindings = production,
  authenticated = true,
) {
  const headers = new Headers(init.headers);
  headers.set("origin", "https://portal.test");
  headers.set("cf-connecting-ip", "203.0.113." + client++);
  if (authenticated && cookie) headers.set("cookie", cookie);
  return apiWorker.fetch(
    new Request("https://api.test/api/v1" + path, { ...init, headers }),
    bindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
}
function mutationSpy() {
  const mutations: string[] = [];
  const guarded = new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => {
          if (
            /^\s*(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER)\b/i.test(
              query,
            )
          )
            mutations.push(query);
          return target.prepare(query);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: guarded, mutations };
}
async function counts() {
  return db
    .prepare(
      "SELECT (SELECT count(*) FROM storage_files) files,(SELECT count(*) FROM storage_file_promotions) promotions,(SELECT count(*) FROM governance_audit_events) audit,(SELECT count(*) FROM integration_outbox_events) outbox",
    )
    .first();
}
beforeAll(async () => {
  for (const sql of [foundation, phase1, closeout])
    await db.exec(sql.replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'production')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,'Synthetic Production Simulation','production-simulation@example.test',1)",
    )
    .bind(account)
    .run();
  await db
    .prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES('production-simulation-credential',?,?,'credential',?)",
    )
    .bind(account, account, await hashPassword(password))
    .run();
  await db
    .prepare(
      "INSERT INTO iam_people(id,status,given_name,family_name) VALUES(?,'ACTIVE','Synthetic','Production Simulation')",
    )
    .bind(person)
    .run();
  await db
    .prepare(
      "INSERT INTO iam_accounts(id,person_id,status) VALUES(?,?,'ACTIVE')",
    )
    .bind(account, person)
    .run();
  await db
    .prepare(
      "INSERT INTO professional_mechanic_profiles(person_id,bio) VALUES(?,'Synthetic no-file profile')",
    )
    .bind(person)
    .run();
  // Retained private metadata fixture only: no scanner success or ACTIVE promotion is fabricated.
  await db
    .prepare(
      "INSERT INTO storage_files(id,uploaded_by_account_id,object_key,declared_mime,size_bytes,status,request_id) VALUES(?,?,'quarantine/synthetic-retained','image/png',4,'QUARANTINED','synthetic-retained-metadata')",
    )
    .bind(historicalFile, account)
    .run();
  const signedIn = await request(
    "/auth/sign-in/email",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "production-simulation@example.test",
        password,
      }),
    },
    production,
    false,
  );
  expect(signedIn.status).toBe(200);
  cookie = signedIn.headers
    .getSetCookie()
    .map((header) => header.split(";", 1)[0])
    .join("; ");
});

describe("Production uploads require a separate real scanner release", () => {
  it("rejects authorized uploads before request-body, R2, DB or outbox mutations", async () => {
    const state = mutationSpy(),
      put = vi.fn<typeof production.PRIVATE_BUCKET.put>();
    const bucket = new Proxy(production.PRIVATE_BUCKET, {
      get(target, property) {
        if (property === "put") return put;
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const bindings = { ...production, DB: state.db, PRIVATE_BUCKET: bucket };
    const before = await counts();
    for (const headers of [
      { "content-type": "image/png", "x-file-size": "4" },
      { "content-type": "application/octet-stream", "x-file-size": "invalid" },
    ]) {
      const response = await request(
        "/me/evidence-files",
        { method: "POST", headers, body: new Uint8Array([137, 80, 78, 71]) },
        bindings,
      );
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "FILE_UPLOAD_UNAVAILABLE",
      });
    }
    expect(state.mutations).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
  });
  it("retains private authorized metadata and no-file credential workflows while denying anonymous upload/read", async () => {
    const list = await request("/me/evidence-files");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([
      expect.objectContaining({ id: historicalFile, status: "QUARANTINED" }),
    ]);
    const detail = await request("/me/evidence-files/" + historicalFile);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      id: historicalFile,
      status: "QUARANTINED",
    });
    expect(
      (
        await request(
          "/me/evidence-files",
          {
            method: "POST",
            headers: { "content-type": "image/png", "x-file-size": "4" },
            body: new Uint8Array([137, 80, 78, 71]),
          },
          production,
          false,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await request(
          "/me/evidence-files/" + historicalFile,
          {},
          production,
          false,
        )
      ).status,
    ).toBe(401);
    const credential = await request("/me/credentials", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        credentialType: "TRAINING",
        issuer: "Synthetic No-file Institution",
      }),
    });
    expect(credential.status).toBe(201);
    const submitted = (await credential.json()) as { credentialId: string };
    expect(
      await db
        .prepare(
          "SELECT evidence_file_id,status FROM professional_credentials WHERE id=?",
        )
        .bind(submitted.credentialId)
        .first(),
    ).toEqual({ evidence_file_id: null, status: "PENDING" });
    expect((await request("/me/credentials")).status).toBe(200);
  });
  it("enforces the storage availability contract before either upload mutation and keeps download authorization checks", async () => {
    const state = mutationSpy(),
      put = vi.fn<typeof production.PRIVATE_BUCKET.put>(),
      get = vi.fn<typeof production.PRIVATE_BUCKET.get>();
    const bucket = { put, get } as unknown as R2Bucket;
    const service = files(state.db, bucket, {
      scanner: unavailableScanner,
      uploadsEnabled: false,
      authorizeDownload: async () => false,
    });
    const before = await counts();
    await expect(
      service.requestUpload(
        account,
        "image/png",
        4,
        "synthetic-disabled-upload",
      ),
    ).rejects.toMatchObject({ status: 503, code: "FILE_UPLOAD_UNAVAILABLE" });
    await expect(
      service.putQuarantineObject(
        historicalFile,
        new Uint8Array(4),
        "image/png",
      ),
    ).rejects.toMatchObject({ status: 503, code: "FILE_UPLOAD_UNAVAILABLE" });
    await expect(
      service.download(historicalFile, account),
    ).rejects.toMatchObject({ status: 404, code: "FILE_NOT_FOUND" });
    expect(state.mutations).toEqual([]);
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(await counts()).toEqual(before);
  });
});

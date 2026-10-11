import { DatabaseSync } from "node:sqlite";
import {
  provisionCredential,
  rotateCredential,
  revokeCredential,
  buildLifecycleSql,
} from "../../scripts/development/automation-key.mjs";
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalRequest,
  DEVELOPMENT_ADMIN_ORIGIN,
  DEVELOPMENT_API_ORIGIN,
  getAutomationFetch,
  signRequest,
  validateCredential,
} from "../../scripts/development/automation-client.mjs";
const credential = {
  keyId: "11111111-1111-4111-8111-111111111111",
  version: 1,
  secret: Buffer.alloc(32, 7).toString("base64url"),
};
const nonce = "22222222-2222-4222-8222-222222222222";
describe("Development automation client", () => {
  it("signs exact URL, method and bytes using UTF8 secret", () => {
    const url = `${DEVELOPMENT_API_ORIGIN}/api/v1/example?b=2&a=%2F`;
    const body = Buffer.from("á");
    const canonical = canonicalRequest(1790000000000, nonce, "post", url, body);
    expect(canonical).toContain("\nPOST\n/api/v1/example?b=2&a=%2F\n");
    expect(
      signRequest(credential, 1790000000000, nonce, "post", url, body),
    ).toBe(
      `MotorBaldi-Development ${credential.keyId}:1:1790000000000:${nonce}:${createHmac("sha256", credential.secret).update(canonical).digest("hex")}`,
    );
    expect(() =>
      validateCredential({ ...credential, secret: "bad" }),
    ).toThrow();
    expect(() => signRequest(credential, 1, nonce, "GET", url, body)).toThrow();
  });
  it("rewrites marked requests, preserves idempotency and uses fresh nonces on retries", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    let count = 0;
    const run = getAutomationFetch({
      credential,
      now: () => 1790000000000,
      nonce: () => `${++count}2222222-2222-4222-8222-222222222222`,
      fetch: async (url: string, init: RequestInit) => {
        calls.push({ url, headers: new Headers(init.headers) });
        return new Response("ok");
      },
    });
    for (let i = 0; i < 2; i++)
      await run(`${DEVELOPMENT_ADMIN_ORIGIN}/api/v1/example?q=1`, {
        method: "POST",
        body: "same",
        headers: {
          "x-motorbaldi-automation-intent": "true",
          "idempotency-key": "same",
        },
      });
    expect(calls[0]?.url).toBe(`${DEVELOPMENT_API_ORIGIN}/api/v1/example?q=1`);
    expect(calls[0]?.headers.get("origin")).toBe(DEVELOPMENT_ADMIN_ORIGIN);
    expect(calls[0]?.headers.has("x-motorbaldi-automation-intent")).toBe(false);
    expect(calls[0]?.headers.get("idempotency-key")).toBe("same");
    expect(calls[0]?.headers.get("authorization")).not.toBe(
      calls[1]?.headers.get("authorization"),
    );
  });
  it("fails closed on hosts, assets, cookies, and sanitizes transport errors", async () => {
    const run = getAutomationFetch({
      credential,
      fetch: async () => {
        throw new Error(credential.secret);
      },
    });
    for (const url of [
      "https://example.test/api/v1/a",
      `${DEVELOPMENT_ADMIN_ORIGIN}/asset.js`,
      `${DEVELOPMENT_API_ORIGIN}/api/v1/a`,
    ])
      await expect(
        run(url, { headers: { "x-motorbaldi-automation-intent": "true" } }),
      ).rejects.toThrow("prohibited");
    await expect(
      run(`${DEVELOPMENT_ADMIN_ORIGIN}/api/v1/a`, {
        headers: {
          "x-motorbaldi-automation-intent": "true",
          cookie: "session=x",
        },
      }),
    ).rejects.toThrow("prohibited");
    await expect(
      run(`${DEVELOPMENT_ADMIN_ORIGIN}/api/v1/a`, {
        headers: { "x-motorbaldi-automation-intent": "true" },
      }),
    ).rejects.toThrow("Development automation request failed.");
  });
  it("does not sign anonymous requests and strips intent markers", async () => {
    let captured: Request | undefined;
    const run = getAutomationFetch({
      credential,
      fetch: async (request: Request) => {
        captured = request;
        return new Response();
      },
    });
    await run(`${DEVELOPMENT_ADMIN_ORIGIN}/asset.js`, {
      headers: { "x-motorbaldi-automation-intent": "false" },
    });
    expect(captured?.headers.has("authorization")).toBe(false);
    expect(captured?.headers.has("x-motorbaldi-automation-intent")).toBe(false);
  });
  it("rejects environment credentials without exposing their value", async () => {
    process.env.DEVELOPMENT_AUTOMATION_CREDENTIAL = credential.secret;
    try {
      await expect(
        getAutomationFetch({ credential })(
          `${DEVELOPMENT_ADMIN_ORIGIN}/api/v1/a`,
          { headers: { "x-motorbaldi-automation-intent": "true" } },
        ),
      ).rejects.toThrow("Environment credentials are prohibited.");
    } finally {
      delete process.env.DEVELOPMENT_AUTOMATION_CREDENTIAL;
    }
  });
  it("stores before installing and retries the same credential without leaking failures", async () => {
    const operations: string[] = [];
    let stored: string | undefined;
    const bridge = async (operation: string, input?: string) => {
      operations.push(operation);
      if (operation === "lookup-optional") return stored ?? "null";
      stored = input;
      return "";
    };
    const failing = async () => {
      operations.push("install");
      throw new Error(credential.secret);
    };
    await expect(
      provisionCredential(credential, {
        secretService: bridge,
        command: failing,
      }),
    ).rejects.toThrow("Development automation provisioning failed.");
    expect(operations).toEqual(["lookup-optional", "store", "install"]);
    const first = stored;
    await provisionCredential(credential, {
      secretService: bridge,
      command: async (_args, input) => {
        expect(input).toBe(first);
        return "ignored provider output";
      },
    });
    expect(stored).toBe(first);
    const before = stored;
    await expect(
      provisionCredential(
        { ...credential, version: 2 },
        { secretService: bridge, command: failing },
      ),
    ).rejects.toThrow("Development automation provisioning failed.");
    expect(stored).toBe(before);
  });
  it("recovers rotation after OS-first DB failure and retries Cloudflare with the exact new secret", async () => {
    const metadata = {
      ...credential,
      accountId: nonce,
      status: "ACTIVE" as const,
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    let stored = JSON.stringify(credential);
    const steps: string[] = [];
    const bridge = async (operation: string, input?: string) => {
      steps.push(operation);
      if (operation.startsWith("lookup")) return stored;
      stored = input!;
      return "";
    };
    await expect(
      rotateCredential(metadata, {
        secretService: bridge,
        command: async () => {
          steps.push("db");
          throw new Error(credential.secret);
        },
      }),
    ).rejects.toThrow("Development automation provisioning failed.");
    expect(steps).toEqual(["lookup", "store", "db"]);
    const next = stored;
    expect(JSON.parse(next).version).toBe(2);
    const command = async (args: string[], input?: string) => {
      if (args.includes("d1")) {
        steps.push("db");
        return JSON.stringify([{ success: true, results: [{ changed: 1 }] }]);
      }
      steps.push("cloudflare");
      expect(input).toBe(next);
      throw new Error(credential.secret);
    };
    await expect(
      rotateCredential(metadata, { secretService: bridge, command }),
    ).rejects.toThrow("Development automation provisioning failed.");
    expect(stored).toBe(next);
    await provisionCredential(
      { keyId: credential.keyId, version: 2 },
      {
        secretService: bridge,
        command: async (_args, input) => {
          expect(input).toBe(next);
          return "";
        },
      },
    );
    await expect(
      rotateCredential(
        { ...metadata, version: 4 },
        { secretService: bridge, command },
      ),
    ).rejects.toThrow("Development automation provisioning failed.");
    expect(stored).toBe(next);
  });
  it("uses guarded lifecycle CAS and records only the successful version or revocation", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(
      "CREATE TABLE governance_environment_metadata(singleton INTEGER,environment TEXT); INSERT INTO governance_environment_metadata VALUES(1,'development'); CREATE TABLE development_automation_identities(name TEXT,key_id TEXT,account_id TEXT,credential_version INTEGER,status TEXT,expires_at TEXT); CREATE TABLE governance_audit_events(id TEXT,actor_id TEXT,action TEXT,resource_type TEXT,resource_id TEXT,request_id TEXT,reason TEXT); CREATE TABLE governance_security_events(id TEXT,actor_id TEXT,code TEXT,request_id TEXT);",
    );
    const metadata = {
      ...credential,
      accountId: nonce,
      status: "ACTIVE" as const,
      expiresAt: "2027-01-01T00:00:00.000Z",
    };
    db.prepare(
      "INSERT INTO development_automation_identities VALUES('development-validation',?,?,1,'ACTIVE',?)",
    ).run(metadata.keyId, metadata.accountId, metadata.expiresAt);
    db.exec(buildLifecycleSql(metadata, "rotate"));
    expect(
      db
        .prepare(
          "SELECT credential_version AS version FROM development_automation_identities",
        )
        .get()?.version,
    ).toBe(2);
    db.exec(buildLifecycleSql(metadata, "rotate"));
    expect(
      db.prepare("SELECT COUNT(*) AS total FROM governance_audit_events").get()
        ?.total,
    ).toBe(1);
    const current = db
      .prepare(
        "SELECT credential_version AS version,expires_at AS expiresAt FROM development_automation_identities",
      )
      .get() as { version: number; expiresAt: string };
    db.exec(buildLifecycleSql({ ...metadata, ...current }, "revoke"));
    expect(
      db.prepare("SELECT status FROM development_automation_identities").get()
        ?.status,
    ).toBe("REVOKED");
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS total FROM governance_security_events WHERE code='DEVELOPMENT_AUTOMATION_REVOKED'",
        )
        .get()?.total,
    ).toBe(1);
    await expect(
      revokeCredential(metadata, {
        command: async () =>
          JSON.stringify([{ success: true, results: [{ changed: 0 }] }]),
      }),
    ).rejects.toThrow("Development automation provisioning failed.");
    expect(
      JSON.stringify(
        db.prepare("SELECT * FROM governance_audit_events").all(),
      ).includes(credential.secret),
    ).toBe(false);
    db.close();
  });
});

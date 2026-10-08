import { beforeAll, describe, expect, it } from "vitest";
import { env, exports as workerExports } from "cloudflare:workers";
import { hashPassword } from "better-auth/crypto";
import type { ApiBindings } from "@motorbaldi/config";
import foundation from "../../migrations/0001_foundation.sql?raw";
import phase1 from "../../migrations/0002_phase1.sql?raw";
import closeout from "../../migrations/0003_phase1_closeout.sql?raw";

const db = (env as unknown as ApiBindings).DB;
const worker = (
  workerExports as unknown as { default: ExportedHandler<ApiBindings> }
).default;
const accountId = "018f0000-0000-7000-8000-000000000071";
const password = "local-mfa-password-123";
const cookies = new Map<string, string>();

async function request(path: string, body?: object) {
  const response = await worker.fetch!(
    new Request(`https://api.test/api/v1${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        origin: "https://portal.test",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(cookies.size
          ? {
              cookie: [...cookies]
                .map(([name, value]) => `${name}=${value}`)
                .join("; "),
            }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }) as never,
    env as unknown as ApiBindings,
    {
      waitUntil() {},
      passThroughOnException() {},
      props: {},
    } as unknown as ExecutionContext,
  );
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";", 1)[0]!;
    const separator = pair.indexOf("=");
    const name = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (!value || /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(header))
      cookies.delete(name);
    else cookies.set(name, value);
  }
  return response;
}

async function totp(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of secret.toUpperCase().replaceAll("=", "")) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 255);
    }
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(bytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = new ArrayBuffer(8);
  new DataView(counter).setBigUint64(0, BigInt(Math.floor(Date.now() / 30000)));
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, counter));
  const offset = digest[digest.length - 1]! & 15;
  const code =
    (((digest[offset]! & 127) << 24) |
      (digest[offset + 1]! << 16) |
      (digest[offset + 2]! << 8) |
      digest[offset + 3]!) %
    1_000_000;
  return String(code).padStart(6, "0");
}

beforeAll(async () => {
  await db.exec(foundation.replace(/\n/g, " "));
  await db.exec(phase1.replace(/\n/g, " "));
  await db.exec(closeout.replace(/\n/g, " "));
  await db
    .prepare(
      "INSERT INTO governance_environment_metadata(singleton,environment) VALUES(1,'local')",
    )
    .run();
  await db
    .prepare(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES(?,?,?,1)",
    )
    .bind(accountId, "MFA Test", "mfa@example.test")
    .run();
  await db
    .prepare(
      "INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES(?,?,?,'credential',?)",
    )
    .bind("mfa-credential", accountId, accountId, await hashPassword(password))
    .run();
});

describe("password and TOTP transition", () => {
  it("creates a fresh assured session and authorizes a platform administrator", async () => {
    const firstSignIn = await request("/auth/sign-in/email", {
      email: "mfa@example.test",
      password,
    });
    expect(firstSignIn.status).toBe(200);
    expect((await firstSignIn.json()) as object).not.toHaveProperty(
      "twoFactorRedirect",
    );

    const enrollment = await request("/auth/two-factor/enable", {
      password,
      method: "totp",
    });
    expect(enrollment.status).toBe(200);
    const { totpURI } = (await enrollment.json()) as { totpURI: string };
    const secret = new URL(totpURI).searchParams.get("secret");
    expect(secret).toBeTruthy();
    const confirmed = await request("/auth/two-factor/verify-totp", {
      code: await totp(secret!),
      trustDevice: false,
    });
    expect(confirmed.status).toBe(200);

    expect((await request("/auth/sign-out", {})).status).toBe(200);
    const signIn = await request("/auth/sign-in/email", {
      email: "mfa@example.test",
      password,
    });
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    const verified = await request("/auth/two-factor/verify-totp", {
      code: await totp(secret!),
      trustDevice: false,
    });
    expect(verified.status).toBe(200);
    expect(verified.headers.getSetCookie().length).toBeGreaterThanOrEqual(2);

    const session = await request("/auth/get-session");
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ user: { id: accountId } });
    const principal = await request("/principal");
    expect(principal.status).toBe(200);
    const identity = (await principal.json()) as {
      accountId: string;
      personId: string;
      mfaEnabled: boolean;
    };
    expect(identity).toMatchObject({ accountId, mfaEnabled: true });
    const reconciled = await db
      .prepare("SELECT person_id FROM iam_accounts WHERE id=?")
      .bind(accountId)
      .first<{ person_id: string }>();
    expect(reconciled?.person_id).toBe(identity.personId);

    await db
      .prepare(
        "INSERT INTO platform_person_roles(person_id,role_id) VALUES(?,'platform-superadmin')",
      )
      .bind(identity.personId)
      .run();
    const admin = await request("/admin/access");
    expect(admin.status).toBe(200);
    expect(await admin.json()).toMatchObject({ mfaEnabled: true });
  }, 20_000);
});

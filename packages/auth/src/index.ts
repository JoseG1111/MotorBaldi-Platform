import { betterAuth, type BetterAuthOptions } from "better-auth";
import { openAPI, twoFactor } from "better-auth/plugins";
import type { ApiBindings, ApiConfig } from "@motorbaldi/config";
import type { Principal } from "@motorbaldi/contracts";
import { newId } from "@motorbaldi/shared";
import { securityEvent } from "@motorbaldi/db/audit";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";
import {
  createAuthEmailTransport,
  type AuthEmailKind,
} from "@motorbaldi/messaging/auth-email";

/** Trusted API signup acceptance, captured only for the current creation request. */
export interface SignupConsent {
  termsVersion: string;
  privacyVersion: string;
}

function remoteAuthEmailTransport(env: ApiBindings, c: ApiConfig) {
  return c.emailProvider === "RESEND"
    ? createAuthEmailTransport({
        environment: c.environment,
        enabled: env.AUTH_EMAIL_DELIVERY_ENABLED === "true",
        testRecipientHashes: env.AUTH_EMAIL_TEST_RECIPIENT_SHA256,
        apiKey: env.RESEND_API_KEY,
        from: env.RESEND_FROM,
        fromVerified: env.RESEND_DOMAIN_VERIFIED === "true",
        authBaseUrl: c.authBaseUrl,
        trustedOrigins: c.corsOrigins,
      })
    : null;
}

/** Configuration readiness only; does not claim an email has been delivered. */
export function authEmailCapability(env: ApiBindings, c: ApiConfig): boolean {
  return (
    (c.environment === "local" && c.emailProvider === "DEVELOPMENT_SINK") ||
    remoteAuthEmailTransport(env, c) !== null
  );
}

async function sendAuthEmail(
  env: ApiBindings,
  c: ApiConfig,
  requestId: string,
  kind: AuthEmailKind,
  user: { id: string; email: string; emailVerified?: boolean },
  url: string,
  token: string,
) {
  if (c.environment === "local" && c.emailProvider === "DEVELOPMENT_SINK") {
    await env.DB.prepare(
      "INSERT INTO integration_local_email_sink(id,auth_user_id,kind,action_url) VALUES(?,?,?,?)",
    )
      .bind(newId(), user.id, kind, url)
      .run();
    return;
  }
  const transport = remoteAuthEmailTransport(env, c);
  if (!transport) throw new Error("EMAIL_PROVIDER_UNCONFIGURED");
  if (kind === "VERIFY_EMAIL" && user.emailVerified !== true) {
    const eligible = await env.DB.prepare(
      "SELECT 1 FROM iam_signup_consents c JOIN auth_credentials a ON a.user_id=c.auth_user_id WHERE c.auth_user_id=? AND a.provider_id='credential' AND a.password IS NOT NULL",
    )
      .bind(user.id)
      .first();
    if (!eligible) {
      await securityEvent(env.DB, "AUTH_EMAIL_SUBMISSION_FAILED", requestId);
      throw new Error("AUTH_EMAIL_SUBMISSION_FAILED");
    }
  }
  const receipt = await transport.send({
    kind,
    recipient: user.email,
    url,
    token,
    idempotencyKey: newId(),
    signal: AbortSignal.timeout(10_000),
  });
  // Never put recipients, links, credentials, tokens or provider response bodies in errors/audit.
  if (receipt.status !== "ACCEPTED") {
    await securityEvent(env.DB, "AUTH_EMAIL_SUBMISSION_FAILED", requestId);
    throw new Error("AUTH_EMAIL_SUBMISSION_FAILED");
  }
}

export const allowedAuthPaths = new Set([
  "/sign-up/email",
  "/verify-email",
  "/send-verification-email",
  "/request-password-reset",
  "/reset-password",
  "/sign-in/email",
  "/get-session",
  "/sign-out",
  "/list-sessions",
  "/revoke-session",
  "/revoke-other-sessions",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/enable",
]);

export async function assessAuthenticatedSession(
  db: D1Database,
  accountId: string,
  sessionId: string,
): Promise<{ mfaEnabled: boolean } | null> {
  if (
    (await db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='development_automation_identities'",
      )
      .first()) &&
    (await db
      .prepare(
        "SELECT 1 FROM development_automation_identities WHERE account_id=?",
      )
      .bind(accountId)
      .first())
  )
    return null;
  const row = await db
    .prepare(
      "SELECT u.two_factor_enabled,EXISTS(SELECT 1 FROM auth_two_factors f WHERE f.user_id=u.id AND f.verified=1) AS verified_factor,s.created_at>=u.updated_at AS recent_session FROM auth_users u JOIN auth_sessions s ON s.user_id=u.id WHERE u.id=? AND s.id=? AND u.email_verified=1 AND s.expires_at>?",
    )
    .bind(accountId, sessionId, new Date().toISOString())
    .first<{
      two_factor_enabled: number;
      verified_factor: number;
      recent_session: number;
    }>();
  if (!row) return null;
  return {
    mfaEnabled:
      row.two_factor_enabled === 1 &&
      row.verified_factor === 1 &&
      row.recent_session === 1,
  };
}

export function authentication(
  env: ApiBindings,
  c: ApiConfig,
  requestId: string,
  allowSignUp = false,
  signupConsent?: SignupConsent,
) {
  const options = authOptions(env, c, requestId, allowSignUp, signupConsent);
  const auth = betterAuth(options);

  return {
    auth,
    async principal(headers: Headers): Promise<Principal | null> {
      const session = await auth.api.getSession({ headers });
      if (!session || !session.user.emailVerified) return null;
      const assurance = await assessAuthenticatedSession(
        env.DB,
        session.user.id,
        session.session.id,
      );
      if (!assurance) return null;
      const account = await ensureMotorBaldiAccount(
        env.DB,
        session.user.id,
        requestId,
      );
      return {
        accountId: session.user.id,
        personId: account.personId,
        mfaEnabled: assurance.mfaEnabled,
      };
    },
  };
}

export function authOptions(
  env: ApiBindings,
  c: ApiConfig,
  requestId: string,
  allowSignUp = false,
  signupConsent?: SignupConsent,
): BetterAuthOptions {
  let signupUserId: string | null = null;
  return {
    appName: "MotorBaldi",
    baseURL: c.authBaseUrl,
    basePath: "/api/v1/auth",
    secret: c.authSecret,
    secrets: [...c.authSecrets],
    database: env.DB,
    trustedOrigins: [...c.corsOrigins],
    user: {
      modelName: "auth_users",
      additionalFields: {
        twoFactorEnabled: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
          fieldName: "two_factor_enabled",
        },
      },
      fields: {
        emailVerified: "email_verified",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    session: {
      modelName: "auth_sessions",
      expiresIn: 60 * 60 * 24,
      cookieCache: { enabled: false },
      fields: {
        userId: "user_id",
        expiresAt: "expires_at",
        ipAddress: "ip_address",
        userAgent: "user_agent",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    account: {
      modelName: "auth_credentials",
      fields: {
        userId: "user_id",
        accountId: "account_id",
        providerId: "provider_id",
        accessToken: "access_token",
        refreshToken: "refresh_token",
        idToken: "id_token",
        accessTokenExpiresAt: "access_token_expires_at",
        refreshTokenExpiresAt: "refresh_token_expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    verification: {
      modelName: "auth_verifications",
      fields: {
        expiresAt: "expires_at",
        createdAt: "created_at",
        updatedAt: "updated_at",
      },
    },
    emailAndPassword: {
      enabled: true,
      disableSignUp: !allowSignUp || !authEmailCapability(env, c),
      requireEmailVerification: true,
      minPasswordLength: 12,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url, token }) =>
        sendAuthEmail(env, c, requestId, "PASSWORD_RESET", user, url, token),
    },
    emailVerification: {
      expiresIn: 60 * 60,
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url, token }) => {
        if (signupConsent && signupUserId === user.id) {
          try {
            await env.DB.prepare(
              "INSERT INTO iam_signup_consents(auth_user_id,terms_version,privacy_version,request_id) VALUES(?,?,?,?)",
            )
              .bind(
                user.id,
                signupConsent.termsVersion,
                signupConsent.privacyVersion,
                requestId,
              )
              .run();
          } catch {
            await securityEvent(
              env.DB,
              "AUTH_SIGNUP_CONSENT_FAILED",
              requestId,
            );
            throw new Error("AUTH_SIGNUP_CONSENT_FAILED");
          }
        }
        await sendAuthEmail(
          env,
          c,
          requestId,
          "VERIFY_EMAIL",
          user,
          url,
          token,
        );
      },
    },
    advanced: {
      useSecureCookies: c.environment !== "local",
      database: { generateId: () => newId() },
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", path: "/" },
    },
    plugins: [
      openAPI({ disableDefaultReference: true }),
      twoFactor({
        issuer: "MotorBaldi",
        schema: {
          twoFactor: {
            modelName: "auth_two_factors",
            fields: {
              userId: "user_id",
              backupCodes: "backup_codes",
              failedVerificationCount: "failed_verification_count",
              lockedUntil: "locked_until",
            },
          },
        },
      }),
    ],
    logger: { disabled: true },
    databaseHooks: {
      ...(signupConsent
        ? {
            user: {
              create: {
                before: async (user) => {
                  signupUserId = newId();
                  return { data: { ...user, id: signupUserId } };
                },
              },
            },
          }
        : {}),
      session: {
        create: {
          after: async (session) =>
            securityEvent(env.DB, "SESSION_CREATED", requestId, session.userId),
        },
        delete: {
          after: async (session) =>
            securityEvent(env.DB, "SESSION_REVOKED", requestId, session.userId),
        },
      },
    },
  };
}

export * from "./development-automation.js";

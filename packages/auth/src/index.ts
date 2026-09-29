import { betterAuth, type BetterAuthOptions } from "better-auth";
import { openAPI, twoFactor } from "better-auth/plugins";
import type { ApiBindings, ApiConfig } from "@motorbaldi/config";
import type { Principal } from "@motorbaldi/contracts";
import { newId } from "@motorbaldi/shared";
import { securityEvent } from "@motorbaldi/db/audit";
import { ensureMotorBaldiAccount } from "@motorbaldi/identity";

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
) {
  const options = authOptions(env, c, requestId, allowSignUp);
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
): BetterAuthOptions {
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
      disableSignUp: !allowSignUp,
      requireEmailVerification: true,
      minPasswordLength: 12,
      sendResetPassword: async ({ user, url }) => {
        if (c.environment !== "local" || c.emailProvider !== "DEVELOPMENT_SINK")
          throw new Error("EMAIL_PROVIDER_UNCONFIGURED");
        await env.DB.prepare(
          "INSERT INTO integration_local_email_sink(id,auth_user_id,kind,action_url) VALUES(?,?,'PASSWORD_RESET',?)",
        )
          .bind(newId(), user.id, url)
          .run();
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        if (c.environment !== "local" || c.emailProvider !== "DEVELOPMENT_SINK")
          throw new Error("EMAIL_PROVIDER_UNCONFIGURED");
        await env.DB.prepare(
          "INSERT INTO integration_local_email_sink(id,auth_user_id,kind,action_url) VALUES(?,?,'VERIFY_EMAIL',?)",
        )
          .bind(newId(), user.id, url)
          .run();
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

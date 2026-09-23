import { betterAuth } from "better-auth";
import { openAPI, twoFactor } from "better-auth/plugins";
import type { PlatformBindings, RuntimeConfig } from "@motorbaldi/config";
import type { Principal } from "@motorbaldi/contracts";
import { newId } from "@motorbaldi/shared";
import { securityEvent } from "@motorbaldi/db/audit";

export const allowedAuthPaths = new Set([
  "/sign-in/email",
  "/get-session",
  "/sign-out",
  "/list-sessions",
  "/revoke-session",
  "/revoke-other-sessions",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
]);

export function authentication(
  env: PlatformBindings,
  c: RuntimeConfig,
  requestId: string,
) {
  const auth = betterAuth({
    appName: "MotorBaldi",
    baseURL: c.authBaseUrl,
    basePath: "/api/v1/auth",
    secret: c.authSecret,
    secrets: [...c.authSecrets],
    database: env.DB,
    trustedOrigins: [...c.corsOrigins],
    user: {
      modelName: "auth_users",
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
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      sendResetPassword: async () => {
        throw new Error("EMAIL_PROVIDER_UNCONFIGURED");
      },
    },
    advanced: {
      useSecureCookies: ["staging", "production"].includes(c.environment),
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
  });

  return {
    auth,
    async principal(headers: Headers): Promise<Principal | null> {
      const session = await auth.api.getSession({ headers });
      if (!session || !session.user.emailVerified) return null;
      return {
        accountId: session.user.id,
        personId: null,
        mfaEnabled: false,
      };
    },
  };
}

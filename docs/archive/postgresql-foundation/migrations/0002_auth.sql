-- Provider technical identity is NOT iam.people. Person linking belongs to phase 1.
CREATE TABLE iam.auth_users (
 id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
 "emailVerified" boolean NOT NULL DEFAULT false, image text,
 "twoFactorEnabled" boolean NOT NULL DEFAULT false,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE iam.auth_sessions (
 id uuid PRIMARY KEY, "userId" uuid NOT NULL REFERENCES iam.auth_users(id) ON DELETE RESTRICT,
 token text NOT NULL UNIQUE, "expiresAt" timestamptz NOT NULL,
 "ipAddress" text, "userAgent" text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_session_user ON iam.auth_sessions("userId");
CREATE TABLE iam.auth_credentials (
 id uuid PRIMARY KEY, "userId" uuid NOT NULL REFERENCES iam.auth_users(id) ON DELETE RESTRICT,
 "accountId" text NOT NULL, "providerId" text NOT NULL,
 "accessToken" text, "refreshToken" text, "idToken" text,
 "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, scope text, password text,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE("providerId","accountId")
);
CREATE INDEX auth_credentials_user ON iam.auth_credentials("userId");
CREATE TABLE iam.auth_verifications (
 id uuid PRIMARY KEY, identifier text NOT NULL, value text NOT NULL, "expiresAt" timestamptz NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX auth_verification_identifier ON iam.auth_verifications(identifier);
CREATE TABLE iam.auth_two_factors (
 id uuid PRIMARY KEY, "userId" uuid NOT NULL UNIQUE REFERENCES iam.auth_users(id) ON DELETE RESTRICT,
 secret text NOT NULL, "backupCodes" text NOT NULL,
 verified boolean DEFAULT true, "failedVerificationCount" integer DEFAULT 0, "lockedUntil" timestamptz
);
ALTER TABLE governance.files ADD CONSTRAINT files_owner_fk FOREIGN KEY(owner_account_id) REFERENCES iam.auth_users(id) ON DELETE RESTRICT;

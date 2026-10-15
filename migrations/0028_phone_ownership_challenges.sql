-- One bounded, replaceable challenge per account; tokens and message bodies are never stored.
CREATE TABLE iam_phone_ownership_challenges (
  account_id TEXT PRIMARY KEY REFERENCES iam_accounts(id) ON DELETE RESTRICT,
  person_id TEXT NOT NULL REFERENCES iam_people(id) ON DELETE RESTRICT,
  contact_method_id TEXT NOT NULL REFERENCES iam_contact_methods(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE CHECK(length(token_sha256)=64),
  phone_sha256 TEXT NOT NULL CHECK(length(phone_sha256)=64),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK(expires_at>created_at),
  consumed_at TEXT,
  provider_reference_sha256 TEXT UNIQUE,
  CHECK((consumed_at IS NULL)=(provider_reference_sha256 IS NULL))
) STRICT;

CREATE TABLE governance.environment_metadata (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  environment text NOT NULL CHECK (environment IN ('local','test','staging','production')),
  initialized_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE governance.environment_metadata IS 'INTERNAL: immutable database environment identity; retain for database lifetime';
CREATE TRIGGER environment_metadata_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON governance.environment_metadata FOR EACH STATEMENT EXECUTE FUNCTION governance.prevent_mutation();

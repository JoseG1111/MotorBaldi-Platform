-- Deprecated local compatibility shim.
-- Runtime grant policy is canonical in packages/db/src/grants.ts and is applied by the migrator.
-- Do not add table grants here.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'motorbaldi_runtime') THEN
    CREATE ROLE motorbaldi_runtime LOGIN PASSWORD 'motorbaldi_local_runtime';
  END IF;
END $$;

PRAGMA foreign_keys = ON;

CREATE TABLE vehicle_vehicles (
  id TEXT PRIMARY KEY CHECK (
    length(id) = 36
    AND id = lower(id)
    AND id NOT GLOB '*[^0-9a-f-]*'
    AND substr(id, 9, 1) = '-'
    AND substr(id, 14, 1) = '-'
    AND substr(id, 15, 1) = '7'
    AND substr(id, 19, 1) = '-'
    AND substr(id, 20, 1) IN ('8','9','a','b')
    AND substr(id, 24, 1) = '-'
  ),
  kind_code TEXT NOT NULL CHECK (
    length(kind_code) BETWEEN 1 AND 64
    AND substr(kind_code, 1, 1) GLOB '[A-Z]'
    AND kind_code NOT GLOB '*[^A-Z0-9_]*'
  ),
  specification_json TEXT NOT NULL DEFAULT '{}' CHECK (
    length(specification_json) <= 16384
    AND CASE WHEN json_valid(specification_json)
      THEN json_type(specification_json) = 'object'
      ELSE 0
    END
  ),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;

CREATE INDEX vehicle_vehicles_kind ON vehicle_vehicles(kind_code, id);

CREATE TRIGGER vehicle_vehicles_version_step
BEFORE UPDATE ON vehicle_vehicles
WHEN NEW.version <> OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'vehicle version must advance by one'); END;

# ADR 0015 - D1 Instead Of PostgreSQL

Status: Accepted.

D1 is the Platform SQL database for CF-0. Active migrations use SQLite semantics: prefixed table names, `TEXT` UUIDv7 identifiers, ISO UTC timestamp text, JSON stored as validated text and SQLite constraints.

All Foundation tables use SQLite `STRICT` mode. Better Auth 1.7.5 works with the strict D1 schema, and a runtime migration introspection test fails when its configured tables or columns drift. Database triggers prevent updates or deletes of environment metadata, audit events, and security events.

PostgreSQL schemas, roles, grants, advisory locks, `TIMESTAMPTZ`, connection pools and migration runners are superseded. Historical PostgreSQL foundation files are archived in `docs/archive/postgresql-foundation/`.

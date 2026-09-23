# ADR 0015 - D1 Instead Of PostgreSQL

Status: Accepted.

D1 is the Platform SQL database for CF-0. Active migrations use SQLite semantics: prefixed table names, `TEXT` UUIDv7 identifiers, ISO UTC timestamp text, JSON stored as validated text and SQLite constraints.

PostgreSQL schemas, roles, grants, advisory locks, `TIMESTAMPTZ`, connection pools and migration runners are superseded. Historical PostgreSQL foundation files are archived in `docs/archive/postgresql-foundation/`.

import pg from "pg";
export function migrationDatabase(url: string) {
  return new pg.Pool({
    connectionString: url,
    max: 1,
    connectionTimeoutMillis: 5000,
    statement_timeout: 300000,
    application_name: "motorbaldi-migrator",
    options:
      "-c timezone=UTC -c lock_timeout=30000 -c idle_in_transaction_session_timeout=60000",
  });
}

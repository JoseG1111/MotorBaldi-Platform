import type pg from "pg";
const schemas = [
  "iam",
  "crm",
  "org",
  "professional",
  "vehicle",
  "service",
  "inspection",
  "billing",
  "communication",
  "notification",
  "support",
  "integration",
  "governance",
];
// New tables require a reviewed policy; omission fails migration rather than silently missing grants.
const policies: Record<string, string> = {
  "iam.auth_users": "SELECT,INSERT,UPDATE,DELETE",
  "iam.auth_sessions": "SELECT,INSERT,UPDATE,DELETE",
  "iam.auth_credentials": "SELECT,INSERT,UPDATE,DELETE",
  "iam.auth_verifications": "SELECT,INSERT,UPDATE,DELETE",
  "iam.auth_two_factors": "SELECT,INSERT,UPDATE,DELETE",
  "governance.audit_events": "SELECT,INSERT",
  "governance.security_events": "SELECT,INSERT",
  "governance.environment_metadata": "SELECT",
  "governance.feature_flags": "SELECT,INSERT,UPDATE",
  "governance.files": "SELECT,INSERT,UPDATE",
  "governance.file_promotions": "SELECT,INSERT,UPDATE,DELETE",
  "governance.idempotency_records": "SELECT,INSERT,DELETE",
  "integration.outbox_events": "SELECT,INSERT,UPDATE",
  "integration.inbound_events": "SELECT,INSERT,UPDATE",
  "integration.dead_letters": "SELECT,INSERT,UPDATE",
};
export async function applyRuntimeGrants(tx: pg.PoolClient, role: string) {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(role))
    throw new Error("Invalid runtime role name");
  const tables = await tx.query<{ name: string }>(
    `SELECT n.nspname||'.'||c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=ANY($1::text[]) AND c.relkind IN ('r','p')`,
    [schemas],
  );
  for (const { name } of tables.rows)
    if (!policies[name])
      throw new Error("Missing runtime grant policy: " + name);
  await tx.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
  for (const schema of schemas) {
    await tx.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC, "${role}"`);
    await tx.query(`GRANT USAGE ON SCHEMA ${schema} TO "${role}"`);
    await tx.query(
      `REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC, "${role}"`,
    );
    await tx.query(
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC, "${role}"`,
    );
  }
  await tx.query(
    `REVOKE ALL ON public.motorbaldi_migrations FROM PUBLIC, "${role}"`,
  );
  for (const { name } of tables.rows)
    await tx.query(`GRANT ${policies[name]} ON ${name} TO "${role}"`);
}

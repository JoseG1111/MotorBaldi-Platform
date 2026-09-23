import type pg from "pg";
export async function assertRuntimeRole(pool: pg.Pool) {
  const row = (
    await pool.query<{
      unsafe: boolean;
    }>(`SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls OR
 has_database_privilege(current_user,current_database(),'CREATE') OR
 EXISTS (SELECT 1 FROM pg_namespace WHERE nspname IN ('public','iam','crm','org','professional','vehicle','service','inspection','billing','communication','notification','support','integration','governance') AND has_schema_privilege(current_user,oid,'CREATE')) OR
 EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN ('iam','crm','org','professional','vehicle','service','inspection','billing','communication','notification','support','integration','governance') AND c.relkind IN ('r','p','S') AND pg_has_role(current_user,c.relowner,'USAGE')) OR
 has_table_privilege(current_user,'governance.audit_events','UPDATE,DELETE,TRUNCATE') OR
 has_table_privilege(current_user,'governance.security_events','UPDATE,DELETE,TRUNCATE') OR
 has_table_privilege(current_user,'governance.environment_metadata','INSERT,UPDATE,DELETE,TRUNCATE') OR
 has_table_privilege(current_user,'public.motorbaldi_migrations','INSERT,UPDATE,DELETE,TRUNCATE')
 AS unsafe FROM pg_roles WHERE rolname=current_user`)
  ).rows[0];
  if (!row || row.unsafe) throw new Error("Unsafe runtime database role");
}

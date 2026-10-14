const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
export function requireSyntheticSandboxExecution(args) {
  if (!(
    args[0] === "development" &&
    args[1] === "--execute" &&
    (args.length === 2 ||
      (args.length === 3 && ["MONTHLY", "ANNUAL"].includes(args[2])) ||
      (args.length === 4 &&
        ["MONTHLY", "ANNUAL"].includes(args[2]) &&
        ["--resume-approved", "--resume-voided", "--account-only"].includes(
          args[3],
        )))
  ))
    throw new Error(
      "Explicit Development synthetic Sandbox execution required",
    );
}
export function syntheticCustomerSql({
  accountId,
  credentialId,
  auditId,
  requestId,
  passwordHash,
}) {
  if (
    ![accountId, credentialId, auditId, requestId].every(
      (x) => typeof x === "string" && uuid.test(x),
    ) ||
    !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)
  )
    throw new Error("Invalid synthetic fixture input");
  const id = quote(accountId),
    email = quote(`sandbox-customer-${accountId}@development.invalid`);
  return `INSERT INTO auth_users(id,name,email,email_verified,two_factor_enabled)
 VALUES(CASE WHEN (SELECT environment FROM governance_environment_metadata WHERE singleton=1)='development' THEN ${id} ELSE NULL END,'Synthetic Sandbox Customer',${email},1,0);
 INSERT INTO auth_credentials(id,user_id,account_id,provider_id,password) VALUES(${quote(credentialId)},${id},${id},'credential',${quote(passwordHash)});
 INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,reason) VALUES(${quote(auditId)},${id},'identity.development_customer_fixture.provisioned','auth_user',${id},${quote(requestId)},'Owner-authorized nonprivileged synthetic Sandbox customer; operator fixture, not real email verification or public signup consent');`;
}
export function closeSyntheticCustomerSql({ accountId, auditId, requestId }) {
  if (
    ![accountId, auditId, requestId].every(
      (x) => typeof x === "string" && uuid.test(x),
    )
  )
    throw new Error("Invalid fixture identity");
  const id = quote(accountId);
  const eligible = `(SELECT environment FROM governance_environment_metadata WHERE singleton=1)='development' AND EXISTS(SELECT 1 FROM auth_users u JOIN governance_audit_events a ON a.resource_id=u.id WHERE u.id=${id} AND u.email=${quote(`sandbox-customer-${accountId}@development.invalid`)} AND a.action='identity.development_customer_fixture.provisioned')`;
  return `DELETE FROM auth_sessions WHERE user_id=${id} AND ${eligible};
 UPDATE auth_credentials SET password=NULL WHERE user_id=${id} AND provider_id='credential' AND ${eligible};
 UPDATE iam_accounts SET status='SUSPENDED' WHERE id=${id} AND ${eligible};
 INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,reason) SELECT ${quote(auditId)},${id},'identity.development_customer_fixture.closed','auth_user',${id},${quote(requestId)},'Synthetic customer disabled; sessions revoked and credentials cleared; immutable financial and audit history retained' WHERE ${eligible};`;
}

export function resumeSyntheticCustomerSql({
  accountId,
  auditId,
  requestId,
  passwordHash,
}) {
  if (
    ![accountId, auditId, requestId].every(
      (x) => typeof x === "string" && uuid.test(x),
    ) ||
    !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(passwordHash)
  )
    throw new Error("Invalid synthetic fixture input");
  const id = quote(accountId);
  const eligible = `(SELECT environment FROM governance_environment_metadata WHERE singleton=1)='development'
 AND EXISTS(SELECT 1 FROM auth_users u JOIN iam_accounts ac ON ac.id=u.id JOIN governance_audit_events a ON a.resource_id=u.id WHERE u.id=${id} AND u.name='Synthetic Sandbox Customer' AND u.email=${quote(`sandbox-customer-${accountId}@development.invalid`)} AND a.action='identity.development_customer_fixture.provisioned'
 AND NOT EXISTS(SELECT 1 FROM platform_person_roles pr WHERE pr.person_id=ac.person_id)
 AND NOT EXISTS(SELECT 1 FROM org_memberships om WHERE om.person_id=ac.person_id))`;
  return `INSERT INTO governance_audit_events(id,actor_id,action,resource_type,resource_id,request_id,reason) VALUES(${quote(auditId)},${id},'identity.development_customer_fixture.resumed','auth_user',CASE WHEN ${eligible} THEN ${id} ELSE NULL END,${quote(requestId)},'Owner-authorized nonprivileged synthetic customer resumed with fresh ephemeral password for normal Better Auth login');
 DELETE FROM auth_sessions WHERE user_id=${id};
 UPDATE auth_credentials SET password=${quote(passwordHash)} WHERE user_id=${id} AND provider_id='credential';
 UPDATE iam_accounts SET status='ACTIVE' WHERE id=${id};`;
}

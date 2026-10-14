export function requireSyntheticSandboxExecution(args: string[]): void;
export function syntheticCustomerSql(input: {
  accountId: string;
  credentialId: string;
  auditId: string;
  requestId: string;
  passwordHash: string;
}): string;
export function closeSyntheticCustomerSql(input: {
  accountId: string;
  auditId: string;
  requestId: string;
}): string;
export function resumeSyntheticCustomerSql(input: {
  accountId: string;
  auditId: string;
  requestId: string;
  passwordHash: string;
}): string;

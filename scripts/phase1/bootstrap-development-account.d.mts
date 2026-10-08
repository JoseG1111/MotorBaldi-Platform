export function requireDevelopmentExecution(args: string[]): void;
export function normalizeBootstrapEmail(value: string): string;
export function buildBootstrapSql(input: {
  accountId: string;
  credentialId: string;
  auditId: string;
  securityId: string;
  requestId: string;
  name: string;
  email: string;
  passwordHash: string;
}): string;

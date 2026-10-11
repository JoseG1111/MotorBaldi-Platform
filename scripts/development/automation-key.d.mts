export function provisionCredential(
  metadata: { keyId: string; version: number },
  dependencies?: {
    secretService?: (operation: string, input?: string) => Promise<string>;
    command?: (args: string[], input?: string) => Promise<string>;
  },
): Promise<void>;
export interface LifecycleMetadata {
  keyId: string;
  version: number;
  accountId: string;
  status: "ACTIVE" | "REVOKED";
  expiresAt: string;
}
export function buildLifecycleSql(
  metadata: LifecycleMetadata,
  operation: "rotate" | "revoke",
  requestId?: string,
): string;
export function rotateCredential(
  metadata: LifecycleMetadata,
  dependencies?: Parameters<typeof provisionCredential>[1],
): Promise<void>;
export function revokeCredential(
  metadata: LifecycleMetadata,
  dependencies?: Parameters<typeof provisionCredential>[1],
): Promise<void>;

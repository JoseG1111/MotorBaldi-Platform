export interface AutomationCredential {
  keyId: string;
  version: number;
  secret: string;
}
export const DEVELOPMENT_ADMIN_ORIGIN: string;
export const DEVELOPMENT_API_ORIGIN: string;
export function validateCredential(value: unknown): AutomationCredential;
export function secretService(
  operation: string,
  input?: string,
): Promise<string>;
export function loadCredential(): Promise<AutomationCredential>;
export function canonicalRequest(
  timestamp: number,
  nonce: string,
  method: string,
  url: string | URL,
  body: Uint8Array,
): string;
export function signRequest(
  credential: AutomationCredential,
  timestamp: number,
  nonce: string,
  method: string,
  url: string | URL,
  body: Uint8Array,
): string;
export function getAutomationFetch(options?: {
  credential?: AutomationCredential;
  now?: () => number;
  nonce?: () => string;
  fetch?: {
    bivarianceHack(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response>;
  }["bivarianceHack"];
}): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

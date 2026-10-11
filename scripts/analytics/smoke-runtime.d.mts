export type Evidence = {
  canonical: Report;
  organization: Report;
  organizationId: string;
  locationId: string;
};
export type Report = {
  schemaVersion: 1;
  classification: "INTERNAL";
  kind: string;
  observedAt: string;
  scope: Record<string, unknown>;
  provenance: { mode: "CURRENT_STATE"; sourceTables: string[] };
  counts:
    | Record<string, number>
    | {
        offerings: Record<string, number>;
        listings: Record<string, number>;
        discoverable: number;
      };
};
export function validateReport(
  value: unknown,
  kind: string,
  organizationId?: string,
  locationId?: string,
): Report;
export function runSmoke(options?: {
  fetch?: {
    bivarianceHack(
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response>;
  }["bivarianceHack"];
  log?: (message: string) => void;
  compare?: (evidence: Evidence) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void>;
export function formatSmokeFailure(error: unknown): string;

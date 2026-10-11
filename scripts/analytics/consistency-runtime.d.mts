import type { Evidence } from "./smoke-runtime.mjs";
export function buildConsistencySql(
  organizationId: string,
  locationId: string,
): string;
export function assessAnalyticsConsistency(
  results: unknown,
  evidence: Evidence,
): void;
export function compareRemoteEvidence(
  evidence: Evidence,
  options?: { exec?: (file: string, args: string[]) => Promise<string> },
): Promise<void>;

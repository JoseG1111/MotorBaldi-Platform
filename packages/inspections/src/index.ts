import { z } from "zod";
import { Problem } from "@motorbaldi/contracts";
import { canonical } from "@motorbaldi/shared";

export const inspectionRecordType = "INSPECTION";
const ids = z
  .array(z.string().uuid())
  .max(20)
  .refine((v) => new Set(v).size === v.length);
export const inspectionFindingSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(120),
    observation: z.string().trim().min(1).max(4000),
    evidenceFileIds: ids,
  })
  .strict();
export const inspectionReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    summary: z.string().trim().min(5).max(4000),
    findings: z
      .array(inspectionFindingSchema)
      .max(200)
      .refine((v) => new Set(v.map((f) => f.id)).size === v.length),
  })
  .strict();
export const inspectionAmendmentSchema = z
  .object({
    reason: z.string().trim().min(5).max(1000),
    content: inspectionReportSchema,
  })
  .strict();
export type InspectionReport = z.infer<typeof inspectionReportSchema>;

/** Immutable value; the caller must resolve authorized ACTIVE associations, never trust client IDs. */
export function inspectionSnapshot(
  input: unknown,
  authorizedActiveFileIds: ReadonlySet<string>,
): string {
  const report = inspectionReportSchema.parse(input);
  for (const finding of report.findings)
    for (const fileId of finding.evidenceFileIds)
      if (!authorizedActiveFileIds.has(fileId))
        throw new Problem(
          409,
          "INSPECTION_EVIDENCE_UNAVAILABLE",
          "Authorized active evidence required",
        );
  const snapshot = canonical(report);
  if (new TextEncoder().encode(snapshot).byteLength > 65536)
    throw new Problem(
      400,
      "INSPECTION_REPORT_TOO_LARGE",
      "Report content exceeds limit",
    );
  return snapshot;
}

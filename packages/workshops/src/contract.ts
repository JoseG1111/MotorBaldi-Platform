import { Problem } from "@motorbaldi/contracts";

export const workshopStates = [
  "DRAFT",
  "OPEN",
  "IN_PROGRESS",
  "COMPLETED",
  "CLOSED",
  "CANCELLED",
] as const;
export type WorkshopState = (typeof workshopStates)[number];
export const workshopTransitions: Readonly<
  Record<WorkshopState, readonly WorkshopState[]>
> = {
  DRAFT: ["OPEN", "CANCELLED"],
  OPEN: ["IN_PROGRESS", "CANCELLED"],
  IN_PROGRESS: ["COMPLETED", "CANCELLED"],
  COMPLETED: ["CLOSED"],
  CLOSED: [],
  CANCELLED: [],
};
export function assertWorkshopTransition(
  from: WorkshopState,
  to: WorkshopState,
  context: {
    manage: boolean;
    execute: boolean;
    assigned: boolean;
    finalRecord: boolean;
    mfa: boolean;
  },
) {
  if (!workshopTransitions[from]?.includes(to))
    throw new Problem(
      409,
      "WORKSHOP_INVALID_TRANSITION",
      "Invalid workshop transition",
    );
  if (to === "IN_PROGRESS" || to === "COMPLETED") {
    if (!context.execute || !context.assigned)
      throw new Problem(
        403,
        "FORBIDDEN",
        "Assigned workshop executor required",
      );
  } else if (!context.manage)
    throw new Problem(403, "FORBIDDEN", "Workshop manager required");
  if (to === "COMPLETED" && !context.finalRecord)
    throw new Problem(
      409,
      "WORKSHOP_FINAL_RECORD_REQUIRED",
      "Matching final professional record required",
    );
  if (to === "CLOSED" && !context.mfa)
    throw new Problem(
      403,
      "MFA_REQUIRED",
      "Multi-factor authentication required",
    );
}

import type { Principal } from "@motorbaldi/contracts";
import { Problem } from "@motorbaldi/contracts";
import {
  listPlans,
  membershipOverview,
  adminBillingOverview,
  adminCommissionOverview,
  parseBillingCommand,
  parseCommissionCommand,
} from "@motorbaldi/payments";
import type { Json } from "@motorbaldi/shared";

/** Account-scoped membership and privileged financial management; no client payment confirmation. */
export async function billingRoutes(
  request: Request,
  db: D1Database,
  principal: () => Promise<Principal & { personId: string }>,
  execute: (operation: string, body: Json) => Promise<unknown>,
  readBody: () => Promise<unknown>,
  cors: Record<string, string>,
  checkoutAvailable = false,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const reply = (value: unknown) =>
    Response.json(value, { headers: { ...cors, "cache-control": "no-store" } });
  const method = (value: string) => {
    if (request.method !== value)
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  };
  async function command(operation: string, extra: Record<string, Json> = {}) {
    method("POST");
    await principal();
    const input = await readBody();
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Problem(400, "INVALID_FINANCIAL_COMMAND", "Object required");
    for (const name of Object.keys(extra))
      if (name in input)
        throw new Problem(
          400,
          "INVALID_FINANCIAL_COMMAND",
          "Route identifiers cannot be overridden",
        );
    const body = { ...input, ...extra };
    const parsed = operation.startsWith("billing.")
      ? parseBillingCommand(operation, body)
      : parseCommissionCommand(operation, body);
    return reply(await execute(operation, parsed));
  }
  if (path === "/api/v1/billing/plans") {
    method("GET");
    return reply({ items: await listPlans(db) });
  }
  if (path === "/api/v1/me/membership") {
    method("GET");
    return reply({
      ...(await membershipOverview(db, await principal())),
      checkoutAvailable,
    });
  }
  if (path === "/api/v1/admin/billing") {
    method("GET");
    return reply(await adminBillingOverview(db, await principal()));
  }
  if (path === "/api/v1/admin/commissions") {
    method("GET");
    return reply(await adminCommissionOverview(db, await principal()));
  }
  if (path === "/api/v1/billing/subscriptions")
    return command("billing.subscription.create");
  const subscription = path.match(
    /^\/api\/v1\/billing\/subscriptions\/([0-9a-f-]{36})\/(cancel|vehicles)(?:\/([0-9a-f-]{36})\/remove)?$/,
  );
  if (subscription) {
    const operation =
      subscription[2] === "cancel"
        ? "billing.subscription.cancel"
        : subscription[3]
          ? "billing.vehicle.remove"
          : "billing.vehicle.add";
    return command(operation, {
      subscriptionId: subscription[1]!,
      ...(subscription[3] ? { vehicleId: subscription[3] } : {}),
    });
  }
  const grant = path.match(
    /^\/api\/v1\/admin\/billing\/subscriptions\/([0-9a-f-]{36})\/(grant|suspend)$/,
  );
  if (grant)
    return command(`billing.admin.${grant[2]}`, { subscriptionId: grant[1]! });
  if (path === "/api/v1/me/commission-consents")
    return command("commission.consent.record");
  const staticCommission: Record<string, string> = {
    "/api/v1/admin/commissions/agreements": "commission.agreement.create",
    "/api/v1/admin/commissions/referrals": "commission.referral.create",
    "/api/v1/admin/commissions/recognitions": "commission.recognize",
  };
  if (staticCommission[path]) return command(staticCommission[path]);
  const agreement = path.match(
    /^\/api\/v1\/admin\/commissions\/agreements\/([0-9a-f-]{36})\/approve$/,
  );
  if (agreement)
    return command("commission.agreement.approve", {
      agreementId: agreement[1]!,
    });
  const commission = path.match(
    /^\/api\/v1\/admin\/commissions\/([0-9a-f-]{36})\/(approve|adjustments|settlements|dispute)$/,
  );
  if (commission)
    return command(
      commission[2] === "approve"
        ? "commission.approve"
        : commission[2] === "dispute"
          ? "commission.dispute"
          : commission[2] === "adjustments"
            ? "commission.adjust"
            : "commission.settlement.record",
      { commissionId: commission[1]! },
    );
  const settlement = path.match(
    /^\/api\/v1\/admin\/commissions\/settlements\/([0-9a-f-]{36})\/reconcile$/,
  );
  if (settlement)
    return command("commission.settlement.reconcile", {
      settlementId: settlement[1]!,
    });
  return null;
}

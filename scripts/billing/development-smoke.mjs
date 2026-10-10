// Development only: existing assured Admin cookie on stdin; never print identity or credentials.
// Retains a synthetic suspended subscription/audit history; never calls a payment provider.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const adminHost = "motorbaldi-admin-development.josegbarrios2.workers.dev";
const portalHost = "motorbaldi-portal-development.josegbarrios2.workers.dev";
const anonymous = process.argv.includes("--anonymous");
const verifyOnly = process.argv.includes("--verify-only");
const gatewayClosed = process.argv.includes("--gateway-closed");
const cookie = anonymous ? "" : readFileSync(0, "utf8").trim();
if (!anonymous && (!cookie || /[\r\n]/.test(cookie))) {
  console.error("Existing assured Development cookie required through stdin.");
  process.exit(1);
}
class SmokeError extends Error {}
function assert(condition, message) {
  if (!condition) throw new SmokeError(message);
}
async function call(
  path,
  body,
  {
    status = 200,
    key = randomUUID(),
    authenticated = true,
    origin = `https://${adminHost}`,
  } = {},
) {
  assert(
    !verifyOnly || body === undefined,
    "Verify-only mode prohibits all POST requests",
  );
  const response = await fetch(`https://${adminHost}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      origin,
      "content-type": "application/json",
      ...(authenticated && cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "idempotency-key": key }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await response.json().catch(() => null);
  const expected = Array.isArray(status) ? status : [status];
  if (!expected.includes(response.status)) {
    const code =
      typeof data?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(data.code)
        ? data.code
        : "UNKNOWN";
    throw new SmokeError(
      `Development request failed: expected ${expected.join("/")}, received ${response.status}; code=${code}`,
    );
  }
  return { status: response.status, data };
}
const read = async (path) => (await call(path)).data;
async function syntheticVehicles() {
  const readable = [],
    inaccessible = [];
  let cursor = "";
  for (let page = 0; page < 20; page++) {
    const batch = await read(
      `/admin/vehicles${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    for (const row of batch.items) {
      const detail = await read(`/admin/vehicles/${row.id}`);
      const spec = JSON.parse(detail.vehicle.specification_json);
      if (
        spec.brand !== "Development validation" ||
        !/synthetic/i.test(String(spec.model))
      )
        continue;
      const access = await call(`/vehicles/${row.id}`, undefined, {
        status: [200, 404],
      });
      (access.status === 200 ? readable : inaccessible).push(row.id);
    }
    if (!batch.items.length || batch.items.length < 30) break;
    assert(
      batch.nextCursor && batch.nextCursor !== cursor,
      "Vehicle pagination did not advance",
    );
    cursor = batch.nextCursor;
  }
  return { readable: readable.slice(0, 3), inaccessible: inaccessible[0] };
}
async function main() {
  assert(
    !(anonymous && verifyOnly),
    "Choose anonymous or authenticated verify-only mode",
  );
  assert(
    !gatewayClosed || (!anonymous && !verifyOnly),
    "Gateway-closed probes require their own authenticated mode",
  );
  for (const path of [
    "/me/membership",
    "/admin/billing",
    "/admin/commissions",
    "/billing/payment-capabilities",
  ])
    await call(path, undefined, { authenticated: false, status: 401 });
  if (!verifyOnly && !gatewayClosed)
    await call(
      "/billing/subscriptions",
      { planCode: "ACOMPANAMIENTO_MONTHLY" },
      { authenticated: false, status: 401 },
    );
  const plans = (await read("/billing/plans")).items;
  for (const [code, amount] of [
    ["ACOMPANAMIENTO_MONTHLY", 2990000],
    ["ACOMPANAMIENTO_ANNUAL", 28800000],
  ]) {
    const plan = plans.find((row) => row.code === code);
    assert(
      plan?.amount_minor === amount &&
        plan.currency === "COP" &&
        plan.vehicle_limit === 2,
      "Owner-approved server plan mismatch",
    );
  }
  for (const [host, markers] of [
    [adminHost, ["billing-detail", "commissions-detail"]],
    [portalHost, ["membership-panel"]],
  ]) {
    const response = await fetch(`https://${host}`, {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    const page = await response.text();
    assert(
      response.status === 200 &&
        markers.every((marker) => page.includes(marker)),
      "Development billing UI unavailable",
    );
  }
  console.log(
    "PASS Development anonymous protection, server plans and billing UI assets.",
  );
  if (anonymous) return;
  assert(
    (await read("/me")).mfaEnabled === true,
    "Existing assured MFA session required",
  );
  const initial = await read("/me/membership");
  const capabilities = await read("/billing/payment-capabilities");
  assert(
    Object.keys(capabilities).sort().join(",") ===
      "checkoutAvailable,environment,manualReconciliationAvailable,productionAvailable,recurringAvailable" &&
      capabilities.environment === "SANDBOX" &&
      typeof capabilities.checkoutAvailable === "boolean" &&
      capabilities.manualReconciliationAvailable ===
        capabilities.checkoutAvailable &&
      capabilities.productionAvailable === false &&
      capabilities.recurringAvailable === false,
    "Public sandbox capability metadata mismatch",
  );
  console.log(
    "PASS authenticated sandbox capability flags; production and recurring unavailable.",
  );
  const billing = await read("/admin/billing");
  const commissions = await read("/admin/commissions");
  assert(
    Array.isArray(billing.subscriptions) &&
      Array.isArray(billing.payments) &&
      Array.isArray(commissions.agreements),
    "Private financial overview unavailable",
  );
  const fixtures = await syntheticVehicles();
  if (verifyOnly || gatewayClosed) {
    assert(
      initial.premium === false &&
        initial.entitlements.length === 0 &&
        initial.vehicles.length === 0 &&
        initial.checkoutAvailable === false &&
        initial.benefits.every((benefit) => benefit.available === false),
      "Current free membership or deferred benefits mismatch",
    );
    assert(
      !initial.subscription ||
        (["SUSPENDED", "CANCELLED", "EXPIRED"].includes(
          initial.subscription.status,
        ) &&
          initial.subscription.auto_renew === 0),
      "Existing synthetic subscription cleanup mismatch",
    );
    assert(
      fixtures.readable.length > 0,
      "Existing readable synthetic vehicle required to verify free access",
    );
    for (const vehicleId of fixtures.readable)
      await read(`/vehicles/${vehicleId}`);
    await read("/me/garage");
    if (gatewayClosed) {
      assert(
        capabilities.checkoutAvailable === false &&
          capabilities.manualReconciliationAvailable === false,
        "Refuse closed-gateway probes while payment gateway is configured",
      );
      assert(
        initial.subscription?.status === "SUSPENDED" &&
          /^[0-9a-f-]{36}$/.test(initial.subscription.id),
        "Existing suspended synthetic subscription required for rejected checkout probe",
      );
      const webhook = "/payments/wompi/events";
      await call(webhook, undefined, { status: 405, authenticated: false });
      const rejected = await call(
        webhook,
        {},
        { status: 503, authenticated: false },
      );
      assert(
        rejected.data?.code === "PAYMENTS_UNAVAILABLE",
        "Closed webhook rejection code mismatch",
      );
      const checkout = `/billing/subscriptions/${initial.subscription.id}/checkout`;
      const reservation = await call(checkout, {}, { status: 503 });
      assert(
        reservation.data?.code === "PAYMENTS_UNAVAILABLE",
        "Closed checkout rejection code mismatch",
      );
      await call(
        checkout,
        {},
        { status: 403, origin: "https://untrusted.example" },
      );
      const afterBilling = await read("/admin/billing"),
        afterMembership = await read("/me/membership"),
        afterCommissions = await read("/admin/commissions");
      assert(
        JSON.stringify(afterBilling) === JSON.stringify(billing) &&
          JSON.stringify(afterMembership) === JSON.stringify(initial) &&
          JSON.stringify(afterCommissions) === JSON.stringify(commissions),
        "Rejected gateway probes changed visible financial state",
      );
      console.log(
        "PASS closed sandbox webhook/checkout/method/origin rejection; visible financial state unchanged. No provider confirmation or successful ledger reservation claimed.",
      );
    }
    console.log(
      "PASS Development read-only verification: assured private financial reads, no entitlements or coverage, renewal disabled, deferred benefits, free garage and existing vehicle access.",
    );
    return;
  }
  assert(
    !initial.premium &&
      (!initial.subscription ||
        ["CANCELLED", "EXPIRED"].includes(initial.subscription.status)),
    "Existing membership requires review before synthetic mutation",
  );
  const input = { planCode: "ACOMPANAMIENTO_MONTHLY" },
    key = randomUUID();
  await call(
    "/billing/subscriptions",
    { ...input, amount_minor: 1 },
    { status: 400 },
  );
  await call("/billing/subscriptions", input, {
    origin: "https://untrusted.example",
    status: 403,
  });
  const receipt = (await call("/billing/subscriptions", input, { key })).data;
  const id = receipt.subscriptionId;
  assert(
    typeof id === "string" && /^[0-9a-f-]{36}$/.test(id),
    "Synthetic subscription receipt unavailable",
  );
  const own = async () => {
    const data = await read("/me/membership");
    assert(
      data.subscription?.id === id,
      "Synthetic membership selection changed; stop",
    );
    return data;
  };
  try {
    assert(
      receipt.status === "PENDING_ACTIVATION" &&
        receipt.checkoutAvailable === false,
      "Creation must remain pending without checkout",
    );
    assert(
      (await call("/billing/subscriptions", input, { key })).data
        .subscriptionId === id,
      "Create replay duplicated subscription",
    );
    await call(
      "/billing/subscriptions",
      { planCode: "ACOMPANAMIENTO_ANNUAL" },
      { key, status: 409 },
    );
    let state = await own();
    assert(!state.premium, "Pending membership activated without evidence");
    const startsAt = new Date(Date.now() - 60000).toISOString(),
      endsAt = new Date(Date.now() + 30 * 60000).toISOString();
    await call(`/admin/billing/subscriptions/${id}/grant`, {
      version: state.subscription.version,
      startsAt,
      endsAt,
      reason:
        "Owner-authorized finite Development synthetic smoke grant; no payment",
    });
    state = await own();
    assert(
      state.premium &&
        state.benefits.every((benefit) => benefit.available === false) &&
        !state.checkoutAvailable,
      "Finite grant or deferred benefits mismatch",
    );
    if (fixtures.inaccessible)
      await call(
        `/billing/subscriptions/${id}/vehicles`,
        {
          version: state.subscription.version,
          vehicleId: fixtures.inaccessible,
        },
        { status: 404 },
      );
    else
      console.log(
        "SKIP existing inaccessible synthetic vehicle fixture unavailable.",
      );
    for (const vehicleId of fixtures.readable.slice(0, 2)) {
      state = await own();
      await call(`/billing/subscriptions/${id}/vehicles`, {
        version: state.subscription.version,
        vehicleId,
      });
    }
    if (fixtures.readable.length === 3) {
      state = await own();
      await call(
        `/billing/subscriptions/${id}/vehicles`,
        {
          version: state.subscription.version,
          vehicleId: fixtures.readable[2],
        },
        { status: 409 },
      );
      assert(
        (await own()).subscription.version === state.subscription.version &&
          (await own()).vehicles.length === 2,
        "Vehicle limit rejection mutated state",
      );
      console.log(
        "PASS two-vehicle limit with existing exact-authorized fixtures.",
      );
    } else
      console.log(
        "SKIP two-vehicle limit: three readable synthetic fixtures required.",
      );
    for (const vehicleId of fixtures.readable.slice(0, 2)) {
      state = await own();
      assert(
        state.vehicles.some((row) => row.vehicle_id === vehicleId),
        "Covered vehicle missing",
      );
      await call(`/billing/subscriptions/${id}/vehicles/${vehicleId}/remove`, {
        version: state.subscription.version,
      });
    }
    state = await own();
    await call(`/billing/subscriptions/${id}/cancel`, {
      version: state.subscription.version,
    });
    state = await own();
    assert(
      state.premium &&
        state.subscription.auto_renew === 0 &&
        state.subscription.cancel_at_period_end === 1 &&
        state.subscription.current_period_end === endsAt,
      "Cancellation lost finite grant cutoff",
    );
    console.log(
      "PASS assured financial reads, pending/replay/conflict, finite grant, covered fixture lifecycle and cancellation cutoff.",
    );
  } finally {
    let state = await own();
    for (const row of state.vehicles) {
      await call(
        `/billing/subscriptions/${id}/vehicles/${row.vehicle_id}/remove`,
        { version: state.subscription.version },
      );
      state = await own();
    }
    if (state.subscription.status !== "SUSPENDED")
      await call(`/admin/billing/subscriptions/${id}/suspend`, {
        version: state.subscription.version,
        reason:
          "End owner-authorized Development synthetic billing smoke grant",
      });
    state = await own();
    assert(
      !state.premium &&
        state.subscription.auto_renew === 0 &&
        state.vehicles.length === 0,
      "Synthetic cleanup incomplete",
    );
    console.log(
      "PASS cleanup: synthetic subscription suspended, renewal disabled, coverage removed; immutable audit retained.",
    );
  }
  for (const vehicleId of fixtures.readable)
    await read(`/vehicles/${vehicleId}`);
  await read("/me/garage");
  console.log(
    "PASS free garage and existing vehicle access preserved; no charges, provider calls or file mutations.",
  );
}
main().catch((error) => {
  // Never print arbitrary thrown fetch/body errors: they may contain request or identity data.
  console.error(
    error instanceof SmokeError
      ? error.message
      : "Development billing smoke failed; inspect remote state privately.",
  );
  process.exitCode = 1;
});

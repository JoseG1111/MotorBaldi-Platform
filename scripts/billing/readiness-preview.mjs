/** GET-only, Development-only remote preview. Run with the existing API bindings.
 * Never prints keys, acceptance tokens, identities, transaction IDs or raw bodies.
 * Does not initiate payments, mutate merchant settings, or grant entitlements.
 */
import { createWompiAdapter } from "../../packages/payments/src/wompi.js";
import { paymentsConfigured } from "../../apps/api/src/payment-gateway.js";
export {
  IdempotencyCoordinator,
  OutboxCoordinator,
} from "../../apps/api/src/coordinators.js";
export default {
  async fetch(request, env) {
    if (request.method !== "GET") return new Response(null, { status: 405 });
    if (
      env.ENVIRONMENT !== "development" ||
      (env.WOMPI_ENVIRONMENT !== undefined &&
        env.WOMPI_ENVIRONMENT !== "SANDBOX")
    )
      return Response.json({ available: false }, { status: 403 });
    const metadata = await env.DB.prepare(
      "SELECT environment FROM governance_environment_metadata WHERE singleton=1",
    ).first();
    if (metadata?.environment !== "development")
      return Response.json({ available: false }, { status: 403 });
    const result = {
      environment: "SANDBOX",
      credentialsConfigured: paymentsConfigured(env),
      merchantReadVerified: false,
      paymentCycleVerified: false,
      privateKeyAuthenticationVerified: false,
    };
    if (!result.credentialsConfigured)
      return Response.json(result, { status: 503 });
    try {
      const gateway = createWompiAdapter({
        environment: "SANDBOX",
        publicKey: env.WOMPI_PUBLIC_KEY,
        privateKey: env.WOMPI_PRIVATE_KEY,
        integritySecret: env.WOMPI_INTEGRITY_SECRET,
      });
      await gateway.getMerchantAcceptance(AbortSignal.timeout(10000));
      result.merchantReadVerified = true;
    } catch {
      result.merchantReadVerified = false;
    }
    return Response.json(result, { headers: { "cache-control": "no-store" } });
  },
};

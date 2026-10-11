import { randomUUID } from "node:crypto";
import {
  DEVELOPMENT_API_ORIGIN,
  DEVELOPMENT_ADMIN_ORIGIN,
  loadCredential,
  signRequest,
} from "./automation-client.mjs";
let failureStep = "configuration";
async function main() {
  if (process.argv.length !== 2) throw new Error();
  failureStep = "credential-storage";
  const credential = await loadCredential();
  async function probe(
    step,
    path,
    {
      timestamp = Date.now(),
      signedPath = path,
      authorization,
      expected = 200,
    } = {},
  ) {
    failureStep = step;
    const header =
      authorization ??
      signRequest(
        credential,
        timestamp,
        randomUUID(),
        "GET",
        DEVELOPMENT_API_ORIGIN + signedPath,
        Buffer.alloc(0),
      );
    const response = await fetch(DEVELOPMENT_API_ORIGIN + path, {
      headers: { authorization: header, origin: DEVELOPMENT_ADMIN_ORIGIN },
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error();
    }
    if (
      response.status !== expected ||
      (expected === 200 &&
        (data.authenticationMethod !== "DEVELOPMENT_AUTOMATION" ||
          data.mfaEnabled !== false)) ||
      (expected !== 200 &&
        ![
          "DEVELOPMENT_AUTOMATION_DENIED",
          "DEVELOPMENT_AUTOMATION_SCOPE",
          "NOT_FOUND",
        ].includes(data.code))
    ) {
      process.stderr.write(
        `FAIL step=${step} status=${response.status} code=AUTHENTICATION_VALIDATION_FAILED\n`,
      );
      throw new Error();
    }
    return header;
  }
  const header = await probe("machine-assurance", "/api/v1/me");
  await probe("nonce-replay", "/api/v1/me", {
    authorization: header,
    expected: 403,
  });
  await probe("expired-signature", "/api/v1/me", {
    timestamp: Date.now() - 120000,
    expected: 403,
  });
  await probe("path-tamper", "/api/v1/me?tampered=true", {
    signedPath: "/api/v1/me",
    expected: 403,
  });
  await probe("unrelated-workflow", "/api/v1/billing/payment-capabilities", {
    expected: 403,
  });
  await probe(
    "foreign-organization",
    `/api/v1/organizations/${randomUUID()}/parts-offerings`,
    { expected: 404 },
  );
  process.stdout.write(
    "PASS Development machine assurance, nonce replay, freshness, path binding and workflow isolation\n",
  );
}
main().catch(() => {
  process.stderr.write(
    `FAIL step=${failureStep} status=none code=AUTOMATION_AUTHENTICATION_UNAVAILABLE\n`,
  );
  process.exitCode = 1;
});

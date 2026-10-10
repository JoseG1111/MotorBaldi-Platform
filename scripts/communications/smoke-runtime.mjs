import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
const adminHost = "motorbaldi-admin-development.josegbarrios2.workers.dev";
const apiHost = "motorbaldi-api-development.josegbarrios2.workers.dev";
const portalHost = "motorbaldi-portal-development.josegbarrios2.workers.dev";
const apiCodes = new Set([
  "UNAUTHORIZED",
  "FORBIDDEN",
  "MFA_REQUIRED",
  "VALIDATION_ERROR",
  "VERSION_CONFLICT",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL_ERROR",
  "NOT_FOUND",
  "METHOD_NOT_ALLOWED",
  "ORIGIN_FORBIDDEN",
  "INVALID_NOTIFICATION_COMMAND",
  "NOTIFICATION_STATE_CONFLICT",
  "NOTIFICATION_VERSION_CONFLICT",
  "NOTIFICATION_ACCOUNT_UNAVAILABLE",
  "NOTIFICATION_NOT_FOUND",
  "INVALID_NOTIFICATION_CURSOR",
  "INVALID_SUPPORT_COMMAND",
  "SUPPORT_STATE_CONFLICT",
  "SUPPORT_VERSION_CONFLICT",
  "SUPPORT_ASSIGNEE_UNAVAILABLE",
  "SUPPORT_ACCOUNT_UNAVAILABLE",
  "INVALID_SUPPORT_CURSOR",
]);
function apiCode(data) {
  return apiCodes.has(data?.code) ? data.code : "HTTP_ERROR";
}
const ambiguousCodes = new Set([
  "TRANSPORT_ERROR",
  "TIMEOUT",
  "ABORTED",
  "INVALID_RESPONSE",
  "ASSERTION_FAILED",
]);
function transportCode(error) {
  return error?.name === "TimeoutError"
    ? "TIMEOUT"
    : error?.name === "AbortError"
      ? "ABORTED"
      : "TRANSPORT_ERROR";
}
export function formatSmokeFailure(error) {
  if (!(error instanceof SmokeError))
    return "FAIL step=internal code=INTERNAL_ERROR";
  const one = (value) =>
    `step=${value.step} status=${value.status ?? "none"} code=${value.code}`;
  return `FAIL ${one(error)}${error.cleanup ? `; cleanup ${one(error.cleanup)}${error.cleanup.cleanup ? `; cleanup recovery ${one(error.cleanup.cleanup)}` : ""}` : ""}${error.fixtureRisk ? `; support_fixture_review known_unclosed=${error.fixtureRisk.knownOpen} unknown_outcome=${error.fixtureRisk.unknownOutcome}` : ""}`;
}
class SmokeError extends Error {
  constructor(step, code, status) {
    super("Sanitized smoke failure");
    this.step = step;
    this.code = code;
    this.status = status;
  }
}
export async function runSmoke({
  cookie = "",
  anonymous = false,
  verifyOnly = false,
  fetch: fetcher = globalThis.fetch,
  log = console.log,
} = {}) {
  const fetch = fetcher;
  let step = "configuration",
    lastStatus;
  const failure = (code, status = lastStatus) =>
    new SmokeError(step, code, status);
  const safeFailure = (error) =>
    error instanceof SmokeError ? error : failure("INVALID_RESPONSE");
  function preference(data) {
    const pref = data?.items?.find?.(
      (item) =>
        item?.category === "TRANSACTIONAL" && item?.channel === "IN_APP",
    );
    if (
      !pref ||
      typeof pref.enabled !== "boolean" ||
      !Number.isInteger(pref.version)
    )
      throw failure("INVALID_RESPONSE");
    return pref;
  }

  function assert(condition) {
    if (!condition) throw failure("ASSERTION_FAILED");
  }
  let requests = 0,
    mutations = 0;
  async function requestOnce(
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
      "GET-only verification prohibits mutations.",
    );
    let response;
    lastStatus = undefined;
    requests++;
    if (body !== undefined) mutations++;
    try {
      response = await fetch(
        `https://${path.startsWith("/health") ? apiHost : adminHost}${path.startsWith("/health") ? path : `/api/v1${path}`}`,
        {
          method: body === undefined ? "GET" : "POST",
          redirect: "error",
          headers: {
            origin,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json", "idempotency-key": key }),
            ...(authenticated && cookie ? { cookie } : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(30000),
        },
      );
    } catch (error) {
      throw failure(transportCode(error));
    }
    lastStatus = response.status;
    const data = await response.json().catch(() => null);
    if (response.status !== status)
      throw failure(apiCode(data), response.status);
    if (
      status === 200 &&
      (!data || typeof data !== "object" || Array.isArray(data))
    )
      throw failure("INVALID_RESPONSE", response.status);
    return data;
  }
  const recoveredReceipts = new WeakSet(),
    openFixtures = new Set();
  let unknownCaseOutcome = false;
  async function call(path, body, options = {}) {
    const key = options.key ?? randomUUID();
    const eligible =
      body !== undefined &&
      (options.status ?? 200) === 200 &&
      (path.includes("/support-cases") ||
        /^\/me\/notifications\/[^/]+\/read$/.test(path));
    const create = eligible && path === "/me/support-cases";
    const attempt = async () => {
      const data = await requestOnce(path, body, { ...options, key });
      if (eligible) {
        const valid =
          typeof data.replayed === "boolean" &&
          Number.isInteger(data.version) &&
          data.version > 0 &&
          (path.includes("/support-cases")
            ? typeof data.caseId === "string" &&
              /^[0-9a-f-]{36}$/i.test(data.caseId) &&
              ["OPEN", "ASSIGNED", "CLOSED"].includes(data.status) &&
              data.version === (create ? 1 : body.version + 1)
            : typeof data.notificationId === "string" &&
              data.notificationId === path.split("/")[3] &&
              data.read === true &&
              typeof data.readAt === "string" &&
              data.version >= body.version);
        if (!valid) throw failure("INVALID_RESPONSE");
        if (path.includes("/support-cases")) {
          if (create) openFixtures.add(data.caseId);
          if (data.status === "CLOSED") openFixtures.delete(data.caseId);
        }
      }
      return data;
    };
    try {
      return await attempt();
    } catch (error) {
      const primary = safeFailure(error);
      if (!eligible || !ambiguousCodes.has(primary.code)) {
        if (
          eligible &&
          path.includes("/support-cases") &&
          primary.status >= 500
        )
          unknownCaseOutcome = true;
        throw primary;
      }
      try {
        const receipt = await attempt();
        recoveredReceipts.add(receipt);
        return receipt;
      } catch (recoveryError) {
        if (path.includes("/support-cases")) unknownCaseOutcome = true;
        primary.cleanup = safeFailure(recoveryError);
        throw primary;
      }
    }
  }
  const read = (path) => call(path);
  function replay(first, repeated) {
    assert(
      (first?.replayed === false ||
        (first?.replayed === true && recoveredReceipts.has(first))) &&
        repeated?.replayed === true,
      "Idempotency replay flags failed.",
    );
    assert(
      isDeepStrictEqual({ ...first, replayed: true }, repeated),
      "Idempotency replay result changed.",
    );
  }
  async function preferenceSmoke(initial) {
    step = "preference-update";
    const pref = preference(initial);
    assert(
      pref &&
        typeof pref.enabled === "boolean" &&
        Number.isInteger(pref.version),
      "Transactional in-app preference unavailable.",
    );
    const key = randomUUID(),
      body = {
        category: "TRANSACTIONAL",
        channel: "IN_APP",
        enabled: !pref.enabled,
        version: pref.version,
      };
    let primary, receipt;
    try {
      receipt = await call("/me/notification-preferences", body, { key });
      assert(
        receipt.enabled === body.enabled &&
          receipt.version === pref.version + 1,
      );
      step = "preference-replay";
      replay(
        receipt,
        await call("/me/notification-preferences", body, { key }),
      );
      step = "preference-conflict";
      await call(
        "/me/notification-preferences",
        { ...body, enabled: pref.enabled },
        { key, status: 409 },
      );
    } catch (error) {
      primary = safeFailure(error);
    }
    let cleanup;
    try {
      // One same-key retry may recover the authoritative receipt after an ambiguous
      // approved idempotent update. Never infer ownership from current state alone.
      if (
        !receipt ||
        receipt.enabled !== body.enabled ||
        receipt.version !== pref.version + 1
      ) {
        if (!primary || !ambiguousCodes.has(primary.code))
          throw failure("RESTORATION_UNCONFIRMED");
        step = "preference-recover";
        receipt = await call("/me/notification-preferences", body, { key });
        assert(
          typeof receipt.replayed === "boolean" &&
            receipt.enabled === body.enabled &&
            receipt.version === pref.version + 1,
        );
      }
      step = "preference-restore-read";
      const current = preference(await read("/me/notification-preferences"));
      if (
        current.version === pref.version + 1 &&
        current.enabled === body.enabled
      ) {
        step = "preference-restore";
        const restoreBody = {
            ...body,
            enabled: pref.enabled,
            version: current.version,
          },
          restoreKey = randomUUID();
        try {
          const restoredReceipt = await call(
            "/me/notification-preferences",
            restoreBody,
            { key: restoreKey },
          );
          assert(
            restoredReceipt.enabled === pref.enabled &&
              restoredReceipt.version === current.version + 1,
          );
        } catch (error) {
          const restoreFailure = safeFailure(error);
          if (!ambiguousCodes.has(restoreFailure.code)) throw restoreFailure;
          step = "preference-restore-recover";
          try {
            const restoredReceipt = await call(
              "/me/notification-preferences",
              restoreBody,
              { key: restoreKey },
            );
            assert(
              typeof restoredReceipt.replayed === "boolean" &&
                restoredReceipt.enabled === pref.enabled &&
                restoredReceipt.version === current.version + 1,
            );
          } catch (recoveryError) {
            restoreFailure.cleanup = safeFailure(recoveryError);
            throw restoreFailure;
          }
        }
        step = "preference-restore-verify";
        const restored = preference(await read("/me/notification-preferences"));
        assert(
          restored.enabled === pref.enabled &&
            restored.version === current.version + 1,
        );
      } else {
        assert(
          current.version === pref.version && current.enabled === pref.enabled,
        );
      }
    } catch (error) {
      cleanup = safeFailure(error);
    }
    if (primary) {
      primary.cleanup = cleanup;
      throw primary;
    }
    if (cleanup) throw cleanup;
  }
  async function inboxSmoke(inbox) {
    step = "inbox-pagination";
    assert(Array.isArray(inbox.items), "Private inbox unavailable.");
    if (!inbox.items.length) {
      log(
        "SKIP positive membership notification materialization and read: inbox empty; no source fabricated.",
      );
      return;
    }
    const item = inbox.items[0];
    const page = await read(
      `/me/notifications?limit=1&cursor=${encodeURIComponent(item.id)}`,
    );
    assert(
      Array.isArray(page.items) &&
        page.items.every((row) => row.id !== item.id),
      "Owner inbox cursor did not advance.",
    );
    if (!verifyOnly) {
      step = "inbox-read";
      const key = randomUUID(),
        body = { version: item.version },
        path = `/me/notifications/${item.id}/read`;
      replay(await call(path, body, { key }), await call(path, body, { key }));
      const refreshed = await read("/me/notifications?limit=50");
      const saved = refreshed.items.find((row) => row.id === item.id);
      assert(saved?.readAt, "Inbox read state unavailable.");
    }
    log("PASS existing owner inbox pagination and permitted read checks.");
  }
  async function caseSmoke(personId) {
    step = "case-create";
    const creation = {
      subject: "Development validation: synthetic general support",
      body: "Synthetic Development communication check. No customer, vehicle or workshop data.",
    };
    const key = randomUUID(),
      created = await call("/me/support-cases", creation, { key }),
      path = `/me/support-cases/${created.caseId}`;
    replay(created, await call("/me/support-cases", creation, { key }));
    await call(
      "/me/support-cases",
      {
        ...creation,
        subject: "Development validation: changed synthetic subject",
      },
      { key, status: 409 },
    );
    step = "case-read";
    const own = await read(path);
    assert(
      own.status === "OPEN" && own.version === 1 && own.messages.length === 1,
      "Synthetic own case creation failed.",
    );
    step = "case-reply";
    const replyBody = { version: 1, body: "Synthetic additional information." },
      replyKey = randomUUID();
    replay(
      await call(`${path}/reply`, replyBody, { key: replyKey }),
      await call(`${path}/reply`, replyBody, { key: replyKey }),
    );
    await call(`${path}/reply`, replyBody, { status: 409 });
    step = "case-assign";
    const adminPath = `/admin/support-cases/${created.caseId}`;
    const assigned = await call(`${adminPath}/assign`, {
      version: 2,
      assigneePersonId: personId,
    });
    assert(
      assigned.status === "ASSIGNED" && assigned.version === 3,
      "Synthetic staff self-assignment failed.",
    );
    step = "case-staff-reply";
    const staffReply = await call(`${adminPath}/reply`, {
      version: 3,
      body: "Synthetic staff response; no delivery or service promise.",
    });
    assert(staffReply.version === 4, "Synthetic staff reply failed.");
    step = "case-close";
    const closeBody = {
        version: 4,
        resolution: "Synthetic Development validation complete.",
      },
      closeKey = randomUUID();
    replay(
      await call(`${path}/close`, closeBody, { key: closeKey }),
      await call(`${path}/close`, closeBody, { key: closeKey }),
    );
    await call(
      `${path}/reply`,
      { version: 5, body: "Synthetic terminal-state denial check." },
      { status: 409 },
    );
    await call(
      `${adminPath}/assign`,
      { version: 5, assigneePersonId: personId },
      { status: 409 },
    );
    await call(`${path}/close`, { version: 5 }, { status: 409 });
    const closed = await read(path);
    assert(
      closed.status === "CLOSED" &&
        closed.version === 5 &&
        closed.messages.length === 3,
      "Closed synthetic case changed.",
    );
    step = "case-follow-up";
    const follow = await call("/me/support-cases", {
      ...creation,
      previousCaseId: created.caseId,
    });
    await call(`/me/support-cases/${follow.caseId}/close`, { version: 1 });
    const followed = await read(`/me/support-cases/${follow.caseId}`);
    assert(
      followed.previousCaseId === created.caseId &&
        followed.status === "CLOSED",
      "Synthetic linked follow-up did not close.",
    );
    log(
      "PASS synthetic support cases: 2 closed; customer/staff CAS, replay, assignment, replies and terminal denial.",
    );
  }
  async function main() {
    step = "health";
    const health = await call("/health", undefined, { authenticated: false });
    assert(health, "Development health unavailable.");
    step = "anonymous-protection";
    for (const path of [
      "/me/notifications",
      "/me/notification-preferences",
      "/me/support-cases",
      "/admin/support-cases",
    ])
      await call(path, undefined, { authenticated: false, status: 401 });
    step = "ui-assets";
    for (const host of [adminHost, portalHost]) {
      for (const asset of ["/", "/app.js"]) {
        lastStatus = undefined;
        requests++;
        let response, text;
        try {
          response = await fetch(`https://${host}${asset}`, {
            redirect: "error",
            signal: AbortSignal.timeout(30000),
          });
          lastStatus = response.status;
          text = await response.text();
        } catch (error) {
          throw failure(transportCode(error));
        }
        if (response.status !== 200)
          throw failure("HTTP_ERROR", response.status);
        assert(
          response.status === 200 &&
            (asset === "/"
              ? text.includes("support-panel")
              : (host === adminHost || text.includes("/me/notifications")) &&
                text.includes("/support-cases")),
          "Development communication UI asset unavailable.",
        );
      }
    }
    log(
      "PASS Development health, anonymous protection and communication UI assets.",
    );
    if (!anonymous) {
      step = "session";
      const me = await read("/me");
      assert(
        me.mfaEnabled === true && typeof me.personId === "string",
        "Existing assured MFA Admin session required.",
      );
      step = "authenticated-reads";
      const preferences = await read("/me/notification-preferences"),
        inbox = await read("/me/notifications?limit=50");
      assert(
        preferences.externalDeliveryAvailable === false &&
          Array.isArray(preferences.items),
        "External delivery must remain unavailable.",
      );
      for (const path of ["/me/support-cases", "/admin/support-cases"]) {
        const cases = await read(path);
        assert(
          Array.isArray(cases.items),
          "Authorized support list unavailable.",
        );
        if (cases.items.length)
          await read(`${path}/${encodeURIComponent(cases.items[0].caseId)}`);
      }
      await inboxSmoke(inbox);
      if (!verifyOnly) {
        await preferenceSmoke(preferences);
        await caseSmoke(me.personId);
      }
      log(
        verifyOnly
          ? "PASS authenticated GET-only communication verification."
          : "PASS authenticated communication smoke; initial in-app preference restored.",
      );
    }
    log(`PASS requests=${requests}; mutation_requests=${mutations}.`);
  }

  try {
    await main();
    return { requests, mutations };
  } catch (error) {
    const sanitized = safeFailure(error);
    if (openFixtures.size || unknownCaseOutcome)
      sanitized.fixtureRisk = {
        knownOpen: openFixtures.size,
        unknownOutcome: unknownCaseOutcome,
      };
    throw sanitized;
  }
}

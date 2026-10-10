// Development only. Read an existing assured Admin session cookie from stdin;
// never persist credentials or print response bodies or account/person/resource IDs.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const adminHost = "motorbaldi-admin-development.josegbarrios2.workers.dev";
const apiHost = "motorbaldi-api-development.josegbarrios2.workers.dev";
const portalHost = "motorbaldi-portal-development.josegbarrios2.workers.dev";
const anonymous = process.argv.includes("--anonymous");
const verifyOnly = process.argv.includes("--verify-only");
const allowed = new Set(["--anonymous", "--verify-only"]);
if (
  process.argv.slice(2).some((arg) => !allowed.has(arg)) ||
  (anonymous && verifyOnly)
) {
  console.error(
    "Choose --anonymous, --verify-only, or authenticated smoke without flags.",
  );
  process.exit(1);
}
const cookie = anonymous ? "" : readFileSync(0, "utf8").trim();
if (!anonymous && (!cookie || /[\r\n]/.test(cookie))) {
  console.error(
    "Existing assured Development session cookie required through stdin only.",
  );
  process.exit(1);
}
class SmokeError extends Error {}
function assert(condition, message) {
  if (!condition) throw new SmokeError(message);
}
let requests = 0,
  mutations = 0;
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
    "GET-only verification prohibits mutations.",
  );
  const response = await fetch(
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
  requests++;
  if (body !== undefined) mutations++;
  const data = await response.json().catch(() => null);
  assert(
    response.status === status,
    `Request status mismatch: expected ${status}, received ${response.status}.`,
  );
  return data;
}
const read = (path) => call(path);
function replay(first, repeated) {
  assert(
    first?.replayed === false && repeated?.replayed === true,
    "Idempotency replay flags failed.",
  );
  assert(
    JSON.stringify({ ...first, replayed: true }) === JSON.stringify(repeated),
    "Idempotency replay result changed.",
  );
}
async function preferenceSmoke(initial) {
  const pref = initial.items.find(
    (item) => item.category === "TRANSACTIONAL" && item.channel === "IN_APP",
  );
  assert(
    pref && typeof pref.enabled === "boolean" && Number.isInteger(pref.version),
    "Transactional in-app preference unavailable.",
  );
  const key = randomUUID(),
    body = {
      category: "TRANSACTIONAL",
      channel: "IN_APP",
      enabled: !pref.enabled,
      version: pref.version,
    };
  try {
    const updated = await call("/me/notification-preferences", body, { key });
    replay(updated, await call("/me/notification-preferences", body, { key }));
    await call(
      "/me/notification-preferences",
      { ...body, enabled: pref.enabled },
      { key, status: 409 },
    );
  } finally {
    const current = (await read("/me/notification-preferences")).items.find(
      (item) => item.category === "TRANSACTIONAL" && item.channel === "IN_APP",
    );
    assert(current, "Preference restoration could not read current state.");
    if (
      current.version === pref.version + 1 &&
      current.enabled === !pref.enabled
    ) {
      await call("/me/notification-preferences", {
        category: "TRANSACTIONAL",
        channel: "IN_APP",
        enabled: pref.enabled,
        version: current.version,
      });
      const restored = (await read("/me/notification-preferences")).items.find(
        (item) =>
          item.category === "TRANSACTIONAL" && item.channel === "IN_APP",
      );
      assert(
        restored.enabled === pref.enabled,
        "Initial in-app preference was not restored.",
      );
    } else {
      assert(
        current.version === pref.version && current.enabled === pref.enabled,
        "Concurrent preference change preserved; restoration requires review.",
      );
    }
  }
}
async function inboxSmoke(inbox) {
  assert(Array.isArray(inbox.items), "Private inbox unavailable.");
  if (!inbox.items.length) {
    console.log(
      "SKIP positive membership notification materialization and read: inbox empty; no source fabricated.",
    );
    return;
  }
  const item = inbox.items[0];
  const page = await read(
    `/me/notifications?limit=1&cursor=${encodeURIComponent(item.id)}`,
  );
  assert(
    Array.isArray(page.items) && page.items.every((row) => row.id !== item.id),
    "Owner inbox cursor did not advance.",
  );
  if (!verifyOnly) {
    const key = randomUUID(),
      body = { version: item.version },
      path = `/me/notifications/${item.id}/read`;
    replay(await call(path, body, { key }), await call(path, body, { key }));
    const refreshed = await read("/me/notifications?limit=50");
    const saved = refreshed.items.find((row) => row.id === item.id);
    assert(saved?.readAt, "Inbox read state unavailable.");
  }
  console.log(
    "PASS existing owner inbox pagination and permitted read checks.",
  );
}
async function caseSmoke(personId) {
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
  const own = await read(path);
  assert(
    own.status === "OPEN" && own.version === 1 && own.messages.length === 1,
    "Synthetic own case creation failed.",
  );
  const replyBody = { version: 1, body: "Synthetic additional information." },
    replyKey = randomUUID();
  replay(
    await call(`${path}/reply`, replyBody, { key: replyKey }),
    await call(`${path}/reply`, replyBody, { key: replyKey }),
  );
  await call(`${path}/reply`, replyBody, { status: 409 });
  const adminPath = `/admin/support-cases/${created.caseId}`;
  const assigned = await call(`${adminPath}/assign`, {
    version: 2,
    assigneePersonId: personId,
  });
  assert(
    assigned.status === "ASSIGNED" && assigned.version === 3,
    "Synthetic staff self-assignment failed.",
  );
  const staffReply = await call(`${adminPath}/reply`, {
    version: 3,
    body: "Synthetic staff response; no delivery or service promise.",
  });
  assert(staffReply.version === 4, "Synthetic staff reply failed.");
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
  const follow = await call("/me/support-cases", {
    ...creation,
    previousCaseId: created.caseId,
  });
  await call(`/me/support-cases/${follow.caseId}/close`, { version: 1 });
  const followed = await read(`/me/support-cases/${follow.caseId}`);
  assert(
    followed.previousCaseId === created.caseId && followed.status === "CLOSED",
    "Synthetic linked follow-up did not close.",
  );
  console.log(
    "PASS synthetic support cases: 2 closed; customer/staff CAS, replay, assignment, replies and terminal denial.",
  );
}
async function main() {
  const health = await call("/health", undefined, { authenticated: false });
  assert(health, "Development health unavailable.");
  for (const path of [
    "/me/notifications",
    "/me/notification-preferences",
    "/me/support-cases",
    "/admin/support-cases",
  ])
    await call(path, undefined, { authenticated: false, status: 401 });
  for (const host of [adminHost, portalHost]) {
    for (const asset of ["/", "/app.js"]) {
      const response = await fetch(`https://${host}${asset}`, {
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
      const text = await response.text();
      requests++;
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
  console.log(
    "PASS Development health, anonymous protection and communication UI assets.",
  );
  if (!anonymous) {
    const me = await read("/me");
    assert(
      me.mfaEnabled === true && typeof me.personId === "string",
      "Existing assured MFA Admin session required.",
    );
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
    console.log(
      verifyOnly
        ? "PASS authenticated GET-only communication verification."
        : "PASS authenticated communication smoke; initial in-app preference restored.",
    );
  }
  console.log(`PASS requests=${requests}; mutation_requests=${mutations}.`);
}
main().catch((error) => {
  console.error(
    error instanceof SmokeError
      ? error.message
      : "Development communication smoke failed; response and credentials withheld.",
  );
  process.exitCode = 1;
});

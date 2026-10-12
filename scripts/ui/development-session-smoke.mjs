/** Read-only/anonymous Development session protocol checks; no human-session claim. */
import assert from "node:assert/strict";

for (const app of ["admin", "portal"]) {
  const origin = `https://motorbaldi-${app}-development.josegbarrios2.workers.dev`;
  const call = (path, init = {}) =>
    fetch(origin + path, {
      ...init,
      signal: AbortSignal.timeout(30000),
      headers: { origin, ...init.headers },
    });
  const html = await call("/");
  assert.equal(html.status, 200);
  assert.match(html.headers.get("cache-control") ?? "", /no-store/);
  assert.ok(html.headers.get("content-security-policy"));
  const script = await call("/app.js");
  assert.equal(script.status, 200);
  assert.match(await script.text(), /function uiSignOut/);
  const original = await call("/api/v1/auth/sign-out", { method: "POST" });
  assert.equal(original.status, 415);
  assert.equal((await original.json()).code, "UNSUPPORTED_MEDIA_TYPE");
  const rejected = await call("/api/v1/auth/sign-out", {
    method: "POST",
    headers: {
      origin: "https://untrusted.example.test",
      cookie: "__Secure-better-auth.session_token=synthetic-invalid",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(rejected.status, 403);
  const logout = await call("/api/v1/auth/sign-out", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(logout.status, 200);
  assert.equal((await logout.json()).success, true);
  const cookies = logout.headers.getSetCookie();
  assert.ok(cookies.length >= 2);
  for (const cookie of cookies) {
    assert.match(cookie, /Max-Age=0/i);
    assert.match(cookie, /Path=\//i);
    assert.match(cookie, /Secure/i);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Lax/i);
    assert.doesNotMatch(cookie, /Domain=/i);
  }
  const session = await call("/api/v1/auth/get-session");
  assert.equal(session.status, 200);
  assert.equal(await session.json(), null);
  for (const path of ["/api/v1/me", "/api/v1/admin/access"])
    assert.equal((await call(path)).status, 401);
  console.log(
    `PASS Development ${app}: JSON logout, expired host-only secure cookies, no-store, CSRF origin denial, anonymous session/private denial`,
  );
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { authorization, can, type Actor } from "@motorbaldi/authz";
const actor: Actor = {
  accountId: "A",
  personId: null,
  active: true,
  permissions: new Set(["work_order.read", "unknown"]),
};
const context = {
  requestId: "request",
  now: new Date(),
  organizationId: "org-A",
};
test("unregistered action always DENIED even if actor claims permission", () => {
  assert.equal(
    can(actor, "unknown", { type: "vehicle", id: "1" }, context),
    false,
  );
});
test("RBAC alone cannot authorize another organization", () => {
  const engine = authorization(
    new Map([
      ["work_order.read", (_a, r, c) => r.organizationId === c.organizationId],
    ]),
  );
  assert.equal(
    engine.can(
      actor,
      "work_order.read",
      { type: "work_order", id: "1", organizationId: "org-B" },
      context,
    ),
    false,
  );
  assert.equal(
    engine.can(
      null,
      "work_order.read",
      { type: "work_order", id: "1", organizationId: "org-A" },
      context,
    ),
    false,
  );
  assert.equal(
    engine.can(
      { ...actor, active: false },
      "work_order.read",
      { type: "work_order", id: "1", organizationId: "org-A" },
      context,
    ),
    false,
  );
  assert.equal(
    engine.can(
      actor,
      "work_order.read",
      { type: "work_order", id: "1", organizationId: "org-A" },
      context,
    ),
    true,
  );
});

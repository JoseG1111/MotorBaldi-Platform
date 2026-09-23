import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedHandler } from "@motorbaldi/messaging/handler";
test("timeout aborts a delayed handler without exposing a transaction", async () => {
  let signal: AbortSignal | undefined;
  await assert.rejects(
    () =>
      boundedHandler(
        async (_event, context) => {
          signal = context.signal;
          await new Promise(() => {});
        },
        {
          id: "id",
          event_type: "test",
          aggregate_id: "id",
          payload: {},
          request_id: "request",
          attempts: 0,
          status: "PROCESSING",
          aggregate_type: "fixture",
          event_version: 1,
          external_effect_policy: "RECONCILE",
        },
        10,
      ),
    /HANDLER_TIMEOUT/,
  );
  assert.equal(signal?.aborted, true);
});

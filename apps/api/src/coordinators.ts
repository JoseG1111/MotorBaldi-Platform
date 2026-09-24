import { DurableObject } from "cloudflare:workers";
import type { ApiBindings } from "@motorbaldi/config";
import {
  readReplay,
  storeReplay,
  type IdempotencyScope,
} from "@motorbaldi/db/idempotency";
import { relayOutbox } from "@motorbaldi/messaging/queue";
import { Problem } from "@motorbaldi/contracts";
import type { Json } from "@motorbaldi/shared";

export class IdempotencyCoordinator extends DurableObject<ApiBindings> {
  private tail: Promise<void> = Promise.resolve();
  private async execute(
    operation: string,
    request: Json,
    requestId: string,
  ): Promise<Json> {
    if (operation !== "foundation.test")
      throw new Problem(
        400,
        "UNKNOWN_IDEMPOTENCY_OPERATION",
        "Unknown idempotent operation",
      );
    const input = request as Record<string, Json>;
    if (typeof input.responseBytes === "number" && input.responseBytes > 8000)
      throw new Problem(
        413,
        "IDEMPOTENCY_RESPONSE_TOO_LARGE",
        "Idempotent response is too large to store",
      );
    const effects =
      ((await this.ctx.storage.get<number>("foundation-effects")) ?? 0) + 1;
    await this.ctx.storage.put("foundation-effects", effects);
    return { ok: true, requestId, effectNumber: effects };
  }

  async fetch(request: Request) {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.run(request);
    } catch (error) {
      if (error instanceof Problem)
        return Response.json(
          { code: error.code, message: error.message },
          { status: error.status },
        );
      throw error;
    } finally {
      release();
    }
  }

  private async run(request: Request) {
    if (new URL(request.url).pathname !== "/run" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    const input = (await request.json()) as {
      key: string;
      scope: IdempotencyScope;
      request: Json;
      requestId: string;
    };
    const replay = await readReplay<Json>(
      this.env.DB,
      input.scope,
      input.key,
      input.request,
    );
    if (replay)
      return Response.json({
        ...(replay.response as Record<string, Json>),
        replayed: true,
      });
    const response = await this.execute(
      input.scope.operation,
      input.request,
      input.requestId,
    );
    try {
      await storeReplay(
        this.env.DB,
        input.scope,
        input.key,
        input.request,
        response,
      );
    } catch (error) {
      const replayAfterRace = await readReplay<Json>(
        this.env.DB,
        input.scope,
        input.key,
        input.request,
      );
      if (replayAfterRace)
        return Response.json({
          ...(replayAfterRace.response as Record<string, Json>),
          replayed: true,
        });
      throw error;
    }
    return Response.json({
      ...(response as Record<string, Json>),
      replayed: false,
    });
  }
}

export class OutboxCoordinator extends DurableObject<ApiBindings> {
  async relay() {
    if (!this.env.EVENTS_QUEUE)
      throw new Problem(503, "QUEUE_UNAVAILABLE", "Events queue unavailable");
    return relayOutbox(this.env.DB, this.env.EVENTS_QUEUE);
  }

  async fetch() {
    return Response.json({ relayed: await this.relay() });
  }
}

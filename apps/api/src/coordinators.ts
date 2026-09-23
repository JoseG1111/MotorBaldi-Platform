import { DurableObject } from "cloudflare:workers";
import type { PlatformBindings } from "@motorbaldi/config";
import {
  readReplay,
  storeReplay,
  type IdempotencyScope,
} from "@motorbaldi/db/idempotency";
import { relayOutbox } from "@motorbaldi/messaging/queue";
import { Problem } from "@motorbaldi/contracts";
import type { Json } from "@motorbaldi/shared";

export class IdempotencyCoordinator extends DurableObject<PlatformBindings> {
  async fetch(request: Request) {
    if (new URL(request.url).pathname !== "/run" || request.method !== "POST")
      return new Response("Not found", { status: 404 });
    const input = (await request.json()) as {
      key: string;
      scope: IdempotencyScope;
      request: Json;
      response: Json;
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
    try {
      await storeReplay(
        this.env.DB,
        input.scope,
        input.key,
        input.request,
        input.response,
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
      ...(input.response as Record<string, Json>),
      replayed: false,
    });
  }
}

export class OutboxCoordinator extends DurableObject<PlatformBindings> {
  async relay() {
    if (!this.env.EVENTS_QUEUE)
      throw new Problem(503, "QUEUE_UNAVAILABLE", "Events queue unavailable");
    return relayOutbox(this.env.DB, this.env.EVENTS_QUEUE);
  }

  async fetch() {
    return Response.json({ relayed: await this.relay() });
  }
}

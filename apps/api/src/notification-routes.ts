import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  listNotificationPreferences,
  listNotificationInbox,
  parseNotificationCommand,
} from "@motorbaldi/messaging";
import type { Json } from "@motorbaldi/shared";

export async function notificationRoutes(
  request: Request,
  db: D1Database,
  principal: () => Promise<Principal & { personId: string }>,
  execute: (operation: string, body: Json) => Promise<unknown>,
  readBody: () => Promise<unknown>,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const reply = (value: unknown) =>
    Response.json(value, { headers: { ...cors, "cache-control": "no-store" } });
  const method = (value: string) => {
    if (request.method !== value)
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  };
  if (url.pathname === "/api/v1/me/notification-preferences") {
    if (request.method === "GET")
      return reply(await listNotificationPreferences(db, await principal()));
    method("POST");
    await principal();
    return reply(
      await execute(
        "notification.preference.update",
        parseNotificationCommand(
          "notification.preference.update",
          (await readBody()) as Json,
        ),
      ),
    );
  }
  if (url.pathname === "/api/v1/me/notifications") {
    method("GET");
    const cursor = z
      .string()
      .uuid()
      .optional()
      .parse(url.searchParams.get("cursor") ?? undefined);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .parse(url.searchParams.get("limit") ?? 20);
    return reply(
      await listNotificationInbox(db, await principal(), { cursor, limit }),
    );
  }
  const read = url.pathname.match(
    /^\/api\/v1\/me\/notifications\/([0-9a-f-]{36})\/read$/,
  );
  if (read) {
    method("POST");
    await principal();
    const body = z
      .object({ version: z.number().int().positive() })
      .strict()
      .parse(await readBody());
    return reply(
      await execute("notification.inbox.read", {
        ...body,
        notificationId: read[1]!,
      }),
    );
  }
  return null;
}

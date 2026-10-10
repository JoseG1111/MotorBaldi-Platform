import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  getSupportCase,
  listSupportCases,
  parseSupportCommand,
} from "@motorbaldi/messaging";
import type { Json } from "@motorbaldi/shared";

export async function supportRoutes(
  request: Request,
  db: D1Database,
  principal: () => Promise<Principal & { personId: string }>,
  execute: (operation: string, body: Json) => Promise<unknown>,
  readBody: () => Promise<unknown>,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(
    /^\/api\/v1\/(me|admin)\/support-cases(?:\/([0-9a-f-]{36})(?:\/(reply|assign|close))?)?$/,
  );
  if (!match) return null;
  const staff = match[1] === "admin",
    caseId = match[2],
    action = match[3];
  const reply = (value: unknown) =>
    Response.json(value, { headers: { ...cors, "cache-control": "no-store" } });
  const method = (expected: string) => {
    if (request.method !== expected)
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  };
  if (!caseId && request.method === "GET") {
    const actor = await principal();
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
    return reply(await listSupportCases(db, actor, { staff, cursor, limit }));
  }
  if (caseId && !action) {
    method("GET");
    return reply(
      await getSupportCase(
        db,
        await principal(),
        z.string().uuid().parse(caseId),
        { staff },
      ),
    );
  }
  if ((!caseId && staff) || (action === "assign" && !staff)) {
    throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  }
  method("POST");
  await principal();
  const operation = `support.case.${action ?? "create"}`;
  const schemas = {
    create: z
      .object({
        subject: z.string(),
        body: z.string(),
        previousCaseId: z.string().uuid().nullable().optional(),
      })
      .strict(),
    reply: z
      .object({ version: z.number().int().positive(), body: z.string() })
      .strict(),
    assign: z
      .object({
        version: z.number().int().positive(),
        assigneePersonId: z.string().uuid(),
      })
      .strict(),
    close: z
      .object({
        version: z.number().int().positive(),
        resolution: z.string().nullable().optional(),
      })
      .strict(),
  };
  const body = schemas[(action ?? "create") as keyof typeof schemas].parse(
    await readBody(),
  );
  return reply(
    await execute(
      operation,
      parseSupportCommand(operation, {
        ...body,
        staff,
        ...(caseId ? { caseId: z.string().uuid().parse(caseId) } : {}),
      }),
    ),
  );
}

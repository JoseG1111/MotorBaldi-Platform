import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  discoverCustomerWorkshops,
  listCustomerWorkshopContacts,
  listOrganizationWorkshopContacts,
  parseCustomerWorkshopCommand,
} from "@motorbaldi/workshops";
import type { Json } from "@motorbaldi/shared";
export async function customerWorkshopRoutes(
  request: Request,
  db: D1Database,
  principal: () => Promise<Principal & { personId: string }>,
  execute: (
    operation: string,
    body: Json,
    organizationId: string,
  ) => Promise<unknown>,
  readBody: () => Promise<unknown>,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url),
    path = url.pathname;
  const reply = (body: unknown) =>
    Response.json(body, { headers: { ...cors, "cache-control": "no-store" } });
  const method = (expected: string) => {
    if (request.method !== expected)
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  };
  const cursor = url.searchParams.get("cursor") ?? "";
  if (path === "/api/v1/workshops/discovery") {
    method("GET");
    return reply(
      await discoverCustomerWorkshops(
        db,
        await principal(),
        url.searchParams.get("q") ?? "",
        cursor,
      ),
    );
  }
  if (path === "/api/v1/me/workshop-contact-requests") {
    method("GET");
    return reply(
      await listCustomerWorkshopContacts(db, await principal(), cursor),
    );
  }
  const uuid = "[0-9a-f-]{36}";
  const create = path.match(
    new RegExp("^/api/v1/workshops/(" + uuid + ")/contact-requests$"),
  );
  const org = path.match(
    new RegExp(
      "^/api/v1/organizations/(" +
        uuid +
        ")/workshop/contact-requests(?:/(" +
        uuid +
        ")/close)?$",
    ),
  );
  if (!create && !org) return null;
  if (org && !org[2]) {
    method("GET");
    return reply(
      await listOrganizationWorkshopContacts(
        db,
        await principal(),
        org[1]!,
        cursor,
      ),
    );
  }
  method("POST");
  await principal();
  const body = await readBody();
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Problem(400, "INVALID_WORKSHOP_CONTACT", "Object required");
  const extra = create
    ? { organizationId: create[1]! }
    : { organizationId: org![1]!, requestId: org![2]! };
  for (const field of Object.keys(extra))
    if (field in body)
      throw new Problem(
        400,
        "INVALID_WORKSHOP_CONTACT",
        "Route identifiers cannot be overridden",
      );
  const operation = create
    ? "workshop.contact.create"
    : "workshop.contact.close";
  const parsed = parseCustomerWorkshopCommand(operation, { ...body, ...extra });
  return reply(await execute(operation, parsed, String(parsed.organizationId)));
}

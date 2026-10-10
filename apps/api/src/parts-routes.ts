import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  getCanonicalPart,
  getPartsOffering,
  listCanonicalParts,
  listCanonicalPartsForOrganization,
  listPartsOfferings,
  listWorkshopPartSnapshots,
  listWorkshopPartsOfferings,
  matchCanonicalParts,
  matchCanonicalPartsForOrganization,
  parsePartsCommand,
  partsCommandInputs,
} from "@motorbaldi/parts";
import type { Json } from "@motorbaldi/shared";

const id = z.string().uuid();
const paging = {
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};
const location = { locationId: id.optional() };
const identity = {
  brand: z.string().trim().min(1).max(160),
  manufacturerReference: z.string().trim().min(1).max(160),
};

export async function partsRoutes(
  request: Request,
  db: D1Database,
  principal: () => Promise<Principal & { personId: string }>,
  execute: (
    operation: string,
    body: Json,
    organizationId?: string,
  ) => Promise<unknown>,
  readBody: () => Promise<unknown>,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const admin = url.pathname.match(
    /^\/api\/v1\/admin\/parts(?:\/([^/]+)(?:\/(update|transition))?)?$/,
  );
  const offerings = url.pathname.match(
    /^\/api\/v1\/organizations\/([^/]+)\/parts-offerings(?:\/([^/]+)(?:\/(update|transition))?)?$/,
  );
  const catalog = url.pathname.match(
    /^\/api\/v1\/organizations\/([^/]+)\/parts-catalog(?:\/(match))?$/,
  );
  const workshop = url.pathname.match(
    /^\/api\/v1\/organizations\/([^/]+)\/workshop\/orders\/([^/]+)\/parts(?:\/(offerings))?$/,
  );
  if (!admin && !offerings && !catalog && !workshop) return null;
  const method = (expected: string) => {
    if (request.method !== expected)
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  };
  const reply = (value: unknown) =>
    Response.json(value, { headers: { ...cors, "cache-control": "no-store" } });
  const query = <T extends z.ZodType>(schema: T): z.output<T> => {
    const value: Record<string, string> = {};
    for (const [key, item] of url.searchParams) {
      if (Object.hasOwn(value, key))
        throw new Problem(
          400,
          "INVALID_PARTS_QUERY",
          "Duplicate query parameter",
        );
      value[key] = item;
    }
    return schema.parse(value);
  };
  const actor = await principal();
  if (catalog) {
    method("GET");
    const organizationId = id.parse(catalog[1]);
    return reply(
      catalog[2]
        ? await matchCanonicalPartsForOrganization(
            db,
            actor,
            organizationId,
            query(z.object({ ...identity, ...location }).strict()),
          )
        : await listCanonicalPartsForOrganization(
            db,
            actor,
            organizationId,
            query(z.object({ ...paging, ...location }).strict()),
          ),
    );
  }
  if (workshop) {
    const organizationId = id.parse(workshop[1]),
      orderId = id.parse(workshop[2]);
    if (workshop[3]) {
      method("GET");
      return reply(
        await listWorkshopPartsOfferings(
          db,
          actor,
          organizationId,
          orderId,
          query(z.object(paging).strict()),
        ),
      );
    }
    if (request.method === "GET") {
      return reply(
        await listWorkshopPartSnapshots(
          db,
          actor,
          organizationId,
          orderId,
          query(z.object(paging).strict()),
        ),
      );
    }
    method("POST");
    query(z.object({}).strict());
    const operation = "parts.workshop.snapshot.add";
    const body = partsCommandInputs[operation]
      .omit({ organizationId: true, orderId: true })
      .strict()
      .parse(await readBody());
    return reply(
      await execute(
        operation,
        parsePartsCommand(operation, { ...body, organizationId, orderId }),
        organizationId,
      ),
    );
  }
  if (admin) {
    const partId = admin[1],
      action = admin[2];
    if (partId === "match" && !action) {
      method("GET");
      return reply(
        await matchCanonicalParts(
          db,
          actor,
          query(z.object(identity).strict()),
        ),
      );
    }
    if (!partId && request.method === "GET")
      return reply(
        await listCanonicalParts(
          db,
          actor,
          query(
            z
              .object({
                ...paging,
                status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).optional(),
              })
              .strict(),
          ),
        ),
      );
    if (partId && !action) {
      method("GET");
      query(z.object({}).strict());
      return reply(await getCanonicalPart(db, actor, id.parse(partId)));
    }
    method("POST");
    query(z.object({}).strict());
    if (!partId) {
      const operation = "parts.canonical.create";
      return reply(
        await execute(
          operation,
          parsePartsCommand(operation, await readBody()),
        ),
      );
    }
    const operation =
      action === "update"
        ? "parts.canonical.update"
        : "parts.canonical.transition";
    const bodySchema =
      action === "update"
        ? partsCommandInputs["parts.canonical.update"].omit({ partId: true })
        : partsCommandInputs["parts.canonical.transition"].omit({
            partId: true,
          });
    const body = bodySchema.strict().parse(await readBody());
    return reply(
      await execute(
        operation,
        parsePartsCommand(operation, { ...body, partId: id.parse(partId) }),
      ),
    );
  }
  const organizationId = id.parse(offerings![1]),
    offeringId = offerings![2],
    action = offerings![3];
  if (!offeringId && request.method === "GET")
    return reply(
      await listPartsOfferings(
        db,
        actor,
        organizationId,
        query(
          z
            .object({
              ...paging,
              ...location,
              status: z.enum(["DRAFT", "ACTIVE", "INACTIVE"]).optional(),
            })
            .strict(),
        ),
      ),
    );
  if (offeringId && !action) {
    method("GET");
    query(z.object({}).strict());
    return reply(
      await getPartsOffering(db, actor, organizationId, id.parse(offeringId)),
    );
  }
  method("POST");
  query(z.object({}).strict());
  if (!offeringId) {
    const operation = "parts.offering.create";
    const body = partsCommandInputs[operation]
      .omit({ organizationId: true })
      .strict()
      .parse(await readBody());
    return reply(
      await execute(
        operation,
        parsePartsCommand(operation, { ...body, organizationId }),
        organizationId,
      ),
    );
  }
  const operation =
    action === "update" ? "parts.offering.update" : "parts.offering.transition";
  const bodySchema =
    action === "update"
      ? partsCommandInputs["parts.offering.update"].omit({
          organizationId: true,
          offeringId: true,
        })
      : partsCommandInputs["parts.offering.transition"].omit({
          organizationId: true,
          offeringId: true,
        });
  const body = bodySchema.strict().parse(await readBody());
  return reply(
    await execute(
      operation,
      parsePartsCommand(operation, {
        ...body,
        organizationId,
        offeringId: id.parse(offeringId),
      }),
      organizationId,
    ),
  );
}

import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  getMarketplaceOwned,
  getMarketplacePublic,
  listMarketplaceOwned,
  listMarketplacePublic,
  listMarketplaceReview,
  marketplaceCapabilities,
  marketplaceCommandInputs,
  parseMarketplaceCommand,
  type MarketplaceOperation,
} from "@motorbaldi/parts";
import type { Json } from "@motorbaldi/shared";

const id = z.uuid();
const paging = {
  cursor: id.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
};
const publicPaging = z
  .object({
    ...paging,
    q: z.string().trim().max(100).optional(),
    category: z.string().trim().max(100).optional(),
  })
  .strict();
const privatePaging = z.object(paging).strict();
const staffPaging = z
  .object({
    ...paging,
    status: z
      .enum(["DRAFT", "PENDING_REVIEW", "PUBLISHED", "SUSPENDED"])
      .optional(),
  })
  .strict();
const empty = z.object({}).strict();
export async function marketplaceRoutes(
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
  const publicRoute = url.pathname.match(
    /^\/api\/v1\/public\/parts(?:\/([^/]+))?$/,
  );
  const owned = url.pathname.match(
    /^\/api\/v1\/organizations\/([^/]+)\/marketplace-listings(?:\/([^/]+)(?:\/(submit|withdraw))?)?$/,
  );
  const staff = url.pathname.match(
    /^\/api\/v1\/admin\/marketplace\/listings(?:\/([^/]+)\/(approve|reject|suspend))?$/,
  );
  if (!publicRoute && !owned && !staff) return null;
  const method = (expected: string) => {
    if (request.method !== expected)
      throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  };
  const query = <T extends z.ZodType>(schema: T): z.output<T> => {
    const value: Record<string, string> = {};
    for (const [key, item] of url.searchParams) {
      if (Object.hasOwn(value, key))
        throw new Problem(
          400,
          "INVALID_MARKETPLACE_QUERY",
          "Duplicate query parameter",
        );
      value[key] = item;
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success)
      throw new Problem(
        400,
        "INVALID_MARKETPLACE_QUERY",
        "Invalid marketplace query",
      );
    return parsed.data;
  };
  const reply = (value: unknown) =>
    Response.json(value, { headers: { ...cors, "cache-control": "no-store" } });
  const page = (items: Record<string, Json>[], limit: number) => ({
    items,
    nextCursor:
      items.length === limit ? (items.at(-1)?.listingId ?? null) : null,
  });
  if (publicRoute) {
    method("GET");
    if (publicRoute[1] === "capabilities") {
      query(empty);
      return reply(marketplaceCapabilities);
    }
    if (publicRoute[1]) {
      query(empty);
      return reply(await getMarketplacePublic(db, id.parse(publicRoute[1])));
    }
    const { q, ...options } = query(publicPaging);
    return reply(
      page(
        await listMarketplacePublic(db, { ...options, query: q }),
        options.limit,
      ),
    );
  }
  const actor = await principal();
  if (staff) {
    if (!staff[1]) {
      method("GET");
      const options = query(staffPaging);
      return reply(
        page(await listMarketplaceReview(db, actor, options), options.limit),
      );
    }
    method("POST");
    query(empty);
    const operation = `marketplace.listing.${staff[2]}` as MarketplaceOperation;
    const body = marketplaceCommandInputs["marketplace.listing.approve"]
      .omit({ listingId: true })
      .strict()
      .parse(await readBody());
    return reply(
      await execute(
        operation,
        parseMarketplaceCommand(operation, {
          ...body,
          listingId: id.parse(staff[1]),
        }),
        body.organizationId,
      ),
    );
  }
  const organizationId = id.parse(owned![1]),
    listingId = owned![2],
    action = owned![3];
  if (!listingId && request.method === "GET") {
    const options = query(privatePaging);
    return reply(
      page(
        await listMarketplaceOwned(db, actor, organizationId, options),
        options.limit,
      ),
    );
  }
  if (listingId && !action) {
    method("GET");
    query(empty);
    return reply(
      await getMarketplaceOwned(db, actor, organizationId, id.parse(listingId)),
    );
  }
  method("POST");
  query(empty);
  if (!listingId) {
    const operation = "marketplace.listing.create";
    const body = marketplaceCommandInputs[operation]
      .omit({ organizationId: true })
      .strict()
      .parse(await readBody());
    return reply(
      await execute(
        operation,
        parseMarketplaceCommand(operation, { ...body, organizationId }),
        organizationId,
      ),
    );
  }
  const operation = `marketplace.listing.${action}` as MarketplaceOperation;
  const body = marketplaceCommandInputs["marketplace.listing.submit"]
    .omit({ organizationId: true, listingId: true })
    .strict()
    .parse(await readBody());
  return reply(
    await execute(
      operation,
      parseMarketplaceCommand(operation, {
        ...body,
        organizationId,
        listingId: id.parse(listingId),
      }),
      organizationId,
    ),
  );
}

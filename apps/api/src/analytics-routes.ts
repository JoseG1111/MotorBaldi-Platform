import { z } from "zod";
import { Problem, type Principal } from "@motorbaldi/contracts";
import {
  queryCanonicalPartsReport,
  queryOrganizationPartsReport,
  queryPlatformQueueReport,
} from "@motorbaldi/analytics";

const empty = z.object({}).strict();
const organizationQuery = z
  .object({ locationId: z.uuid().optional() })
  .strict();
/** Private transient reports reuse the same assured source authority; no mutation or export. */
export async function analyticsRoutes(
  request: Request,
  db: D1Database,
  principal: () => Promise<Principal & { personId: string }>,
  cors: Record<string, string>,
): Promise<Response | null> {
  const url = new URL(request.url);
  const platform = url.pathname.match(
    /^\/api\/v1\/admin\/analytics\/(parts|queue)$/,
  );
  const organization = url.pathname.match(
    /^\/api\/v1\/organizations\/([^/]+)\/analytics\/parts$/,
  );
  if (!platform && !organization) return null;
  if (request.method !== "GET")
    throw new Problem(405, "METHOD_NOT_ALLOWED", "Method not allowed");
  const actor = await principal();
  const values: Record<string, string> = {};
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(values, key))
      throw new Problem(400, "INVALID_ANALYTICS_QUERY", "Invalid report query");
    values[key] = value;
  }
  const query = (platform ? empty : organizationQuery).safeParse(values);
  if (!query.success)
    throw new Problem(400, "INVALID_ANALYTICS_QUERY", "Invalid report query");
  let report;
  if (platform)
    report =
      platform[1] === "parts"
        ? await queryCanonicalPartsReport(db, actor)
        : await queryPlatformQueueReport(db, actor);
  else {
    const organizationId = z.uuid().safeParse(organization![1]);
    if (!organizationId.success)
      throw new Problem(400, "INVALID_ANALYTICS_QUERY", "Invalid report scope");
    report = await queryOrganizationPartsReport(
      db,
      actor,
      organizationId.data,
      "locationId" in query.data ? (query.data.locationId ?? null) : null,
    );
  }
  return Response.json(report, {
    headers: {
      ...cors,
      "cache-control": "no-store",
      "x-data-classification": "INTERNAL",
    },
  });
}

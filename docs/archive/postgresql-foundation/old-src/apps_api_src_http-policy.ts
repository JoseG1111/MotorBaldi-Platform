import type { FastifyRequest } from "fastify";
import { Problem } from "@motorbaldi/contracts";

export type MutationPolicy =
  | { strategy: "browser" }
  | {
      strategy: "authenticated";
      authenticate: (request: FastifyRequest) => Promise<boolean>;
    };
declare module "fastify" {
  interface FastifyContextConfig {
    mutationPolicy?: MutationPolicy;
    bodyPolicy?: "json" | "bodyless" | "multipart";
  }
}
export async function enforceMutationPolicy(
  req: FastifyRequest,
  origins: readonly string[],
) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const policy = req.routeOptions.config.mutationPolicy;
  if (!policy)
    throw new Problem(403, "MUTATION_POLICY_REQUIRED", "Request rejected");
  if (policy.strategy === "browser") {
    if (!req.headers.origin || !origins.includes(req.headers.origin))
      throw new Problem(403, "ORIGIN_DENIED", "Origin denied");
  } else if (req.headers.cookie || !(await policy.authenticate(req))) {
    throw new Problem(401, "UNAUTHENTICATED", "Authentication required");
  }
}
export function enforceBodyPolicy(req: FastifyRequest) {
  const policy = req.routeOptions.config.bodyPolicy ?? "json";
  if (
    policy === "json" &&
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.headers["content-length"] !== "0" &&
    !req.headers["content-type"]?.startsWith("application/json")
  )
    throw new Problem(415, "CONTENT_TYPE", "JSON required");
}

/** Bounded per-process fallback protects independent reads; auth always fails closed. */
export class RequestLimiter {
  private readonly windows = new Map<
    string,
    { count: number; until: number }
  >();
  constructor(
    private readonly redis: {
      eval: (
        ...args: [string, number, ...Array<string | number>]
      ) => Promise<unknown>;
    },
    private readonly namespace: string,
  ) {}
  async check(ip: string, sensitive: boolean, now = Date.now()) {
    let count: number;
    try {
      count = Number(
        await this.redis.eval(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('PEXPIRE',KEYS[1],60000) end; return n",
          1,
          `${this.namespace}:${sensitive ? "auth" : "api"}:${ip}`,
        ),
      );
    } catch {
      if (sensitive)
        throw new Problem(
          503,
          "SECURITY_DEPENDENCY_UNAVAILABLE",
          "Authentication temporarily unavailable",
        );
      for (const [key, value] of this.windows)
        if (value.until <= now) this.windows.delete(key);
      let window = this.windows.get(ip);
      if (!window) {
        if (this.windows.size >= 10000)
          throw new Problem(
            503,
            "RATE_LIMIT_CAPACITY",
            "Temporarily unavailable",
          );
        window = { count: 0, until: now + 60000 };
        this.windows.set(ip, window);
      }
      count = ++window.count;
    }
    if (count > (sensitive ? 10 : 60))
      throw new Problem(429, "RATE_LIMITED", "Too many requests");
  }
}

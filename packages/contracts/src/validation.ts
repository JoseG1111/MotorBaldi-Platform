import { z } from "zod";
import { Problem } from "./index.js";

/** Call before domain commands. All three surfaces reject undeclared fields. */
export function validateRequest<
  B extends z.ZodRawShape,
  P extends z.ZodRawShape,
  Q extends z.ZodRawShape,
>(
  schemas: {
    body: z.ZodObject<B>;
    params: z.ZodObject<P>;
    query: z.ZodObject<Q>;
  },
  input: { body?: unknown; params?: unknown; query?: unknown },
) {
  const parse = <S extends z.ZodRawShape>(
    schema: z.ZodObject<S>,
    value: unknown,
  ) => {
    const result = schema.strict().safeParse(value ?? {});
    if (!result.success) {
      const details: Record<string, string> = {};
      for (const issue of result.error.issues) {
        const key =
          typeof issue.path[0] === "string" &&
          Object.hasOwn(schema.shape, issue.path[0])
            ? issue.path[0]
            : "request";
        details[key] =
          issue.code === "unrecognized_keys" ? "unknown_fields" : "invalid";
      }
      throw new Problem(
        400,
        "VALIDATION_ERROR",
        "Request validation failed",
        details,
      );
    }
    return result.data;
  };
  return {
    body: parse(schemas.body, input.body),
    params: parse(schemas.params, input.params),
    query: parse(schemas.query, input.query),
  };
}

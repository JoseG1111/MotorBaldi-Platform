import { Problem } from "@motorbaldi/contracts";

// The dependent INSERT deliberately violates its NOT NULL column when a
// conditional UPDATE changed no row. D1 rolls the entire batch back.
export async function guardedBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
  guard: { table: string; column: string; code: string; message: string },
) {
  try {
    return await db.batch(statements);
  } catch (error) {
    if (
      String(error).includes(
        `NOT NULL constraint failed: ${guard.table}.${guard.column}`,
      )
    )
      throw new Problem(409, guard.code, guard.message);
    throw error;
  }
}

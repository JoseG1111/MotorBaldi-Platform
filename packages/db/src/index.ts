export async function one<T>(
  statement: D1PreparedStatement,
): Promise<T | null> {
  return statement.first<T>();
}

export async function all<T>(statement: D1PreparedStatement): Promise<T[]> {
  return (await statement.all<T>()).results ?? [];
}

export async function changed(statement: D1PreparedStatement): Promise<number> {
  return (await statement.run()).meta.changes ?? 0;
}

export * from "./audit.js";
export * from "./environment.js";
export * from "./idempotency.js";
export * from "./outbox.js";

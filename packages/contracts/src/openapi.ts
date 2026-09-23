// Better Auth emits nullable JSON Schema types. Normalize into OpenAPI 3.0.
export function openApi30(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(openApi30);
  if (value === null || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([k, v]) => [k, openApi30(v)]),
  );
  if (Array.isArray(result.type)) {
    const types = result.type.filter((t) => t !== "null");
    if (result.type.includes("null")) result.nullable = true;
    if (types.length === 1) result.type = types[0];
    else {
      delete result.type;
      result.anyOf = types.map((type) => ({ type }));
    }
  }
  return result;
}

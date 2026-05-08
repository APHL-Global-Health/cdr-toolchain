/**
 * Normalize a user-supplied --where value.
 * Accepts either "Region=1" or "WHERE Region=1" and returns the canonical
 * "WHERE Region=1" that disalab/mssql expects. Empty/whitespace → "".
 */
export function normalizeWhere(userWhere: string | undefined): string {
  const body = userWhere?.trim().replace(/^WHERE\s+/i, "") ?? "";
  return body.length === 0 ? "" : `WHERE ${body}`;
}

/**
 * Compose a WHERE that may include cursor pagination (ORDER BY + OFFSET + FETCH).
 * Used by `list` for SQL-level limit/offset push-down.
 */
export function composeWhereWithPagination(
  userWhere: string | undefined,
  limit: number | undefined,
  offset: number,
  cursorColumn: string | undefined,
): { where: string; pushedToSql: boolean } {
  let where = normalizeWhere(userWhere);

  if (limit === undefined && offset === 0) return { where, pushedToSql: false };
  if (cursorColumn === undefined) return { where, pushedToSql: false };

  where += ` ORDER BY ${cursorColumn} OFFSET ${offset} ROWS`;
  if (limit !== undefined) where += ` FETCH NEXT ${limit} ROWS ONLY`;
  return { where, pushedToSql: true };
}

/**
 * Compose a WHERE that combines the user's clause with a cursor `--after` filter.
 * Used by `stream` for resume semantics.
 */
export function composeWhereWithCursor(
  userWhere: string | undefined,
  after: string | undefined,
  cursorColumn: string | undefined,
): string {
  const parts: string[] = [];
  const body = userWhere?.trim().replace(/^WHERE\s+/i, "") ?? "";
  if (body.length > 0) parts.push(body);

  if (after !== undefined) {
    if (cursorColumn === undefined) {
      throw new Error("--after requires an entity with a defined cursor column");
    }
    const escaped = after.replace(/'/g, "''");
    parts.push(`${cursorColumn} > '${escaped}'`);
  }

  return parts.length === 0 ? "" : `WHERE ${parts.join(" AND ")}`;
}

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

/** Direction for a batch lab-selection scan. */
export type SelectionOrder = "asc" | "desc";

/**
 * Compose the lab-selection clause used by the batch commands: the user's
 * WHERE, then a deterministic ORDER BY, then OFFSET/FETCH paging.
 *
 * `export-batch` builds this clause twice, once for the query and once for
 * --explain. Both call this function so --explain can never describe an order
 * the query does not use.
 *
 * DISA lab numbers are chronological, so the order decides which era of data a
 * bounded run selects. Ascending is oldest first and stays the default.
 */
export function composeBatchSelection(
  userWhere: string | undefined,
  column: string,
  limit: number,
  offset: number,
  order: SelectionOrder,
): string {
  const userClause = normalizeWhere(userWhere);
  const direction = order === "desc" ? " DESC" : "";
  return `${userClause} ORDER BY ${column}${direction} OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
}

import { z } from "zod";
import { HTTPException } from "hono/http-exception";
import { sql, type SQL, type AnyColumn } from "drizzle-orm";

const cursorSchema = z
  .object({
    time: z
      .string()
      .regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}$/)
      .refine((value) => {
        const date = new Date(`${value}Z`);
        return (
          value.slice(0, 4) !== "0000" &&
          Number.isFinite(date.getTime()) &&
          date.toISOString().slice(0, 19) === value.slice(0, 19)
        );
      }),
    id: z.string().uuid(),
  })
  .strict();

const querySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .transform(Number)
      .refine((n) => n <= 100)
      .default("25"),
    cursor: z.string().max(256).optional(),
    search: z.string().trim().max(100).optional(),
    status: z.enum(["draft", "sent", "paid", "overdue"]).optional(),
    clientId: z.string().uuid().optional(),
  })
  .strict();

export function listQuery(url: string, invoiceFilters = false) {
  const params = new URL(url).searchParams;
  const values: Record<string, string> = {};
  for (const [key, value] of params) {
    if (
      key in values ||
      (["status", "clientId"].includes(key) && !invoiceFilters)
    )
      throw new HTTPException(400, { message: "Invalid list query" });
    values[key] = value;
  }
  const parsed = querySchema.safeParse(values);
  if (!parsed.success)
    throw new HTTPException(400, { message: "Invalid list query" });
  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (parsed.data.cursor) {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(parsed.data.cursor)) throw new Error();
      cursor = cursorSchema.parse(
        JSON.parse(
          Buffer.from(parsed.data.cursor, "base64url").toString("utf8"),
        ),
      );
    } catch {
      throw new HTTPException(400, { message: "Invalid page cursor" });
    }
  } else if (parsed.data.cursor === "")
    throw new HTTPException(400, { message: "Invalid page cursor" });
  return { ...parsed.data, cursor };
}

export function beforeCursor(
  time: AnyColumn,
  id: AnyColumn,
  cursor: ReturnType<typeof listQuery>["cursor"],
): SQL | undefined {
  return cursor
    ? sql`(${time}, ${id}) < (${cursor.time}::timestamp, ${cursor.id})`
    : undefined;
}

// Preserve PostgreSQL's microseconds; serializing a JavaScript Date would skip
// rows whose timestamps fall within the same millisecond.
export function cursorTime(column: AnyColumn) {
  return sql<string>`to_char(${column}, 'YYYY-MM-DD"T"HH24:MI:SS.US')`;
}

export function listPage<T extends { id: string; cursorTime: string }>(
  rows: T[],
  limit: number,
) {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    data: page.map(({ cursorTime: _time, ...row }) => row),
    pagination: {
      limit,
      hasMore,
      nextCursor:
        hasMore && last
          ? Buffer.from(
              JSON.stringify({ time: last.cursorTime, id: last.id }),
            ).toString("base64url")
          : null,
    },
  };
}

export function searchPattern(value: string) {
  return `%${value.replace(/[\\%_]/g, "\\$&")}%`;
}

import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { verifyAccessToken } from "../lib/jwt";
import type { Variables } from "../types";
import { and, eq, gt } from "drizzle-orm";
import { db, type DB } from "../db";
import { users, refreshTokens } from "../db/schema";

// Verify the session cookie and make the user available to route handlers.
export function createAuthMiddleware(
  database: DB = db,
  requireVerified = false,
) {
  return createMiddleware<{ Variables: Variables }>(async (c, next) => {
    const token = getCookie(c, "access_token");

    if (!token) {
      throw new HTTPException(401, { message: "Unauthorized: Please log in" });
    }

    let payload;
    try {
      payload = await verifyAccessToken(token);
    } catch {
      throw new HTTPException(401, {
        message: "Unauthorized: Session expired, please log in again",
      });
    }

    // Check revocation outside the JWT catch so a database outage remains a server error.
    const [user] = await database
      .select({
        id: users.id,
        email: users.email,
        emailVerifiedAt: users.emailVerifiedAt,
      })
      .from(users)
      .innerJoin(refreshTokens, eq(refreshTokens.userId, users.id))
      .where(
        and(
          eq(users.id, payload.sub),
          eq(users.sessionVersion, payload.sessionVersion),
          eq(refreshTokens.sessionId, payload.sessionId),
          eq(refreshTokens.revoked, false),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!user)
      throw new HTTPException(401, { message: "Session is no longer valid" });
    if (requireVerified && !user.emailVerifiedAt)
      throw new HTTPException(403, {
        message: "Verify your email before using the dashboard",
      });
    c.set("userId", user.id);
    c.set("userEmail", user.email);

    await next();
  });
}

export const authMiddleware = createAuthMiddleware();

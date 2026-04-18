import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { verifyAccessToken } from "../lib/jwt";

/**
 * Auth middleware — verifies the access_token httpOnly cookie on every
 * protected route. Attaches userId and userEmail to the Hono context.
 *
 * Usage:  route.get("/protected", authMiddleware, (c) => { ... })
 */
export const authMiddleware = createMiddleware(async (c, next) => {
  const token = getCookie(c, "access_token");

  if (!token) {
    throw new HTTPException(401, { message: "Unauthorized: Please log in" });
  }

  try {
    const payload = await verifyAccessToken(token);
    c.set("userId",    payload.sub);
    c.set("userEmail", payload.email);
  } catch {
    throw new HTTPException(401, { message: "Unauthorized: Session expired, please log in again" });
  }

  await next();
});

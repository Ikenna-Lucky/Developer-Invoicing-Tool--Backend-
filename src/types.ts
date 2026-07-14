// Values attached by authMiddleware via c.set() and read by route handlers via
// c.get(). Passing this type to Hono<{ Variables: Variables }> makes
// c.get("userId") return `string` instead of `unknown`.

export type Variables = {
  userId: string;
  userEmail: string;
};

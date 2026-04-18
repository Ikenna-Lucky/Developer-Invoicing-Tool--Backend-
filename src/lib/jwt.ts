import { SignJWT, jwtVerify } from "jose";
import crypto from "crypto";

const accessSecret = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!);
const refreshSecret = new TextEncoder().encode(process.env.JWT_REFRESH_SECRET!);

export interface JWTPayload {
  sub: string; // user ID
  email: string;
}

// ─── Sign ─────────────────────────────────────────────────────────────────────

export async function signAccessToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_ACCESS_EXPIRES_IN ?? "15m")
    .sign(accessSecret);
}

export async function signRefreshToken(payload: JWTPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(process.env.JWT_REFRESH_EXPIRES_IN ?? "7d")
    .sign(refreshSecret);
}

// ─── Verify ───────────────────────────────────────────────────────────────────

export async function verifyAccessToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, accessSecret);
  return { sub: payload.sub as string, email: payload.email as string };
}

export async function verifyRefreshToken(token: string): Promise<JWTPayload> {
  const { payload } = await jwtVerify(token, refreshSecret);
  return { sub: payload.sub as string, email: payload.email as string };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Hash a refresh token before storing in DB (prevents exposure if DB leaks) */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/** Parse "7d", "15m" etc. into a future Date for DB storage */
export function tokenExpiryDate(duration: string): Date {
  const unit = duration.slice(-1);
  const value = parseInt(duration.slice(0, -1), 10);
  const ms =
    unit === "d"
      ? value * 86_400_000
      : unit === "h"
        ? value * 3_600_000
        : unit === "m"
          ? value * 60_000
          : value * 1_000;
  return new Date(Date.now() + ms);
}

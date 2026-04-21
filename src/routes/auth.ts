import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import { db } from "../db";
import { users, refreshTokens } from "../db/schema";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  tokenExpiryDate,
} from "../lib/jwt";
import { authMiddleware } from "../middleware/auth";

const auth = new Hono();

const REFRESH_COOKIE  = "refresh_token";
const ACCESS_COOKIE   = "access_token";
const IS_PROD         = process.env.NODE_ENV === "production";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generateId(): string {
  return crypto.randomUUID();
}

function setAuthCookies(c: any, accessToken: string, refreshToken: string) {
  const cookieOptions = {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: "Lax" as const,
    path: "/",
  };

  setCookie(c, ACCESS_COOKIE,  accessToken,  { ...cookieOptions, maxAge: 60 * 15 });          // 15 min
  setCookie(c, REFRESH_COOKIE, refreshToken, { ...cookieOptions, maxAge: 60 * 60 * 24 * 7 }); // 7 days
}

function clearAuthCookies(c: any) {
  deleteCookie(c, ACCESS_COOKIE,  { path: "/" });
  deleteCookie(c, REFRESH_COOKIE, { path: "/" });
}

// ─── POST /auth/register ──────────────────────────────────────────────────────
auth.post(
  "/register",
  zValidator(
    "json",
    z.object({
      fullName: z.string().min(2, "Full name must be at least 2 characters"),
      email:    z.string().email("Invalid email address"),
      password: z.string().min(8, "Password must be at least 8 characters"),
    })
  ),
  async (c) => {
    const { fullName, email, password } = c.req.valid("json");

    // Check if email already in use
    const existing = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
    });

    if (existing) {
      return c.json({ error: "An account with this email already exists" }, 409);
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);
    const userId = generateId();

    // Create user
    const [user] = await db
      .insert(users)
      .values({
        id:           userId,
        email:        email.toLowerCase(),
        passwordHash,
        fullName,
      })
      .returning();

    // Issue tokens
    const accessToken  = await signAccessToken({ sub: user.id, email: user.email });
    const refreshToken = await signRefreshToken({ sub: user.id, email: user.email });

    // Store hashed refresh token
    await db.insert(refreshTokens).values({
      id:        generateId(),
      userId:    user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: tokenExpiryDate(process.env.JWT_REFRESH_EXPIRES_IN ?? "7d"),
    });

    setAuthCookies(c, accessToken, refreshToken);

    return c.json(
      {
        message: "Account created successfully",
        user: {
          id:           user.id,
          email:        user.email,
          fullName:     user.fullName,
          businessName: user.businessName,
        },
      },
      201
    );
  }
);

// ─── POST /auth/login ─────────────────────────────────────────────────────────
auth.post(
  "/login",
  zValidator(
    "json",
    z.object({
      email:    z.string().email(),
      password: z.string().min(1, "Password is required"),
    })
  ),
  async (c) => {
    const { email, password } = c.req.valid("json");

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
    });

    // Use constant-time comparison to prevent timing attacks
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    // Issue tokens
    const accessToken  = await signAccessToken({ sub: user.id, email: user.email });
    const refreshToken = await signRefreshToken({ sub: user.id, email: user.email });

    // Store hashed refresh token
    await db.insert(refreshTokens).values({
      id:        generateId(),
      userId:    user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: tokenExpiryDate(process.env.JWT_REFRESH_EXPIRES_IN ?? "7d"),
    });

    setAuthCookies(c, accessToken, refreshToken);

    return c.json({
      message: "Logged in successfully",
      user: {
        id:           user.id,
        email:        user.email,
        fullName:     user.fullName,
        businessName: user.businessName,
        logoUrl:      user.logoUrl,
      },
    });
  }
);

// ─── POST /auth/refresh ───────────────────────────────────────────────────────
auth.post("/refresh", async (c) => {
  const token = getCookie(c, REFRESH_COOKIE);

  if (!token) {
    return c.json({ error: "No refresh token provided" }, 401);
  }

  // Verify JWT signature + expiry
  let payload;
  try {
    payload = await verifyRefreshToken(token);
  } catch {
    clearAuthCookies(c);
    return c.json({ error: "Invalid or expired refresh token" }, 401);
  }

  // Check DB — token must exist and not be revoked
  const storedToken = await db.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, hashToken(token)),
  });

  if (!storedToken || storedToken.revoked || storedToken.expiresAt < new Date()) {
    clearAuthCookies(c);
    return c.json({ error: "Refresh token has been revoked or expired" }, 401);
  }

  // Rotate: revoke old token, issue new pair
  await db
    .update(refreshTokens)
    .set({ revoked: true })
    .where(eq(refreshTokens.id, storedToken.id));

  const newAccessToken  = await signAccessToken({ sub: payload.sub, email: payload.email });
  const newRefreshToken = await signRefreshToken({ sub: payload.sub, email: payload.email });

  await db.insert(refreshTokens).values({
    id:        generateId(),
    userId:    payload.sub,
    tokenHash: hashToken(newRefreshToken),
    expiresAt: tokenExpiryDate(process.env.JWT_REFRESH_EXPIRES_IN ?? "7d"),
  });

  setAuthCookies(c, newAccessToken, newRefreshToken);

  return c.json({ message: "Tokens refreshed" });
});

// ─── POST /auth/logout ────────────────────────────────────────────────────────
auth.post("/logout", async (c) => {
  const token = getCookie(c, REFRESH_COOKIE);

  if (token) {
    // Revoke the refresh token in DB
    await db
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.tokenHash, hashToken(token)));
  }

  clearAuthCookies(c);
  return c.json({ message: "Logged out successfully" });
});

// ─── GET /auth/me ─────────────────────────────────────────────────────────────
auth.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId");

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return c.json({ error: "User not found" }, 404);

  return c.json({
    id:           user.id,
    email:        user.email,
    fullName:     user.fullName,
    businessName: user.businessName,
    logoUrl:      user.logoUrl,
    address:      user.address,
    phone:        user.phone,
    createdAt:    user.createdAt,
  });
});

// ─── PATCH /auth/me ────────────────────────────────────────────────────────────
// Update the current user's profile (fullName, phone, address, businessName, logoUrl/avatar)
auth.patch(
  "/me",
  authMiddleware,
  zValidator(
    "json",
    z.object({
      fullName:     z.string().min(1).optional(),
      phone:        z.string().optional(),
      businessName: z.string().optional(),
      address:      z.string().optional(),
      logoUrl:      z.string().optional(), // used as profile avatar (base64 or URL)
    })
  ),
  async (c) => {
    const userId = c.get("userId");
    const body   = c.req.valid("json");

    await db
      .update(users)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(users.id, userId));

    const updated = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!updated) return c.json({ error: "User not found" }, 404);

    return c.json({
      id:           updated.id,
      email:        updated.email,
      fullName:     updated.fullName,
      businessName: updated.businessName,
      logoUrl:      updated.logoUrl,
      address:      updated.address,
      phone:        updated.phone,
      createdAt:    updated.createdAt,
    });
  }
);

export default auth;

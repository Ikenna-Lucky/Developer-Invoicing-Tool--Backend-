import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import { db as defaultDb, type DB } from "../db";
import { users, emailJobs } from "../db/schema";
import { resendVerification, verifyEmail } from "../lib/email-verification";
import {
  createSession,
  registerWithPassword,
  loginWithPassword,
  rotateSession,
  revokeSession,
  requestPasswordReset,
  resetPassword,
  passwordSchema,
  type AuthSession,
} from "../lib/sessions";
import { createAuthMiddleware } from "../middleware/auth";
import type { Variables } from "../types";

export function createAuthRouter(
  database: DB = defaultDb,
  googleRequest: (
    url: string,
    options?: RequestInit,
  ) => Promise<Response> = fetch,
) {
  const db = database;
  const auth = new Hono<{ Variables: Variables }>();
  const authMiddleware = createAuthMiddleware(database);
  const REFRESH_COOKIE = "refresh_token";
  const ACCESS_COOKIE = "access_token";
  const IS_PROD = process.env.NODE_ENV === "production";
  const cookieOptions = {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: (IS_PROD ? "None" : "Lax") as "None" | "Lax",
    path: "/",
  };

  function generateId(): string {
    return crypto.randomUUID();
  }
  function setAuthCookies(c: Context, session: AuthSession) {
    const maxAge = (expiresAt: Date) =>
      Math.max(0, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
    setCookie(c, ACCESS_COOKIE, session.accessToken, {
      ...cookieOptions,
      expires: session.accessExpiresAt,
      maxAge: maxAge(session.accessExpiresAt),
    });
    setCookie(c, REFRESH_COOKIE, session.refreshToken, {
      ...cookieOptions,
      expires: session.refreshExpiresAt,
      maxAge: maxAge(session.refreshExpiresAt),
    });
  }
  function clearAuthCookies(c: Context) {
    deleteCookie(c, ACCESS_COOKIE, cookieOptions);
    deleteCookie(c, REFRESH_COOKIE, cookieOptions);
  }

  // POST /auth/register
  auth.post(
    "/register",
    zValidator(
      "json",
      z.object({
        fullName: z.string().min(2, "Full name must be at least 2 characters"),
        email: z.string().email("Invalid email address"),
        password: passwordSchema,
      }),
    ),
    async (c) => {
      const { user, session } = await registerWithPassword(
        db,
        c.req.valid("json"),
      );
      setAuthCookies(c, session);

      return c.json(
        {
          message: "Account created successfully",
          user: {
            id: user.id,
            email: user.email,
            emailVerifiedAt: user.emailVerifiedAt,
            fullName: user.fullName,
            businessName: user.businessName,
          },
        },
        201,
      );
    },
  );

  // POST /auth/login
  auth.post(
    "/login",
    zValidator(
      "json",
      z.object({
        email: z.string().email(),
        password: z.string().min(1, "Password is required"),
        rememberMe: z.boolean().optional().default(false),
      }),
    ),
    async (c) => {
      const { user, session } = await loginWithPassword(
        db,
        c.req.valid("json"),
      );
      setAuthCookies(c, session);

      return c.json({
        message: "Logged in successfully",
        user: {
          id: user.id,
          email: user.email,
          emailVerifiedAt: user.emailVerifiedAt,
          fullName: user.fullName,
          businessName: user.businessName,
          logoUrl: user.logoUrl,
        },
      });
    },
  );

  // POST /auth/refresh
  auth.post("/refresh", async (c) => {
    const token = getCookie(c, REFRESH_COOKIE);
    if (!token) return c.json({ error: "No refresh token provided" }, 401);
    // Failed refreshes must not erase cookies written by a concurrent successful refresh.
    const session = await rotateSession(db, token);
    setAuthCookies(c, session);
    return c.json({ message: "Tokens refreshed" });
  });

  // POST /auth/logout
  auth.post("/logout", async (c) => {
    const token = getCookie(c, REFRESH_COOKIE);
    try {
      if (token) await revokeSession(db, token);
    } catch (error) {
      console.error("Session revocation failed:", error);
      return c.json(
        { error: "Could not revoke the session. Please try again." },
        503,
      );
    }
    clearAuthCookies(c);
    return c.json({ message: "Logged out successfully" });
  });

  // GET /auth/me
  auth.get("/me", authMiddleware, async (c) => {
    const userId = c.get("userId");

    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });
    if (!user) return c.json({ error: "User not found" }, 404);

    return c.json({
      id: user.id,
      email: user.email,
      emailVerifiedAt: user.emailVerifiedAt,
      fullName: user.fullName,
      businessName: user.businessName,
      logoUrl: user.logoUrl,
      address: user.address,
      phone: user.phone,
      createdAt: user.createdAt,
    });
  });

  // PATCH /auth/me — update fullName, phone, address, businessName, logoUrl/avatar
  auth.patch(
    "/me",
    authMiddleware,
    zValidator(
      "json",
      z.object({
        fullName: z.string().min(1).optional(),
        phone: z.string().optional(),
        businessName: z.string().optional(),
        address: z.string().optional(),
        logoUrl: z.string().optional(), // used as profile avatar (base64 or URL)
      }),
    ),
    async (c) => {
      const userId = c.get("userId");
      const body = c.req.valid("json");

      await db
        .update(users)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(users.id, userId));

      const updated = await db.query.users.findFirst({
        where: eq(users.id, userId),
      });
      if (!updated) return c.json({ error: "User not found" }, 404);

      return c.json({
        id: updated.id,
        email: updated.email,
        emailVerifiedAt: updated.emailVerifiedAt,
        fullName: updated.fullName,
        businessName: updated.businessName,
        logoUrl: updated.logoUrl,
        address: updated.address,
        phone: updated.phone,
        createdAt: updated.createdAt,
      });
    },
  );

  // GET /auth/google — kick off OAuth flow
  auth.get("/google", (c) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return c.json(
        { error: "Google OAuth is not configured on this server" },
        503,
      );
    }

    const apiUrl = process.env.API_URL ?? "http://localhost:3001";
    const redirectUri = `${apiUrl}/auth/google/callback`;

    // random state, stashed in a short-lived cookie so we can verify it in the
    // callback (CSRF protection)
    const state = crypto.randomUUID();

    setCookie(c, "oauth_state", state, {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 10, // Allow 10 minutes to complete sign-in.
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "online",
      prompt: "select_account", // always show the account picker
    });

    return c.redirect(
      `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
    );
  });

  // GET /auth/google/callback — handle Google's redirect back
  auth.get("/google/callback", async (c) => {
    const { code, state, error } = c.req.query();

    const storedState = getCookie(c, "oauth_state");
    deleteCookie(c, "oauth_state", { path: "/" });

    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
    const apiUrl = process.env.API_URL ?? "http://localhost:3001";
    const redirectUri = `${apiUrl}/auth/google/callback`;

    // validation

    if (error === "access_denied") {
      return c.redirect(`${frontendUrl}/sign-in?error=google_denied`);
    }

    if (!code) {
      return c.redirect(`${frontendUrl}/sign-in?error=google_no_code`);
    }

    if (!state || !storedState || state !== storedState) {
      return c.redirect(`${frontendUrl}/sign-in?error=google_state_mismatch`);
    }

    try {
      // exchange the authorization code for an access token

      const tokenRes = await googleRequest(
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            code,
            client_id: process.env.GOOGLE_CLIENT_ID!,
            client_secret: process.env.GOOGLE_CLIENT_SECRET!,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
          }),
        },
      );

      if (!tokenRes.ok) {
        console.error("Google token exchange failed:", await tokenRes.text());
        return c.redirect(`${frontendUrl}/sign-in?error=google_token_failed`);
      }

      const { access_token } = (await tokenRes.json()) as {
        access_token: string;
      };

      // fetch the user's Google profile

      const profileRes = await googleRequest(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {
          headers: { Authorization: `Bearer ${access_token}` },
        },
      );

      if (!profileRes.ok) {
        return c.redirect(`${frontendUrl}/sign-in?error=google_profile_failed`);
      }

      const googleUser = z
        .object({
          id: z.string().min(1),
          email: z.string().email(),
          name: z.string().min(1),
          picture: z.string().url().optional(),
          verified_email: z.boolean(),
        })
        .parse(await profileRes.json());

      if (!googleUser.verified_email) {
        return c.redirect(
          `${frontendUrl}/sign-in?error=google_unverified_email`,
        );
      }

      // find or create the account

      let user = await db.query.users.findFirst({
        // Link an existing account using Google's verified email address.
        where: eq(users.email, googleUser.email.toLowerCase()),
      });

      if (user) {
        if (
          (user.googleId && user.googleId !== googleUser.id) ||
          (!user.googleId && !user.emailVerifiedAt)
        ) {
          return c.redirect(
            `${frontendUrl}/sign-in?error=verify_email_before_google_link`,
          );
        }
        // link the Google ID to the existing account if not already linked
        if (!user.googleId) {
          await db
            .update(users)
            .set({ googleId: googleUser.id, updatedAt: new Date() })
            .where(eq(users.id, user.id));
          user = { ...user, googleId: googleUser.id };
        }
        await db
          .update(users)
          .set({
            emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
            updatedAt: new Date(),
          })
          .where(eq(users.id, user.id));
      } else {
        // first time — create a new account from the Google profile
        const [newUser] = await db
          .insert(users)
          .values({
            id: generateId(),
            email: googleUser.email.toLowerCase(),
            fullName: googleUser.name,
            googleId: googleUser.id,
            logoUrl: googleUser.picture ?? null,
            passwordHash: null, // Google-only account — no password
            emailVerifiedAt: new Date(),
          })
          .returning();
        user = newUser;
      }

      const session = await createSession(db, user.id);
      setAuthCookies(c, session);

      return c.redirect(`${frontendUrl}/dashboard`);
    } catch (err) {
      console.error("Google OAuth callback error:", err);
      return c.redirect(`${frontendUrl}/sign-in?error=google_auth_failed`);
    }
  });

  // POST /auth/forgot-password — issues a one-time reset token and emails a link.
  // Always returns 200 whether or not the email exists, so we don't leak that info.
  auth.post(
    "/forgot-password",
    zValidator("json", z.object({ email: z.string().email() })),
    async (c) => {
      const { email } = c.req.valid("json");
      await requestPasswordReset(db, email);
      return c.json({
        message: "If that email exists, a reset email has been queued.",
      });
    },
  );

  // POST /auth/reset-password — validates the token and sets the new password
  auth.post(
    "/reset-password",
    zValidator(
      "json",
      z.object({
        token: z.string().regex(/^[a-fA-F0-9]{64}$/, "Invalid reset token"),
        password: passwordSchema,
      }),
    ),
    async (c) => {
      const { token, password } = c.req.valid("json");
      await resetPassword(db, token, password);
      clearAuthCookies(c);

      return c.json({
        message: "Password updated successfully. You can now sign in.",
      });
    },
  );

  auth.post("/resend-verification", authMiddleware, async (c) => {
    await resendVerification(db, c.get("userId"));
    return c.json(
      { message: "If verification is needed, an email has been queued." },
      202,
    );
  });
  auth.get("/verification-status", authMiddleware, async (c) => {
    const job = await db.query.emailJobs.findFirst({
      where: and(
        eq(emailJobs.userId, c.get("userId")),
        eq(emailJobs.purpose, "verification"),
      ),
      orderBy: desc(emailJobs.createdAt),
    });
    return c.json({
      data: job ? { status: job.status, acceptedAt: job.acceptedAt } : null,
    });
  });
  auth.post(
    "/verify-email",
    authMiddleware,
    zValidator("json", z.object({ token: z.string().regex(/^[a-f0-9]{64}$/) })),
    async (c) => {
      await verifyEmail(db, c.get("userId"), c.req.valid("json").token);
      return c.json({ message: "Email verified successfully" });
    },
  );

  return auth;
}

export default createAuthRouter();

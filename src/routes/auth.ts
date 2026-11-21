import { Hono, type Context } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import { db as defaultDb, type DB } from "../db";
import { users } from "../db/schema";
import { sendMail } from "../lib/email";
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

export function createAuthRouter(database: DB = defaultDb) {
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

      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: process.env.GOOGLE_CLIENT_ID!,
          client_secret: process.env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      });

      if (!tokenRes.ok) {
        console.error("Google token exchange failed:", await tokenRes.text());
        return c.redirect(`${frontendUrl}/sign-in?error=google_token_failed`);
      }

      const { access_token } = (await tokenRes.json()) as {
        access_token: string;
      };

      // fetch the user's Google profile

      const profileRes = await fetch(
        "https://www.googleapis.com/oauth2/v2/userinfo",
        {
          headers: { Authorization: `Bearer ${access_token}` },
        },
      );

      if (!profileRes.ok) {
        return c.redirect(`${frontendUrl}/sign-in?error=google_profile_failed`);
      }

      const googleUser = (await profileRes.json()) as {
        id: string;
        email: string;
        name: string;
        picture?: string;
        verified_email: boolean;
      };

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
        // link the Google ID to the existing account if not already linked
        if (!user.googleId) {
          await db
            .update(users)
            .set({ googleId: googleUser.id, updatedAt: new Date() })
            .where(eq(users.id, user.id));
          user = { ...user, googleId: googleUser.id };
        }
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
      const reset = await requestPasswordReset(db, email);
      if (reset) {
        const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";
        const resetUrl = `${frontendUrl}/reset-password?token=${reset.rawToken}`;
        await sendMail({
          to: reset.user.email,
          subject: "Reset your Billd password",
          html: buildResetEmail({ fullName: reset.user.fullName, resetUrl }),
        });
      }
      return c.json({
        message: "If that email exists, a reset link has been sent.",
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

  return auth;
}

function buildResetEmail({
  fullName,
  resetUrl,
}: {
  fullName: string;
  resetUrl: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>Reset your password</title>
  <style>
    body { margin:0; padding:0; background:#0a0f1e; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
    .wrapper { max-width:520px; margin:0 auto; padding:40px 16px; }
    .card { background:#0f172a; border:1px solid #1e293b; border-radius:16px; overflow:hidden; }
    .section { padding:32px; }
    @media only screen and (max-width:480px) {
      .wrapper { padding:24px 12px; }
      .section { padding:24px 20px; }
    }
  </style>
</head>
<body>
  <div class="wrapper">
    <div style="text-align:center;margin-bottom:28px;">
      <div style="font-size:28px;font-weight:900;letter-spacing:-0.02em;background:linear-gradient(135deg,#2563eb,#7c3aed);-webkit-background-clip:text;-webkit-text-fill-color:transparent;color:#7c3aed;">Billd</div>
    </div>
    <div class="card">
      <div style="height:4px;background:linear-gradient(90deg,#2563eb,#7c3aed,#ec4899);"></div>
      <div class="section">
        <p style="font-size:22px;font-weight:700;color:#fff;margin:0 0 8px;">Reset your password</p>
        <p style="font-size:15px;color:#64748b;margin:0 0 28px;line-height:1.6;">
          Hi ${fullName}, we received a request to reset your Billd password. Click the button below — this link expires in <strong style="color:#94a3b8;">1 hour</strong>.
        </p>
        <div style="text-align:center;margin-bottom:28px;">
          <a href="${resetUrl}"
             style="display:inline-block;background:linear-gradient(135deg,#2563eb,#7c3aed);color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:12px;">
            Reset password
          </a>
        </div>
        <p style="font-size:13px;color:#475569;line-height:1.6;margin:0;">
          If you didn't request this, you can safely ignore this email — your password won't change.
        </p>
        <p style="font-size:12px;color:#334155;margin:20px 0 0;word-break:break-all;">
          Or copy this link: <a href="${resetUrl}" style="color:#60a5fa;">${resetUrl}</a>
        </p>
      </div>
    </div>
    <p style="text-align:center;color:#334155;font-size:11px;margin-top:24px;">
      Sent via <strong>Billd</strong> — Professional invoicing for freelancers
    </p>
  </div>
</body>
</html>`;
}

export default createAuthRouter();

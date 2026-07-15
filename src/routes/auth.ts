import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";

import { db } from "../db";
import { users, refreshTokens, passwordResetTokens } from "../db/schema";
import { sendMail } from "../lib/email";
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  tokenExpiryDate,
} from "../lib/jwt";
import { authMiddleware } from "../middleware/auth";
import type { Variables } from "../types";

const auth = new Hono<{ Variables: Variables }>();

const REFRESH_COOKIE = "refresh_token";
const ACCESS_COOKIE = "access_token";
const IS_PROD = process.env.NODE_ENV === "production";

// helpers

function generateId(): string {
  return crypto.randomUUID();
}

function setAuthCookies(c: any, accessToken: string, refreshToken: string) {
  const cookieOptions = {
    httpOnly: true,
    secure: IS_PROD,
    // SameSite=None is needed for cross-site cookies (netlify.app → onrender.com),
    // and it has to be paired with Secure=true, which is only true in prod.
    // Locally everything's same-origin so Lax is fine.
    sameSite: (IS_PROD ? "None" : "Lax") as "None" | "Lax",
    path: "/",
  };

  setCookie(c, ACCESS_COOKIE, accessToken, {
    ...cookieOptions,
    maxAge: 60 * 15,
  }); // 15 min
  setCookie(c, REFRESH_COOKIE, refreshToken, {
    ...cookieOptions,
    maxAge: 60 * 60 * 24 * 7,
  }); // 7 days
}

function clearAuthCookies(c: any) {
  deleteCookie(c, ACCESS_COOKIE, { path: "/" });
  deleteCookie(c, REFRESH_COOKIE, { path: "/" });
}

// POST /auth/register
auth.post(
  "/register",
  zValidator(
    "json",
    z.object({
      fullName: z.string().min(2, "Full name must be at least 2 characters"),
      email: z.string().email("Invalid email address"),
      password: z.string().min(8, "Password must be at least 8 characters"),
    }),
  ),
  async (c) => {
    const { fullName, email, password } = c.req.valid("json");

    // Check if email already in use
    const existing = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
    });

    if (existing) {
      return c.json(
        { error: "An account with this email already exists" },
        409,
      );
    }

    // cost factor 10 — 12 adds ~300ms of blocking CPU with no real security gain here
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = generateId();

    // Create user
    const [user] = await db
      .insert(users)
      .values({
        id: userId,
        email: email.toLowerCase(),
        passwordHash,
        fullName,
      })
      .returning();

    // Issue tokens
    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
    });
    const refreshToken = await signRefreshToken({
      sub: user.id,
      email: user.email,
    });

    // Store hashed refresh token
    await db.insert(refreshTokens).values({
      id: generateId(),
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: tokenExpiryDate(process.env.JWT_REFRESH_EXPIRES_IN ?? "7d"),
    });

    setAuthCookies(c, accessToken, refreshToken);

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
    const { email, password, rememberMe } = c.req.valid("json");

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
    });

    // If the account was created via Google, it has no password
    if (user && !user.passwordHash) {
      return c.json(
        {
          error:
            "This account uses Google Sign-In. Please click 'Continue with Google' to access it.",
        },
        401,
      );
    }

    // constant-time comparison to avoid timing attacks
    if (!user || !(await bcrypt.compare(password, user.passwordHash!))) {
      return c.json({ error: "Invalid email or password" }, 401);
    }

    // "Remember me" extends the refresh token from 7 days to 30
    const refreshTTL = rememberMe
      ? "30d"
      : (process.env.JWT_REFRESH_EXPIRES_IN ?? "7d");
    const cookieMaxAge = rememberMe ? 60 * 60 * 24 * 30 : 60 * 60 * 24 * 7;

    // Issue tokens
    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
    });
    const refreshToken = await signRefreshToken(
      { sub: user.id, email: user.email },
      refreshTTL,
    );

    // Store hashed refresh token
    await db.insert(refreshTokens).values({
      id: generateId(),
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: tokenExpiryDate(refreshTTL),
    });

    // Override cookie max-age for remember-me sessions
    const cookieOptions = {
      httpOnly: true,
      secure: IS_PROD,
      sameSite: (IS_PROD ? "None" : "Lax") as "None" | "Lax",
      path: "/",
    };
    setCookie(c, ACCESS_COOKIE, accessToken, {
      ...cookieOptions,
      maxAge: 60 * 15,
    });
    setCookie(c, REFRESH_COOKIE, refreshToken, {
      ...cookieOptions,
      maxAge: cookieMaxAge,
    });

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

  if (
    !storedToken ||
    storedToken.revoked ||
    storedToken.expiresAt < new Date()
  ) {
    clearAuthCookies(c);
    return c.json({ error: "Refresh token has been revoked or expired" }, 401);
  }

  // Rotate: revoke old token, issue new pair
  await db
    .update(refreshTokens)
    .set({ revoked: true })
    .where(eq(refreshTokens.id, storedToken.id));

  const newAccessToken = await signAccessToken({
    sub: payload.sub,
    email: payload.email,
  });
  const newRefreshToken = await signRefreshToken({
    sub: payload.sub,
    email: payload.email,
  });

  await db.insert(refreshTokens).values({
    id: generateId(),
    userId: payload.sub,
    tokenHash: hashToken(newRefreshToken),
    expiresAt: tokenExpiryDate(process.env.JWT_REFRESH_EXPIRES_IN ?? "7d"),
  });

  setAuthCookies(c, newAccessToken, newRefreshToken);

  return c.json({ message: "Tokens refreshed" });
});

// POST /auth/logout
auth.post("/logout", async (c) => {
  const token = getCookie(c, REFRESH_COOKIE);

  // Clear cookies first — this is what actually signs the user out. If a Neon
  // cold-start makes the DB call below slow or throw, we don't want that to
  // leave stale cookies around and trap the user in a sign-in/dashboard loop.
  clearAuthCookies(c);

  // Revoking the token in the DB is best-effort. If it fails, the token just
  // sits there until it expires naturally in 7 days — the user's already
  // signed out either way.
  if (token) {
    db.update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.tokenHash, hashToken(token)))
      .catch(() => {
        /* non-critical — token expires naturally */
      });
  }

  return c.json({ message: "Logged out successfully" });
});

// GET /auth/me
auth.get("/me", authMiddleware, async (c) => {
  const userId = c.get("userId");

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
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
    maxAge: 60 * 10, // 10 minutes — plenty of time to complete the OAuth flow
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
      return c.redirect(`${frontendUrl}/sign-in?error=google_unverified_email`);
    }

    // find or create the account

    let user = await db.query.users.findFirst({
      // match by google_id if we can, otherwise fall back to email so existing
      // email/password accounts get linked on first Google sign-in
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

    // issue session tokens

    const accessToken = await signAccessToken({
      sub: user.id,
      email: user.email,
    });
    const refreshToken = await signRefreshToken({
      sub: user.id,
      email: user.email,
    });

    await db.insert(refreshTokens).values({
      id: generateId(),
      userId: user.id,
      tokenHash: hashToken(refreshToken),
      expiresAt: tokenExpiryDate(process.env.JWT_REFRESH_EXPIRES_IN ?? "7d"),
    });

    setAuthCookies(c, accessToken, refreshToken);

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
    const frontendUrl = process.env.FRONTEND_URL ?? "http://localhost:3000";

    const user = await db.query.users.findFirst({
      where: eq(users.email, email.toLowerCase()),
    });

    // silent success — don't reveal whether the email exists
    if (!user || !user.passwordHash) {
      return c.json({
        message: "If that email exists, a reset link has been sent.",
      });
    }

    // one active reset token per user at a time
    await db
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id));

    const rawToken =
      crypto.randomUUID().replace(/-/g, "") +
      crypto.randomUUID().replace(/-/g, "");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await db.insert(passwordResetTokens).values({
      id: generateId(),
      userId: user.id,
      tokenHash,
      expiresAt,
    });

    const resetUrl = `${frontendUrl}/reset-password?token=${rawToken}`;

    await sendMail({
      to: user.email,
      subject: "Reset your Billd password",
      html: buildResetEmail({ fullName: user.fullName, resetUrl }),
    });

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
      token: z.string().min(1),
      password: z.string().min(8, "Password must be at least 8 characters"),
    }),
  ),
  async (c) => {
    const { token, password } = c.req.valid("json");

    const tokenHash = hashToken(token);

    const record = await db.query.passwordResetTokens.findFirst({
      where: eq(passwordResetTokens.tokenHash, tokenHash),
    });

    if (!record) {
      return c.json({ error: "Invalid or expired reset link." }, 400);
    }

    if (new Date() > record.expiresAt) {
      await db
        .delete(passwordResetTokens)
        .where(eq(passwordResetTokens.id, record.id));
      return c.json(
        { error: "This reset link has expired. Please request a new one." },
        400,
      );
    }

    // Update password
    const passwordHash = await bcrypt.hash(password, 10);
    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, record.userId));

    // Delete the used token
    await db
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.id, record.id));

    // Revoke all existing sessions for security
    await db
      .delete(refreshTokens)
      .where(eq(refreshTokens.userId, record.userId));

    return c.json({
      message: "Password updated successfully. You can now sign in.",
    });
  },
);

// reset password email template
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

export default auth;

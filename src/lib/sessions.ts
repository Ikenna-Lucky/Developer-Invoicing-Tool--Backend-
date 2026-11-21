import { and, eq, gt, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { DB } from "../db";
import {
  users,
  refreshTokens,
  passwordResetTokens,
  type User,
} from "../db/schema";
import {
  hashToken,
  signAccessToken,
  signRefreshToken,
  tokenExpiryDate,
  verifyRefreshToken,
  validateAuthConfiguration,
} from "./jwt";

type Transaction = Parameters<Parameters<DB["transaction"]>[0]>[0];

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= 72,
    "Password must not exceed 72 UTF-8 bytes",
  );

export type AuthSession = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date;
};

async function lockUser(tx: Transaction, userId: string) {
  const [user] = await tx
    .select()
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  if (!user)
    throw new HTTPException(401, { message: "Session is no longer valid" });
  return user;
}

async function issueSession(
  tx: Transaction,
  user: User,
  refreshExpiresAt: Date,
  sessionId: string = randomUUID(),
): Promise<AuthSession> {
  const accessExpiresAt = new Date(
    Math.min(
      tokenExpiryDate(process.env.JWT_ACCESS_EXPIRES_IN ?? "15m").getTime(),
      refreshExpiresAt.getTime(),
    ),
  );
  const payload = {
    sub: user.id,
    email: user.email,
    sessionId,
    sessionVersion: user.sessionVersion,
  };
  const [accessToken, refreshToken] = await Promise.all([
    signAccessToken(payload, accessExpiresAt),
    signRefreshToken(payload, refreshExpiresAt),
  ]);
  await tx.insert(refreshTokens).values({
    id: randomUUID(),
    userId: user.id,
    sessionId,
    tokenHash: hashToken(refreshToken),
    expiresAt: refreshExpiresAt,
  });
  return { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt };
}

function expiry(rememberMe = false) {
  return tokenExpiryDate(
    rememberMe ? "30d" : (process.env.JWT_REFRESH_EXPIRES_IN ?? "7d"),
  );
}

export async function createSession(
  database: DB,
  userId: string,
  rememberMe = false,
) {
  validateAuthConfiguration();
  return database.transaction(async (tx) =>
    issueSession(tx, await lockUser(tx, userId), expiry(rememberMe)),
  );
}

export async function registerWithPassword(
  database: DB,
  input: { fullName: string; email: string; password: string },
) {
  validateAuthConfiguration();
  const passwordHash = await bcrypt.hash(
    passwordSchema.parse(input.password),
    10,
  );
  return database.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        id: randomUUID(),
        email: input.email.toLowerCase(),
        fullName: input.fullName,
        passwordHash,
      })
      .onConflictDoNothing({ target: users.email })
      .returning();
    if (!user)
      throw new HTTPException(409, {
        message: "An account with this email already exists",
      });
    return { user, session: await issueSession(tx, user, expiry()) };
  });
}

export async function loginWithPassword(
  database: DB,
  input: { email: string; password: string; rememberMe: boolean },
) {
  validateAuthConfiguration();
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.email, input.email.toLowerCase()))
      .for("update");
    if (
      !user?.passwordHash ||
      !(await bcrypt.compare(input.password, user.passwordHash))
    ) {
      throw new HTTPException(401, { message: "Invalid email or password" });
    }
    // Resets take the same lock, so an old password cannot open a session after a reset commits.
    return {
      user,
      session: await issueSession(tx, user, expiry(input.rememberMe)),
    };
  });
}

export async function rotateSession(database: DB, rawToken: string) {
  validateAuthConfiguration();
  let payload;
  try {
    payload = await verifyRefreshToken(rawToken);
  } catch {
    throw new HTTPException(401, {
      message: "Invalid or expired refresh token",
    });
  }
  return database.transaction(async (tx) => {
    const user = await lockUser(tx, payload.sub);
    const [stored] = await tx
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.tokenHash, hashToken(rawToken)),
          eq(refreshTokens.userId, user.id),
        ),
      )
      .for("update");
    if (
      !stored ||
      stored.revoked ||
      stored.expiresAt <= new Date() ||
      stored.sessionId !== payload.sessionId ||
      user.sessionVersion !== payload.sessionVersion
    ) {
      throw new HTTPException(401, { message: "Session is no longer valid" });
    }
    await tx
      .update(refreshTokens)
      .set({ revoked: true })
      .where(eq(refreshTokens.id, stored.id));
    // Keep the original deadline, including the 30-day Remember me deadline.
    return issueSession(tx, user, stored.expiresAt, stored.sessionId);
  });
}

export async function revokeSession(database: DB, rawToken: string) {
  const stored = await database.query.refreshTokens.findFirst({
    where: eq(refreshTokens.tokenHash, hashToken(rawToken)),
  });
  if (!stored) return;
  await database.transaction(async (tx) => {
    await lockUser(tx, stored.userId);
    // A logout using an older rotated token still closes the same browser session.
    await tx
      .update(refreshTokens)
      .set({ revoked: true })
      .where(
        and(
          eq(refreshTokens.userId, stored.userId),
          eq(refreshTokens.sessionId, stored.sessionId),
        ),
      );
  });
}

export async function requestPasswordReset(database: DB, email: string) {
  return database.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .for("update");
    if (!user?.passwordHash) return null;
    const rawToken = randomBytes(32).toString("hex");
    await tx
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id));
    await tx.insert(passwordResetTokens).values({
      id: randomUUID(),
      userId: user.id,
      tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { user, rawToken };
  });
}

export async function resetPassword(
  database: DB,
  rawToken: string,
  password: string,
) {
  const tokenHash = hashToken(rawToken);
  const record = await database.query.passwordResetTokens.findFirst({
    where: eq(passwordResetTokens.tokenHash, tokenHash),
  });
  if (!record || record.expiresAt <= new Date())
    throw new HTTPException(400, { message: "Invalid or expired reset link" });
  const passwordHash = await bcrypt.hash(passwordSchema.parse(password), 10);
  await database.transaction(async (tx) => {
    const user = await lockUser(tx, record.userId);
    const [current] = await tx
      .select()
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.tokenHash, tokenHash),
          gt(passwordResetTokens.expiresAt, new Date()),
        ),
      )
      .for("update");
    if (!current || current.userId !== user.id || !user.passwordHash) {
      throw new HTTPException(400, {
        message: "Invalid or expired reset link",
      });
    }
    await tx
      .update(users)
      .set({
        passwordHash,
        sessionVersion: sql`${users.sessionVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    await tx
      .delete(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id));
    await tx.delete(refreshTokens).where(eq(refreshTokens.userId, user.id));
  });
}

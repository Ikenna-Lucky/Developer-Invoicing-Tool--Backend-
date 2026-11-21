import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DB } from "../db";
import { emailVerificationTokens, users, type User } from "../db/schema";
import { hashToken } from "./jwt";
import { cancelTokenEmails, enqueueEmail } from "./email-queue";
import { buildAccountEmail } from "./account-emails";
import { frontendOrigin } from "../middleware/csrf";

type Transaction = Parameters<Parameters<DB["transaction"]>[0]>[0];

// Call with the user row locked, or within the transaction that created it.
export async function issueVerification(tx: Transaction, user: User) {
  if (user.emailVerifiedAt) return null;
  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 24 * 3600_000);
  await tx
    .delete(emailVerificationTokens)
    .where(eq(emailVerificationTokens.userId, user.id));
  await cancelTokenEmails(tx, user.id, "verification");
  await tx.insert(emailVerificationTokens).values({
    id: randomUUID(),
    userId: user.id,
    email: user.email,
    tokenHash,
    expiresAt,
  });
  const link = `${frontendOrigin()}/verify-email#token=${rawToken}`;
  await enqueueEmail(tx, {
    userId: user.id,
    purpose: "verification",
    tokenHash,
    expiresAt,
    message: {
      to: user.email,
      subject: "Verify your Billd email",
      html: buildAccountEmail({
        fullName: user.fullName,
        url: link,
        purpose: "verification",
      }),
    },
  });
}

export async function resendVerification(database: DB, userId: string) {
  await database.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for("update");
    if (!user)
      throw new HTTPException(401, { message: "Please sign in again" });
    const current = await tx.query.emailVerificationTokens.findFirst({
      where: eq(emailVerificationTokens.userId, userId),
    });
    if (current && Date.now() - current.createdAt.getTime() < 60_000)
      throw new HTTPException(429, {
        message: "Please wait one minute before requesting another link",
      });
    await issueVerification(tx, user);
  });
}

export async function verifyEmail(
  database: DB,
  userId: string,
  rawToken: string,
) {
  const tokenHash = hashToken(rawToken);
  const record = await database.query.emailVerificationTokens.findFirst({
    where: eq(emailVerificationTokens.tokenHash, tokenHash),
  });
  if (!record || record.userId !== userId)
    throw new HTTPException(400, {
      message: "Invalid or expired verification link",
    });
  await database.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(users)
      .where(eq(users.id, record.userId))
      .for("update");
    const [token] = await tx
      .select()
      .from(emailVerificationTokens)
      .where(
        and(
          eq(emailVerificationTokens.tokenHash, tokenHash),
          gt(emailVerificationTokens.expiresAt, new Date()),
        ),
      )
      .for("update");
    if (
      !user ||
      !token ||
      token.email !== user.email ||
      token.userId !== user.id
    )
      throw new HTTPException(400, {
        message: "Invalid or expired verification link",
      });
    await tx
      .update(users)
      .set({ emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    await tx
      .delete(emailVerificationTokens)
      .where(eq(emailVerificationTokens.userId, user.id));
    await cancelTokenEmails(tx, user.id, "verification");
  });
}

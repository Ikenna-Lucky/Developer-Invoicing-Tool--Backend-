import { beforeAll, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { SignJWT, decodeJwt } from "jose";
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  tokenExpiryDate,
  validateAuthConfiguration,
} from "../src/lib/jwt";
import { passwordSchema } from "../src/lib/sessions";

beforeAll(() => {
  process.env.JWT_ACCESS_SECRET = "unit-access-secret-at-least-32-bytes";
  process.env.JWT_REFRESH_SECRET = "unit-refresh-secret-at-least-32-bytes";
  process.env.JWT_ACCESS_EXPIRES_IN = "15m";
  process.env.JWT_REFRESH_EXPIRES_IN = "7d";
});

const payload = {
  sub: randomUUID(),
  email: "user@example.test",
  sessionId: randomUUID(),
  sessionVersion: 0,
};

test("identical session claims produce unique refresh tokens", async () => {
  const deadline = new Date(Date.now() + 60_000);
  const tokens = await Promise.all(
    Array.from({ length: 20 }, () => signRefreshToken(payload, deadline)),
  );
  expect(new Set(tokens).size).toBe(20);
  expect(new Set(tokens.map((token) => decodeJwt(token).jti)).size).toBe(20);
  expect(await verifyRefreshToken(tokens[0])).toEqual(payload);
});

test("access and refresh tokens cannot be substituted for each other", async () => {
  const access = await signAccessToken(payload),
    refresh = await signRefreshToken(payload);
  await expect(verifyAccessToken(refresh)).rejects.toThrow();
  await expect(verifyRefreshToken(access)).rejects.toThrow();
});

async function forged(
  changes: Record<string, unknown> = {},
  algorithm = "HS256",
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: payload.sub,
    email: payload.email,
    sid: payload.sessionId,
    sv: 0,
    token_use: "access",
    iss: "billd-api",
    aud: "billd-browser",
    jti: randomUUID(),
    iat: now,
    exp: now + 60,
    ...changes,
  })
    .setProtectedHeader({ alg: algorithm })
    .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!));
}

test("verification rejects wrong issuer, audience, purpose, malformed claims, and disallowed algorithms", async () => {
  for (const changes of [
    { iss: "foreign-api" },
    { aud: "foreign-client" },
    { iat: "invalid" },
    { token_use: "refresh" },
    { sid: "invalid" },
    { sv: -1 },
    { email: null },
  ]) {
    await expect(verifyAccessToken(await forged(changes))).rejects.toThrow();
  }
  await expect(verifyAccessToken(await forged({}, "HS384"))).rejects.toThrow();
});

test("expired and legacy tokens are rejected", async () => {
  await expect(
    verifyAccessToken(
      await signAccessToken(payload, new Date(Date.now() - 10_000)),
    ),
  ).rejects.toThrow();
  const legacy = await new SignJWT({ email: payload.email })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime("15m")
    .setProtectedHeader({ alg: "HS256" })
    .sign(new TextEncoder().encode(process.env.JWT_ACCESS_SECRET!));
  await expect(verifyAccessToken(legacy)).rejects.toThrow();
});

test("lifetime parsing rejects invalid or unsafe durations", () => {
  for (const duration of [
    "0s",
    "-1d",
    "1.5h",
    "7days",
    "15x",
    "366d",
    "999999999999999999999d",
  ]) {
    expect(() => tokenExpiryDate(duration)).toThrow();
  }
  const now = Date.now();
  const deadline = tokenExpiryDate("2m").getTime();
  expect(deadline > now + 119_000 && deadline <= now + 120_000).toBe(true);
});

test("auth configuration requires long, distinct secrets", () => {
  const access = process.env.JWT_ACCESS_SECRET;
  try {
    process.env.JWT_ACCESS_SECRET = "short";
    expect(() => validateAuthConfiguration()).toThrow("32 bytes");
    process.env.JWT_ACCESS_SECRET = process.env.JWT_REFRESH_SECRET;
    expect(() => validateAuthConfiguration()).toThrow("different secrets");
  } finally {
    process.env.JWT_ACCESS_SECRET = access;
  }
  validateAuthConfiguration();
});

test("new passwords respect bcrypt's UTF-8 byte limit", () => {
  expect(passwordSchema.safeParse("é".repeat(36)).success).toBe(true);
  expect(passwordSchema.safeParse("é".repeat(37)).success).toBe(false);
  expect(passwordSchema.safeParse("short").success).toBe(false);
});

import { SignJWT, jwtVerify } from "jose";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const issuer = "billd-api";
const audience = "billd-browser";

export interface JWTPayload {
  sub: string;
  email: string;
  sessionId: string;
  sessionVersion: number;
}

function secret(
  name: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET",
  env: NodeJS.ProcessEnv = process.env,
) {
  const value = env[name];
  if (!value || !value.trim() || Buffer.byteLength(value, "utf8") < 32) {
    throw new Error(`${name} must contain at least 32 bytes`);
  }
  return new TextEncoder().encode(value);
}

export function tokenExpiryDate(duration: string): Date {
  const match = /^([1-9]\d*)(s|m|h|d)$/.exec(duration);
  if (!match)
    throw new Error(
      "Token lifetimes must use a positive integer followed by s, m, h, or d",
    );
  const seconds =
    Number(match[1]) *
    { s: 1, m: 60, h: 3600, d: 86400 }[match[2] as "s" | "m" | "h" | "d"];
  if (!Number.isSafeInteger(seconds) || seconds > 365 * 86400) {
    throw new Error("Token lifetimes must not exceed 365 days");
  }
  return new Date((Math.floor(Date.now() / 1000) + seconds) * 1000);
}

export function validateAuthConfiguration(
  env: NodeJS.ProcessEnv = process.env,
) {
  secret("JWT_ACCESS_SECRET", env);
  secret("JWT_REFRESH_SECRET", env);
  if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
    throw new Error("Access and refresh tokens must use different secrets");
  }
  for (const [name, fallback] of [
    ["JWT_ACCESS_EXPIRES_IN", "15m"],
    ["JWT_REFRESH_EXPIRES_IN", "7d"],
  ] as const) {
    try {
      tokenExpiryDate(env[name] ?? fallback);
    } catch (error) {
      throw new Error(
        `${name}: ${error instanceof Error ? error.message : "Invalid token lifetime"}`,
      );
    }
  }
}

function token(
  payload: JWTPayload,
  purpose: "access" | "refresh",
  expiresAt: Date,
) {
  return new SignJWT({
    email: payload.email,
    sid: payload.sessionId,
    sv: payload.sessionVersion,
    token_use: purpose,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(payload.sub)
    .setIssuer(issuer)
    .setAudience(audience)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime(expiresAt)
    .sign(
      secret(purpose === "access" ? "JWT_ACCESS_SECRET" : "JWT_REFRESH_SECRET"),
    );
}

export function signAccessToken(
  payload: JWTPayload,
  expiresAt = tokenExpiryDate(process.env.JWT_ACCESS_EXPIRES_IN ?? "15m"),
) {
  return token(payload, "access", expiresAt);
}

export function signRefreshToken(
  payload: JWTPayload,
  expiresAt = tokenExpiryDate(process.env.JWT_REFRESH_EXPIRES_IN ?? "7d"),
) {
  return token(payload, "refresh", expiresAt);
}

async function verifyToken(
  rawToken: string,
  purpose: "access" | "refresh",
): Promise<JWTPayload> {
  const { payload } = await jwtVerify(
    rawToken,
    secret(purpose === "access" ? "JWT_ACCESS_SECRET" : "JWT_REFRESH_SECRET"),
    {
      algorithms: ["HS256"],
      issuer,
      audience,
      requiredClaims: [
        "sub",
        "email",
        "sid",
        "sv",
        "jti",
        "exp",
        "iat",
        "token_use",
      ],
    },
  );
  const claims = z
    .object({
      sub: z.string().uuid(),
      email: z.string().email(),
      sid: z.string().uuid(),
      sv: z.number().int().min(0).max(2_147_483_647),
      jti: z.string().uuid(),
      iat: z.number().int().nonnegative(),
      exp: z.number().int().positive(),
      token_use: z.literal(purpose),
    })
    .parse(payload);
  return {
    sub: claims.sub,
    email: claims.email,
    sessionId: claims.sid,
    sessionVersion: claims.sv,
  };
}

export function verifyAccessToken(rawToken: string) {
  return verifyToken(rawToken, "access");
}
export function verifyRefreshToken(rawToken: string) {
  return verifyToken(rawToken, "refresh");
}

// Store a hash so a database leak does not expose usable tokens.
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

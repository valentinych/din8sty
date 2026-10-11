/**
 * Panenka SSO + Din8sty session cookies.
 *
 * Login: redirect to https://panenka.games/api/sso/din8sty (Google via Auth.js).
 * Handoff token and session cookie share SSO_SECRET (prod: panenka AUTH_SECRET).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const ADMIN_EMAIL = "aharodnik@gmail.com";
export const SESSION_COOKIE = "din8sty_session";
const SESSION_TTL_SEC = 60 * 60 * 24 * 30; // 30 days

export type AuthUser = {
  email: string;
  name: string | null;
};

export type TokenPayload = {
  email: string;
  name: string | null;
  exp: number;
  aud: string;
};

function secret(): string {
  const s = process.env.SSO_SECRET ?? process.env.AUTH_SECRET ?? "";
  if (!s) {
    throw new Error("SSO_SECRET (or AUTH_SECRET) is not set");
  }
  return s;
}

function b64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf, "utf8");
  return b.toString("base64url");
}

function signPayload(payload: TokenPayload): string {
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", secret()).update(`v1.${body}`).digest("base64url");
  return `v1.${body}.${sig}`;
}

export function verifyToken(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const [, body, sig] = parts;
  let expected: string;
  try {
    expected = createHmac("sha256", secret()).update(`v1.${body}`).digest("base64url");
  } catch {
    return null;
  }
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    if (payload.aud !== "din8sty" || !payload.email || !payload.exp) return null;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return {
      email: String(payload.email).toLowerCase(),
      name: payload.name ?? null,
      exp: payload.exp,
      aud: payload.aud,
    };
  } catch {
    return null;
  }
}

export function mintSessionToken(user: AuthUser): string {
  return signPayload({
    email: user.email.toLowerCase(),
    name: user.name,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
    aud: "din8sty",
  });
}

export function isAdminEmail(email: string | null | undefined): boolean {
  return (email ?? "").toLowerCase() === ADMIN_EMAIL;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getSessionUser(req: FastifyRequest): AuthUser | null {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const payload = verifyToken(token);
  if (!payload) return null;
  return { email: payload.email, name: payload.name };
}

export function setSessionCookie(reply: FastifyReply, token: string, secure: boolean): void {
  const maxAge = SESSION_TTL_SEC;
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(reply: FastifyReply, secure: boolean): void {
  const parts = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (secure) parts.push("Secure");
  reply.header("Set-Cookie", parts.join("; "));
}

export function panenkaSsoUrl(callbackUrl: string, nextPath: string): string {
  const base = process.env.PANENKA_ORIGIN ?? "https://panenka.games";
  const u = new URL("/api/sso/din8sty", base);
  u.searchParams.set("return", callbackUrl);
  if (nextPath) u.searchParams.set("next", nextPath);
  return u.toString();
}

export function isSecureRequest(req: FastifyRequest): boolean {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim();
  if (proto === "https") return true;
  if (proto === "http") return false;
  return process.env.NODE_ENV === "production";
}

export function safeNextPath(raw: string | undefined | null): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

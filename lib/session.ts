import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { config, ROLES, type Role } from "./config";

export type Session = { name: string; role: Role; exp: number };
const COOKIE = "stockroom_session";
const TTL_SECONDS = 60 * 60 * 12; // one shift

const sign = (payload: string) => createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");

export function encodeSession(s: Omit<Session, "exp">): string {
  const payload = Buffer.from(JSON.stringify({ ...s, exp: Math.floor(Date.now() / 1000) + TTL_SECONDS })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function decodeSession(token: string | undefined): Session | null {
  if (!token || !config.sessionSecret) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    if (!ROLES.includes(s.role) || typeof s.name !== "string" || s.exp < Date.now() / 1000) return null;
    return s;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  return decodeSession((await cookies()).get(COOKIE)?.value);
}

export async function setSession(s: Omit<Session, "exp">) {
  (await cookies()).set(COOKIE, encodeSession(s), {
    httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: TTL_SECONDS,
  });
}

export async function clearSession() {
  (await cookies()).delete(COOKIE);
}

/** Constant-time passcode check. Returns the role whose passcode matches, if any. */
export function roleForPasscode(code: string): Role | null {
  let match: Role | null = null;
  for (const role of ROLES) {
    const want = config.passcodes[role];
    if (!want) continue;
    const a = createHmac("sha256", "cmp").update(code).digest();
    const b = createHmac("sha256", "cmp").update(want).digest();
    if (timingSafeEqual(a, b)) match = role;
  }
  return match;
}

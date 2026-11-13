import { createHmac } from "node:crypto";

function findDbUrl(): string {
  const e = process.env;
  const direct = e.DATABASE_URL || e.POSTGRES_URL;
  if (direct) return direct;
  const key = Object.keys(e).find((k) => /(DATABASE_URL|POSTGRES_URL)$/.test(k) && !/UNPOOLED|NON_POOLING/.test(k));
  return key ? (e[key] as string) : "";
}

export type Role = "staff" | "manager" | "admin";
export const ROLES: Role[] = ["staff", "manager", "admin"];

export const config = {
  databaseUrl: findDbUrl(),
  sessionSecret: process.env.SESSION_SECRET ?? "",
  timezone: process.env.APP_TIMEZONE || "America/Chicago",
  restaurantName: process.env.RESTAURANT_NAME || "Our Kitchen",
  passcodes: {
    staff: process.env.STAFF_PASSCODE ?? "",
    manager: process.env.MANAGER_PASSCODE ?? "",
    admin: process.env.ADMIN_PASSCODE ?? "",
  } as Record<Role, string>,
};

export function requireConfig() {
  const missing: string[] = [];
  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (config.sessionSecret.length < 32) missing.push("SESSION_SECRET (32+ chars)");
  if (!process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) missing.push("GEMINI_API_KEY (free from aistudio.google.com/apikey)");
  if (!config.passcodes.staff && !config.passcodes.manager) missing.push("STAFF_PASSCODE / MANAGER_PASSCODE");
  return missing;
}

// Must match scripts/setup.mjs
export const READERS = { staff: "stockroom_staff_ro", manager: "stockroom_manager_ro" } as const;
export function readerPassword(kind: keyof typeof READERS) {
  return createHmac("sha256", config.sessionSecret).update(`reader:${kind}`).digest("hex").slice(0, 40) + "Aa9!";
}
export const readerFor = (role: Role): keyof typeof READERS => (role === "staff" ? "staff" : "manager");

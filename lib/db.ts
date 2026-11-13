import postgres from "postgres";
import { config, READERS, readerFor, readerPassword, type Role } from "./config";

// Return numbers as numbers and dates/timestamps as plain strings (no timezone surprises in JSON).
const types = {
  numeric: { to: 1700, from: [1700], serialize: (x: unknown) => String(x), parse: (x: string) => parseFloat(x) },
  date: { to: 1082, from: [1082], serialize: (x: unknown) => String(x), parse: (x: string) => x },
  tstz: { to: 1184, from: [1184, 1114], serialize: (x: unknown) => String(x), parse: (x: string) => x },
  int8: { to: 20, from: [20], serialize: (x: unknown) => String(x), parse: (x: string) => Number(x) },
};

type Sql = ReturnType<typeof postgres>;
const g = globalThis as unknown as { __owner?: Sql; __readers?: Partial<Record<string, Sql>> };

/** Owner connection: app plumbing and the confirmed, typed write operations only. */
export function ownerDb(): Sql {
  g.__owner ??= postgres(config.databaseUrl, { prepare: false, max: 3, idle_timeout: 20, types, onnotice: () => {} });
  return g.__owner;
}

/**
 * Read-only login for a role. Staff → sees the cost-free `staff_ro` schema only.
 * Manager/admin → inventory tables + audit log, never conversations or pending actions.
 * The login itself has default_transaction_read_only=on and a 5s statement timeout.
 */
export function readerDb(role: Role): Sql {
  const kind = readerFor(role);
  g.__readers ??= {};
  if (!g.__readers[kind]) {
    const u = new URL(config.databaseUrl);
    u.username = READERS[kind];
    u.password = encodeURIComponent(readerPassword(kind));
    g.__readers[kind] = postgres(u.toString(), { prepare: false, max: 3, idle_timeout: 20, types, onnotice: () => {} });
  }
  return g.__readers[kind]!;
}

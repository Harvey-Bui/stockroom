import type { Role } from "./config";
import { ownerDb, readerDb } from "./db";

export const MAX_ROWS = 200;

// ---------------------------------------------------------------------------- reads

export type QueryResult =
  | { columns: string[]; rows: unknown[][]; row_count: number; truncated?: string }
  | { error: string };

/** Strip quoted literals and comments so we can look for statement separators. */
export function stripLiterals(sql: string): string {
  return sql
    .replace(/'(?:''|[^'])*'/g, "''")
    .replace(/"(?:""|[^"])*"/g, '""')
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, "''")
    .replace(/--[^\n]*/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

export function checkReadSql(raw: string): string | { error: string } {
  const sql = raw.trim().replace(/;\s*$/, "").trim();
  if (!sql) return { error: "Empty query." };
  const bare = stripLiterals(sql);
  if (bare.includes(";")) return { error: "Only one statement per call." };
  if (!/^\s*(select|with)\b/i.test(bare)) return { error: "Only SELECT queries are allowed. Use the write tools to change data." };
  return sql;
}

/**
 * Runs model-written SQL as the role's read-only database login, inside a READ ONLY
 * transaction, wrapped so it can only ever be one SELECT and returns at most MAX_ROWS+1 rows.
 * The database grants (not this function) decide what each role can see.
 */
export async function runReadQuery(role: Role, raw: string): Promise<QueryResult> {
  const checked = checkReadSql(raw);
  if (typeof checked !== "string") return checked;
  const db = readerDb(role);
  try {
    const result = await db.begin("read only", async (tx) => {
      await tx.unsafe("SET LOCAL statement_timeout = '5s'");
      return tx.unsafe(`SELECT * FROM (\n${checked}\n) AS q LIMIT ${MAX_ROWS + 1}`);
    });
    const columns = (result.columns ?? []).map((c: { name: string }) => c.name);
    const rows = (result as unknown as Record<string, unknown>[]).map((r) => columns.map((c) => r[c]));
    const out: QueryResult = { columns, rows: rows.slice(0, MAX_ROWS), row_count: Math.min(rows.length, MAX_ROWS) };
    if (rows.length > MAX_ROWS) out.truncated = `Only the first ${MAX_ROWS} rows are shown; add filters or aggregation.`;
    return out;
  } catch (e) {
    const err = e as { message?: string; code?: string };
    if (err.code === "42501") return { error: `Not permitted for role '${role}': ${err.message}` };
    if (err.code === "57014") return { error: "Query took too long and was cancelled. Narrow it down." };
    if (err.code === "25006") return { error: "Read-only: use the write tools to change data." };
    return { error: err.message ?? String(e) };
  }
}

/** Column list for everything this role's login can read (privileges decide what shows up). */
export async function describeSchema(role: Role): Promise<string> {
  const rows = await readerDb(role)`
    SELECT c.table_name, t.table_type, string_agg(c.column_name || ' ' || c.data_type, ', ' ORDER BY c.ordinal_position) AS cols
    FROM information_schema.columns c
    JOIN information_schema.tables t USING (table_schema, table_name)
    WHERE c.table_schema = current_schema()
    GROUP BY c.table_name, t.table_type
    ORDER BY t.table_type DESC, c.table_name`;
  return rows.map((r) => `${r.table_type === "VIEW" ? "view" : "table"} ${r.table_name}(${r.cols})`).join("\n");
}

export async function dataProfile(role: Role): Promise<string> {
  const db = readerDb(role);
  const [p] = await db`
    SELECT
      (SELECT count(*) FROM ingredients)::int AS items,
      (SELECT count(*) FROM ingredients WHERE is_food)::int AS food,
      (SELECT count(*) FROM suppliers)::int AS suppliers,
      (SELECT count(*) FROM suppliers WHERE phone IS NOT NULL OR email IS NOT NULL)::int AS sup_contacts,
      (SELECT count(*) FROM purchase_orders)::int AS deliveries,
      (SELECT min(invoice_date)::text FROM purchase_orders) AS first_delivery,
      (SELECT max(invoice_date)::text FROM purchase_orders) AS last_delivery,
      (SELECT count(DISTINCT ingredient_id) FROM inventory_transactions WHERE txn_type = 'count')::int AS counted,
      (SELECT count(*) FROM ingredients WHERE min_stock_level IS NOT NULL OR reorder_point IS NOT NULL)::int AS thresholds,
      (SELECT count(*) FROM inventory_transactions WHERE txn_type IN ('usage','waste'))::int AS usage,
      (SELECT count(*) FROM v_expiring_lots WHERE expiration_date IS NOT NULL)::int AS expiring`;
  return [
    `- stocked items: ${p.items} (${p.food} food, the rest packaging/supplies)`,
    `- suppliers: ${p.suppliers} (with phone/email on file: ${p.sup_contacts})`,
    `- deliveries on record: ${p.deliveries}, from ${p.first_delivery ?? "n/a"} to ${p.last_delivery ?? "n/a"}`,
    `- items with a physical stock count: ${p.counted}`,
    `- items with min/reorder thresholds: ${p.thresholds}`,
    `- usage/waste records: ${p.usage}`,
    `- lots with an expiration date: ${p.expiring}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------- writes

export const ROLE_WRITES: Record<Role, string[]> = {
  staff: ["record_stock_count", "record_usage"],
  manager: ["record_stock_count", "record_usage", "record_delivery", "set_stock_thresholds", "set_lot_expiration", "update_supplier_contact"],
  admin: ["record_stock_count", "record_usage", "record_delivery", "set_stock_thresholds", "set_lot_expiration", "update_supplier_contact"],
};

export type Actor = { name: string; role: Role };
export type Prepared = { ok: true; summary: string; args: Record<string, unknown> } | { ok: false; reason: string };

type Args = Record<string, unknown>;
const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const isDate = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v));
const fmt = (n: number) => String(Number(n.toFixed(3)));

async function ingredient(id: unknown) {
  const rows = await ownerDb()`
    SELECT ingredient_id, name, COALESCE(stock_unit, order_unit) AS unit FROM ingredients WHERE ingredient_id = ${String(id ?? "")}`;
  if (!rows.length) throw new Error(`No item with id '${id}'. Look it up with query_inventory first.`);
  return rows[0] as { ingredient_id: string; name: string; unit: string | null };
}

function checkUnit(given: unknown, expected: string | null) {
  const g = str(given);
  if (g && expected && g.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Unit mismatch: this item is tracked in '${expected}', not '${g}'. Convert first or ask the user.`);
  }
}

/** Validate a write and build the human-readable confirmation text. Touches nothing. */
export async function prepareWrite(actor: Actor, action: string, a: Args): Promise<Prepared> {
  if (!ROLE_WRITES[actor.role].includes(action)) {
    return { ok: false, reason: `Role '${actor.role}' is not allowed to ${action}.` };
  }
  try {
    switch (action) {
      case "record_stock_count": {
        const it = await ingredient(a.ingredient_id);
        checkUnit(a.unit, it.unit);
        const q = num(a.quantity);
        if (!(q >= 0)) throw new Error("A stock count must be a number ≥ 0.");
        return { ok: true, summary: `Record a physical count: **${it.name}** = ${fmt(q)} ${it.unit ?? ""}`.trim(),
          args: { ingredient_id: it.ingredient_id, quantity: q, unit: it.unit, note: str(a.note) } };
      }
      case "record_usage": {
        const it = await ingredient(a.ingredient_id);
        checkUnit(a.unit, it.unit);
        const q = num(a.quantity);
        const kind = a.kind === "waste" ? "waste" : a.kind === "usage" || a.kind == null ? "usage" : null;
        if (!kind) throw new Error("kind must be 'usage' or 'waste'.");
        if (!(q > 0)) throw new Error("Quantity must be a positive number.");
        return { ok: true, summary: `Record ${kind}: ${fmt(q)} ${it.unit ?? ""} of **${it.name}**`,
          args: { ingredient_id: it.ingredient_id, quantity: q, kind, unit: it.unit, note: str(a.note) } };
      }
      case "record_delivery": {
        const sup = await ownerDb()`SELECT supplier_id, name FROM suppliers WHERE supplier_id = ${String(a.supplier_id ?? "")}`;
        if (!sup.length) throw new Error(`No supplier with id '${a.supplier_id}'.`);
        if (!isDate(a.invoice_date)) throw new Error("invoice_date must be YYYY-MM-DD.");
        const lines = Array.isArray(a.lines) ? (a.lines as Args[]) : [];
        if (!lines.length) throw new Error("A delivery needs at least one line.");
        const out = [];
        for (const ln of lines) {
          const it = await ingredient(ln.ingredient_id);
          const shipped = num(ln.qty_shipped);
          const ordered = ln.qty_ordered == null ? shipped : num(ln.qty_ordered);
          if (!(shipped >= 0) || !(ordered >= 0)) throw new Error(`Quantities for ${it.name} must be numbers ≥ 0.`);
          if (ln.expiration_date != null && !isDate(ln.expiration_date)) throw new Error("expiration_date must be YYYY-MM-DD.");
          const cost = ln.unit_cost_usd == null ? null : num(ln.unit_cost_usd);
          if (cost !== null && !(cost >= 0)) throw new Error("unit_cost_usd must be ≥ 0.");
          out.push({ ingredient_id: it.ingredient_id, name: it.name, unit: it.unit, ordered, shipped, cost,
            expiration_date: (ln.expiration_date as string) ?? null });
        }
        const summary = `Record delivery from **${sup[0].name}** on ${a.invoice_date}:\n` + out.map((l) =>
          `- ${l.name}: shipped ${fmt(l.shipped)} of ${fmt(l.ordered)} ${l.unit ?? ""}` +
          (l.cost != null ? ` @ $${l.cost.toFixed(2)}` : "") + (l.expiration_date ? `, expires ${l.expiration_date}` : "")).join("\n");
        return { ok: true, summary, args: { supplier_id: sup[0].supplier_id, invoice_date: a.invoice_date,
          invoice_number: str(a.invoice_number), lines: out } };
      }
      case "set_stock_thresholds": {
        const it = await ingredient(a.ingredient_id);
        const vals: Record<string, number | string> = {};
        for (const k of ["min_stock_level", "reorder_point", "target_stock"]) {
          if (a[k] == null) continue;
          const v = num(a[k]);
          if (!(v >= 0)) throw new Error(`${k} must be a number ≥ 0.`);
          vals[k] = v;
        }
        if (str(a.stock_unit)) vals.stock_unit = str(a.stock_unit)!;
        if (!Object.keys(vals).length) throw new Error("Nothing to change.");
        const unit = (vals.stock_unit as string) ?? it.unit ?? "";
        const label: Record<string, string> = { min_stock_level: "minimum", reorder_point: "reorder point",
          target_stock: "target", stock_unit: "tracking unit" };
        return { ok: true, summary: `Update **${it.name}**: ` + Object.entries(vals).map(([k, v]) =>
          `${label[k]} → ${typeof v === "number" ? `${fmt(v)} ${unit}` : v}`).join(", "),
          args: { ingredient_id: it.ingredient_id, ...vals } };
      }
      case "set_lot_expiration": {
        if (!isDate(a.expiration_date)) throw new Error("expiration_date must be YYYY-MM-DD.");
        const rows = await ownerDb()`
          SELECT l.lot_id, i.name, l.received_date FROM stock_lots l JOIN ingredients i USING (ingredient_id)
          WHERE l.lot_id = ${Number(a.lot_id) || 0}`;
        if (!rows.length) throw new Error(`No lot ${a.lot_id}.`);
        return { ok: true, summary: `Set expiration of **${rows[0].name}** (lot ${rows[0].lot_id}, received ${rows[0].received_date}) → ${a.expiration_date}`,
          args: { lot_id: rows[0].lot_id, expiration_date: a.expiration_date } };
      }
      case "update_supplier_contact": {
        const sup = await ownerDb()`SELECT supplier_id, name FROM suppliers WHERE supplier_id = ${String(a.supplier_id ?? "")}`;
        if (!sup.length) throw new Error(`No supplier with id '${a.supplier_id}'.`);
        const vals: Record<string, string> = {};
        for (const k of ["contact_name", "phone", "email", "address"]) if (str(a[k])) vals[k] = str(a[k])!;
        if (!Object.keys(vals).length) throw new Error("Nothing to change.");
        return { ok: true, summary: `Update supplier **${sup[0].name}**: ` + Object.entries(vals).map(([k, v]) => `${k.replace("_", " ")} → ${v}`).join(", "),
          args: { supplier_id: sup[0].supplier_id, ...vals } };
      }
      default:
        return { ok: false, reason: `Unknown action '${action}'.` };
    }
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

export async function logAudit(actor: Actor, action: string, details: unknown, outcome: "applied" | "declined" | "rejected" | "expired") {
  await ownerDb()`INSERT INTO audit_log (user_name, role, action, details, outcome)
                  VALUES (${actor.name}, ${actor.role}, ${action}, ${ownerDb().json(details as never)}, ${outcome})`;
}

/** Apply an already-prepared, human-confirmed write. Change + audit row commit together. */
export async function applyWrite(actor: Actor, action: string, a: Args): Promise<void> {
  if (!ROLE_WRITES[actor.role].includes(action)) throw new Error("Not permitted.");
  await ownerDb().begin(async (tx) => {
    switch (action) {
      case "record_stock_count":
      case "record_usage": {
        const type = action === "record_stock_count" ? "count" : (a.kind as string);
        await tx`INSERT INTO inventory_transactions (ingredient_id, txn_type, quantity, unit, txn_at, recorded_by, note)
                 VALUES (${a.ingredient_id as string}, ${type}, ${a.quantity as number}, ${a.unit as string}, now(),
                         ${actor.name}, ${(a.note as string) ?? null})`;
        break;
      }
      case "record_delivery": {
        const lines = a.lines as { ingredient_id: string; unit: string; ordered: number; shipped: number; cost: number | null; expiration_date: string | null }[];
        const status = lines.some((l) => l.shipped < l.ordered) ? "partial" : "delivered";
        const [{ po_id }] = await tx`
          INSERT INTO purchase_orders (supplier_id, invoice_number, invoice_date, delivery_status)
          VALUES (${a.supplier_id as string}, ${(a.invoice_number as string) ?? null}, ${a.invoice_date as string}, ${status})
          RETURNING po_id`;
        for (const l of lines) {
          const [{ line_id }] = await tx`
            INSERT INTO purchase_lines (po_id, ingredient_id, qty_ordered, qty_shipped, unit, unit_cost_usd, line_cost_usd)
            VALUES (${po_id}, ${l.ingredient_id}, ${l.ordered}, ${l.shipped}, ${l.unit}, ${l.cost},
                    ${l.cost == null ? null : Math.round(l.cost * l.shipped * 100) / 100})
            RETURNING line_id`;
          if (l.shipped > 0) {
            await tx`INSERT INTO inventory_transactions (ingredient_id, txn_type, quantity, unit, txn_at, recorded_by, purchase_line_id, note)
                     VALUES (${l.ingredient_id}, 'receipt', ${l.shipped}, ${l.unit}, now(), ${actor.name}, ${line_id}, 'Delivery')`;
            await tx`INSERT INTO stock_lots (ingredient_id, purchase_line_id, received_date, quantity, unit, expiration_date)
                     VALUES (${l.ingredient_id}, ${line_id}, ${a.invoice_date as string}, ${l.shipped}, ${l.unit}, ${l.expiration_date})`;
          }
        }
        break;
      }
      case "set_stock_thresholds": {
        const { ingredient_id, ...vals } = a;
        // Column names come from prepareWrite's fixed allow-list, values are parameterised.
        await tx`UPDATE ingredients SET ${tx(vals as Record<string, string | number>)}, updated_at = now()
                 WHERE ingredient_id = ${ingredient_id as string}`;
        break;
      }
      case "set_lot_expiration":
        await tx`UPDATE stock_lots SET expiration_date = ${a.expiration_date as string} WHERE lot_id = ${a.lot_id as number}`;
        break;
      case "update_supplier_contact": {
        const { supplier_id, ...vals } = a;
        await tx`UPDATE suppliers SET ${tx(vals as Record<string, string>)} WHERE supplier_id = ${supplier_id as string}`;
        break;
      }
      default:
        throw new Error(`Unknown action '${action}'.`);
    }
    await tx`INSERT INTO audit_log (user_name, role, action, details, outcome)
             VALUES (${actor.name}, ${actor.role}, ${action}, ${tx.json(a as never)}, 'applied')`;
  });
}

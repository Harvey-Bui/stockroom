// Creates/updates the schema, seeds the spreadsheet data (first run only),
// and creates the two read-only database logins the assistant uses.
// Idempotent: runs automatically before every Vercel build.
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import postgres from "postgres";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
const secret = process.env.SESSION_SECRET;
const tz = process.env.APP_TIMEZONE || "America/Chicago";

if (!url) {
  console.error("✖ DATABASE_URL is not set. Add a Neon Postgres database to the Vercel project (Storage tab) first.");
  process.exit(1);
}
if (!secret || secret.length < 32) {
  console.error("✖ SESSION_SECRET must be set to a random string of at least 32 characters.");
  process.exit(1);
}

export const READERS = { staff: "stockroom_staff_ro", manager: "stockroom_manager_ro" };
export function readerPassword(role, s = secret) {
  return createHmac("sha256", s).update(`reader:${role}`).digest("hex").slice(0, 40) + "Aa9!";
}

const NON_FOOD = new Set(["office supplies", "foodservice packaging", "cleaning & ppe"]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const sql = postgres(url, { prepare: false, onnotice: () => {}, max: 1 });

async function main() {
  await sql.unsafe(readFileSync(path.join(root, "db/schema.sql"), "utf8"));
  console.log("✔ schema");

  const [{ n }] = await sql`SELECT count(*)::int AS n FROM ingredients`;
  if (n === 0) {
    const rows = JSON.parse(readFileSync(path.join(root, "seed/inventory.json"), "utf8"));
    await seed(rows);
  } else {
    console.log(`• data already present (${n} items) — skipping seed`);
  }

  await createReaders();
  console.log("✔ read-only logins");
  await sql.end();
}

async function seed(rows) {
  await sql.begin(async (tx) => {
    const suppliers = new Map();
    const pos = new Map();
    for (const r of rows) {
      let supId = null;
      if (r.supplier) {
        supId = suppliers.get(r.supplier);
        if (!supId) {
          supId = slug(r.supplier);
          await tx`INSERT INTO suppliers (supplier_id, name) VALUES (${supId}, ${r.supplier})`;
          suppliers.set(r.supplier, supId);
        }
      }
      const cat = r.category || "Uncategorised";
      await tx`
        INSERT INTO ingredients (ingredient_id, name, category, is_food, supplier_id, supplier_sku, pack_size,
                                 order_unit, stock_unit, min_stock_level, reorder_point, target_stock, notes)
        VALUES (${r.item_id}, ${r.product_name}, ${cat}, ${!NON_FOOD.has(cat.toLowerCase())}, ${supId},
                ${r.supplier_sku}, ${r.pack_size}, ${r.order_unit}, ${r.order_unit},
                ${r.min_stock_level ?? null}, ${r.reorder_point ?? null}, ${r.target_stock ?? null}, ${r.data_notes})`;

      if (r.last_invoice_date && supId && r.last_qty_ordered != null) {
        const key = `${supId}|${r.last_invoice_date}`;
        if (!pos.has(key)) {
          const [{ po_id }] = await tx`
            INSERT INTO purchase_orders (supplier_id, invoice_date) VALUES (${supId}, ${r.last_invoice_date})
            RETURNING po_id`;
          pos.set(key, po_id);
        }
        const shipped = r.last_qty_shipped ?? r.last_qty_ordered;
        const [{ line_id }] = await tx`
          INSERT INTO purchase_lines (po_id, ingredient_id, invoice_description, qty_ordered, qty_shipped, unit,
                                      unit_cost_usd, line_cost_usd, notes)
          VALUES (${pos.get(key)}, ${r.item_id}, ${r.invoice_description}, ${r.last_qty_ordered}, ${shipped},
                  ${r.order_unit}, ${r.unit_cost_usd}, ${r.last_line_cost_usd}, ${r.data_notes})
          RETURNING line_id`;
        if (shipped < r.last_qty_ordered) {
          await tx`UPDATE purchase_orders SET delivery_status = 'partial' WHERE po_id = ${pos.get(key)}`;
        }
        if (shipped > 0) {
          await tx`
            INSERT INTO inventory_transactions (ingredient_id, txn_type, quantity, unit, txn_at, recorded_by,
                                                purchase_line_id, note)
            VALUES (${r.item_id}, 'receipt', ${shipped}, ${r.order_unit},
                    (${r.last_invoice_date}::date)::timestamp AT TIME ZONE ${tz}, 'import', ${line_id},
                    'From supplier invoice')`;
          await tx`
            INSERT INTO stock_lots (ingredient_id, purchase_line_id, received_date, quantity, unit, expiration_date)
            VALUES (${r.item_id}, ${line_id}, ${r.last_invoice_date}, ${shipped}, ${r.order_unit},
                    ${r.expiration_date ?? null})`;
        }
      }
      if (r.qty_on_hand != null) {
        await tx`
          INSERT INTO inventory_transactions (ingredient_id, txn_type, quantity, unit, txn_at, recorded_by, note)
          VALUES (${r.item_id}, 'count', ${r.qty_on_hand}, ${r.order_unit}, now(), 'import', 'qty_on_hand from spreadsheet')`;
      }
    }
    await tx`
      INSERT INTO audit_log (user_name, role, action, details, outcome)
      VALUES ('system', 'admin', 'import', ${tx.json({ source: "seed/inventory.json", items: rows.length })}, 'applied')`;
    console.log(`✔ seeded ${rows.length} items, ${suppliers.size} suppliers, ${pos.size} deliveries`);
  });
}

async function createReaders() {
  const [{ db }] = await sql`SELECT current_database() AS db`;
  for (const [role, name] of Object.entries(READERS)) {
    const pw = readerPassword(role).replace(/'/g, "''");
    const exists = await sql`SELECT 1 FROM pg_roles WHERE rolname = ${name}`;
    await sql.unsafe(
      exists.length
        ? `ALTER ROLE ${name} WITH LOGIN PASSWORD '${pw}'`
        : `CREATE ROLE ${name} WITH LOGIN PASSWORD '${pw}'`
    );
    await sql.unsafe(`GRANT CONNECT ON DATABASE "${db}" TO ${name}`);
    await sql.unsafe(`ALTER ROLE ${name} SET default_transaction_read_only = on`);
    await sql.unsafe(`ALTER ROLE ${name} SET statement_timeout = '5s'`);
    await sql.unsafe(`ALTER ROLE ${name} SET TimeZone = '${tz.replace(/'/g, "")}'`);
  }
  const staff = READERS.staff;
  const mgr = READERS.manager;

  // Staff: only the cost-free views in staff_ro.
  await sql.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${staff}`);
  await sql.unsafe(`GRANT USAGE ON SCHEMA staff_ro TO ${staff}`);
  await sql.unsafe(`GRANT SELECT ON ALL TABLES IN SCHEMA staff_ro TO ${staff}`);
  await sql.unsafe(`ALTER ROLE ${staff} SET search_path = staff_ro`);

  // Manager: inventory tables, views and the audit log. Never the chat/plumbing tables.
  await sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${mgr}`);
  await sql.unsafe(`REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${mgr}`);
  await sql.unsafe(
    `GRANT SELECT ON suppliers, ingredients, purchase_orders, purchase_lines, stock_lots, inventory_transactions,
       audit_log, v_current_stock, v_purchase_history, v_expiring_lots TO ${mgr}`
  );
  await sql.unsafe(`ALTER ROLE ${mgr} SET search_path = public`);
}

main().catch(async (e) => {
  console.error("✖ setup failed:", e.message);
  await sql.end({ timeout: 1 });
  process.exit(1);
});

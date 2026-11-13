import InventoryTable, { type Item } from "@/components/InventoryTable";
import AskButton from "@/components/AskButton";
import { readerDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function InventoryPage() {
  const s = (await getSession())!;
  const db = readerDb(s.role);
  const items = (await db`
    SELECT c.ingredient_id, c.name, c.category, c.supplier, c.unit, c.pack_size, c.current_stock,
           c.min_stock_level, c.reorder_point, c.stock_status, c.notes,
           (SELECT max(delivery_date)::text FROM v_purchase_history h WHERE h.ingredient_id = c.ingredient_id) AS last_received
    FROM v_current_stock c
    ORDER BY CASE c.stock_status WHEN 'Out of stock' THEN 0 WHEN 'Low stock' THEN 1 WHEN 'Reorder' THEN 2 WHEN 'OK' THEN 3
                                 WHEN 'Unknown - no threshold set' THEN 4 ELSE 5 END, c.category, c.name`) as unknown as Item[];
  const [k] = await db`
    SELECT (SELECT count(*) FROM suppliers)::int AS suppliers,
           (SELECT max(invoice_date)::text FROM purchase_orders) AS last_delivery,
           (SELECT count(*) FROM v_purchase_history WHERE qty_short > 0)::int AS short_lines`;

  const counted = items.filter((i) => i.current_stock != null).length;
  const attention = items.filter((i) => ["Low stock", "Reorder", "Out of stock"].includes(i.stock_status)).length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
          <p>{items.length} items across {k.suppliers} suppliers</p>
        </div>
        <AskButton text="What's running low, and who do I order it from?" label="What's running low?" />
      </div>

      {counted === 0 && (
        <div className="notice">
          <span aria-hidden>📋</span>
          <div>
            <strong>No stock counts recorded yet.</strong> On-hand amounts and low-stock alerts appear once
            counts are in. Tell the assistant something like <em>“we have 3 bags of jasmine rice”</em> and approve the change.
          </div>
        </div>
      )}

      <div className="stats">
        <div className="stat"><div className="stat-label">Items counted</div><div className="stat-value">{counted}/{items.length}</div>
          <div className="stat-note">have an on-hand amount</div></div>
        <div className={`stat${attention ? " attn" : ""}`}><div className="stat-label">Need attention</div><div className="stat-value">{attention}</div>
          <div className="stat-note">low, reorder or out</div></div>
        <div className="stat"><div className="stat-label">Last delivery</div><div className="stat-value" style={{ fontSize: 22 }}>{k.last_delivery ?? "—"}</div>
          <div className="stat-note">invoice date</div></div>
        <div className={`stat${k.short_lines ? " attn" : ""}`}><div className="stat-label">Short-shipped</div><div className="stat-value">{k.short_lines}</div>
          <div className="stat-note">lines not fully delivered</div></div>
      </div>

      <InventoryTable items={items} />
    </>
  );
}

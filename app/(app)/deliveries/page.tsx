import AskButton from "@/components/AskButton";
import { readerDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

type Line = {
  po_id: number; invoice_number: string | null; invoice_date: string; delivery_status: string; supplier: string;
  ingredient: string; invoice_description: string | null; qty_ordered: number; qty_shipped: number; qty_short: number;
  unit: string | null; unit_cost_usd?: number | null; line_cost_usd?: number | null; notes: string | null;
};
const money = (n: number | null | undefined) => (n == null ? "—" : `$${n.toFixed(2)}`);

export default async function DeliveriesPage() {
  const s = (await getSession())!;
  const showCost = s.role !== "staff";
  const lines = (await readerDb(s.role)`SELECT * FROM v_purchase_history ORDER BY invoice_date DESC, po_id, line_id`) as unknown as Line[];
  const orders = new Map<number, Line[]>();
  for (const l of lines) orders.set(l.po_id, [...(orders.get(l.po_id) ?? []), l]);

  return (
    <>
      <div className="page-head">
        <div><h1>Deliveries</h1><p>{orders.size} invoices on record</p></div>
        <AskButton text="Was anything short-shipped?" label="Anything short-shipped?" />
      </div>
      {[...orders.values()].map((ls) => {
        const h = ls[0];
        const total = ls.reduce((a, l) => a + (l.line_cost_usd ?? 0), 0);
        const short = ls.filter((l) => l.qty_short > 0).length;
        return (
          <section className="card delivery" key={h.po_id}>
            <div className="delivery-head">
              <div>
                <h2>{h.supplier}</h2>
                <div className="delivery-meta">
                  {h.invoice_date}{h.invoice_number ? ` · Invoice ${h.invoice_number}` : ""} · {ls.length} lines
                  {short > 0 && <> · <span className="short">{short} short</span></>}
                  {showCost && <> · {money(total)}</>}
                </div>
              </div>
              <AskButton text={`Summarise the ${h.supplier} delivery from ${h.invoice_date}.`} />
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr>
                  <th>Item</th><th className="hide-sm">On invoice as</th><th className="num">Shipped</th>
                  {showCost && <><th className="num hide-sm">Unit cost</th><th className="num">Line</th></>}
                </tr></thead>
                <tbody>
                  {ls.map((l, i) => (
                    <tr key={i}>
                      <td><div className="item-name">{l.ingredient}</div>{l.notes && <div className="item-sub">{l.notes}</div>}</td>
                      <td className="hide-sm">{l.invoice_description ?? "—"}</td>
                      <td className="num">
                        {l.qty_short > 0 ? <span className="short">{l.qty_shipped} of {l.qty_ordered}</span> : l.qty_shipped} {l.unit}
                      </td>
                      {showCost && <><td className="num hide-sm">{money(l.unit_cost_usd)}</td><td className="num">{money(l.line_cost_usd)}</td></>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}

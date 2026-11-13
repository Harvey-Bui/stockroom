import { redirect } from "next/navigation";
import { readerDb } from "@/lib/db";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = {
  record_stock_count: "Stock count", record_usage: "Usage / waste", record_delivery: "Delivery",
  set_stock_thresholds: "Thresholds", set_lot_expiration: "Expiry date", update_supplier_contact: "Supplier contact", import: "Data import",
};
const pill: Record<string, string> = { applied: "ok", declined: "unk", expired: "unk", rejected: "bad" };

export default async function ActivityPage() {
  const s = (await getSession())!;
  if (s.role === "staff") redirect("/");
  const rows = await readerDb(s.role)`
    SELECT id, to_char(at, 'Mon DD, HH24:MI') AS at, user_name, role, action, details, outcome
    FROM audit_log ORDER BY id DESC LIMIT 200`;
  return (
    <>
      <div className="page-head"><div><h1>Activity log</h1><p>Every change the assistant was asked to make, including cancelled and rejected ones.</p></div></div>
      <div className="card table-wrap">
        <table className="data">
          <thead><tr><th>When</th><th>Who</th><th>Action</th><th className="hide-sm">Details</th><th>Result</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id as number}>
                <td style={{ whiteSpace: "nowrap" }}>{r.at as string}</td>
                <td>{r.user_name as string}<div className="item-sub">{r.role as string}</div></td>
                <td>{LABELS[r.action as string] ?? (r.action as string)}</td>
                <td className="hide-sm"><code style={{ fontSize: 12 }}>{JSON.stringify(r.details).slice(0, 140)}</code></td>
                <td><span className={`pill ${pill[r.outcome as string] ?? "unk"}`}>{r.outcome as string}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

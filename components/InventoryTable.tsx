"use client";
import { useMemo, useState } from "react";
import { ask } from "./AskButton";

export type Item = {
  ingredient_id: string; name: string; category: string; supplier: string | null; unit: string | null;
  pack_size: string | null; current_stock: number | null; min_stock_level: number | null; reorder_point: number | null;
  stock_status: string; last_received: string | null; notes: string | null;
};

export function statusClass(s: string) {
  if (s === "OK") return "ok";
  if (s === "Reorder") return "warn";
  if (s === "Low stock" || s === "Out of stock") return "bad";
  return "unk";
}
export const statusLabel = (s: string) => (s.startsWith("Unknown - no stock") ? "Not counted" : s.startsWith("Unknown") ? "No threshold" : s);
const fmt = (n: number | null, unit: string | null) => (n == null ? "—" : `${Number(n.toFixed(2))} ${unit ?? ""}`.trim());

export default function InventoryTable({ items }: { items: Item[] }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [status, setStatus] = useState("");
  const cats = useMemo(() => [...new Set(items.map((i) => i.category))].sort(), [items]);
  const shown = items.filter((i) =>
    (!cat || i.category === cat) &&
    (!status || statusLabel(i.stock_status) === status) &&
    (!q || `${i.name} ${i.supplier ?? ""} ${i.ingredient_id}`.toLowerCase().includes(q.toLowerCase())));

  return (
    <div className="card">
      <div className="toolbar">
        <input className="input" placeholder="Search items or suppliers…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <select className="select" value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Category">
          <option value="">All categories</option>
          {cats.map((c) => <option key={c}>{c}</option>)}
        </select>
        <select className="select" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          {["Out of stock", "Low stock", "Reorder", "OK", "No threshold", "Not counted"].map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Item</th><th className="hide-sm">Supplier</th><th className="num">On hand</th>
              <th className="num hide-sm">Min</th><th>Status</th><th className="hide-sm">Last received</th><th />
            </tr>
          </thead>
          <tbody>
            {shown.map((i) => (
              <tr key={i.ingredient_id}>
                <td>
                  <div className="item-name">{i.name}</div>
                  <div className="item-sub">{i.category}{i.pack_size ? ` · ${i.pack_size}` : ""}</div>
                </td>
                <td className="hide-sm">{i.supplier ?? "—"}</td>
                <td className="num">{fmt(i.current_stock, i.unit)}</td>
                <td className="num hide-sm">{fmt(i.min_stock_level ?? i.reorder_point, i.unit)}</td>
                <td><span className={`pill ${statusClass(i.stock_status)}`}>{statusLabel(i.stock_status)}</span></td>
                <td className="hide-sm">{i.last_received ?? "—"}</td>
                <td><button className="ask-btn" onClick={() => ask(`Tell me about ${i.name} (${i.ingredient_id}).`)}>Ask</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!shown.length && <div className="empty">No items match.</div>}
      </div>
    </div>
  );
}

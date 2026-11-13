// End-to-end tests against a running app + tests/mock-anthropic.mjs.
//   node tests/mock-anthropic.mjs &
//   ANTHROPIC_BASE_URL=http://127.0.0.1:4010 npm start &
//   BASE=http://127.0.0.1:3000 STAFF_PASSCODE=… MANAGER_PASSCODE=… node --test tests/e2e.mjs
// Run against a throwaway database: it records counts and thresholds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BASE = process.env.BASE || "http://127.0.0.1:3000";

async function login(name, passcode) {
  const r = await fetch(`${BASE}/api/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, passcode }) });
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}
function client(cookie) {
  const post = async (path, body) => {
    const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
  return {
    post,
    page: async (path) => { const r = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
      return { status: r.status, html: await r.text(), location: r.headers.get("location") }; },
    say: async (message, conversationId) => (await post("/api/chat", { message, conversationId })).data,
    sql: async (q) => {
      const d = (await post("/api/chat", { message: `SQL: ${q}` })).data;
      assert.ok(d.text?.startsWith("RESULT: "), `unexpected reply: ${JSON.stringify(d)}`);
      return JSON.parse(d.text.slice(8));
    },
  };
}

const staffLogin = await login("Ana", process.env.STAFF_PASSCODE);
const mgrLogin = await login("Marco", process.env.MANAGER_PASSCODE);
const staff = client(staffLogin.cookie);
const mgr = client(mgrLogin.cookie);

test("login", async () => {
  assert.equal(staffLogin.status, 200);
  assert.equal(mgrLogin.status, 200);
  assert.equal((await login("Eve", "wrong")).status, 401);
  assert.equal((await fetch(`${BASE}/`, { redirect: "manual" })).status, 307);
  const forged = client(staffLogin.cookie.replace(/\.[^.]+$/, ".AAAA"));
  assert.equal((await forged.page("/")).status, 307);
});

test("pages respect roles", async () => {
  const inv = await staff.page("/");
  assert.equal(inv.status, 200);
  assert.match(inv.html, /Not counted/);
  assert.match(inv.html, /Jalape/);
  const staffDel = (await staff.page("/deliveries")).html;
  assert.doesNotMatch(staffDel, /Unit cost|\$584|\$36\.00/);
  assert.match((await mgr.page("/deliveries")).html, /\$584\.85/);
  assert.equal((await staff.page("/activity")).status, 307);
  assert.equal((await mgr.page("/activity")).status, 200);
});

test("reads answer from the database", async () => {
  const r = await staff.sql("SELECT name, supplier FROM v_current_stock WHERE category = 'Oils & fats' ORDER BY name");
  assert.deepEqual(r.rows, [["Clear fry shortening", "La Tortilleria / Food Show"], ["Liquid margarine", "La Tortilleria / Food Show"]]);
  const short = await mgr.sql("SELECT ingredient, qty_short FROM v_purchase_history WHERE qty_short > 0");
  assert.deepEqual(short.rows, [["Frozen mango fruit pulp", 1]]);
  const unk = await staff.sql("SELECT DISTINCT current_stock, stock_status FROM v_current_stock");
  assert.deepEqual(unk.rows, [[null, "Unknown - no stock count recorded"]]);
});

test("staff can't reach costs, the audit log, or other users' chats", async () => {
  for (const q of [
    "SELECT unit_cost_usd FROM v_purchase_history",
    "SELECT * FROM public.purchase_lines",
    "SELECT * FROM public.v_purchase_history",
    "SELECT * FROM audit_log",
    "SELECT * FROM public.conversations",
  ]) assert.ok((await staff.sql(q)).error, q);
});

test("managers see costs but not app plumbing", async () => {
  assert.equal((await mgr.sql("SELECT round(sum(line_cost_usd), 2) AS t FROM v_purchase_history")).rows[0][0], 4675.92);
  assert.ok((await mgr.sql("SELECT * FROM conversations")).error);
  assert.ok((await mgr.sql("SELECT * FROM pending_actions")).error);
});

test("model-written SQL can't change anything", async () => {
  for (const q of [
    "DELETE FROM ingredients",
    "SELECT 1; DELETE FROM ingredients",
    "WITH x AS (DELETE FROM ingredients RETURNING *) SELECT * FROM x",
    "SELECT 1) q; DROP TABLE ingredients; SELECT * FROM (SELECT 1",
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT set_config('transaction_read_only', 'off', true), (SELECT count(*) FROM ingredients)",
    "SELECT pg_sleep(8)",
  ]) {
    const r = await mgr.sql(q);
    assert.ok(r.error, `should fail: ${q} -> ${JSON.stringify(r)}`);
  }
  assert.equal((await mgr.sql("SELECT count(*) FROM ingredients")).rows[0][0], 56);
  assert.deepEqual((await mgr.sql("SELECT ';' AS semi")).rows, [[";"]]);
});

test("write needs approval, then updates stock", async () => {
  const p1 = await mgr.say('WRITE: set_stock_thresholds {"ingredient_id":"LT-011","min_stock_level":1,"reorder_point":2}');
  assert.ok(p1.pending, JSON.stringify(p1));
  assert.match(p1.pending.summary, /Sarita jasmine rice/);
  const a1 = (await mgr.post("/api/confirm", { pendingId: p1.pending.id, approve: true })).data;
  assert.equal(a1.applied.status, "applied");
  assert.match(a1.text, /"status":"applied"/);

  const p2 = await staff.say('WRITE: record_stock_count {"ingredient_id":"LT-011","quantity":2,"unit":"EA"}');
  assert.equal((await staff.post("/api/confirm", { pendingId: p2.pending.id, approve: true })).data.applied.status, "applied");
  const r = await mgr.sql("SELECT current_stock, stock_status FROM v_current_stock WHERE ingredient_id = 'LT-011'");
  assert.deepEqual(r.rows, [[2, "Reorder"]]);
});

test("declines, double-clicks and other people's confirmations", async () => {
  const p = await mgr.say('WRITE: record_stock_count {"ingredient_id":"LT-009","quantity":4}');
  assert.equal((await staff.post("/api/confirm", { pendingId: p.pending.id, approve: true })).status, 409);
  const d = (await mgr.post("/api/confirm", { pendingId: p.pending.id, approve: false })).data;
  assert.equal(d.applied.status, "declined");
  assert.equal((await mgr.post("/api/confirm", { pendingId: p.pending.id, approve: true })).status, 409);
  assert.deepEqual((await mgr.sql("SELECT current_stock FROM v_current_stock WHERE ingredient_id = 'LT-009'")).rows, [[null]]);
});

test("bad or forbidden writes are rejected before any prompt", async () => {
  const forbidden = await staff.say('WRITE: set_stock_thresholds {"ingredient_id":"LT-011","min_stock_level":99}');
  assert.equal(forbidden.pending, undefined);
  assert.match(forbidden.text, /rejected/);
  const unit = await staff.say('WRITE: record_stock_count {"ingredient_id":"LT-011","quantity":3,"unit":"kg"}');
  assert.equal(unit.pending, undefined);
  assert.match(unit.text, /Unit mismatch/);
  const neg = await mgr.say('WRITE: record_usage {"ingredient_id":"LT-011","quantity":-1,"kind":"usage"}');
  assert.equal(neg.pending, undefined);
});

test("typing a new message while a change waits cancels it cleanly", async () => {
  const p = await mgr.say('WRITE: record_stock_count {"ingredient_id":"LT-010","quantity":5}');
  const next = await mgr.say("never mind", p.conversationId);
  assert.equal(next.conversationId, p.conversationId);
  assert.equal(next.text, "echo: never mind");
  const sent = JSON.parse(readFileSync("/tmp/mock-last-request.json", "utf8"));
  const tail = JSON.stringify(sent.messages.slice(-3));
  assert.match(tail, /declined/);
  assert.match(tail, /never mind/);
  assert.equal((await mgr.post("/api/confirm", { pendingId: p.pending.id, approve: true })).status, 409);
});

test("conversations are private to their owner", async () => {
  const mine = await mgr.say("hello");
  const theirs = await staff.say("hello", mine.conversationId);
  assert.notEqual(theirs.conversationId, mine.conversationId);
});

test("audit log records every outcome", async () => {
  const r = await mgr.sql("SELECT outcome, count(*)::int FROM audit_log WHERE action <> 'import' GROUP BY 1 ORDER BY 1");
  const m = Object.fromEntries(r.rows);
  assert.ok(m.applied >= 2 && m.declined >= 2 && m.rejected >= 3, JSON.stringify(m));
});

test("system prompt is role-aware and honest about gaps", async () => {
  await staff.say("hi");
  const sys = JSON.parse(readFileSync("/tmp/mock-last-request.json", "utf8")).system;
  assert.match(sys, /role: staff/);
  assert.match(sys, /can't see prices/);
  assert.doesNotMatch(sys, /unit_cost_usd/);
  assert.match(sys, /lots with an expiration date: 0/);
});

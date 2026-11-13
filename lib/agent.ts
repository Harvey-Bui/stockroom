import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { config } from "./config";
import { ownerDb } from "./db";
import type { Session } from "./session";
import {
  ROLE_WRITES, applyWrite, dataProfile, describeSchema, logAudit, prepareWrite, runReadQuery, type Actor,
} from "./tools";

const MAX_ROUNDS = 10;
const PENDING_TTL_MINUTES = 15;

type Block = Record<string, unknown> & { type: string };
type Message = { role: "user" | "assistant"; content: string | Block[] };

export type Pending = { id: string; action: string; summary: string };
export type AgentReply = {
  conversationId: string;
  text: string;
  pending?: Pending;
  queries: { purpose?: string; sql: string; rows?: number; error?: string }[];
  applied?: { summary: string; status: "applied" | "declined" | "rejected" | "expired" };
};

// Injectable for tests.
type Client = { messages: { create: (body: Record<string, unknown>) => Promise<{ content: Block[]; stop_reason: string | null }> } };
let clientOverride: Client | null = null;
export const __setClient = (c: Client | null) => { clientOverride = c; };
const client = (): Client => clientOverride ?? (new Anthropic() as unknown as Client);

// --------------------------------------------------------------------------- prompt + tools

function systemPrompt(s: Session, schema: string, profile: string) {
  const today = new Intl.DateTimeFormat("en-US", { timeZone: config.timezone, weekday: "long", year: "numeric",
    month: "long", day: "numeric" }).format(new Date());
  const writes = ROLE_WRITES[s.role];
  return `You are the inventory assistant for ${config.restaurantName}, a restaurant. Kitchen staff and managers ask \
you questions in plain language inside the restaurant's inventory app; you answer by querying its database.

Today is ${today} (${config.timezone}). You're talking to ${s.name} (role: ${s.role}).

## Ground rules
1. Every quantity, date, price, supplier detail or status you state must come from a query_inventory result in this \
conversation. Never estimate, recall typical values, or fill gaps.
2. If the data doesn't exist (NULL, no rows, not tracked), say so plainly and say what would need to be recorded to \
answer it next time. "We don't have that recorded yet" is a good answer.
3. If a request is ambiguous (several matching items, unclear time window, a unit the item isn't tracked in), ask one \
short clarifying question. If the ambiguity is minor, answer and state your assumption.
4. Don't convert units (cases ↔ lb ↔ kg) unless pack_size gives an exact conversion; show the math if you do.
5. ${s.role === "staff" ? "This user can't see prices or costs (those columns don't exist for them). If asked, say a manager can see that." : "This user can see costs."}

## Querying (PostgreSQL)
- Prefer the views: v_current_stock (stock + status), v_purchase_history (deliveries, quantities${s.role === "staff" ? "" : ", costs"}, \
suppliers), v_expiring_lots (expiry). Use base tables for anything else.
- Match names loosely with ILIKE and wildcards. Item names are English; invoice_description is the supplier's wording \
(often Spanish), so search both: name ILIKE '%tomat%' OR invoice_description ILIKE '%tomat%'.
- Dates: current_date and now() are already in the restaurant's timezone. "Last week" = the previous 7 days unless \
the user says otherwise.
- "Running low" = stock_status IN ('Low stock','Reorder','Out of stock'). If every status starts with 'Unknown', \
explain that counts/thresholds haven't been recorded yet instead of saying nothing is low.
- "Enough for N days" needs current stock AND a usage rate from usage records; say which is missing.
- The delivery date is the invoice date unless delivery_date was recorded separately.
- Mention data-quality notes and short shipments (qty_short > 0) when they're relevant.
- Always pass a short "purpose" with each query.

## Answer style
This is a chat panel next to the inventory screen, used on a busy shift.
- Lead with the direct answer in one sentence, in plain kitchen language (no SQL, table or column names).
- Use a markdown table for 3+ items or several attributes per item. Put units in the cells.
- Keep it short. End with at most one helpful follow-up offer when there's an obvious next step.

## Changing data
You can only change data with the write tools, never with SQL. This user may: ${writes.join(", ") || "nothing"}.
Collect every value from the user first (never invent quantities or dates; ask). Call ONE write tool at a time. The app \
then shows the user an Approve/Cancel card; you'll get back applied, declined or rejected. Report that honestly.

## Schema visible to this user
${schema}

## What's in the database right now
${profile}`;
}

function tools(role: Session["role"]) {
  const all: Record<string, { description: string; input_schema: Record<string, unknown> }> = {
    query_inventory: {
      description: "Run ONE read-only PostgreSQL SELECT (or WITH … SELECT) and get rows back as JSON (max 200 rows).",
      input_schema: { type: "object", properties: {
        sql: { type: "string", description: "A single SELECT statement." },
        purpose: { type: "string", description: "A few words: what this query is for." } }, required: ["sql", "purpose"] },
    },
    record_stock_count: {
      description: "Record a physical count (absolute quantity on hand) for one item. Resets its stock baseline.",
      input_schema: { type: "object", properties: {
        ingredient_id: { type: "string" }, quantity: { type: "number", minimum: 0 },
        unit: { type: "string", description: "Must match the item's tracked unit." }, note: { type: "string" } },
        required: ["ingredient_id", "quantity"] },
    },
    record_usage: {
      description: "Record stock used in service ('usage') or thrown away ('waste').",
      input_schema: { type: "object", properties: {
        ingredient_id: { type: "string" }, quantity: { type: "number" }, kind: { type: "string", enum: ["usage", "waste"] },
        unit: { type: "string" }, note: { type: "string" } }, required: ["ingredient_id", "quantity", "kind"] },
    },
    record_delivery: {
      description: "Record a supplier delivery/invoice with one or more lines. Creates receipts and lots.",
      input_schema: { type: "object", properties: {
        supplier_id: { type: "string" }, invoice_date: { type: "string", description: "YYYY-MM-DD" },
        invoice_number: { type: "string" },
        lines: { type: "array", items: { type: "object", properties: {
          ingredient_id: { type: "string" }, qty_ordered: { type: "number" }, qty_shipped: { type: "number" },
          unit_cost_usd: { type: "number" }, expiration_date: { type: "string", description: "YYYY-MM-DD" } },
          required: ["ingredient_id", "qty_shipped"] } } },
        required: ["supplier_id", "invoice_date", "lines"] },
    },
    set_stock_thresholds: {
      description: "Set minimum / reorder point / target stock (and optionally the tracking unit) for an item.",
      input_schema: { type: "object", properties: {
        ingredient_id: { type: "string" }, min_stock_level: { type: "number" }, reorder_point: { type: "number" },
        target_stock: { type: "number" }, stock_unit: { type: "string" } }, required: ["ingredient_id"] },
    },
    set_lot_expiration: {
      description: "Set the expiration date of a received lot (find lot_id in v_expiring_lots).",
      input_schema: { type: "object", properties: { lot_id: { type: "integer" },
        expiration_date: { type: "string", description: "YYYY-MM-DD" } }, required: ["lot_id", "expiration_date"] },
    },
    update_supplier_contact: {
      description: "Update a supplier's contact details. Only the fields given change.",
      input_schema: { type: "object", properties: { supplier_id: { type: "string" }, contact_name: { type: "string" },
        phone: { type: "string" }, email: { type: "string" }, address: { type: "string" } }, required: ["supplier_id"] },
    },
  };
  const names = ["query_inventory", ...ROLE_WRITES[role]];
  return names.map((name, i) => ({ name, ...all[name], ...(i === names.length - 1 ? { cache_control: { type: "ephemeral" } } : {}) }));
}

// --------------------------------------------------------------------------- conversation storage

async function loadConversation(id: string | undefined, s: Session) {
  if (id) {
    const rows = await ownerDb()`SELECT id, messages FROM conversations
                                 WHERE id = ${id} AND user_name = ${s.name} AND role = ${s.role}`;
    if (rows.length) return { id: rows[0].id as string, messages: rows[0].messages as Message[] };
  }
  const newId = randomUUID();
  await ownerDb()`INSERT INTO conversations (id, user_name, role) VALUES (${newId}, ${s.name}, ${s.role})`;
  return { id: newId, messages: [] as Message[] };
}

async function saveConversation(id: string, messages: Message[]) {
  await ownerDb()`UPDATE conversations SET messages = ${ownerDb().json(messages as never)}, updated_at = now() WHERE id = ${id}`;
}

const textOf = (content: Block[]) =>
  content.filter((b) => b.type === "text").map((b) => b.text as string).join("\n").trim();

// --------------------------------------------------------------------------- the loop

async function runLoop(convId: string, messages: Message[], s: Session, reply: AgentReply): Promise<AgentReply> {
  const actor: Actor = { name: s.name, role: s.role };
  const [schema, profile] = await Promise.all([describeSchema(s.role), dataProfile(s.role)]);
  const system = systemPrompt(s, schema, profile);

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const resp = await client().messages.create({
      model: config.model, max_tokens: 2048, system, tools: tools(s.role), messages,
    });
    const content = resp.content.map((b) => ({ ...b })) as Block[];
    messages.push({ role: "assistant", content });

    if (resp.stop_reason !== "tool_use") {
      await saveConversation(convId, messages);
      return { ...reply, text: textOf(content) };
    }

    const results: Block[] = [];
    let pending: { id: string; toolUseId: string; action: string; args: Record<string, unknown>; summary: string } | null = null;

    for (const b of content.filter((b) => b.type === "tool_use")) {
      const name = b.name as string;
      const input = (b.input ?? {}) as Record<string, unknown>;
      let out: unknown;
      let isError = false;

      if (name === "query_inventory") {
        const r = await runReadQuery(s.role, String(input.sql ?? ""));
        reply.queries.push({ purpose: input.purpose as string | undefined, sql: String(input.sql ?? ""),
          ...("error" in r ? { error: r.error } : { rows: r.row_count }) });
        out = r;
        isError = "error" in r;
      } else if (!ROLE_WRITES[s.role].includes(name)) {
        out = { status: "rejected", reason: `Tool '${name}' isn't available to role '${s.role}'.` };
        isError = true;
        await logAudit(actor, name, input, "rejected");
      } else if (pending) {
        out = { status: "rejected", reason: "Only one change at a time. Ask for this one after the current change is confirmed." };
        isError = true;
      } else {
        const prep = await prepareWrite(actor, name, input);
        if (!prep.ok) {
          out = { status: "rejected", reason: prep.reason };
          isError = true;
          await logAudit(actor, name, { ...input, error: prep.reason }, "rejected");
        } else {
          pending = { id: randomUUID(), toolUseId: b.id as string, action: name, args: prep.args, summary: prep.summary };
          continue; // result is filled in when the user approves/cancels
        }
      }
      results.push({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(out), is_error: isError });
    }

    if (pending) {
      await ownerDb()`
        INSERT INTO pending_actions (id, conversation_id, user_name, role, action, args, summary, tool_use_id, other_results)
        VALUES (${pending.id}, ${convId}, ${s.name}, ${s.role}, ${pending.action}, ${ownerDb().json(pending.args as never)},
                ${pending.summary}, ${pending.toolUseId}, ${ownerDb().json(results as never)})`;
      await saveConversation(convId, messages);
      return { ...reply, text: textOf(content), pending: { id: pending.id, action: pending.action, summary: pending.summary } };
    }
    messages.push({ role: "user", content: results });
  }
  await saveConversation(convId, messages);
  return { ...reply, text: "That took more steps than I'm allowed. Could you narrow the question down?" };
}

/** Close out an open confirmation (declined/expired) so the transcript stays valid. Returns the tool_result blocks. */
async function settleOpenPending(convId: string, s: Session, outcome: "declined" | "expired"): Promise<Block[] | null> {
  const rows = await ownerDb()`
    UPDATE pending_actions SET status = ${outcome} WHERE conversation_id = ${convId} AND status = 'pending'
    RETURNING action, args, tool_use_id, other_results`;
  if (!rows.length) return null;
  const p = rows[0];
  await logAudit({ name: s.name, role: s.role }, p.action as string, p.args, outcome);
  return [
    ...(p.other_results as Block[]),
    { type: "tool_result", tool_use_id: p.tool_use_id, is_error: true,
      content: JSON.stringify({ status: outcome, reason: outcome === "declined"
        ? "The user moved on without approving. Nothing was written." : "Confirmation expired. Nothing was written." }) },
  ];
}

export async function chat(s: Session, conversationId: string | undefined, text: string): Promise<AgentReply> {
  const conv = await loadConversation(conversationId, s);
  const settled = await settleOpenPending(conv.id, s, "declined");
  if (settled) conv.messages.push({ role: "user", content: [...settled, { type: "text", text }] });
  else conv.messages.push({ role: "user", content: text });
  return runLoop(conv.id, conv.messages, s, { conversationId: conv.id, text: "", queries: [] });
}

export async function resolvePending(s: Session, pendingId: string, approve: boolean): Promise<AgentReply> {
  const db = ownerDb();
  // Claim it atomically so a double-click can't apply twice.
  const rows = await db`
    UPDATE pending_actions SET status = CASE
        WHEN created_at < now() - make_interval(mins => ${PENDING_TTL_MINUTES}) THEN 'expired'
        WHEN ${approve} THEN 'applied' ELSE 'declined' END
    WHERE id = ${pendingId} AND user_name = ${s.name} AND role = ${s.role} AND status = 'pending'
    RETURNING conversation_id, action, args, summary, tool_use_id, other_results, status`;
  if (!rows.length) throw new Error("That change was already handled or doesn't belong to you.");
  const p = rows[0];
  const actor: Actor = { name: s.name, role: s.role };
  let status = p.status as "applied" | "declined" | "expired" | "rejected";
  let reason = "";

  if (status === "applied") {
    try {
      await applyWrite(actor, p.action as string, p.args as Record<string, unknown>);
    } catch (e) {
      status = "rejected";
      reason = (e as Error).message;
      await db`UPDATE pending_actions SET status = 'declined' WHERE id = ${pendingId}`;
      await logAudit(actor, p.action as string, { ...(p.args as object), error: reason }, "rejected");
    }
  } else {
    await logAudit(actor, p.action as string, p.args, status);
  }

  const conv = await loadConversation(p.conversation_id as string, s);
  const result = { status, ...(status === "applied" ? { summary: p.summary } : {}),
    ...(reason ? { reason } : status === "declined" ? { reason: "The user cancelled. Nothing was written." }
      : status === "expired" ? { reason: "Confirmation expired. Nothing was written." } : {}) };
  conv.messages.push({ role: "user", content: [
    ...(p.other_results as Block[]),
    { type: "tool_result", tool_use_id: p.tool_use_id, content: JSON.stringify(result), is_error: status !== "applied" },
  ] });
  return runLoop(conv.id, conv.messages, s, { conversationId: conv.id, text: "", queries: [],
    applied: { summary: p.summary as string, status } });
}

// One interface for the model, two providers behind it.
//  - GEMINI_API_KEY set    → Google Gemini via its OpenAI-compatible endpoint (free tier, no card)
//  - ANTHROPIC_API_KEY set → Claude via the Anthropic Messages API
// The agent always speaks Anthropic-style blocks (text / tool_use / tool_result); this file translates.
import Anthropic from "@anthropic-ai/sdk";

export type Block = Record<string, unknown> & { type: string };
export type Message = { role: "user" | "assistant"; content: string | Block[] };
export type Tool = { name: string; description: string; input_schema: Record<string, unknown> };
export type LlmRequest = { system: string; tools: Tool[]; messages: Message[]; max_tokens: number; deadline?: number };
export type LlmResponse = { content: Block[]; stop_reason: string | null };

export class LlmError extends Error {
  constructor(message: string, public status?: number) { super(message); }
}

export const provider = (): "gemini" | "anthropic" | null =>
  process.env.GEMINI_API_KEY ? "gemini" : process.env.ANTHROPIC_API_KEY ? "anthropic" : null;

// ------------------------------------------------------------------ Anthropic
async function anthropic(req: LlmRequest): Promise<LlmResponse> {
  const client = new Anthropic();
  const tools = req.tools.map((t, i) => (i === req.tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));
  try {
    const r = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
      max_tokens: req.max_tokens, system: req.system, tools: tools as never, messages: req.messages as never,
    });
    return { content: r.content as unknown as Block[], stop_reason: r.stop_reason };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    throw new LlmError(err.message ?? "Anthropic request failed", err.status);
  }
}

// ------------------------------------------------------------------ Gemini (OpenAI-compatible)
const GEMINI_BASE = () => (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai").replace(/\/$/, "");
const GEMINI_MODELS = () =>
  [...new Set((process.env.GEMINI_MODEL ? [process.env.GEMINI_MODEL] : []).concat(
    ["gemini-flash-latest", "gemini-2.5-flash", "gemini-flash-lite-latest", "gemini-2.5-flash-lite"]))];

/** Gemini's schema support is narrower than JSON Schema: drop numeric bounds and other extras. */
function cleanSchema(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(cleanSchema);
  if (!s || typeof s !== "object") return s;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) {
    if (["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "cache_control", "additionalProperties"].includes(k)) continue;
    out[k] = cleanSchema(v);
  }
  return out;
}

function toOpenAI(req: LlmRequest) {
  const msgs: Record<string, unknown>[] = [{ role: "system", content: req.system }];
  for (const m of req.messages) {
    if (typeof m.content === "string") { msgs.push({ role: m.role, content: m.content }); continue; }
    if (m.role === "assistant") {
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text as string).join("\n");
      const calls = m.content.filter((b) => b.type === "tool_use").map((b) => ({
        id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
      }));
      msgs.push({ role: "assistant", content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    } else {
      for (const b of m.content.filter((b) => b.type === "tool_result")) {
        msgs.push({ role: "tool", tool_call_id: b.tool_use_id, content: String(b.content ?? "") });
      }
      const text = m.content.filter((b) => b.type === "text").map((b) => b.text as string).join("\n");
      if (text) msgs.push({ role: "user", content: text });
    }
  }
  return {
    messages: msgs,
    max_tokens: req.max_tokens,
    tools: req.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: cleanSchema(t.input_schema) } })),
  };
}

let callSeq = 0;
function fromOpenAI(data: { choices?: { message?: { content?: string | null; tool_calls?: { id?: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[] }): LlmResponse {
  const msg = data.choices?.[0]?.message ?? {};
  const content: Block[] = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const c of msg.tool_calls ?? []) {
    let input: unknown = {};
    try { input = JSON.parse(c.function.arguments || "{}"); } catch { input = {}; }
    content.push({ type: "tool_use", id: c.id || `call_${Date.now()}_${++callSeq}`, name: c.function.name, input });
  }
  return { content, stop_reason: (msg.tool_calls?.length ?? 0) > 0 ? "tool_use" : "end_turn" };
}

// Models that just failed are skipped for a few minutes (per server instance).
const cooldown = new Map<string, number>();
const COOLDOWN_MS = 5 * 60_000;
function modelsInOrder() {
  const now = Date.now();
  const all = GEMINI_MODELS();
  const ok = all.filter((m) => (cooldown.get(m) ?? 0) < now);
  return ok.length ? ok : all; // if everything is cooling down, try them all anyway
}

async function gemini(req: LlmRequest): Promise<LlmResponse> {
  const body = toOpenAI(req);
  let last: LlmError | null = null;
  const deadline = req.deadline ?? Date.now() + 45_000;
  for (const model of modelsInOrder()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 3_000) throw last ?? new LlmError("Gemini didn't answer in time.", 504);
      let res: Response;
      try {
        res = await fetch(`${GEMINI_BASE()}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GEMINI_API_KEY}` },
          body: JSON.stringify({ model, ...body }),
          signal: AbortSignal.timeout(Math.min(20_000, left - 1_000)),
        });
      } catch (e) {
        console.error(`Gemini ${model} attempt ${attempt + 1}: ${(e as Error).name} ${(e as Error).message}`);
        last = new LlmError(`Gemini ${model}: no answer (${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message})`, 504);
        break; // try the next model
      }
      if (res.ok) { cooldown.delete(model); return fromOpenAI(await res.json()); }
      const text = await res.text();
      console.error(`Gemini ${model} attempt ${attempt + 1}: ${res.status} ${text.slice(0, 500)}`);
      last = new LlmError(`Gemini ${model}: ${res.status} ${shortReason(text)}`, res.status);
      // Overloaded: wait a moment and retry the same model once.
      if ((res.status === 503 || res.status === 500) && attempt === 0) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      break;
    }
    // Move on to the next model when this one is missing, overloaded or out of free quota.
    if (last && [404, 429, 500, 503, 504].includes(last.status ?? 0)) cooldown.set(model, Date.now() + COOLDOWN_MS);
    if (!last || ![404, 429, 500, 503, 504].includes(last.status ?? 0)) break;
  }
  throw last ?? new LlmError("Gemini request failed");
}

function shortReason(body: string): string {
  try {
    const j = JSON.parse(body);
    const e = Array.isArray(j) ? j[0]?.error : j.error;
    return String(e?.message ?? e?.status ?? body).slice(0, 160);
  } catch {
    return body.slice(0, 160);
  }
}

// ------------------------------------------------------------------ entry point
let override: ((req: LlmRequest) => Promise<LlmResponse>) | null = null;
export const __setLlm = (fn: typeof override) => { override = fn; };

/** Tiny request per model, for the diagnostics page. Never returns the key. */
export async function probeGemini() {
  const out: { model: string; status: number | string; ms: number; reply?: string; reason?: string }[] = [];
  for (const model of GEMINI_MODELS()) {
    const t = Date.now();
    try {
      const res = await fetch(`${GEMINI_BASE()}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${process.env.GEMINI_API_KEY}` },
        body: JSON.stringify({ model, max_tokens: 20, messages: [{ role: "user", content: "Reply with the single word: ok" }] }),
        signal: AbortSignal.timeout(12_000),
      });
      const text = await res.text();
      out.push(res.ok
        ? { model, status: res.status, ms: Date.now() - t, reply: String(JSON.parse(text).choices?.[0]?.message?.content ?? "").slice(0, 40) }
        : { model, status: res.status, ms: Date.now() - t, reason: shortReason(text) });
    } catch (e) {
      out.push({ model, status: (e as Error).name, ms: Date.now() - t, reason: (e as Error).message.slice(0, 120) });
    }
  }
  return out;
}

export async function createMessage(req: LlmRequest): Promise<LlmResponse> {
  if (override) return override(req);
  const p = provider();
  if (p === "gemini") return gemini(req);
  if (p === "anthropic") return anthropic(req);
  throw new LlmError("No AI key configured. Set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY.");
}

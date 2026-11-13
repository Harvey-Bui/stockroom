import { NextResponse } from "next/server";
import { config, requireConfig } from "@/lib/config";
import { readerDb } from "@/lib/db";
import { probeGemini, provider } from "@/lib/llm";
import { getSession } from "@/lib/session";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

// Managers only: checks settings, database and the AI provider. Never shows secret values.
export async function GET() {
  const s = await getSession();
  if (!s || s.role === "staff") return NextResponse.json({ error: "Sign in as a manager first." }, { status: 401 });
  const out: Record<string, unknown> = { missing_settings: requireConfig(), ai_provider: provider(), timezone: config.timezone };
  try {
    const [r] = await readerDb(s.role)`SELECT count(*)::int AS items FROM ingredients`;
    out.database = `ok (${r.items} items)`;
  } catch (e) {
    out.database = `error: ${(e as Error).message}`;
  }
  if (provider() === "gemini") {
    const key = process.env.GEMINI_API_KEY ?? "";
    out.gemini_key = `${key.length} characters, starts "${key.slice(0, 4)}"${/\s/.test(key) ? " — CONTAINS SPACES" : ""}`;
    out.gemini_models = await probeGemini();
  }
  return NextResponse.json(out, { headers: { "cache-control": "no-store" } });
}

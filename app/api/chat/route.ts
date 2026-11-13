import { NextResponse } from "next/server";
import { chat } from "@/lib/agent";
import { getSession } from "@/lib/session";

export const maxDuration = 60;

export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Your session ended. Sign in again." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const message = String(body.message ?? "").trim();
  if (!message) return NextResponse.json({ error: "Empty message." }, { status: 400 });
  if (message.length > 2000) return NextResponse.json({ error: "That message is too long." }, { status: 400 });
  try {
    return NextResponse.json(await chat(s, body.conversationId || undefined, message));
  } catch (e) {
    console.error("chat failed", e);
    return NextResponse.json({ error: friendly(e) }, { status: 500 });
  }
}

function friendly(e: unknown) {
  const msg = (e as { status?: number; message?: string });
  if (msg.status === 400 && /API key|API_KEY/i.test(msg.message ?? "")) return "The AI service rejected the API key. Check GEMINI_API_KEY in Vercel.";
  if (msg.status === 401 || msg.status === 403) return "The AI service rejected the API key. Check GEMINI_API_KEY in Vercel.";
  if (msg.status === 429) return "The free AI quota is used up for the moment. Wait a minute (or until tomorrow if the daily limit is reached) and try again.";
  if (msg.status === 529 || msg.status === 503) return "The assistant is busy right now. Try again in a moment.";
  return "Something went wrong talking to the assistant. Try again.";
}

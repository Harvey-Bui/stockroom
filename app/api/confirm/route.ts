import { NextResponse } from "next/server";
import { resolvePending } from "@/lib/agent";
import { getSession } from "@/lib/session";

export const maxDuration = 60;

export async function POST(req: Request) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "Your session ended. Sign in again." }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  if (typeof body.pendingId !== "string") return NextResponse.json({ error: "Missing pendingId." }, { status: 400 });
  try {
    return NextResponse.json(await resolvePending(s, body.pendingId, body.approve === true));
  } catch (e) {
    console.error("confirm failed", e);
    return NextResponse.json({ error: (e as Error).message }, { status: 409 });
  }
}

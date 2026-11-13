import { NextResponse } from "next/server";
import { roleForPasscode, setSession } from "@/lib/session";

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? "").trim().slice(0, 40);
  const passcode = String(body.passcode ?? "");
  const role = name && passcode ? roleForPasscode(passcode) : null;
  if (!role) {
    await new Promise((r) => setTimeout(r, 700)); // slow down guessing
    return NextResponse.json({ error: name ? "That passcode didn't match." : "Enter your name." }, { status: 401 });
  }
  await setSession({ name, role });
  return NextResponse.json({ ok: true, role });
}

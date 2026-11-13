"use client";
import { ASK_EVENT } from "./Assistant";

export function ask(text: string) {
  window.dispatchEvent(new CustomEvent(ASK_EVENT, { detail: text }));
}

export default function AskButton({ text, label = "Ask" }: { text: string; label?: string }) {
  return <button className="ask-btn" onClick={() => ask(text)}>{label}</button>;
}

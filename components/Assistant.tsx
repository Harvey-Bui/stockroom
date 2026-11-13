"use client";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useRouter } from "next/navigation";
import { useAssistantPanel } from "./ShellFrame";
import { CloseIcon, LeafMark, PlusIcon, SendIcon } from "./icons";

type Query = { purpose?: string; sql: string; rows?: number; error?: string };
type Pending = { id: string; action: string; summary: string };
type Outcome = "applied" | "declined" | "rejected" | "expired";
type Msg =
  | { id: number; role: "user"; text: string }
  | { id: number; role: "bot"; text: string; queries?: Query[]; pending?: Pending; outcome?: Outcome; error?: boolean };

export const ASK_EVENT = "stockroom:ask";
export const ASSISTANT_NAME = "Basil";

const SUGGESTIONS: Record<string, { icon: string; text: string }[]> = {
  staff: [
    { icon: "🫒", text: "Who supplies our cooking oil?" },
    { icon: "🚚", text: "What came in on the most recent delivery?" },
    { icon: "⚠️", text: "Was anything short-shipped?" },
    { icon: "📉", text: "What's running low?" },
  ],
  manager: [
    { icon: "📉", text: "What's running low, and who do I order it from?" },
    { icon: "💵", text: "How much did we spend with each supplier this month?" },
    { icon: "⚠️", text: "Was anything short-shipped?" },
    { icon: "🍚", text: "Do we have enough rice for the next three days?" },
  ],
};

let nextId = 1;

export default function Assistant({ name, role }: { name: string; role: string }) {
  const { open, setOpen } = useAssistantPanel();
  const router = useRouter();
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<(t: string) => void>(() => {});

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, busy]);

  useEffect(() => {
    const onAsk = (e: Event) => {
      setOpen(true);
      sendRef.current((e as CustomEvent<string>).detail);
    };
    window.addEventListener(ASK_EVENT, onAsk);
    return () => window.removeEventListener(ASK_EVENT, onAsk);
  }, [setOpen]);

  async function call(url: string, body: unknown) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({ error: res.status === 504
      ? "The assistant took too long to answer (the AI service may be overloaded). Try again in a moment."
      : `Unexpected response from the server (HTTP ${res.status}).` }));
    if (res.status === 401) window.location.href = "/login";
    if (!res.ok) throw new Error(data.error || "Something went wrong.");
    return data;
  }

  function addReply(data: { conversationId: string; text: string; queries?: Query[]; pending?: Pending }) {
    setConversationId(data.conversationId);
    setMsgs((m) => [...m, { id: nextId++, role: "bot", text: data.text, queries: data.queries, pending: data.pending }]);
  }

  async function send(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    setInput("");
    if (inputRef.current) inputRef.current.style.height = "auto";
    // Typing a new message while a change is waiting means it won't be applied: reflect that.
    setMsgs((m) => [...m.map((x) => (x.role === "bot" && x.pending && !x.outcome ? { ...x, outcome: "declined" as const } : x)),
      { id: nextId++, role: "user", text: t }]);
    setBusy(true);
    try {
      addReply(await call("/api/chat", { conversationId, message: t }));
    } catch (e) {
      setMsgs((m) => [...m, { id: nextId++, role: "bot", text: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }
  sendRef.current = send;

  async function resolve(msgId: number, pending: Pending, approve: boolean) {
    setBusy(true);
    try {
      const data = await call("/api/confirm", { pendingId: pending.id, approve });
      setMsgs((m) => m.map((x) => (x.id === msgId && x.role === "bot" ? { ...x, outcome: data.applied?.status ?? (approve ? "applied" : "declined") } : x)));
      addReply(data);
      if (data.applied?.status === "applied") router.refresh(); // update the tables on screen
    } catch (e) {
      setMsgs((m) => [...m, { id: nextId++, role: "bot", text: (e as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setMsgs([]);
    setConversationId(null);
    inputRef.current?.focus();
  }

  const first = name.split(" ")[0];
  const chips = SUGGESTIONS[role === "staff" ? "staff" : "manager"];

  return (
    <>
      <section className="assistant" aria-label={`${ASSISTANT_NAME}, inventory assistant`}>
        <header className="as-head">
          <div className="as-avatar"><LeafMark size={22} /></div>
          <div>
            <div className="as-title">{ASSISTANT_NAME}</div>
            <div className="as-status">Inventory assistant</div>
          </div>
          <button className="icon-btn" title="New conversation" onClick={reset}><PlusIcon /></button>
          <button className="icon-btn" title="Close" onClick={() => setOpen(false)}><CloseIcon /></button>
        </header>

        <div className="as-body" ref={bodyRef}>
          {msgs.length === 0 && (
            <div className="welcome">
              <h2>Hi {first}, what do you need to know?</h2>
              <p>Ask about stock, suppliers, deliveries or expiry dates. I&apos;ll only tell you what&apos;s in the records.</p>
              <div className="chips">
                {chips.map((c) => (
                  <button key={c.text} className="chip" onClick={() => send(c.text)} disabled={busy}>
                    <span>{c.icon}</span>{c.text}
                  </button>
                ))}
              </div>
            </div>
          )}

          {msgs.map((m) =>
            m.role === "user" ? (
              <div key={m.id} className="msg user"><div className="bubble">{m.text}</div></div>
            ) : (
              <div key={m.id} className="msg bot">
                <div className="mini"><LeafMark size={15} /></div>
                <div className={`bubble${m.error ? " error" : ""}`}>
                  {m.text && <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.text}</ReactMarkdown>}
                  {m.pending && (
                    <div className="confirm">
                      <div className="confirm-title">Confirm change</div>
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.pending.summary}</ReactMarkdown>
                      {m.outcome ? (
                        <div className={`outcome ${m.outcome}`}>
                          {m.outcome === "applied" ? "✓ Saved" : m.outcome === "rejected" ? "Couldn't save" : m.outcome === "expired" ? "Expired, not saved" : "Cancelled, not saved"}
                        </div>
                      ) : (
                        <div className="confirm-actions">
                          <button className="btn primary" disabled={busy} onClick={() => resolve(m.id, m.pending!, true)}>Approve</button>
                          <button className="btn ghost" disabled={busy} onClick={() => resolve(m.id, m.pending!, false)}>Cancel</button>
                        </div>
                      )}
                    </div>
                  )}
                  {!!m.queries?.length && (
                    <details className="sources">
                      <summary>🔎 Checked {m.queries.length} record{m.queries.length > 1 ? "s" : ""}</summary>
                      <ol>
                        {m.queries.map((q, i) => (
                          <li key={i}>
                            {q.purpose || "Query"} — {q.error ? <span className="short">failed</span> : `${q.rows} row${q.rows === 1 ? "" : "s"}`}
                            {role !== "staff" && <pre>{q.sql}</pre>}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              </div>
            )
          )}

          {busy && (
            <div className="msg bot">
              <div className="mini"><LeafMark size={15} /></div>
              <div className="bubble" style={{ flex: "none" }}><span className="typing"><i /><i /><i /></span></div>
            </div>
          )}
        </div>

        <div className="composer">
          <form onSubmit={(e) => { e.preventDefault(); send(input); }}>
            <label htmlFor="ask" className="sr-only">Message {ASSISTANT_NAME}</label>
            <textarea
              id="ask" ref={inputRef} rows={1} value={input} placeholder={`Ask ${ASSISTANT_NAME} anything about inventory…`}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
            />
            <button className="send" type="submit" disabled={busy || !input.trim()} aria-label="Send"><SendIcon /></button>
          </form>
          <div className="composer-hint">Answers come from your inventory records. Changes always ask before saving.</div>
        </div>
      </section>

      <button className="fab" onClick={() => setOpen(true)}>
        <span className="as-avatar"><LeafMark size={18} /></span>Ask {ASSISTANT_NAME}
      </button>
    </>
  );
}

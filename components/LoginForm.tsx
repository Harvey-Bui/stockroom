"use client";
import { useState } from "react";

export default function LoginForm() {
  const [name, setName] = useState("");
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, passcode }) });
    if (res.ok) { window.location.href = "/"; return; }
    setError((await res.json().catch(() => ({}))).error || "Couldn't sign in.");
    setBusy(false);
  }

  return (
    <form className="login-card" onSubmit={submit}>
      <h2>Sign in</h2>
      <p>Use the passcode for your role. Ask a manager if you don&apos;t have one.</p>
      <label className="field">Your name
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
      </label>
      <label className="field">Passcode
        <input className="input" type="password" value={passcode} onChange={(e) => setPasscode(e.target.value)} autoComplete="current-password" required />
      </label>
      {error && <div className="form-error">{error}</div>}
      <button className="btn primary block" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
    </form>
  );
}

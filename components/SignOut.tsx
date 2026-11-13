"use client";
export default function SignOut() {
  return (
    <button className="link-btn" onClick={async () => {
      await fetch("/api/logout", { method: "POST" });
      try { sessionStorage.removeItem("stockroom_conversation"); } catch {}
      window.location.href = "/login";
    }}>Sign out</button>
  );
}

import { redirect } from "next/navigation";
import Assistant from "@/components/Assistant";
import NavLinks from "@/components/NavLinks";
import SignOut from "@/components/SignOut";
import ShellFrame from "@/components/ShellFrame";
import { LeafMark } from "@/components/icons";
import { config, requireConfig } from "@/lib/config";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const missing = requireConfig();
  if (missing.length) {
    return (
      <div className="setup-needed card">
        <h1>Almost there</h1>
        <p>Add these environment variables in Vercel → Project → Settings → Environment Variables, then redeploy:</p>
        <ul>{missing.map((m) => <li key={m}><code>{m}</code></li>)}</ul>
      </div>
    );
  }
  const s = await getSession();
  if (!s) redirect("/login");

  return (
    <ShellFrame>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><LeafMark color="#1f4434" /></div>
          <div>
            <div className="brand-name">Stockroom</div>
            <div className="brand-sub">{config.restaurantName}</div>
          </div>
        </div>
        <NavLinks showActivity={s.role !== "staff"} />
        <div className="sidebar-foot">
          <div className="who">
            <div className="avatar">{s.name.slice(0, 1).toUpperCase()}</div>
            <div>
              <div>{s.name}</div>
              <div className="role-tag">{s.role}</div>
            </div>
          </div>
          <SignOut />
        </div>
      </aside>
      <main className="main">{children}</main>
      <Assistant name={s.name} role={s.role} />
    </ShellFrame>
  );
}

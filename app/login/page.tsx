import { redirect } from "next/navigation";
import LoginForm from "@/components/LoginForm";
import { LeafMark } from "@/components/icons";
import { config } from "@/lib/config";
import { getSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await getSession()) redirect("/");
  return (
    <div className="login-wrap">
      <div className="login-art">
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark"><LeafMark color="#1f4434" /></div>
          <div><div className="brand-name">Stockroom</div><div className="brand-sub">{config.restaurantName}</div></div>
        </div>
        <div>
          <h1>Just ask what&apos;s on the shelf.</h1>
          <p>Stock, suppliers, deliveries and expiry dates — answered from your records, in plain language.</p>
          <div className="demo-bubble me">Who supplies our cooking oil?</div>
          <div className="demo-bubble">Both cooking fats, the clear fry shortening and the liquid margarine, come from La Tortilleria / Food Show.</div>
        </div>
        <div style={{ fontSize: 13, opacity: .6 }}>Changes are always confirmed before saving, and every one is logged.</div>
      </div>
      <div className="login-form-side"><LoginForm /></div>
    </div>
  );
}

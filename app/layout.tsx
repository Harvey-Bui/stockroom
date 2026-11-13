import type { Metadata, Viewport } from "next";
import "@fontsource-variable/fraunces";
import "@fontsource-variable/inter-tight";
import "./globals.css";
import { config } from "@/lib/config";

export const metadata: Metadata = {
  title: `Stockroom · ${config.restaurantName}`,
  description: "Restaurant inventory with an AI assistant",
};
export const viewport: Viewport = { themeColor: "#1f4434", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

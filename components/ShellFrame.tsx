"use client";
import { createContext, useContext, useEffect, useState } from "react";

const Ctx = createContext<{ open: boolean; setOpen: (v: boolean) => void }>({ open: true, setOpen: () => {} });
export const useAssistantPanel = () => useContext(Ctx);

export default function ShellFrame({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    // Start collapsed on narrow screens, where the assistant overlays the page.
    if (window.matchMedia("(max-width: 1180px)").matches) setOpen(false);
  }, []);
  return (
    <Ctx.Provider value={{ open, setOpen }}>
      <div className={`shell${open ? "" : " assistant-closed"}`}>{children}</div>
    </Ctx.Provider>
  );
}

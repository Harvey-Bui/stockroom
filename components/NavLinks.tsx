"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BoxIcon, ListIcon, TruckIcon } from "./icons";

export default function NavLinks({ showActivity }: { showActivity: boolean }) {
  const path = usePathname();
  const links = [
    { href: "/", label: "Inventory", icon: <BoxIcon /> },
    { href: "/deliveries", label: "Deliveries", icon: <TruckIcon /> },
    ...(showActivity ? [{ href: "/activity", label: "Activity log", icon: <ListIcon /> }] : []),
  ];
  return (
    <nav className="nav">
      {links.map((l) => (
        <Link key={l.href} href={l.href} className={path === l.href ? "active" : ""}>
          {l.icon}<span>{l.label}</span>
        </Link>
      ))}
    </nav>
  );
}

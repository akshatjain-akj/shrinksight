"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useSyncExternalStore } from "react";
import { clearSession, emptySession, readSession, subscribeSession } from "@/lib/session";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/monitor", label: "Monitor" },
  { href: "/playback", label: "Playback" },
  { href: "/edge", label: "Live edge" },
  { href: "/investigate", label: "Investigate a clip" },
  { href: "/rules", label: "Rules", manager: true },
  { href: "/settings", label: "Settings", manager: true },
  { href: "/about", label: "About" },
];

export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSyncExternalStore(subscribeSession, readSession, emptySession);
  const active = (href: string) => {
    if (href === "/") return pathname === "/";
    if (href === "/monitor") return pathname === "/monitor" || pathname.startsWith("/incident");
    return pathname.startsWith(href);
  };
  const links = LINKS.filter((link) => !link.manager || session?.role === "manager");

  return (
    <header className="topbar">
      <Link href="/" className="brand">
        ShrinkSight <small>Sees what the till missed</small>
      </Link>
      <nav className="nav" aria-label="Main">
        {links.map((link) => (
          <Link key={link.href} href={link.href} aria-current={active(link.href) ? "page" : undefined}>
            {link.label}
          </Link>
        ))}
      </nav>
      {session && (
        <div className="account">
          <span>
            {session.email} · {session.role}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              clearSession();
              router.push("/login");
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}

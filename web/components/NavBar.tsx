"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Overview" },
  { href: "/monitor", label: "Monitor" },
  { href: "/playback", label: "Playback" },
  { href: "/edge", label: "Live edge" },
  { href: "/investigate", label: "Investigate a clip" },
  { href: "/rules", label: "Rules" },
  { href: "/settings", label: "Settings" },
  { href: "/about", label: "About" },
];

export default function NavBar() {
  const pathname = usePathname();
  const active = (href: string) => {
    if (href === "/") return pathname === "/";
    if (href === "/monitor") return pathname === "/monitor" || pathname.startsWith("/incident");
    return pathname.startsWith(href);
  };

  return (
    <header className="topbar">
      <Link href="/" className="brand">
        ShrinkSight <small>Sees what the till missed</small>
      </Link>
      <nav className="nav" aria-label="Main">
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href} aria-current={active(link.href) ? "page" : undefined}>
            {link.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

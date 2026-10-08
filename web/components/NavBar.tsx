"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { clearSession, emptySession, readSession, subscribeSession } from "@/lib/session";
import { clearLocalClips } from "@/lib/localClips";

const LINKS = [
  { href: "/monitor", label: "Monitor" },
  { href: "/playback", label: "Playback" },
  { href: "/edge", label: "Live edge" },
  // { href: "/investigate", label: "Investigate a clip" },
];

export default function NavBar() {
  const pathname = usePathname();
  const router = useRouter();
  const session = useSyncExternalStore(subscribeSession, readSession, emptySession);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const active = (href: string) => {
    if (href === "/monitor") return pathname === "/monitor" || pathname.startsWith("/incident");
    return pathname.startsWith(href);
  };
  const links = session ? LINKS : [];

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <header className="topbar">
      <Link href="/" className="brand">
        <img src="/logo.svg" alt="" width={32} height={32} />
        ShrinkSight <small>Sees what the till missed</small>
      </Link>
      {links.length > 0 && (
        <nav className="nav" aria-label="Main">
          {links.map((link) => (
            <Link key={link.href} href={link.href} aria-current={active(link.href) ? "page" : undefined}>
              {link.label}
            </Link>
          ))}
        </nav>
      )}
      {!session && (
        <Link href="/login" className="btn btn-sm btn-primary signin-end">
          Sign in
        </Link>
      )}
      {session && (
        <div className="account-menu" ref={menuRef}>
          <button
            type="button"
            className="account-trigger"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Account menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span>{session.email}</span>
            <svg className={menuOpen ? "is-open" : ""} width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
          {menuOpen && (
            <div className="account-pop" role="menu">
              <Link href="/profile" role="menuitem">
                Profile
              </Link>
              <Link href="/settings" role="menuitem">
                Settings
              </Link>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  clearSession();
                  // Clips kept on this device go with the session (a shared judge laptop keeps nothing).
                  void clearLocalClips();
                  router.push("/login");
                }}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
      )}
    </header>
  );
}

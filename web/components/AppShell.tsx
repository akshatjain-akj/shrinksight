"use client";

import type { ReactNode } from "react";
import { useEffect, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import NavBar from "@/components/NavBar";
import SiteFooter from "@/components/SiteFooter";
import { emptySession, readSession, subscribeSession } from "@/lib/session";
import { purgeLocalClips } from "@/lib/localClips";

const OPEN = new Set(["/", "/login", "/about"]);

export default function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const bare = pathname === "/login";
  // Subscribed so an expired or cleared session (401, logout in another tab) redirects at once.
  const session = useSyncExternalStore(subscribeSession, readSession, emptySession);

  // Clips kept on this device expire after 24 hours; clear the expired ones whenever the app opens.
  useEffect(() => {
    void purgeLocalClips();
  }, []);

  useEffect(() => {
    if (OPEN.has(pathname)) return;
    const current = readSession();
    if (!current) {
      router.replace("/login");
      return;
    }
    const managerPage = pathname.startsWith("/rules") || pathname.startsWith("/settings");
    if (managerPage && current.role !== "manager") router.replace("/monitor");
  }, [pathname, router, session]);

  if (bare) {
    return (
      <main id="main" className="page page-bare">
        {children}
      </main>
    );
  }

  return (
    <>
      <NavBar />
      <main id="main" className="page">
        {children}
      </main>
      <SiteFooter />
    </>
  );
}

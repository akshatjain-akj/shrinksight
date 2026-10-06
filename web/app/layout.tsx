import type { Metadata } from "next";
import type { ReactNode } from "react";
import AppShell from "@/components/AppShell";
import Warmup from "@/components/Warmup";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShrinkSight · Sees what the till missed",
  description:
    "AI loss prevention for retail: on-device detection plus a Gemini agent that investigates every alert and rejects false alarms.",
  icons: { icon: "/logo.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <Warmup />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}

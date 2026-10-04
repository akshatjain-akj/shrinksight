import type { Metadata } from "next";
import type { ReactNode } from "react";
import NavBar from "@/components/NavBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShrinkSight · Sees what the till missed",
  description:
    "AI loss prevention for retail: on-device detection plus a Gemini agent that investigates every alert and rejects false alarms.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <NavBar />
        <main id="main" className="page">
          {children}
        </main>
        <footer className="footer">
          ShrinkSight · Google Cloud AI Builder Cup 2026 · Retail &amp; Commerce · All store data is synthetic.
        </footer>
      </body>
    </html>
  );
}

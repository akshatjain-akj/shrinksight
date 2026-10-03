import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "ShrinkSight",
  description: "Sees what the till missed.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          margin: 0,
          background: "#0f172a",
          color: "#e2e8f0",
        }}
      >
        {children}
      </body>
    </html>
  );
}

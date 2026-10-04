"use client";

import { useRef, type PointerEvent, type ReactNode } from "react";

export default function HeroStage({ children }: { children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);

  function tilt(event: PointerEvent<HTMLDivElement>) {
    const node = stage.current;
    if (!node || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const box = node.getBoundingClientRect();
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    node.style.setProperty("--tilt-x", `${(8 - y * 10).toFixed(2)}deg`);
    node.style.setProperty("--tilt-y", `${(-18 + x * 14).toFixed(2)}deg`);
  }

  function flatten() {
    const node = stage.current;
    if (!node) return;
    node.style.setProperty("--tilt-x", "8deg");
    node.style.setProperty("--tilt-y", "-18deg");
  }

  return (
    <div
      ref={stage}
      className="sec-scene"
      onPointerMove={tilt}
      onPointerLeave={flatten}
    >
      <span className="sec-slab" aria-hidden="true" />
      <span className="sec-glow" aria-hidden="true" />
      {children}
    </div>
  );
}

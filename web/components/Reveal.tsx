"use client";

import { useEffect, useRef, type ReactNode } from "react";

export default function Reveal({
  children,
  className = "",
  id,
  labelledBy,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  labelledBy?: string;
}) {
  const node = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = node.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      el.classList.add("is-in");
      return;
    }
    const failSafe = window.setTimeout(() => el.classList.add("is-in"), 800);
    const watch = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        el.classList.add("is-in");
        watch.disconnect();
        window.clearTimeout(failSafe);
      },
      { threshold: 0.05, rootMargin: "0px 0px 20% 0px" },
    );
    watch.observe(el);
    return () => {
      watch.disconnect();
      window.clearTimeout(failSafe);
    };
  }, []);

  return (
    <section
      ref={node}
      id={id}
      aria-labelledby={labelledBy}
      className={`sec-reveal ${className}`.trim()}
    >
      {children}
    </section>
  );
}

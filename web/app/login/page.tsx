"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";
import { ApiError, openGoogleSession, openSession } from "@/lib/api";
import { googleIdToken } from "@/lib/firebase";
import { rememberedEmail, saveSession } from "@/lib/session";

type Mode = "login" | "signup" | "recover";

// The server accepted the login but sent a role or token this build doesn't understand (e.g. an API from an
// older release). Saying so beats silently bouncing back to this page.
const UNUSABLE_SESSION = "Signed in, but this account's profile isn't supported by this version of the app. Contact the store manager.";

const SLIDES = [
  {
    title: "Sees what the till missed",
    body: "On-device vision watches every frame. Gemini checks only the ambiguous clip against the receipt.",
  },
  {
    title: "Fewer false alarms.",
    body: "The score gate holds the clip. Staff only see the moment that still needs a person.",
  },
  {
    title: "Camera and receipt, together.",
    body: "Gemini names the unpaid item. The till line still decides what was paid.",
  },
] as const;

const SPRINKLE_COLORS = ["#f6c445", "#3dcf8e", "#ff8f6b", "#7d5cff", "#ffd36a", "#2fd3a2", "#38bdf8", "#fb7185"];

type Sprinkle = { id: string; x: number; y: number; w: number; h: number; rot: number; color: string; round: boolean };

function sprinklesFor(slide: number): Sprinkle[] {
  const count = 8;
  return Array.from({ length: count }, (_, i) => {
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.7;
    const dist = 24 + Math.random() * 20;
    const x = Math.min(92, Math.max(6, 50 + Math.cos(angle) * dist));
    const y = Math.min(88, Math.max(8, 46 + Math.sin(angle) * dist * 0.7));
    const tall = Math.random() > 0.5;
    return {
      id: `${slide}-${i}-${angle.toFixed(2)}`,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(tall ? 10 + Math.random() * 6 : 12 + Math.random() * 8),
      h: Math.round(tall ? 16 + Math.random() * 10 : 11 + Math.random() * 6),
      rot: Math.round(Math.random() * 80 - 40),
      color: SPRINKLE_COLORS[Math.floor(Math.random() * SPRINKLE_COLORS.length)],
      round: Math.random() > 0.55,
    };
  });
}

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [googleBusy, setGoogleBusy] = useState(false);
  const [slide, setSlide] = useState(0);
  const [paused, setPaused] = useState(false);
  const [sprinkles, setSprinkles] = useState<Sprinkle[]>([]);

  useEffect(() => {
    setSprinkles(sprinklesFor(slide));
  }, [slide]);

  // Read after mount: localStorage is not available during prerender.
  useEffect(() => {
    const saved = rememberedEmail();
    if (!saved) return;
    setEmail((current) => current || saved);
    setRemember(true);
  }, []);

  useEffect(() => {
    if (paused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      setSlide((current) => (current + 1) % SLIDES.length);
    }, 4200);
    return () => window.clearInterval(id);
  }, [paused]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setNotice("");
    const trimmed = email.trim();
    if (!trimmed.includes("@")) {
      setError("Enter a valid email.");
      return;
    }
    if (mode === "recover") {
      setNotice(`Reset note queued for ${trimmed}. Demo only — no email is sent.`);
      return;
    }
    if (mode === "signup") {
      setError("Accounts are issued for the store roster. Sign in with that email or its Google account.");
      return;
    }
    if (password.length < 6) {
      setError("Password needs at least 6 characters.");
      return;
    }
    try {
      const session = await openSession(trimmed, password, remember);
      if (!saveSession(session, remember)) {
        setError(UNUSABLE_SESSION);
        return;
      }
      router.push("/monitor");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign in failed.");
    }
  }

  async function onGoogle() {
    setError("");
    setNotice("");
    setGoogleBusy(true);
    try {
      const session = await openGoogleSession(await googleIdToken(), remember);
      if (!saveSession(session, remember)) {
        setError(UNUSABLE_SESSION);
        return;
      }
      router.push("/monitor");
    } catch (err) {
      const code = (err as { code?: string }).code ?? "";
      if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return;
      if (code === "auth/popup-blocked") setError("Allow pop-ups for this site, then try again.");
      else setError(err instanceof ApiError ? err.message : "Google sign-in failed.");
    } finally {
      setGoogleBusy(false);
    }
  }

  const title = mode === "signup" ? "Create account" : mode === "recover" ? "Reset password" : "Hello Again!";
  const lede =
    mode === "signup"
      ? "Open a store desk for the synthetic Demo Mart."
      : mode === "recover"
        ? "We will show a reset note on this page. No email leaves the browser."
        : "Sign in to the loss-prevention desk. Demo Mart uses synthetic data only.";

  return (
    <div className="login-screen">
      <section
        className="login-hero"
        aria-label="Product preview"
        aria-roledescription="carousel"
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        onFocus={() => setPaused(true)}
        onBlur={() => setPaused(false)}
      >
        <div className="login-blob login-blob-a" />
        <div className="login-blob login-blob-b" />
        <div className="login-sprinkles" key={slide} aria-hidden="true">
          {sprinkles.map((piece) => (
            <span
              key={piece.id}
              className="login-confetti"
              style={{
                ["--x" as string]: piece.x,
                ["--y" as string]: piece.y,
                ["--rot" as string]: `${piece.rot}deg`,
                width: piece.w,
                height: piece.h,
                background: piece.color,
                borderRadius: piece.round ? "50%" : "40%",
              }}
            />
          ))}
        </div>
        <span className="login-swoosh" />

        <div className="login-carousel">
          <div className="login-track" style={{ transform: `translateX(-${slide * 100}%)` }}>
            <div className="login-slide" aria-hidden={slide !== 0}>
              <div className="login-stage login-stage-hero">
                <img
                  className="login-card-img"
                  src="/login/lane-card.png?v=8"
                  alt="Lane 3 missed scan. A shopper holds a bottle away from the scanner. Estimated loss 180 rupees."
                  draggable={false}
                />
                <img
                  className="login-mark"
                  src="/login/eye-tile.png?v=4"
                  alt=""
                  draggable={false}
                />
                <img
                  className="login-row-img"
                  src="/login/gemini-card.png?v=4"
                  alt="Gemini verdict. Needs review."
                  draggable={false}
                />
                <img
                  className="login-row-img"
                  src="/login/till-card.png?v=1"
                  alt="Till receipt. Bottle missing."
                  draggable={false}
                />
              </div>
              <div className="login-copy">
                <h2>{SLIDES[0].title}</h2>
                <p>{SLIDES[0].body}</p>
              </div>
            </div>

            <div className="login-slide" aria-hidden={slide !== 1}>
              <div className="login-stage login-stage-drag">
                <article className="login-card login-card-main login-card-plain">
                  <p className="login-kicker">THIS SHIFT</p>
                  <h2>1 review of 6 alerts</h2>
                  <ol>
                    <li>
                      <span>1</span> Sparkling water <em>scanned</em>
                    </li>
                    <li>
                      <span>2</span> Glass bottle <em>missed</em>
                    </li>
                    <li>
                      <span>3</span> Snack bar <em>scanned</em>
                    </li>
                  </ol>
                </article>
                <article className="login-float login-score">
                  <p className="login-kicker">SCORE GATE</p>
                  <strong>0.62</strong>
                  <span>clip sent</span>
                </article>
                <article className="login-float login-found">
                  <div>
                    <strong>Caught today</strong>
                    <span>Lane 3 · 1 miss</span>
                  </div>
                </article>
              </div>
              <div className="login-copy">
                <h2>{SLIDES[1].title}</h2>
                <p>{SLIDES[1].body}</p>
              </div>
            </div>

            <div className="login-slide" aria-hidden={slide !== 2}>
              <div className="login-stage login-stage-drag">
                <article className="login-card login-card-main login-card-plain">
                  <p className="login-kicker">TILL CHECK</p>
                  <h2>Bottle never hit the receipt</h2>
                  <ol>
                    <li>
                      <span>1</span> Seen on camera <em>yes</em>
                    </li>
                    <li>
                      <span>2</span> Paid at till <em>no</em>
                    </li>
                    <li>
                      <span>3</span> Estimated loss <em>₹180</em>
                    </li>
                  </ol>
                </article>
                <article className="login-chip">
                  <i className="dot purple" />
                  <div>
                    <strong>Gemini verdict</strong>
                    <span>Needs review</span>
                  </div>
                </article>
                <article className="login-chip">
                  <i className="dot blue" />
                  <div>
                    <strong>Till match</strong>
                    <span>Line missing</span>
                  </div>
                </article>
                <article className="login-chip">
                  <i className="dot red" />
                  <div>
                    <strong>Face blur</strong>
                    <span>Done on device</span>
                  </div>
                </article>
              </div>
              <div className="login-copy">
                <h2>{SLIDES[2].title}</h2>
                <p>{SLIDES[2].body}</p>
              </div>
            </div>
          </div>
        </div>

        <div className="login-dots" role="tablist" aria-label="Preview slides">
          {SLIDES.map((item, index) => (
            <button
              key={item.title}
              type="button"
              className={index === slide ? "on" : undefined}
              role="tab"
              aria-selected={index === slide}
              aria-label={item.title}
              onClick={() => setSlide(index)}
            />
          ))}
        </div>
      </section>

      <section className="login-panel">
        <Link href="/" className="login-back">
          ← Back
        </Link>
        <img className="login-logo" src="/logo.svg" alt="" width={72} height={72} />
        <h1>{title}</h1>
        <p className="login-lede">{lede}</p>

        <form onSubmit={onSubmit} noValidate>
          {mode === "signup" && (
            <label className="login-field">
              <span className="visually-hidden">Name</span>
              <input
                type="text"
                name="name"
                autoComplete="name"
                placeholder="Name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          <label className="login-field">
            <span className="visually-hidden">Email</span>
            <input
              type="email"
              name="email"
              autoComplete="email"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
            <span className="login-field-icon" aria-hidden="true">
              @
            </span>
          </label>
          {mode !== "recover" && (
            <label className="login-field">
              <span className="visually-hidden">Password</span>
              <input
                type="password"
                name="password"
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                placeholder="Password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
              />
              <span className="login-field-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16">
                  <rect x="6" y="11" width="12" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
                  <path d="M8.5 11V8.5a3.5 3.5 0 0 1 7 0V11" fill="none" stroke="currentColor" strokeWidth="1.6" />
                </svg>
              </span>
            </label>
          )}

          {mode === "login" && (
            <div className="login-row">
              <label>
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                Remember Me
              </label>
              <button type="button" className="login-text" onClick={() => { setMode("recover"); setError(""); setNotice(""); }}>
                Recovery Password
              </button>
            </div>
          )}

          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="login-notice" role="status">
              {notice}
            </p>
          )}

          <button type="submit" className="login-submit">
            {mode === "signup" ? "Create account" : mode === "recover" ? "Send reset note" : "Login"}
          </button>
        </form>

        {mode === "login" && (
          <button type="button" className="login-google" onClick={onGoogle} disabled={googleBusy} aria-busy={googleBusy}>
            <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
              <path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.2-.2-1.8H9v3.4h4.8a4.1 4.1 0 0 1-1.8 2.7v2.2h2.9c1.7-1.6 2.7-3.9 2.7-6.5z" />
              <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.2c-.8.6-1.9.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 0 0 9 18z" />
              <path fill="#FBBC05" d="M3.9 10.7A5.4 5.4 0 0 1 3.6 9c0-.6.1-1.2.3-1.7V5H.9A9 9 0 0 0 0 9c0 1.4.3 2.8.9 4l3-2.3z" />
              <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 0 0 .9 5l3 2.3C4.6 5.2 6.6 3.6 9 3.6z" />
            </svg>
            {googleBusy ? "Opening Google…" : "Sign in with Google"}
          </button>
        )}

        <p className="login-switch">
          {mode === "login" && (
            <>
              Don&apos;t have an account yet?{" "}
              <button type="button" onClick={() => { setMode("signup"); setError(""); setNotice(""); }}>
                Sign Up
              </button>
            </>
          )}
          {mode !== "login" && (
            <button type="button" onClick={() => { setMode("login"); setError(""); setNotice(""); }}>
              Back to login
            </button>
          )}
        </p>
      </section>
    </div>
  );
}

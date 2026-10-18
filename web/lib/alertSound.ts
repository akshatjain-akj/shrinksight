/** Short two-note chime. No audio file. Browsers stay silent until the first click. */

let audio: AudioContext | null = null;
let armed = false;

function context(): AudioContext | null {
  const Ctx = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!audio) audio = new Ctx();
  return audio;
}

export function armAlertSound(): void {
  if (armed || typeof window === "undefined") return;
  armed = true;
  const arm = () => {
    const ctx = context();
    if (ctx?.state === "suspended") void ctx.resume();
    window.removeEventListener("pointerdown", arm);
  };
  window.addEventListener("pointerdown", arm);
}

export function playAlertChime(): void {
  const ctx = context();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.42);
  gain.connect(ctx.destination);

  const tone = (freq: number, at: number) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, at);
    osc.connect(gain);
    osc.start(at);
    osc.stop(at + 0.18);
  };
  tone(784, now);
  tone(1046, now + 0.14);
}

/** Urgent alarm for a possible threat: three sharp, rising beeps, clearly different from the review chime. */
export function playThreatAlarm(): void {
  const ctx = context();
  if (!ctx) return;
  if (ctx.state === "suspended") void ctx.resume();
  const start = ctx.currentTime;
  for (let i = 0; i < 3; i += 1) {
    const at = start + i * 0.32;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.18, at + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.24);
    gain.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(880, at);
    osc.frequency.linearRampToValueAtTime(1320, at + 0.2);
    osc.connect(gain);
    osc.start(at);
    osc.stop(at + 0.25);
  }
}

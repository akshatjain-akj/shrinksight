/**
 * Investigate's Tier-1 measurements: what the main shopper's hands did, as times and places, with no conclusions.
 * Gemini gets these as "where to look" (it judges what happened), and the server compares them with its verdict.
 *
 * - Floor: when each wrist was on the shelf, and where a wrist rested on the body afterwards (pocket height, waistband,
 *   torso centre, out at the side), for how long.
 * - Checkout: hand trips from the item pile to the bagging area, and whether each trip went through the scanner zone.
 *
 * Fed one pose sample per SAMPLE_MS of clip time; a zone counts after two samples in a row, so one bad pose doesn't.
 */

import { atBasket, BodyScale, handSpot, onShelf, type BodySample, type HideSpot } from "./engine.ts";
import { inAny, type Pt, type ZoneShape } from "./geometry.ts";
import type { BodyHold, CloseUpRef, Hand, ShelfContact, Trip } from "../types.ts";

export type CloseUpMoment = CloseUpRef;

export interface Measurements {
  person_seen: number;
  shelf_contacts: ShelfContact[];
  holds: BodyHold[];
  /** Null when the clip can't be counted (not a checkout, or pile / bagging zone not marked). */
  trips: Trip[] | null;
}

const MIN_SAMPLES = 2;
/** A hold only counts if it starts within this long after the same hand left the shelf. */
const HOLD_AFTER_SHELF_MS = 3000;
const MIN_HOLD_MS = 400;
const MAX_CONTACTS = 12;
const MAX_HOLDS = 8;
const MAX_TRIPS = 20;

const seconds = (ms: number) => Math.round(ms / 100) / 10;

/** Debounced "inside" state: flips after MIN_SAMPLES samples in a row that agree. */
class Debounce {
  on = false;
  since = 0;
  private streak = 0;
  private pendingSince = 0;

  /** Returns "start" / "end" on the sample where the state flips. */
  feed(inside: boolean, tMs: number): "start" | "end" | null {
    if (inside === this.on) {
      this.streak = 0;
      return null;
    }
    if (this.streak === 0) this.pendingSince = tMs;
    this.streak += 1;
    if (this.streak < MIN_SAMPLES) return null;
    this.on = inside;
    this.since = this.pendingSince;
    this.streak = 0;
    return inside ? "start" : "end";
  }
}

interface HandState {
  shelf: Debounce;
  contactStart: number;
  lastShelfExit: number | null;
  spot: HideSpot | null;
  spotStreak: number;
  spotSince: number;
  lastSpotAt: number;
  holdStart: number | null;
  holdSpot: HideSpot | null;
  holdAfter: number;
}

const newHand = (): HandState => ({
  shelf: new Debounce(),
  contactStart: 0,
  lastShelfExit: null,
  spot: null,
  spotStreak: 0,
  spotSince: 0,
  lastSpotAt: 0,
  holdStart: null,
  holdSpot: null,
  holdAfter: 0,
});

interface CarryState {
  pile: Debounce;
  bag: Debounce;
  carrying: boolean;
  start: number;
  scanned: boolean;
}

const newCarry = (): CarryState => ({ pile: new Debounce(), bag: new Debounce(), carrying: false, start: 0, scanned: false });

export class ClipMeasure {
  private readonly cameraKind: "checkout" | "floor";
  private readonly shelf: ZoneShape[];
  private readonly pickup: ZoneShape[];
  private readonly scanner: ZoneShape[];
  private readonly bagging: ZoneShape[];
  private readonly scale = new BodyScale();
  private readonly hands: Record<Hand, HandState> = { left: newHand(), right: newHand() };
  private samples = 0;
  private withPerson = 0;
  private lastT = 0;
  private contacts: ShelfContact[] = [];
  private holds: BodyHold[] = [];
  // Checkout trips, per hand: one hand can pick the next item while the other bags the last one.
  private readonly carry: Record<Hand, CarryState> = { left: newCarry(), right: newCarry() };
  private trips: Trip[] = [];

  constructor(cameraKind: "checkout" | "floor", zones: ZoneShape[]) {
    this.cameraKind = cameraKind;
    const of = (kind: string) => zones.filter((zone) => zone.kind === kind);
    this.shelf = of("shelf");
    this.pickup = of("pickup");
    this.scanner = of("scanner");
    this.bagging = of("bagging");
  }

  /** True when the zones this camera kind needs are marked (shelf; or item pile, scanner and bagging). */
  get ready(): boolean {
    return this.cameraKind === "floor"
      ? this.shelf.length > 0
      : this.pickup.length > 0 && this.scanner.length > 0 && this.bagging.length > 0;
  }

  /** One pose sample of the main shopper (or null when nobody is in view) at clip time tMs. */
  feed(tMs: number, sample: BodySample | null): void {
    this.samples += 1;
    this.lastT = tMs;
    if (sample) this.withPerson += 1;
    if (sample) this.scale.update(sample);
    if (this.cameraKind === "floor") {
      this.floor("left", sample?.leftWrist ?? null, sample, tMs);
      this.floor("right", sample?.rightWrist ?? null, sample, tMs);
    } else {
      this.checkout({ left: sample?.leftWrist ?? null, right: sample?.rightWrist ?? null }, tMs);
    }
  }

  result(): Measurements {
    for (const hand of ["left", "right"] as const) {
      const state = this.hands[hand];
      if (state.shelf.on) this.addContact(hand, state.contactStart, this.lastT);
      this.closeHold(hand, state, this.lastT);
    }
    return {
      person_seen: this.samples ? Math.round((this.withPerson / this.samples) * 100) / 100 : 0,
      shelf_contacts: [...this.contacts].sort((a, b) => a.start_s - b.start_s),
      holds: [...this.holds].sort((a, b) => a.start_s - b.start_s),
      trips: this.cameraKind === "checkout" && this.ready ? this.trips : null,
    };
  }

  /** Moments worth a hand close-up: up to 2 shelf exits + holds (floor), or each trip reaching the bag (checkout). */
  static closeUps(measured: Measurements, max = 4): CloseUpMoment[] {
    const moments: Omit<CloseUpMoment, "label">[] = [];
    if (measured.trips) {
      for (const trip of measured.trips.slice(0, 6)) moments.push({ t_s: trip.end_s, moment: "bagging" });
      return moments.map((m, i) => ({ ...m, label: `trip_${i + 1}` }));
    }
    for (const hold of measured.holds.slice(0, 2)) {
      moments.push({ t_s: hold.after_shelf_s, moment: "shelf_exit" });
      moments.push({ t_s: Math.min(hold.end_s, hold.start_s + 0.4), moment: "hold" });
    }
    if (!moments.length) {
      for (const contact of measured.shelf_contacts.slice(0, 2)) moments.push({ t_s: contact.end_s, moment: "shelf_exit" });
    }
    return moments.slice(0, max).map((m, i) => ({ ...m, label: `hand_${i + 1}` }));
  }

  private floor(hand: Hand, wrist: Pt | null, sample: BodySample | null, tMs: number): void {
    const state = this.hands[hand];
    const unit = this.scale.unit;
    const shelfNow = Boolean(wrist && sample && onShelf(wrist, sample, this.shelf, unit));
    const flip = state.shelf.feed(shelfNow, tMs);
    if (flip === "start") {
      state.contactStart = state.shelf.since;
      this.closeHold(hand, state, tMs);
    } else if (flip === "end") {
      this.addContact(hand, state.contactStart, state.shelf.since);
      state.lastShelfExit = state.shelf.since;
    }
    if (state.shelf.on) return;

    // A basket put (hand in front of the body at hip height) is not a rest on the body.
    const spot = wrist && sample && !atBasket(sample, unit) ? handSpot(wrist, sample, this.shelf, unit) : null;
    if (spot && spot === state.spot) {
      state.spotStreak += 1;
    } else {
      state.spot = spot;
      state.spotStreak = spot ? 1 : 0;
      state.spotSince = tMs;
    }
    if (spot) state.lastSpotAt = tMs;

    if (state.holdStart == null) {
      const recentExit = state.lastShelfExit != null && state.spotSince - state.lastShelfExit <= HOLD_AFTER_SHELF_MS;
      if (spot && state.spotStreak >= MIN_SAMPLES && recentExit) {
        state.holdStart = state.spotSince;
        state.holdSpot = spot;
        state.holdAfter = state.lastShelfExit!;
      }
    } else if (!spot && tMs - state.lastSpotAt >= 200) {
      this.closeHold(hand, state, state.lastSpotAt);
    }
  }

  private closeHold(hand: Hand, state: HandState, endMs: number): void {
    if (state.holdStart == null || !state.holdSpot) return;
    if (endMs - state.holdStart >= MIN_HOLD_MS && this.holds.length < MAX_HOLDS) {
      this.holds.push({
        hand,
        start_s: seconds(state.holdStart),
        end_s: seconds(endMs),
        spot: state.holdSpot,
        after_shelf_s: seconds(state.holdAfter),
      });
    }
    state.holdStart = null;
    state.holdSpot = null;
    // One hold per shelf visit: the next one needs the hand to go back to the shelf first.
    state.lastShelfExit = null;
  }

  private addContact(hand: Hand, startMs: number, endMs: number): void {
    if (this.contacts.length < MAX_CONTACTS) this.contacts.push({ hand, start_s: seconds(startMs), end_s: seconds(endMs) });
  }

  private checkout(wrists: Record<Hand, Pt | null>, tMs: number): void {
    if (!this.ready) return;
    for (const hand of ["left", "right"] as const) {
      const state = this.carry[hand];
      const wrist = wrists[hand];
      const pile = state.pile.feed(Boolean(wrist && inAny(wrist, this.pickup)), tMs);
      if (pile === "end") {
        state.carrying = true;
        state.start = state.pile.since;
        state.scanned = false;
      } else if (state.pile.on) {
        state.carrying = false; // still picking
      }
    }
    // A quick swipe can cross the scanner in a single sample. Either hand at the scanner counts for an item in
    // flight, so an item passed from one hand to the other and scanned on the way still counts as scanned.
    if ((["left", "right"] as const).some((hand) => wrists[hand] && inAny(wrists[hand]!, this.scanner))) {
      for (const hand of ["left", "right"] as const) if (this.carry[hand].carrying) this.carry[hand].scanned = true;
    }
    for (const hand of ["left", "right"] as const) {
      const state = this.carry[hand];
      const wrist = wrists[hand];
      if (state.bag.feed(Boolean(wrist && inAny(wrist, this.bagging)), tMs) !== "start") continue;
      // This hand's own item, or one the other hand picked and passed over.
      const other = this.carry[hand === "left" ? "right" : "left"];
      const from = state.carrying ? state : other.carrying ? other : null;
      if (!from) continue; // a hand in the bag without an item from the pile: tidying, not a trip
      if (this.trips.length < MAX_TRIPS) {
        this.trips.push({ start_s: seconds(from.start), end_s: seconds(state.bag.since), via_scanner: from.scanned });
      }
      from.carrying = false;
      from.scanned = false;
    }
  }
}

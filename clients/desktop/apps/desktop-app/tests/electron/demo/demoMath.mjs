/**
 * Pure timing and geometry helpers for `*.demo-spec.ts` recordings. Nothing
 * here touches Playwright, the filesystem, or the clock, so the pacing a demo
 * produces is unit-tested (`../node/demo-math.test.mjs`) and reproducible: the
 * same seed always yields the same cursor paths and typing rhythm.
 */

/**
 * Deterministic PRNG (mulberry32). Returns floats in [0, 1).
 *
 * @param {number} seed
 * @returns {() => number}
 */
export function createRng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** @param {number} t */
function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

/**
 * Human-like cursor travel time: longer moves take longer, but never so long
 * that the viewer waits on the pointer. Scaled by the demo pace.
 *
 * @param {number} distance CSS pixels
 * @param {number} pace multiplier (1 = natural, 0 = instant)
 * @returns {number} milliseconds
 */
export function cursorTravelMs(distance, pace) {
  const natural = Math.min(950, Math.max(320, 260 + distance * 0.45));
  return Math.round(natural * pace);
}

/**
 * Points along a gently curved, eased path from `from` to `to`, one per
 * `frameMs`. The curve bows to a seeded side so repeated moves do not look
 * mechanical. The final point is always exactly `to`.
 *
 * @param {{ x: number, y: number }} from
 * @param {{ x: number, y: number }} to
 * @param {{ durationMs: number, frameMs?: number, rng: () => number }} options
 * @returns {Array<{ x: number, y: number, atMs: number }>}
 */
export function cursorPath(from, to, { durationMs, frameMs = 16, rng }) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 1 || durationMs <= 0) return [{ ...to, atMs: 0 }];
  // Quadratic Bézier control point: midpoint pushed perpendicular to travel.
  const bow = distance * (0.06 + rng() * 0.1) * (rng() < 0.5 ? -1 : 1);
  const control = {
    x: from.x + dx / 2 + (-dy / distance) * bow,
    y: from.y + dy / 2 + (dx / distance) * bow,
  };
  const steps = Math.max(2, Math.round(durationMs / frameMs));
  const points = [];
  for (let step = 1; step <= steps; step += 1) {
    const t = easeInOutCubic(step / steps);
    const inverse = 1 - t;
    points.push({
      x:
        inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
      y:
        inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
      atMs: Math.round((durationMs * step) / steps),
    });
  }
  points[points.length - 1] = { ...to, atMs: durationMs };
  return points;
}

/**
 * A point inside a box, near its center, with a small seeded offset so clicks
 * do not all land on the exact geometric center.
 *
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @param {() => number} rng
 * @returns {{ x: number, y: number }}
 */
export function clickPoint(box, rng) {
  const spreadX = Math.min(6, box.width * 0.15);
  const spreadY = Math.min(4, box.height * 0.15);
  return {
    x: Math.round(box.x + box.width / 2 + (rng() * 2 - 1) * spreadX),
    y: Math.round(box.y + box.height / 2 + (rng() * 2 - 1) * spreadY),
  };
}

/**
 * Per-character delays for typing `text` at roughly `wpm`, with jitter and
 * short hesitations after word and sentence boundaries.
 *
 * @param {string} text
 * @param {{ wpm: number, pace: number, rng: () => number }} options
 * @returns {number[]} one delay (ms) to wait after each character
 */
export function typingDelays(text, { wpm, pace, rng }) {
  const baseMs = 60_000 / (wpm * 5);
  return Array.from(text, (char) => {
    let delay = baseMs * (0.7 + rng() * 0.6);
    if (char === ' ') delay += baseMs * 0.25 * rng();
    if (/[.,!?;:]/.test(char)) delay += baseMs * (0.6 + rng() * 0.6);
    return Math.round(delay * pace);
  });
}

/**
 * Expand screencast frames (emitted only when the page repaints) into a
 * constant-frame-rate sequence: each captured frame is repeated until the next
 * one arrives, and the last frame holds until `endSeconds`.
 *
 * @template T
 * @param {Array<{ frame: T, timestamp: number }>} frames capture-ordered,
 *   timestamps in seconds
 * @param {{ startSeconds: number, endSeconds: number, fps: number }} options
 * @returns {Array<{ frame: T, repeat: number }>} frames with repeat >= 1
 */
export function expandFrameTimeline(frames, { startSeconds, endSeconds, fps }) {
  if (frames.length === 0) return [];
  const frameIndexAt = (seconds) =>
    Math.round((Math.max(seconds, startSeconds) - startSeconds) * fps);
  const totalFrames = Math.max(1, frameIndexAt(endSeconds));
  const expanded = [];
  for (let index = 0; index < frames.length; index += 1) {
    // The first captured frame also covers any gap before it arrived.
    const from = index === 0 ? 0 : frameIndexAt(frames[index].timestamp);
    const to =
      index + 1 < frames.length
        ? frameIndexAt(frames[index + 1].timestamp)
        : totalFrames;
    const repeat = Math.min(to, totalFrames) - from;
    if (repeat > 0) expanded.push({ frame: frames[index].frame, repeat });
  }
  if (expanded.length === 0) {
    expanded.push({ frame: frames[frames.length - 1].frame, repeat: 1 });
  }
  return expanded;
}

/**
 * Round a pixel dimension down to an even number, as VP8 with 4:2:0 chroma
 * requires.
 *
 * @param {number} value
 * @returns {number}
 */
export function evenPixels(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

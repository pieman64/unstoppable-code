/**
 * Human-paced driving for `*.demo-spec.ts` demo videos.
 *
 * Playwright input is synthetic: `locator.click()` teleports, `fill()` pastes,
 * and no pointer is ever painted. A demo built on those is unwatchable. The
 * director instead:
 *
 *   - paints a cursor overlay (pointer-events: none) that follows the real
 *     input events Playwright dispatches, with a press ripple on clicks;
 *   - glides the mouse along curved, eased paths and dwells before clicking,
 *     so hover states render the way they do for a person;
 *   - types character by character with seeded jitter;
 *   - shows lower-third captions and records step stills on the timeline.
 *
 * All randomness is seeded, so a demo replays identically. `CANOPY_DEMO_PACE`
 * scales every delay (`0` runs the same script at test speed for a quick dry
 * run; `1.5` slows it down).
 *
 * Usage (see `demo-chat-turn.demo-spec.ts`):
 *
 *   const demo = await startDemo(window, { dir, name: 'chat-turn' });
 *   try {
 *     await demo.caption('Ask the agent about the project');
 *     await demo.click(composer);
 *     await demo.type(composer, 'Summarize the README');
 *     await demo.press('Enter');
 *     await demo.step('Reply streamed');
 *   } finally {
 *     await demo.finish();
 *   }
 */
import { expect } from '@playwright/test';
import {
  clickPoint,
  createRng,
  cursorPath,
  cursorTravelMs,
  typingDelays,
} from './demoMath.mjs';
import { startDemoRecording } from './demoRecorder.mjs';

const OVERLAY_ID = '__canopy-demo-overlay';

/** Named pauses, in milliseconds at pace 1. */
export const DEMO_BEATS = Object.freeze({
  tiny: 250,
  short: 600,
  read: 1_400,
  result: 2_200,
});

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number}
 */
export function demoPace(env = process.env) {
  const raw = env.CANOPY_DEMO_PACE;
  if (raw === undefined || raw.trim() === '') return 1;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`CANOPY_DEMO_PACE must be a number >= 0, got ${raw}`);
  }
  return value;
}

function sleep(ms) {
  return ms > 0
    ? new Promise((resolve) => setTimeout(resolve, ms))
    : Promise.resolve();
}

/**
 * Installs the cursor and caption overlay. Runs in the renderer; it must be
 * self-contained. Idempotent.
 *
 * @param {{ id: string, x: number, y: number }} options
 */
function installOverlay({ id, x, y }) {
  if (document.getElementById(id)) return;
  const root = document.createElement('div');
  root.id = id;
  root.setAttribute('aria-hidden', 'true');
  root.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483647;contain:strict;';
  root.innerHTML = `
    <style>
      #${id} .cursor { position:absolute; left:0; top:0; width:22px; height:22px;
        transform: translate(${x}px, ${y}px); will-change: transform; }
      #${id} .cursor svg { position:absolute; left:-2px; top:-1px;
        filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.35));
        transition: transform 90ms ease-out; transform-origin: 2px 1px; }
      #${id} .cursor.pressed svg { transform: scale(.86); }
      #${id} .ripple { position:absolute; width:36px; height:36px; margin:-18px 0 0 -18px;
        border-radius:50%; background: rgba(64,132,255,.35);
        border: 2px solid rgba(64,132,255,.7);
        animation: ${id}-ripple 520ms ease-out forwards; }
      @keyframes ${id}-ripple { from { transform: scale(.3); opacity: 1; }
        to { transform: scale(1.4); opacity: 0; } }
      #${id} .caption { position:absolute; left:50%; bottom:28px; max-width:72%;
        transform: translate(-50%, 8px); opacity:0;
        transition: opacity 260ms ease, transform 260ms ease;
        padding:10px 18px; border-radius:10px; background: rgba(17,17,20,.86);
        border: 1px solid rgba(255,255,255,.16);
        color:#fff; font: 500 15px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        letter-spacing:.005em; box-shadow: 0 6px 24px rgba(0,0,0,.28); text-align:center; }
      #${id} .caption.visible { opacity:1; transform: translate(-50%, 0); }
    </style>
    <div class="caption"></div>
    <div class="cursor"><svg width="22" height="26" viewBox="0 0 22 26">
      <path d="M2 1.5 L2 20.5 L6.9 16 L10.2 23.6 L13.6 22.1 L10.4 14.6 L17 14.6 Z"
        fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/>
    </svg></div>`;
  document.documentElement.appendChild(root);
  const cursor = root.querySelector('.cursor');
  if (!(cursor instanceof HTMLElement)) return;
  const move = (event) => {
    cursor.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
  };
  window.addEventListener('mousemove', move, true);
  window.addEventListener(
    'mousedown',
    (event) => {
      move(event);
      cursor.classList.add('pressed');
      const ripple = document.createElement('div');
      ripple.className = 'ripple';
      ripple.style.left = `${event.clientX}px`;
      ripple.style.top = `${event.clientY}px`;
      root.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    },
    true,
  );
  window.addEventListener(
    'mouseup',
    () => cursor.classList.remove('pressed'),
    true,
  );
}

/**
 * @typedef {import('@playwright/test').Locator} Locator
 * @typedef {import('@playwright/test').Page} Page
 * @typedef {keyof typeof DEMO_BEATS | number} Beat
 */

/**
 * Start a recorded demo on `page`.
 *
 * @param {Page} page the Electron window (or any Chromium page)
 * @param {import('./demoRecorder.mjs').DemoRecordingOptions & {
 *   seed?: number,
 *   pace?: number,
 *   record?: boolean,
 * }} options `record: false` drives the same script without recording, for
 *   iterating on a demo quickly (combine with `CANOPY_DEMO_PACE=0`).
 */
export async function startDemo(page, options) {
  const pace = options.pace ?? demoPace();
  const rng = createRng(options.seed ?? 1);
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  let cursor = {
    x: Math.round(viewport.width * 0.55),
    y: Math.round(viewport.height * 0.6),
  };

  const ensureOverlay = () =>
    page.evaluate(installOverlay, { id: OVERLAY_ID, ...cursor });
  await ensureOverlay();
  // Park the real pointer where the overlay starts.
  await page.mouse.move(cursor.x, cursor.y);

  const recording =
    options.record === false ? null : await startDemoRecording(page, options);

  /** @param {Beat} beat */
  const beatMs = (beat) =>
    Math.round((typeof beat === 'number' ? beat : DEMO_BEATS[beat]) * pace);

  /** @param {{ x: number, y: number }} target */
  async function glideTo(target) {
    await ensureOverlay();
    const durationMs = cursorTravelMs(
      Math.hypot(target.x - cursor.x, target.y - cursor.y),
      pace,
    );
    const startedAt = Date.now();
    for (const point of cursorPath(cursor, target, { durationMs, rng })) {
      // Schedule against the start time so CDP latency does not stretch moves.
      await sleep(startedAt + point.atMs - Date.now());
      await page.mouse.move(point.x, point.y);
    }
    cursor = { x: target.x, y: target.y };
  }

  /**
   * Scroll `locator` into view, wait until it is visible, enabled, stable,
   * and not covered at the chosen point, and return that natural point
   * inside it.
   *
   * These checks deliberately avoid `click({ trial: true })`: a trial click
   * still dispatches a real mouse move to the target, which would snap the
   * painted cursor there before the glide starts.
   *
   * @param {Locator} locator
   * @param {{ scroll?: boolean }} [options]
   */
  async function actionablePoint(locator, { scroll = true } = {}) {
    if (scroll) await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeVisible();
    await expect(locator).toBeEnabled();
    let box = await locator.boundingBox();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(resolve)),
      );
      const next = await locator.boundingBox();
      const stable =
        box &&
        next &&
        box.x === next.x &&
        box.y === next.y &&
        box.width === next.width &&
        box.height === next.height;
      box = next;
      if (stable) break;
    }
    if (!box) throw new Error(`Demo target has no bounding box: ${locator}`);
    const point = clickPoint(box, rng);
    // The overlay is pointer-events: none, so hit testing sees the app.
    const hitsLocator = () =>
      locator.evaluate((element, { x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return hit !== null && element.contains(hit);
      }, point);
    if (scroll) {
      await expect.poll(hitsLocator).toBe(true);
    } else if (!(await hitsLocator())) {
      throw new Error('Drag endpoints cannot remain actionable together');
    }
    return point;
  }

  const demo = {
    pace,
    page,

    /**
     * Glide the cursor onto `locator` and leave it hovering there.
     *
     * @param {Locator} locator
     * @param {{ dwell?: Beat }} [options]
     */
    async hover(locator, { dwell = 'short' } = {}) {
      await glideTo(await actionablePoint(locator));
      await sleep(beatMs(dwell));
    },

    /**
     * Glide to `locator`, pause briefly as a person would, and click it.
     *
     * @param {Locator} locator
     * @param {{ label?: string, after?: Beat }} [options]
     */
    async click(locator, { label, after = 'short' } = {}) {
      const point = await actionablePoint(locator);
      await glideTo(point);
      await sleep(Math.round((120 + rng() * 120) * pace));
      recording?.mark({ type: 'click', label, x: point.x, y: point.y });
      await page.mouse.down();
      await sleep(Math.round((70 + rng() * 50) * pace));
      await page.mouse.up();
      await sleep(beatMs(after));
    },

    /**
     * Type `text` into `locator` one character at a time. Clicks the field
     * first unless it already has focus.
     *
     * @param {Locator} locator
     * @param {string} text
     * @param {{ wpm?: number, after?: Beat }} [options]
     */
    async type(locator, text, { wpm = 120, after = 'tiny' } = {}) {
      const focused = await locator.evaluate(
        (element) =>
          element === document.activeElement ||
          element.contains(document.activeElement),
      );
      if (!focused) {
        await demo.click(locator, { after: 'tiny' });
        // People move the pointer off a field before typing; park it just
        // above so it does not cover the text.
        const box = await locator.boundingBox();
        if (box) await glideTo({ x: cursor.x, y: Math.max(8, box.y - 56) });
      }
      const delays = typingDelays(text, { wpm, pace, rng });
      const chars = Array.from(text);
      for (let index = 0; index < chars.length; index += 1) {
        await page.keyboard.type(chars[index]);
        await sleep(delays[index]);
      }
      await sleep(beatMs(after));
    },

    /**
     * Press a key (e.g. `Enter`, `Meta+K`) with a short lead-in pause.
     *
     * @param {string} key
     * @param {{ after?: Beat }} [options]
     */
    async press(key, { after = 'short' } = {}) {
      await sleep(beatMs('tiny'));
      recording?.mark({ type: 'key', label: key });
      await page.keyboard.press(key);
      await sleep(beatMs(after));
    },

    /**
     * Smoothly scroll the element under `locator` by `deltaY` CSS pixels.
     *
     * @param {Locator} locator
     * @param {number} deltaY
     * @param {{ durationMs?: number, after?: Beat }} [options]
     */
    async scroll(locator, deltaY, { durationMs = 900, after = 'short' } = {}) {
      await demo.hover(locator, { dwell: 'tiny' });
      const steps = Math.max(1, Math.round((durationMs * pace) / 16));
      let scrolled = 0;
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        const next = Math.round(deltaY * eased);
        await page.mouse.wheel(0, next - scrolled);
        scrolled = next;
        await sleep(16);
      }
      await sleep(beatMs(after));
    },

    /**
     * Glide to `from`, press, drag with an eased motion to `to`, and release:
     * selecting text, or resizing panels by a divider. Each end is a viewport
     * point or a locator (its natural point, as for `click`).
     *
     * @param {Locator | { x: number, y: number }} from
     * @param {Locator | { x: number, y: number }} to
     * @param {{ label?: string, durationMs?: number, after?: Beat }} [options]
     */
    async drag(from, to, { label, durationMs = 700, after = 'short' } = {}) {
      // Finish all scrolling before measuring either point. A destination
      // scroll may move the source, even when both locators share a container.
      if (!('x' in from)) await from.scrollIntoViewIfNeeded();
      if (!('x' in to)) await to.scrollIntoViewIfNeeded();
      const start =
        'x' in from ? from : await actionablePoint(from, { scroll: false });
      const end = 'x' in to ? to : await actionablePoint(to, { scroll: false });
      await glideTo(start);
      await sleep(Math.round((120 + rng() * 120) * pace));
      recording?.mark({ type: 'drag', label, x: end.x, y: end.y });
      await page.mouse.down();
      const steps = Math.max(1, Math.round((durationMs * pace) / 16));
      for (let step = 1; step <= steps; step += 1) {
        const t = step / steps;
        const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
        await page.mouse.move(
          start.x + (end.x - start.x) * eased,
          start.y + (end.y - start.y) * eased,
        );
        await sleep(16);
      }
      await sleep(Math.round((70 + rng() * 50) * pace));
      await page.mouse.up();
      cursor = { x: end.x, y: end.y };
      await sleep(beatMs(after));
    },

    /**
     * Pause on the current state so the viewer can take it in.
     *
     * @param {Beat} [beat]
     */
    async beat(beat = 'read') {
      await sleep(beatMs(beat));
    },

    /**
     * Show a lower-third caption. It stays up until the next caption or
     * `hideCaption()`.
     *
     * @param {string} text
     * @param {{ hold?: Beat }} [options] pause after it appears
     */
    async caption(text, { hold = 'read' } = {}) {
      await ensureOverlay();
      recording?.mark({ type: 'caption', label: text });
      await page.evaluate(
        ({ id, text: captionText }) => {
          const caption = document.querySelector(`#${id} .caption`);
          if (!caption) return;
          caption.textContent = captionText;
          caption.classList.add('visible');
        },
        { id: OVERLAY_ID, text },
      );
      await sleep(beatMs(hold));
    },

    async hideCaption() {
      await page.evaluate((id) => {
        document.querySelector(`#${id} .caption`)?.classList.remove('visible');
      }, OVERLAY_ID);
      await sleep(beatMs('tiny'));
    },

    /**
     * Mark a named step on the timeline and save a full-resolution still, so
     * an agent can review the demo without playing the video.
     *
     * @param {string} label
     */
    async step(label) {
      await recording?.still(label);
    },

    /**
     * Wait for an app state while the recording keeps rolling (for example a
     * streamed reply), then hold on it.
     *
     * @param {Locator} locator
     * @param {{ timeout?: number, hold?: Beat }} [options]
     */
    async waitFor(locator, { timeout = 30_000, hold = 'result' } = {}) {
      await expect(locator).toBeVisible({ timeout });
      await sleep(beatMs(hold));
    },

    /**
     * Stop recording and write the artifacts. Call before closing the app.
     * Returns null when recording was disabled.
     */
    async finish() {
      if (!recording) return null;
      await demo.hideCaption().catch(() => {});
      return recording.stop();
    },
  };
  return demo;
}

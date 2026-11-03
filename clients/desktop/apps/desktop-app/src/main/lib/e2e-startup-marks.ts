import { isE2eBuild } from './e2e-gate';

/**
 * E2E-only startup marks for the desktop performance harness's J1 journey
 * (process start → main ready → window load → DOMContentLoaded → React mount
 * → hydrated composer). The harness reads them from
 * `globalThis.__CANOPY_E2E_STARTUP_MARKS__` after the measured window. Each
 * mark is `performance.now()` on main's clock, which starts at process start
 * (`performance.timeOrigin`), and is recorded once.
 *
 * Production builds never record anything: `isE2eBuild()` is the build-time
 * `__CANOPY_E2E__` constant. `mainReady` is marked inside an E2E-gated block;
 * the W5 store marks (CAN-5532) are `w5StoreReady`, once the daemon-backed
 * store arm recovered, and `w5FirstReadServed`, once either store served a
 * W5 read.
 */

export type E2eStartupMarkName =
  | 'mainReady'
  | 'w5StoreReady'
  | 'w5FirstReadServed';

export type E2eStartupMarks = Partial<Record<E2eStartupMarkName, number>>;

declare global {
  // Installed in E2E builds only, for the desktop performance harness.
  var __CANOPY_E2E_STARTUP_MARKS__: E2eStartupMarks | undefined;
}

export function markE2eStartup(
  name: E2eStartupMarkName,
  now: () => number = (): number => performance.now(),
): void {
  if (!isE2eBuild()) return;
  const marks = globalThis.__CANOPY_E2E_STARTUP_MARKS__ ?? {};
  if (marks[name] === undefined) marks[name] = now();
  globalThis.__CANOPY_E2E_STARTUP_MARKS__ = marks;
}

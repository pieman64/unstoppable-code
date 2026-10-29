/**
 * Small curated pool of audience-neutral, action-oriented phrases (CAN-2697).
 *
 * One phrase is picked at random the
 * first time any `HomeSurface` instance mounts and held for as long as at
 * least one instance remains mounted anywhere (see `useHomeHeading`), so
 * re-clicking "New Task" while already on the Home surface — or navigating
 * between the Code page's embedded empty state and the standalone "New Task"
 * page — does not change the visible heading. It only repicks once every
 * `HomeSurface` instance has unmounted.
 */
export const HOME_HEADINGS: readonly string[] = [
  "Say what you'd like to get done",
  'Describe what you need, in your own words',
  "Share what you're working on today",
  'Start with a goal, a question, or a rough idea',
  "Get help with whatever's on your plate today",
  'Explain what you need and let the work begin',
] as const;

declare global {
  /**
   * E2E-only hook set by Electron capture specs via page.addInitScript before
   * a reload so screenshots are deterministic; never set in production.
   */
  var __CANOPY_E2E_HOME_HEADING_INDEX__: number | undefined;
}

/** Picks one heading from `HOME_HEADINGS` at random. */
export function pickHomeHeading(): string {
  const e2eIndex = globalThis.__CANOPY_E2E_HOME_HEADING_INDEX__;
  if (
    e2eIndex !== undefined &&
    Number.isFinite(e2eIndex) &&
    Number.isInteger(e2eIndex) &&
    e2eIndex >= 0 &&
    e2eIndex < HOME_HEADINGS.length
  ) {
    return HOME_HEADINGS[e2eIndex];
  }
  const index = Math.floor(Math.random() * HOME_HEADINGS.length);
  return HOME_HEADINGS[index];
}

/** More's sticky seat is top-px, immediately after the one-pixel flow sentinel. */
const NAVIGATION_SEAT = 1;

/** Layout reads only, in CSS scroll-content coordinates (including fractions). */
export function measureSidebarNavigationThreshold(
  viewport: HTMLElement,
): number | null {
  const sentinel = viewport.querySelector<HTMLElement>(
    '[data-testid="sidebar-sticky-workspace-sentinel"]',
  );
  if (!sentinel) return null;
  const viewportRect = viewport.getBoundingClientRect();
  const sentinelRect = sentinel.getBoundingClientRect();
  if (viewportRect.height <= 0 || sentinelRect.height <= 0) return null;
  // Electron page zoom preserves CSS coordinates for both rects and scrollTop.
  // The sentinel stays in normal flow even after More reaches its sticky seat.
  const threshold =
    sentinelRect.bottom -
    viewportRect.top -
    viewport.clientTop +
    viewport.scrollTop -
    NAVIGATION_SEAT;
  return Number.isFinite(threshold) ? threshold : null;
}

export function isSidebarNavigationHidden(
  scrollTop: number,
  threshold: number | null,
): boolean {
  return (
    Number.isFinite(scrollTop) &&
    scrollTop > 0 &&
    threshold !== null &&
    Number.isFinite(threshold) &&
    scrollTop >= threshold
  );
}

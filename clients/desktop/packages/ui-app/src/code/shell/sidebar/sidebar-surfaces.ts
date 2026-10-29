/**
 * Rail surfaces addressed from more than one module.
 *
 * These were duplicated string literals across the layout cache, the at-rest
 * sync, the Projects stand-in's click handler, and the Chats header's reveal
 * — places a rename would have broken one at a time, silently, since only the
 * E2E suite reads them. They live in their own leaf so both `AppSidebar` and
 * the smaller sidebar helpers can import them without a cycle.
 */

/** The sidebar root. Scopes lookups to one instance rather than the document. */
export const SIDEBAR_ROOT_SELECTOR = '[data-testid="app-sidebar"]';

/**
 * The scrolling viewport inside the rail.
 *
 * Two forms because two hosts own it. The desktop rail's viewport is its own
 * element and carries the test id; a surface that scrolls itself marks its
 * container instead. Matching only the test id meant every geometry lookup
 * that walked up from a row silently found nothing on the portal — the Chats
 * header's "back to the rows" click simply collapsed instead.
 */
export const SIDEBAR_VIEWPORT_TEST_ID = 'sidebar-scroll-container';
export const SIDEBAR_VIEWPORT_ATTR = 'data-sidebar-viewport';
export const SIDEBAR_VIEWPORT_SELECTOR = `[data-testid="${SIDEBAR_VIEWPORT_TEST_ID}"], [${SIDEBAR_VIEWPORT_ATTR}]`;

/** The More row a host rail pins above everything that scrolls beneath it. */
export const SIDEBAR_MORE_LEAD_SELECTOR = '[data-sidebar-more-lead]';

/** The sticky Projects band the rail's geometry is measured against. */
export const STICKY_CONTROLS_SELECTOR =
  '[data-testid="sidebar-more-sticky-container"]';

/**
 * The Projects section header, when the shared surface renders it.
 *
 * The stand-in's visibility is measured against the sticky band that carries
 * the Projects header. On the legacy rail that band IS the sticky controls
 * container, so no mark is needed; when the shared surface supplies the
 * header it sits BELOW that container, and measuring the container would
 * track the More row instead — which never approaches the foot of the rail,
 * so the stand-in would never appear.
 */
export const PROJECTS_HEADER_SELECTOR = '[data-sidebar-projects-header]';

/** The Projects stand-in pinned to the foot of the rail. */
export const PROJECTS_PIN_SELECTOR = '[data-sidebar-projects-pin-bottom]';

/**
 * Trailing padding of a section header seated in a host rail.
 *
 * The host's 8px content gutter covers overlay scrollbars. Classic rails are
 * wider: keep the trailing action's whole hit area clear of the rail while
 * retaining the px-1 inset. Chats and Projects share it, so their "+" stay on
 * one edge whichever scrollbars the host shows.
 */
export const RAIL_SECTION_HEADER_PADDING_RIGHT =
  'max(0.25rem, calc(var(--canopy-scrollbar-rail-size) - 0.5rem))';

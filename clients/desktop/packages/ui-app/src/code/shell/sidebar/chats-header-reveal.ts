/**
 * The Chats header's second job: a way back to its own rows.
 *
 * Chats and Projects share one scroll flow, and an expanded chat list puts
 * the Projects band hundreds of rows down — which is why the rail carries a
 * Projects stand-in at its foot. Taking that stand-in scrolls the view past
 * every chat row, and from there the sticky Chats header is the only Chats
 * surface left on screen. Collapsing on that click hides the rows the user
 * was reaching for, so while the header is stuck over its own occluded list
 * it becomes the inverse of the Projects stand-in: a click returns to the
 * chats instead of collapsing them. With the rows in view it is the ordinary
 * collapse control it has always been.
 */

import { prefersReducedMotion } from '@canopy/ui-shared/lib';
import { SIDEBAR_VIEWPORT_SELECTOR } from './sidebar-surfaces';
import { CHATS_SELECTED_PIN_SELECTOR } from './sticky-selected-item';

/** The sticky Chats header, marked by SidebarChatsSection. */
export const CHATS_HEADER_SELECTOR = '[data-sidebar-chats-header]';
/**
 * The chat rows' fade-mask wrapper. While Chats is collapsed it stays mounted
 * only to hold the selected chat (as a collapsed project keeps its selected
 * row), and is unmounted when nothing in Chats is selected. Collapsed or not,
 * once its rows are behind the header the header is the way back to them:
 * scrolled past the section, a click returns to Chats in both states rather
 * than expanding one and scrolling the other.
 */
export const CHATS_CONTENT_SELECTOR = '[data-sidebar-chats-mask]';
/**
 * A rendered chat row. The wrapper above is rendered whenever the section is
 * expanded, empty or not, so geometry alone cannot tell "every row is behind
 * the header" from "there are no rows". Without this an empty Chats section
 * would announce itself as a way back to nothing, and lose its collapse.
 */
export const CHATS_ROW_ATTR = 'data-sidebar-chat-row';
export const CHATS_ROW_SELECTOR = `[data-testid^="sidebar-work-entry-"], [${CHATS_ROW_ATTR}]`;
/**
 * Published on the header by the rail's scroll sync so the header can show —
 * to the eye through its chevron, and to assistive technology through its
 * label and dropped `aria-expanded` — which of the two meanings a click
 * currently carries. The click path does not read it: it measures for itself,
 * so a stale mark can misdescribe the control but can never make it act
 * wrongly. The at-rest sync clears it for the same reason.
 */
export const CHATS_HEADER_STUCK_ATTR = 'data-sidebar-chats-stuck';

export interface ChatsOcclusionMetrics {
  /** Bottom edge of the chat rows' wrapper. */
  readonly contentBottom: number;
  /** Bottom edge of the sticky header, in the same coordinate space. */
  readonly headerBottom: number;
}

/**
 * Is every chat row behind the header? The header paints over its own rows
 * (it is sticky, they are not), so the list is fully out of sight exactly
 * when its bottom edge has passed the header's.
 *
 * Deliberately "fully": while even one row shows, the user can see what a
 * collapse would hide, and the header keeps its ordinary meaning.
 *
 * Both edges must come from the same coordinate space. Callers pass live
 * client rects so the announced state and the click's own measurement cannot
 * drift apart.
 */
export function isChatsContentOccluded(
  metrics: ChatsOcclusionMetrics,
): boolean {
  return metrics.contentBottom <= metrics.headerBottom + 0.5;
}

/**
 * The live edge the chat rows pass behind: the header's bottom, or the
 * bottom of the selected chat's copy while it is seated under the header
 * (the header's next sibling). The copy occludes the rows as surely as the
 * header does, so a list whose tail is only behind the copy is still gone —
 * and the click must agree with the rail's announcement about that.
 */
export function chatsOcclusionBottom(header: HTMLElement): number {
  const headerBottom = header.getBoundingClientRect().bottom;
  const seat = header.nextElementSibling;
  if (
    !(seat instanceof HTMLElement) ||
    !seat.matches(CHATS_SELECTED_PIN_SELECTOR) ||
    seat.hidden
  ) {
    return headerBottom;
  }
  const copy = seat.firstElementChild;
  return copy instanceof HTMLElement
    ? Math.max(headerBottom, copy.getBoundingClientRect().bottom)
    : headerBottom;
}

/**
 * Does the section actually have rows to go back to? A collapsed section's
 * one kept row, the selected chat, counts: scrolled past, its header behaves
 * exactly as an expanded header does.
 */
export function chatsContentHasRows(content: HTMLElement): boolean {
  return content.querySelector(CHATS_ROW_SELECTOR) !== null;
}

/**
 * Scrolls back to the chat list when the header is stuck over it. Returns
 * whether it did, so the caller knows whether to fall through to the
 * collapse. Measured live from the DOM rather than read off the published
 * attribute: this decides what a click does, so it should not depend on a
 * sync having run.
 */
export function revealOccludedChats(header: HTMLElement): boolean {
  const viewport = header.closest<HTMLElement>(SIDEBAR_VIEWPORT_SELECTOR);
  const content = viewport?.querySelector<HTMLElement>(CHATS_CONTENT_SELECTOR);
  if (!viewport || !content) return false;
  if (
    !isChatsContentOccluded({
      contentBottom: content.getBoundingClientRect().bottom,
      headerBottom: chatsOcclusionBottom(header),
    }) ||
    !chatsContentHasRows(content)
  ) {
    return false;
  }
  // Only the nav rows sit above Chats, so the top of the rail brings the
  // whole list back with them. The Projects stand-in has to compute its
  // target because its band sits mid-flow; this one does not.
  viewport.scrollTo({
    top: 0,
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
  return true;
}

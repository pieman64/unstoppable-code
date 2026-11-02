/**
 * Marks an overlay to draw above the desktop app's in-app browser page.
 *
 * The browser page is a native view stacked over the whole renderer, so no
 * CSS z-index reaches above it. On desktop, an element carrying this
 * attribute is copied, wherever it overlaps a page, into a transparent native
 * layer above the page, which stays live underneath. Hosts without native
 * browser views (web) ignore it, so shared UI can set it unconditionally.
 *
 * Put it on the overlay's outermost positioned element. Values:
 * - `"true"`: copied while it is in the DOM and visible.
 * - `"hover"`: copied only while it is hovered or carries the `hover` or
 *   `active` class (drag handles).
 *
 * The copy ignores the pointer, so mark only overlays nobody clicks into
 * (tooltips, hover cards, handles). Menus, popovers and dialogs instead freeze
 * the page to a snapshot while open, which needs no marker. CSS `:hover` on
 * the copy is replaced by the `data-above-browser-hover` attribute.
 */
export const ABOVE_BROWSER_ATTRIBUTE = 'data-canopy-above-browser';

/** Set on a copy whose original is hovered; a copy itself never is. */
export const ABOVE_BROWSER_HOVER_ATTRIBUTE = 'data-above-browser-hover';

export type AboveBrowserMode = 'true' | 'hover';

export const BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT =
  'canopy:browser-view-bounds-invalidated';

export function dispatchBrowserViewBoundsInvalidated(): void {
  window.dispatchEvent(new Event(BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT));
}

/**
 * Content-adoption contract between panel group hosts and panel content.
 *
 * Panel content renders into a stable host element that group hosts adopt
 * with `appendChild`. Moving a node resets the scroll offsets of everything
 * inside it, and the browser reports the reset as an ordinary scroll event.
 * After every move, the adopting host dispatches
 * {@link PANEL_CONTENT_ADOPTED_EVENT} on the host element so content that
 * owns its scroll position can reapply it before the next paint.
 */
export const PANEL_CONTENT_HOST_ATTRIBUTE = 'data-panel-content-host';

export const PANEL_CONTENT_ADOPTED_EVENT = 'canopy:panel-content-adopted';

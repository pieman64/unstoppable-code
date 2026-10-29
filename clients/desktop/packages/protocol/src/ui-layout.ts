/**
 * Layout constants both hosts must agree on. They live in the protocol
 * package because it is the one dependency the desktop runtime packages and
 * the web app share; a value typed twice drifts the first time one side moves.
 */

/**
 * Opening width of the primary sidebar rail, in CSS pixels. Desktop persists
 * a user-dragged width and falls back to this; web opens `/chat` at this
 * width so the two shells share one rail.
 */
export const DEFAULT_SIDEBAR_WIDTH_PX = 280;

/**
 * Hairline drawn *inside* a bubble's edge on the house line token. In dark
 * mode the bubble sits a couple of ramp steps above a near-black `bg-base`,
 * and the UI-Kit `shadow-sm` is a black shadow that vanishes there, so this
 * hairline is what actually separates the bubble from the transcript. It is
 * inset on purpose: an outer `ring` composites the 12.8% white over the base
 * and lands within a few levels of the bubble's own surface, while an inset
 * ring composites over the bubble and reads as a crisp lighter edge against
 * both. In light mode it is a barely-there `rgba(0,0,0,.069)` line on white.
 */
const BUBBLE_SURFACE_HAIRLINE =
  'shadow-sm inset-ring-[length:var(--border-hairline)] inset-ring-line-secondary';

/**
 * The neutral surface shared by the sent user bubble and the queued bubble it
 * will become: `bg-quaternary` (same white as `bg-tertiary` in light, one
 * ramp step brighter in dark) under the elevation + hairline pair, with the
 * one inset every variant shares (`px-3 py-1.5`) so sent, watcher-fired, and
 * queued bubbles keep identical top and bottom padding. Consumers add only
 * text roles.
 */
export const BUBBLE_SURFACE_CLASS = `rounded-xl bg-quaternary px-3 py-1.5 ${BUBBLE_SURFACE_HAIRLINE}`;

/**
 * Flat variant of {@link BUBBLE_SURFACE_CLASS}: the muted fill, with no
 * elevation or hairline, for a chat that sits on a raised surface of its own
 * (the App Advisor panel). The inset stays the same.
 */
export const BUBBLE_MUTED_SURFACE_CLASS = 'rounded-xl bg-muted px-3 py-1.5';

/**
 * Info-tinted variant of {@link BUBBLE_SURFACE_CLASS} for Canopy-generated
 * (watcher-fired) messages. Only the tint changes; the hairline stays.
 */
export const BUBBLE_INFO_SURFACE_CLASS = `rounded-xl bg-info-subtle px-3 py-1.5 ${BUBBLE_SURFACE_HAIRLINE}`;

/**
 * Shared chrome for the badges pinned to a chat bubble's corners — the
 * leading voice indicator on a user message and the remaining raw-button
 * badges. The copy/revert/edit/clear actions on user, queued and delivery
 * bubbles are the 28px secondary icon `Button`, which carries the same round
 * quaternary surface, elevation and hairline ring.
 *
 * Kept in one place so the passive indicator and the interactive actions
 * cannot drift apart in shape, surface, or elevation. Size is applied
 * separately: the passive indicator is a compact dot, while the action
 * buttons stay large enough for a comfortable pointer target. The badges
 * overlap a bubble on the same quaternary surface, so they carry the house
 * hairline ring (`ring-[length:var(--border-hairline)] ring-line-secondary`, as on the send button
 * and Open dropdown) to stay legible against it in dark mode.
 */
export const BUBBLE_BADGE_CHROME =
  'flex items-center justify-center rounded-full bg-quaternary fg-secondary shadow-sm ring-[length:var(--border-hairline)] ring-line-secondary';

/** Compact badge for the passive leading indicator (10px glyph). */
export const BUBBLE_INDICATOR_BADGE_CLASS = `${BUBBLE_BADGE_CHROME} h-5 w-5`;

/** Interactive corner action, sized for the standard 14px glyph. */
export const BUBBLE_ACTION_BADGE_CLASS = `${BUBBLE_BADGE_CHROME} h-7 w-7 transition-colors hover:fg-primary`;

/** Glyph size for the passive leading indicator. */
export const BUBBLE_INDICATOR_GLYPH_PX = 10;

/** Glyph size for the interactive corner actions. */
export const BUBBLE_ACTION_GLYPH_PX = 14;

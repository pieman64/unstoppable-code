import { createContext, useContext } from 'react';

/**
 * Chrome variant for sections rendered through the desktop `PanelSection`
 * wrapper.
 *
 * - `'card'` (default): today's collapsible card — border, background,
 *   rounded box, and the expand/collapse affordance. Used by the stacked
 *   ActivityPanel and every other card-style consumer.
 * - `'frameless'`: the full-panel display used when ONE activity section is
 *   opened as its own `activity-card` panel. The section keeps its header
 *   row (icon, title, subtitle, header actions) and content, but drops the
 *   card box and the collapse UX entirely — the panel already frames it.
 * - `'body-only'`: host-supplied content rendered inside shared section
 *   chrome. The desktop wrapper contributes its actions and body, but not a
 *   second title/header/card.
 */
export type ActivitySectionChrome = 'card' | 'frameless' | 'body-only';

/**
 * Defaults to `'card'` so every existing consumer (stacked ActivityPanel,
 * standalone-chat workspace panel sections, MCP card, ...) is unaffected.
 * The `activity-card` panel registry wrapper provides `'frameless'`; since
 * every activity section funnels through the desktop `PanelSection` wrapper,
 * providing the context at the panel boundary re-skins all sections for free.
 */
export const ActivitySectionChromeContext =
  createContext<ActivitySectionChrome>('card');

/** The active section chrome variant (`'card'` outside any provider). */
export function useActivitySectionChrome(): ActivitySectionChrome {
  return useContext(ActivitySectionChromeContext);
}

/**
 * Modest max-height cap for the secondary / hidden group inside a frameless
 * hybrid section (Plans "hidden", Pipeline Runs "hidden"). Sits below the
 * primary fill list so a revealed hidden group can never push the primary
 * list away. Frameless-only; card mode keeps its own `max-h-76`.
 */
// Moved verbatim to @canopy/ui-shared; re-exported for desktop consumers.
export { FRAMELESS_HIDDEN_GROUP_MAX_H } from '@canopy/ui-shared/lib';

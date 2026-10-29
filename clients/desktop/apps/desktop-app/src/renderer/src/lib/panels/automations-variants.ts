/**
 * Renderer labels for the protocol-owned Automations panel variant contract.
 * Re-exporting the contract preserves a single renderer import surface.
 */
import { type AutomationsPanelVariant } from '@canopy/protocol/panels';

export {
  AUTOMATIONS_PANEL_VARIANTS,
  isAutomationsPanelVariant,
  type AutomationsPanelVariant,
} from '@canopy/protocol/panels';

/**
 * Add-menu label and per-instance tab title for each automations variant. The
 * add-menu passes the label through as the added tab's instance title, so the
 * panel tab reads "Automations" / "Automations (Upcoming)" / etc.
 */
export const AUTOMATIONS_PANEL_VARIANT_LABELS: Readonly<
  Record<AutomationsPanelVariant, string>
> = {
  full: 'Automations',
  upcoming: 'Automations (Upcoming)',
  overview: 'Automations (Overview)',
  completed: 'Automations (Completed)',
};

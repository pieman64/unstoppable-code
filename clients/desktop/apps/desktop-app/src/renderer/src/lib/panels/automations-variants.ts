/**
 * Renderer labels for the protocol-owned Automations panel variant contract.
 * Re-exporting the contract preserves a single renderer import surface.
 */
import {
  isAutomationsPanelVariant,
  type AutomationsPanelVariant,
} from '@canopy/protocol/panels';

export {
  AUTOMATIONS_PANEL_VARIANTS,
  isAutomationsPanelVariant,
  type AutomationsPanelVariant,
} from '@canopy/protocol/panels';

/**
 * Add-menu label and per-instance tab title for each variant. The panel shows
 * workflows, so its views are named after the Workflows page's tabs. The
 * add-menu passes the label through as the added tab's instance title, so the
 * panel tab reads "Workflows" / "Workflows (Schedule)" / etc.
 */
export const AUTOMATIONS_PANEL_VARIANT_LABELS: Readonly<
  Record<AutomationsPanelVariant, string>
> = {
  full: 'Workflows',
  upcoming: 'Workflows (Schedule)',
  overview: 'Workflows (Library)',
  completed: 'Workflows (Runs)',
};

/** Labels layouts stored before the panel was renamed to Workflows. */
const FORMER_AUTOMATIONS_PANEL_VARIANT_LABELS: Readonly<
  Record<AutomationsPanelVariant, string>
> = {
  full: 'Automations',
  upcoming: 'Automations (Upcoming)',
  overview: 'Automations (Overview)',
  completed: 'Automations (Completed)',
};

/**
 * The label an `automations` tab shows when its stored title is one of its
 * variant's names, current or former, or is missing. Any other stored title
 * is the tab's own and resolves to `undefined`. A tab without a valid variant
 * is the full panel.
 */
export function automationsPanelTabTitle(
  title: string,
  variant: string | undefined,
): string | undefined {
  const resolved = isAutomationsPanelVariant(variant) ? variant : 'full';
  const label = AUTOMATIONS_PANEL_VARIANT_LABELS[resolved];
  return title === '' ||
    title === 'automations' ||
    title === label ||
    title === FORMER_AUTOMATIONS_PANEL_VARIANT_LABELS[resolved]
    ? label
    : undefined;
}

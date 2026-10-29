/**
 * Renderer labels for the protocol-owned Usage panel variant contract.
 * Re-exporting the contract preserves the existing renderer import surface.
 */
import { type UsagePanelVariant } from '@canopy/protocol/panels';

export {
  USAGE_PANEL_VARIANTS,
  isUsagePanelVariant,
  type UsagePanelVariant,
} from '@canopy/protocol/panels';

/**
 * Add-menu label and per-instance tab title for each usage variant. The
 * add-menu passes the label through as the added tab's instance title, so the
 * panel tab reads "Usage" / "Usage (Codex)" / etc.
 */
export const USAGE_PANEL_VARIANT_LABELS: Readonly<
  Record<UsagePanelVariant, string>
> = {
  all: 'Usage',
  'active-chat': 'Usage (Active Chat)',
  codex: 'Usage (Codex)',
  claude: 'Usage (Claude)',
  cursor: 'Usage (Cursor)',
  copilot: 'Usage (GitHub Copilot)',
};

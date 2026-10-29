import {
  useNavigationStore,
  type NavigationPage,
} from '@/stores/navigationStore';
import { isLegacyWorkflowsPage, isWorkflowsTabId } from './workflows-target';

export {
  consumeLegacyCalendarPreference,
  isLegacyWorkflowsPage,
  isWorkflowsTabId,
  LEGACY_AUTOMATIONS_TRIGGERS,
  LEGACY_AUTOMATIONS_VIEW_MODE_KEY,
  LEGACY_PIPELINES_TRIGGERS,
  resolveWorkflowsTarget,
  type LegacyWorkflowsPage,
  type ResolveWorkflowsTargetOptions,
  type WorkflowsPresetFilters,
  type WorkflowsTarget,
} from './workflows-target';

/**
 * Every page id the Workflows entry answers to (CAN-3981): its three tabs,
 * and the legacy ids that resolve to them. `navigate` never leaves a legacy
 * id active, so the page host only ever renders a tab id.
 */
export function isWorkflowsPage(page: NavigationPage): boolean {
  return isWorkflowsTabId(page) || isLegacyWorkflowsPage(page);
}

/**
 * Tab values from before CAN-3980, still sent by App Advisor (`go_to_page`
 * `tab`) and by the `canopy:automations-open-tab` event.
 */
export type LegacyAutomationsTab = 'scheduled' | 'watchers' | 'shared';

export const AUTOMATIONS_OPEN_TAB_EVENT = 'canopy:automations-open-tab';

export function isLegacyAutomationsTab(
  value: unknown,
): value is LegacyAutomationsTab {
  return value === 'scheduled' || value === 'watchers' || value === 'shared';
}

/**
 * Opens what a legacy Automations tab became: Triggered is the Library
 * filtered to scheduled and one-time triggers, Watchers is Runs filtered to
 * watchers, and the retired Shared tab is Marketplace → Automations filtered
 * to Shared by me.
 */
export function openLegacyAutomationsTab(tab: LegacyAutomationsTab): void {
  const navigation = useNavigationStore.getState();
  if (tab === 'shared') {
    navigation.openPluginsNavigation({
      kind: 'marketplace-browse',
      query: '',
      tab: 'workflow',
      focusSection: 'shared-by-me',
    });
    return;
  }
  // Through `navigate`, which resolves the legacy id and applies its filters.
  navigation.navigate(tab === 'watchers' ? 'watchers' : 'automations');
}

import type { NavigationPage } from '@canopy/desktop-shared/types';
import type { WorkflowsTabId } from '@canopy/ui-shared/lib';
import type {
  WorkflowRunKind,
  WorkflowTriggerKind,
} from '@canopy/ui-app/workflows';

/**
 * Workflows page ids from before CAN-3981. They still arrive from stored
 * links, shortcuts and App Advisor, and resolve to a tab plus the filters
 * that show what the old page showed.
 */
export type LegacyWorkflowsPage = 'automations' | 'pipelines' | 'watchers';

/** Filters a legacy id applies. They replace the tab's filters for the visit. */
export interface WorkflowsPresetFilters {
  /** Library: narrow to rows with any of these triggers. */
  readonly libraryTriggers?: readonly WorkflowTriggerKind[];
  /** Runs: narrow to one kind. */
  readonly runKind?: WorkflowRunKind;
}

export interface WorkflowsTarget {
  readonly tab: WorkflowsTabId;
  readonly presetFilters?: WorkflowsPresetFilters;
}

export interface ResolveWorkflowsTargetOptions {
  /**
   * The user last left the old Automations page on its calendar. The first
   * `automations` visit then opens Schedule instead of the Library.
   */
  readonly legacyCalendarPreference?: boolean;
}

/** Automations were the scheduled and one-time rows. */
export const LEGACY_AUTOMATIONS_TRIGGERS: readonly WorkflowTriggerKind[] = [
  'schedule',
  'once',
];

/** Pipelines were the rows started by hand or by an event. */
export const LEGACY_PIPELINES_TRIGGERS: readonly WorkflowTriggerKind[] = [
  'manual',
  'plan-approved',
  'task-ready',
];

export function isWorkflowsTabId(page: NavigationPage): page is WorkflowsTabId {
  return (
    page === 'workflows' ||
    page === 'workflows-schedule' ||
    page === 'workflows-library'
  );
}

export function isLegacyWorkflowsPage(
  page: NavigationPage,
): page is LegacyWorkflowsPage {
  return page === 'automations' || page === 'pipelines' || page === 'watchers';
}

/**
 * The tab a Workflows page id opens, with the filters a legacy id implies.
 * `null` for a page that is not part of Workflows. Pure, so every legacy
 * route is unit-tested in one place; `navigationStore.navigate` applies it.
 */
export function resolveWorkflowsTarget(
  page: NavigationPage,
  options: ResolveWorkflowsTargetOptions = {},
): WorkflowsTarget | null {
  switch (page) {
    case 'workflows':
    case 'workflows-schedule':
    case 'workflows-library':
      return { tab: page };
    case 'automations':
      if (options.legacyCalendarPreference === true) {
        return { tab: 'workflows-schedule' };
      }
      return {
        tab: 'workflows-library',
        presetFilters: { libraryTriggers: LEGACY_AUTOMATIONS_TRIGGERS },
      };
    case 'pipelines':
      return {
        tab: 'workflows-library',
        presetFilters: { libraryTriggers: LEGACY_PIPELINES_TRIGGERS },
      };
    case 'watchers':
      return { tab: 'workflows', presetFilters: { runKind: 'watcher' } };
    default:
      return null;
  }
}

/** localStorage key of the old Automations page's List/Calendar choice. */
export const LEGACY_AUTOMATIONS_VIEW_MODE_KEY = 'canopy.automations.viewMode';

/** Whether the old List/Calendar choice is the calendar. Leaves it stored. */
export function peekLegacyCalendarPreference(
  storage: Pick<Storage, 'getItem'> | undefined,
): boolean {
  if (storage === undefined) return false;
  try {
    return storage.getItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY) === 'calendar';
  } catch {
    return false;
  }
}

/**
 * Reads the old List/Calendar choice once and removes it. `true` only when
 * it was the calendar; any other value is removed without effect.
 */
export function consumeLegacyCalendarPreference(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | undefined,
): boolean {
  if (storage === undefined) return false;
  try {
    const value = storage.getItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY);
    if (value === null) return false;
    storage.removeItem(LEGACY_AUTOMATIONS_VIEW_MODE_KEY);
    return value === 'calendar';
  } catch {
    return false;
  }
}

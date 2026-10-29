import { NAVIGATION_PAGE_MAP } from '@canopy/desktop-shared/types';
import {
  consumeLegacyCalendarPreference,
  isLegacyWorkflowsPage,
  isWorkflowsTabId,
  LEGACY_AUTOMATIONS_VIEW_MODE_KEY,
  resolveWorkflowsTarget,
} from '../workflows-target';

function memoryStorage(
  initial: Record<string, string> = {},
): Pick<Storage, 'getItem' | 'removeItem'> & { values: Map<string, string> } {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key): string | null => values.get(key) ?? null,
    removeItem: (key): void => {
      values.delete(key);
    },
  };
}

describe('resolveWorkflowsTarget', () => {
  it('opens each tab id as itself, with no preset', () => {
    expect(resolveWorkflowsTarget('workflows')).toEqual({ tab: 'workflows' });
    expect(resolveWorkflowsTarget('workflows-schedule')).toEqual({
      tab: 'workflows-schedule',
    });
    expect(resolveWorkflowsTarget('workflows-library')).toEqual({
      tab: 'workflows-library',
    });
  });

  it('opens the Library on scheduled and one-time triggers for automations', () => {
    expect(resolveWorkflowsTarget('automations')).toEqual({
      tab: 'workflows-library',
      presetFilters: { libraryTriggers: ['schedule', 'once'] },
    });
  });

  it('opens Schedule for automations when the calendar was the saved view', () => {
    expect(
      resolveWorkflowsTarget('automations', { legacyCalendarPreference: true }),
    ).toEqual({ tab: 'workflows-schedule' });
  });

  it('ignores the calendar preference for every other page', () => {
    expect(
      resolveWorkflowsTarget('pipelines', { legacyCalendarPreference: true }),
    ).toEqual({
      tab: 'workflows-library',
      presetFilters: {
        libraryTriggers: ['manual', 'plan-approved', 'task-ready'],
      },
    });
    expect(
      resolveWorkflowsTarget('watchers', { legacyCalendarPreference: true }),
    ).toEqual({ tab: 'workflows', presetFilters: { runKind: 'watcher' } });
  });

  it('returns null for every page outside Workflows', () => {
    for (const page of Object.values(NAVIGATION_PAGE_MAP)) {
      const inWorkflows = isWorkflowsTabId(page) || isLegacyWorkflowsPage(page);
      expect(resolveWorkflowsTarget(page) === null).toBe(!inWorkflows);
    }
  });

  it('always resolves to a tab id, never to a legacy id', () => {
    for (const page of ['automations', 'pipelines', 'watchers'] as const) {
      const target = resolveWorkflowsTarget(page);
      expect(target !== null && isWorkflowsTabId(target.tab)).toBe(true);
    }
  });
});

describe('consumeLegacyCalendarPreference', () => {
  it('is true once for the calendar, then the key is gone', () => {
    const storage = memoryStorage({
      [LEGACY_AUTOMATIONS_VIEW_MODE_KEY]: 'calendar',
    });
    expect(consumeLegacyCalendarPreference(storage)).toBe(true);
    expect(storage.values.has(LEGACY_AUTOMATIONS_VIEW_MODE_KEY)).toBe(false);
    expect(consumeLegacyCalendarPreference(storage)).toBe(false);
  });

  it('removes any other value without effect', () => {
    const storage = memoryStorage({
      [LEGACY_AUTOMATIONS_VIEW_MODE_KEY]: 'list',
    });
    expect(consumeLegacyCalendarPreference(storage)).toBe(false);
    expect(storage.values.has(LEGACY_AUTOMATIONS_VIEW_MODE_KEY)).toBe(false);
  });

  it('is false with no storage, and when storage throws', () => {
    expect(consumeLegacyCalendarPreference(undefined)).toBe(false);
    expect(
      consumeLegacyCalendarPreference({
        getItem: (): string | null => {
          throw new Error('denied');
        },
        removeItem: (): void => undefined,
      }),
    ).toBe(false);
  });
});

import type { CanopyApi, PreferencesData } from '@canopy/desktop-shared/types';
import {
  createDefaultSidebarNavLayout,
  reconcileSidebarNavLayout,
} from '@canopy/desktop-shared/lib/sidebar-nav-layout';
import { makeTestPreferences } from '../../test-utils/preferences';
import type * as SidebarStoreModule from '../sidebarStore';

const savePreferencesMock = jest.fn<Promise<PreferencesData>, [unknown]>();

declare global {
  interface Window {
    api: CanopyApi;
  }
}

function loadSidebarStore(): typeof SidebarStoreModule {
  jest.resetModules();
  Object.defineProperty(global, 'window', {
    configurable: true,
    value: {
      api: {
        savePreferences: savePreferencesMock,
      },
    },
  });

  return jest.requireActual<typeof SidebarStoreModule>('../sidebarStore');
}

beforeEach(() => {
  jest.useFakeTimers();
  savePreferencesMock.mockReset().mockResolvedValue(makeTestPreferences());
});

afterEach(() => {
  jest.runOnlyPendingTimers();
  jest.useRealTimers();
});

describe('sidebarStore', () => {
  describe('constants', () => {
    it('exports the documented width bounds', () => {
      const { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, SIDEBAR_DEFAULT_WIDTH } =
        loadSidebarStore();
      expect(SIDEBAR_MIN_WIDTH).toBe(220);
      expect(SIDEBAR_MAX_WIDTH).toBe(480);
      // The default is deliberately clear of the minimum: it used to alias it,
      // so every new install opened at the narrowest supported width.
      expect(SIDEBAR_DEFAULT_WIDTH).toBe(280);
      expect(SIDEBAR_DEFAULT_WIDTH).toBeGreaterThan(SIDEBAR_MIN_WIDTH);
    });
  });

  describe('default state', () => {
    it('starts hidden=false, persistedHidden=false, width=280, hydrated=false, sections expanded', () => {
      const { useSidebarStore } = loadSidebarStore();
      const state = useSidebarStore.getState();
      expect(state.hidden).toBe(false);
      expect(state.persistedHidden).toBe(false);
      expect(state.width).toBe(280);
      expect(state.hydrated).toBe(false);
      expect(state.codeSectionCollapsed).toBe(false);
      expect(state.chatsSectionCollapsed).toBe(false);
      expect(state.projectSortMode).toBe('manual');
    });

    it('defaults sidebarNavLayout to the default layout', () => {
      const { useSidebarStore } = loadSidebarStore();
      expect(useSidebarStore.getState().sidebarNavLayout).toEqual(
        createDefaultSidebarNavLayout(),
      );
    });
  });

  describe('hydrateFromPreferences', () => {
    it('applies preference values and marks hydrated', () => {
      const { useSidebarStore } = loadSidebarStore();
      const prefs = makeTestPreferences({
        sidebarCollapsed: true,
        sidebarWidth: 320,
        sidebarCodeSectionCollapsed: true,
        sidebarCoworkSectionCollapsed: true,
        sidebarProjectSortMode: 'last-updated',
      });

      useSidebarStore.getState().hydrateFromPreferences(prefs);

      const state = useSidebarStore.getState();
      expect(state.hidden).toBe(true);
      expect(state.width).toBe(320);
      expect(state.codeSectionCollapsed).toBe(true);
      expect(state.chatsSectionCollapsed).toBe(true);
      expect(state.projectSortMode).toBe('last-updated');
      expect(state.hydrated).toBe(true);
    });

    it('sets both hidden and persistedHidden to the preference value', () => {
      const { useSidebarStore } = loadSidebarStore();
      const prefs = makeTestPreferences({ sidebarCollapsed: true });

      useSidebarStore.getState().hydrateFromPreferences(prefs);

      const state = useSidebarStore.getState();
      expect(state.hidden).toBe(true);
      expect(state.persistedHidden).toBe(true);
    });

    it('clamps a below-minimum stored width up to 220', () => {
      const { useSidebarStore } = loadSidebarStore();
      const prefs = makeTestPreferences({ sidebarWidth: 50 });

      useSidebarStore.getState().hydrateFromPreferences(prefs);

      expect(useSidebarStore.getState().width).toBe(220);
    });

    it('clamps an above-maximum stored width down to 480', () => {
      const { useSidebarStore } = loadSidebarStore();
      const prefs = makeTestPreferences({ sidebarWidth: 999 });

      useSidebarStore.getState().hydrateFromPreferences(prefs);

      expect(useSidebarStore.getState().width).toBe(480);
    });

    it('preserves an existing valid stored width of 280', () => {
      const { useSidebarStore } = loadSidebarStore();
      const prefs = makeTestPreferences({ sidebarWidth: 280 });

      useSidebarStore.getState().hydrateFromPreferences(prefs);

      expect(useSidebarStore.getState().width).toBe(280);
    });

    it('does not persist to savePreferences (read-only hydration)', () => {
      const { useSidebarStore } = loadSidebarStore();
      const prefs = makeTestPreferences({ sidebarWidth: 320 });

      useSidebarStore.getState().hydrateFromPreferences(prefs);

      expect(savePreferencesMock).not.toHaveBeenCalled();
    });

    it('applies a valid persisted sidebarNavLayout as-is', () => {
      const { useSidebarStore } = loadSidebarStore();
      const stored = { order: ['overview', 'kanban'], moreStartIndex: 1 };
      const prefs = makeTestPreferences({ sidebarNavLayout: stored });

      useSidebarStore.getState().hydrateFromPreferences(prefs);

      expect(useSidebarStore.getState().sidebarNavLayout).toEqual(
        reconcileSidebarNavLayout(stored),
      );
    });

    it('reconciles a partial/garbage persisted sidebarNavLayout rather than trusting it verbatim', () => {
      const { useSidebarStore } = loadSidebarStore();
      const stored = {
        order: ['overview', 'not-a-real-key'],
        moreStartIndex: 999,
      };
      const prefs = makeTestPreferences({ sidebarNavLayout: stored });

      useSidebarStore.getState().hydrateFromPreferences(prefs);

      const reconciled = useSidebarStore.getState().sidebarNavLayout;
      expect(reconciled).toEqual(reconcileSidebarNavLayout(stored));
      expect(reconciled.order).not.toContain('not-a-real-key');
      expect(reconciled.moreStartIndex).toBeLessThanOrEqual(
        reconciled.order.length,
      );
    });
  });

  describe('syncFromPreferences', () => {
    it('preserves a transient hidden override instead of clobbering it', () => {
      const { useSidebarStore } = loadSidebarStore();
      // Persisted intent is visible while a transient override hides it.
      useSidebarStore
        .getState()
        .hydrateFromPreferences(
          makeTestPreferences({ sidebarCollapsed: false }),
        );
      useSidebarStore.getState().setHiddenTransient(true);
      expect(useSidebarStore.getState().hidden).toBe(true);
      expect(useSidebarStore.getState().persistedHidden).toBe(false);

      // An unrelated Settings broadcast carries the persisted (visible) value.
      useSidebarStore
        .getState()
        .syncFromPreferences(makeTestPreferences({ sidebarCollapsed: false }));

      const state = useSidebarStore.getState();
      expect(state.hidden).toBe(true); // transient override preserved
      expect(state.persistedHidden).toBe(false);
    });

    it('follows the broadcast hidden value when no transient override is active', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore
        .getState()
        .hydrateFromPreferences(
          makeTestPreferences({ sidebarCollapsed: false }),
        );

      useSidebarStore
        .getState()
        .syncFromPreferences(makeTestPreferences({ sidebarCollapsed: true }));

      const state = useSidebarStore.getState();
      expect(state.hidden).toBe(true);
      expect(state.persistedHidden).toBe(true);
    });

    it('applies width, section-collapsed, and nav-layout fields from the broadcast', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHiddenTransient(true);

      const stored = { order: ['overview', 'kanban'], moreStartIndex: 1 };
      useSidebarStore.getState().syncFromPreferences(
        makeTestPreferences({
          sidebarWidth: 320,
          sidebarCodeSectionCollapsed: true,
          sidebarCoworkSectionCollapsed: true,
          sidebarNavLayout: stored,
          sidebarProjectSortMode: 'last-updated',
        }),
      );

      const state = useSidebarStore.getState();
      expect(state.width).toBe(320);
      expect(state.codeSectionCollapsed).toBe(true);
      expect(state.chatsSectionCollapsed).toBe(true);
      expect(state.sidebarNavLayout).toEqual(reconcileSidebarNavLayout(stored));
      expect(state.projectSortMode).toBe('last-updated');
    });
  });

  describe('setHidden', () => {
    it('updates state immediately', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHidden(true);
      expect(useSidebarStore.getState().hidden).toBe(true);
    });

    it('persists { sidebarCollapsed: true } fire-and-forget', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHidden(true);
      expect(savePreferencesMock).toHaveBeenCalledWith({
        sidebarCollapsed: true,
      });
    });

    it('persists { sidebarCollapsed: false }', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHidden(false);
      expect(savePreferencesMock).toHaveBeenCalledWith({
        sidebarCollapsed: false,
      });
    });

    it('does not throw when savePreferences rejects', () => {
      savePreferencesMock.mockReset().mockRejectedValue(new Error('disk'));
      const { useSidebarStore } = loadSidebarStore();
      expect(() => useSidebarStore.getState().setHidden(true)).not.toThrow();
    });

    it('updates persistedHidden to the same value', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHidden(true);
      expect(useSidebarStore.getState().persistedHidden).toBe(true);
      useSidebarStore.getState().setHidden(false);
      expect(useSidebarStore.getState().persistedHidden).toBe(false);
    });
  });

  describe('toggleHidden', () => {
    it('flips hidden from false to true', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().toggleHidden();
      expect(useSidebarStore.getState().hidden).toBe(true);
    });

    it('flips hidden from true back to false', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().toggleHidden();
      useSidebarStore.getState().toggleHidden();
      expect(useSidebarStore.getState().hidden).toBe(false);
    });

    it('persists the resulting value', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().toggleHidden();
      expect(savePreferencesMock).toHaveBeenCalledWith({
        sidebarCollapsed: true,
      });
    });
  });

  describe('setHiddenTransient', () => {
    it('flips hidden without persisting', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHiddenTransient(true);
      expect(useSidebarStore.getState().hidden).toBe(true);
      expect(savePreferencesMock).not.toHaveBeenCalled();
    });

    it('does not touch persistedHidden', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.setState({ persistedHidden: false });
      useSidebarStore.getState().setHiddenTransient(true);
      expect(useSidebarStore.getState().persistedHidden).toBe(false);
    });
  });

  describe('setPreviewing', () => {
    it('opens the preview only while hidden and never persists', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setPreviewing(true);
      expect(useSidebarStore.getState().previewing).toBe(false);

      useSidebarStore.getState().setHidden(true);
      savePreferencesMock.mockClear();
      useSidebarStore.getState().setPreviewing(true);
      expect(useSidebarStore.getState().previewing).toBe(true);
      expect(savePreferencesMock).not.toHaveBeenCalled();
    });

    it('closes regardless of hidden state', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHidden(true);
      useSidebarStore.getState().setPreviewing(true);
      useSidebarStore.getState().setPreviewing(false);
      expect(useSidebarStore.getState().previewing).toBe(false);
    });

    it('is cleared when the sidebar is pinned open via setHidden', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHidden(true);
      useSidebarStore.getState().setPreviewing(true);

      useSidebarStore.getState().setHidden(false);

      expect(useSidebarStore.getState().previewing).toBe(false);
      expect(useSidebarStore.getState().hidden).toBe(false);
    });

    it('is cleared when a preferences broadcast shows the sidebar', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore
        .getState()
        .hydrateFromPreferences(
          makeTestPreferences({ sidebarCollapsed: true }),
        );
      useSidebarStore.getState().setPreviewing(true);

      useSidebarStore
        .getState()
        .syncFromPreferences(makeTestPreferences({ sidebarCollapsed: false }));

      expect(useSidebarStore.getState().previewing).toBe(false);
      expect(useSidebarStore.getState().hidden).toBe(false);
    });

    it('survives a preferences broadcast that keeps the sidebar hidden', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore
        .getState()
        .hydrateFromPreferences(
          makeTestPreferences({ sidebarCollapsed: true }),
        );
      useSidebarStore.getState().setPreviewing(true);

      useSidebarStore
        .getState()
        .syncFromPreferences(makeTestPreferences({ sidebarCollapsed: true }));

      expect(useSidebarStore.getState().previewing).toBe(true);
      expect(useSidebarStore.getState().hidden).toBe(true);
    });

    it('is reset by hydrateFromPreferences', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHidden(true);
      useSidebarStore.getState().setPreviewing(true);

      useSidebarStore
        .getState()
        .hydrateFromPreferences(
          makeTestPreferences({ sidebarCollapsed: true }),
        );

      expect(useSidebarStore.getState().previewing).toBe(false);
    });

    it('is cleared when a transient override shows the sidebar', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHidden(true);
      useSidebarStore.getState().setPreviewing(true);

      useSidebarStore.getState().setHiddenTransient(false);

      expect(useSidebarStore.getState().previewing).toBe(false);
    });
  });

  describe('restorePersistedHidden', () => {
    it('sets hidden back to persistedHidden=true after a transient override', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHidden(true);
      useSidebarStore.getState().setHiddenTransient(false);
      expect(useSidebarStore.getState().hidden).toBe(false);

      useSidebarStore.getState().restorePersistedHidden();

      expect(useSidebarStore.getState().hidden).toBe(true);
      expect(savePreferencesMock).not.toHaveBeenCalledWith({
        sidebarCollapsed: false,
      });
    });

    it('sets hidden back to persistedHidden=false after a transient override', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHidden(false);
      useSidebarStore.getState().setHiddenTransient(true);
      expect(useSidebarStore.getState().hidden).toBe(true);

      useSidebarStore.getState().restorePersistedHidden();

      expect(useSidebarStore.getState().hidden).toBe(false);
    });

    it('does not persist', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setHiddenTransient(true);
      savePreferencesMock.mockClear();

      useSidebarStore.getState().restorePersistedHidden();

      expect(savePreferencesMock).not.toHaveBeenCalled();
    });
  });

  describe('setWidth', () => {
    it('updates state immediately (before the debounce timer fires)', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setWidth(350);
      expect(useSidebarStore.getState().width).toBe(350);
    });

    it('clamps below-minimum widths to 220', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setWidth(10);
      expect(useSidebarStore.getState().width).toBe(220);
    });

    it('clamps above-maximum widths to 480', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setWidth(1000);
      expect(useSidebarStore.getState().width).toBe(480);
    });

    it('debounces persistence to a single savePreferences call after ~300ms', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setWidth(300);
      useSidebarStore.getState().setWidth(310);
      useSidebarStore.getState().setWidth(320);

      expect(savePreferencesMock).not.toHaveBeenCalled();

      jest.advanceTimersByTime(300);

      expect(savePreferencesMock).toHaveBeenCalledTimes(1);
      expect(savePreferencesMock).toHaveBeenCalledWith({ sidebarWidth: 320 });
    });

    it('does not persist before the debounce interval elapses', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setWidth(300);
      jest.advanceTimersByTime(299);
      expect(savePreferencesMock).not.toHaveBeenCalled();
    });
  });

  describe('setCodeSectionCollapsed', () => {
    it('updates state immediately', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setCodeSectionCollapsed(true);
      expect(useSidebarStore.getState().codeSectionCollapsed).toBe(true);
    });

    it('persists fire-and-forget without debounce', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setCodeSectionCollapsed(true);
      expect(savePreferencesMock).toHaveBeenCalledWith({
        sidebarCodeSectionCollapsed: true,
      });
    });
  });

  describe('setChatsSectionCollapsed', () => {
    it('updates state immediately', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setChatsSectionCollapsed(true);
      expect(useSidebarStore.getState().chatsSectionCollapsed).toBe(true);
    });

    it('persists under the reused sidebarCoworkSectionCollapsed key without debounce', () => {
      const { useSidebarStore } = loadSidebarStore();
      useSidebarStore.getState().setChatsSectionCollapsed(true);
      expect(savePreferencesMock).toHaveBeenCalledWith({
        sidebarCoworkSectionCollapsed: true,
      });
    });
  });

  describe('setSidebarNavLayout', () => {
    it('updates state immediately', () => {
      const { useSidebarStore } = loadSidebarStore();
      const next = { order: ['overview', 'kanban'], moreStartIndex: 1 };

      useSidebarStore.getState().setSidebarNavLayout(next);

      expect(useSidebarStore.getState().sidebarNavLayout).toEqual(next);
    });

    it('persists { sidebarNavLayout } fire-and-forget without debounce', () => {
      const { useSidebarStore } = loadSidebarStore();
      const next = { order: ['overview', 'kanban'], moreStartIndex: 1 };

      useSidebarStore.getState().setSidebarNavLayout(next);

      expect(savePreferencesMock).toHaveBeenCalledWith({
        sidebarNavLayout: next,
      });
    });

    it('does not throw when savePreferences rejects', () => {
      savePreferencesMock.mockReset().mockRejectedValue(new Error('disk'));
      const { useSidebarStore } = loadSidebarStore();
      const next = { order: ['overview', 'kanban'], moreStartIndex: 1 };

      expect(() =>
        useSidebarStore.getState().setSidebarNavLayout(next),
      ).not.toThrow();
    });
  });

  describe('setProjectSortMode', () => {
    it('updates state and persists the preference', async () => {
      const { useSidebarStore } = loadSidebarStore();

      await useSidebarStore.getState().setProjectSortMode('last-updated');

      expect(useSidebarStore.getState().projectSortMode).toBe('last-updated');
      expect(savePreferencesMock).toHaveBeenCalledWith({
        sidebarProjectSortMode: 'last-updated',
      });
    });

    it('rolls back and rejects when persistence fails', async () => {
      savePreferencesMock.mockRejectedValueOnce(new Error('disk'));
      const { useSidebarStore } = loadSidebarStore();

      await expect(
        useSidebarStore.getState().setProjectSortMode('last-updated'),
      ).rejects.toThrow('disk');

      expect(useSidebarStore.getState().projectSortMode).toBe('manual');
    });
  });
});

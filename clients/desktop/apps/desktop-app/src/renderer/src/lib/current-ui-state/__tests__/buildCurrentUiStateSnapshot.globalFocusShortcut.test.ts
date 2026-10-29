/**
 * @jest-environment jsdom
 */
import { useNavigationStore } from '@/stores/navigationStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

beforeEach(() => {
  useNavigationStore.setState({
    activePage: 'main',
    settingsOpen: true,
    settingsInitialSection: 'shortcuts',
    commandPaletteOpen: false,
    fileSearchPaletteOpen: false,
    prPickerOpen: false,
    canopyPortalOpen: false,
    appAdvisorOpen: false,
  });
});

describe('buildCurrentUiStateSnapshot settings.globalFocusShortcut slice', () => {
  it('surfaces the OS focus shortcut section state so the App Advisor can see it', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.globalFocusShortcut': {
        loaded: true,
        enabled: true,
        shortcut: '⌘⇧O',
        registered: false,
        recording: true,
      },
    });

    expect(snapshot.settings?.globalFocusShortcut).toEqual({
      loaded: true,
      enabled: true,
      shortcut: '⌘⇧O',
      registered: false,
      recording: true,
    });
    expect(snapshot.settings?.section).toBe('shortcuts');
  });

  it('omits the slice when no section reporter is mounted', () => {
    const snapshot = buildCurrentUiStateSnapshot({});
    expect(snapshot.settings?.globalFocusShortcut).toBeUndefined();
  });
});

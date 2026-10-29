/**
 * @jest-environment jsdom
 */
import { useNavigationStore } from '@/stores/navigationStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

beforeEach(() => {
  useNavigationStore.setState({
    activePage: 'main',
    settingsOpen: true,
    settingsInitialSection: 'canopy',
    commandPaletteOpen: false,
    fileSearchPaletteOpen: false,
    prPickerOpen: false,
    canopyPortalOpen: false,
    appAdvisorOpen: false,
  });
});

describe('buildCurrentUiStateSnapshot settings.launchAtLogin slice', () => {
  it('surfaces the OS read-back so the App Advisor can see it', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.launchAtLogin': {
        loaded: true,
        supported: true,
        unsupportedReason: null,
        enabled: false,
        pendingApproval: true,
        busy: false,
        error: 'refused',
      },
    });

    expect(snapshot.settings?.launchAtLogin).toEqual({
      loaded: true,
      supported: true,
      unsupportedReason: null,
      enabled: false,
      pendingApproval: true,
      busy: false,
      error: 'refused',
    });
    expect(snapshot.settings?.section).toBe('canopy');
  });

  it('drops values outside the contract', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'settings.launchAtLogin': {
        loaded: 'yes',
        supported: false,
        unsupportedReason: '/Applications/Canopy.app',
        enabled: 1,
        error: 'EACCES',
      },
    });

    expect(snapshot.settings?.launchAtLogin).toEqual({
      loaded: false,
      supported: false,
      unsupportedReason: null,
      enabled: false,
      pendingApproval: false,
      busy: false,
      error: null,
    });
  });

  it('omits the slice when no section reporter is mounted', () => {
    const snapshot = buildCurrentUiStateSnapshot({});
    expect(snapshot.settings?.launchAtLogin).toBeUndefined();
  });
});

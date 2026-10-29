/**
 * @jest-environment jsdom
 */
import { useNavigationStore } from '@/stores/navigationStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  useNavigationStore.setState({
    activePage: 'main',
    settingsOpen: false,
    commandPaletteOpen: false,
    fileSearchPaletteOpen: false,
    prPickerOpen: false,
    canopyPortalOpen: false,
    appAdvisorOpen: false,
  });
});

describe('buildCurrentUiStateSnapshot privacyOptIn slice (CAN-3383)', () => {
  it('reports the open review by feature, organization, and state', () => {
    expect(
      buildCurrentUiStateSnapshot({
        privacyOptIn: {
          open: true,
          feature: 'leaderboards',
          organizationId: ORG,
          state: 'needs-opt-in',
          queued: 1,
          organizationName: 'not forwarded',
        },
      }).privacyOptIn,
    ).toEqual({
      open: true,
      feature: 'leaderboards',
      organizationId: ORG,
      state: 'needs-opt-in',
      queued: 1,
    });
  });

  it('drops a malformed slice', () => {
    expect(
      buildCurrentUiStateSnapshot({
        privacyOptIn: {
          feature: 'everything',
          organizationId: ORG,
          state: 'needs-opt-in',
        },
      }).privacyOptIn,
    ).toBeUndefined();
    expect(buildCurrentUiStateSnapshot({}).privacyOptIn).toBeUndefined();
  });
});

/**
 * @jest-environment jsdom
 */
import { useNavigationStore } from '@/stores/navigationStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

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

describe('buildCurrentUiStateSnapshot releaseHighlights.dialog slice', () => {
  it('reports the open release-highlights dialog with its source and release', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'releaseHighlights.dialog': {
        open: true,
        source: 'automatic',
        version: '1.9.0',
      },
    });
    expect(snapshot.releaseHighlights).toEqual({
      dialog: { open: true, source: 'automatic', version: '1.9.0' },
    });
  });

  it('accepts the manual source and never carries highlight copy', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'releaseHighlights.dialog': {
        open: true,
        source: 'manual',
        version: '1.9.0',
        headline: 'must never leak',
        highlights: [{ title: 'secret' }],
      },
    });
    expect(snapshot.releaseHighlights).toEqual({
      dialog: { open: true, source: 'manual', version: '1.9.0' },
    });
    expect(JSON.stringify(snapshot.releaseHighlights)).not.toContain('secret');
  });

  it('drops a slice with an unknown source or no version', () => {
    expect(
      buildCurrentUiStateSnapshot({
        'releaseHighlights.dialog': {
          open: true,
          source: 'other',
          version: '1.9.0',
        },
      }).releaseHighlights,
    ).toBeUndefined();
    expect(
      buildCurrentUiStateSnapshot({
        'releaseHighlights.dialog': { open: true, source: 'manual' },
      }).releaseHighlights,
    ).toBeUndefined();
  });

  it('omits the slice while the dialog is not reported', () => {
    expect(buildCurrentUiStateSnapshot({}).releaseHighlights).toBeUndefined();
  });
});

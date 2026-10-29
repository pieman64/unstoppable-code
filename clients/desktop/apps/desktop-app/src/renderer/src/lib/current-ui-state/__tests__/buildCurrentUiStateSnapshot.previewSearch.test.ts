/** @jest-environment jsdom */
import { useNavigationStore } from '@/stores/navigationStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

beforeEach(() => {
  useNavigationStore.setState({ activePage: 'main' });
});

describe('buildCurrentUiStateSnapshot files.previewSearch slice', () => {
  it('reports bounded active preview-search drawer metadata', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'files.activeTab': {
        tabId: 'file-1',
        path: '/repo/report.html',
        mode: 'preview',
      },
      'files.previewSearch.file-1': {
        enabled: true,
        open: true,
        queryPresent: true,
        currentIndex: 1,
        totalCount: 3,
      },
    });

    expect(snapshot.activeFile?.previewSearch).toEqual({
      open: true,
      queryPresent: true,
      currentIndex: 1,
      totalCount: 3,
    });
  });

  it('omits preview-search metadata when the active view is not searchable', () => {
    const snapshot = buildCurrentUiStateSnapshot({
      'files.activeTab': {
        tabId: 'file-1',
        path: '/repo/report.html',
        mode: 'raw',
      },
      'files.previewSearch.file-1': {
        enabled: false,
        open: false,
        queryPresent: false,
        currentIndex: 0,
        totalCount: 0,
      },
    });

    expect(snapshot.activeFile?.previewSearch).toBeUndefined();
  });
});

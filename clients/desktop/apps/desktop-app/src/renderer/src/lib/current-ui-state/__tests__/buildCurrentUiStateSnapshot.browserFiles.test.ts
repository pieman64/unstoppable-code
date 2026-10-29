/**
 * @jest-environment jsdom
 */
import type {
  BrowserDownloadTransfer,
  BrowserSessionSnapshot,
} from '@canopy/desktop-shared/types';
import { useBrowserStore } from '@/stores/browserStore';
import { useChatStore } from '@/stores/chatStore';
import { buildCurrentUiStateSnapshot } from '../buildCurrentUiStateSnapshot';

const TARGET = { projectId: 'project-1', worktreeId: 'worktree-1' };
const BROWSER_ID = 'browser-1';

function session(): BrowserSessionSnapshot {
  return {
    id: BROWSER_ID,
    ...TARGET,
    createdAt: 1,
    updatedAt: 2,
    url: 'http://localhost:3000/',
    title: 'Local',
    status: 'ready',
    canGoBack: false,
    canGoForward: false,
    loading: false,
    themeMode: 'light',
    pickMode: false,
    recording: false,
  };
}

function download(
  id: string,
  overrides: Partial<BrowserDownloadTransfer> = {},
): BrowserDownloadTransfer {
  return {
    kind: 'download',
    id,
    browserId: BROWSER_ID,
    source: 'agent',
    origin: 'http://localhost:3000/report.csv',
    fileName: `${id}.csv`,
    receivedBytes: 1,
    totalBytes: 2,
    status: 'in_progress',
    startedAt: 1,
    ...overrides,
  };
}

beforeEach(() => {
  useChatStore.setState({ selectedWorktree: TARGET, worktreeChats: {} });
  useBrowserStore.setState({
    worktrees: {
      [`${TARGET.projectId}/${TARGET.worktreeId}`]: {
        browserOrder: [BROWSER_ID],
        activeBrowserId: BROWSER_ID,
        browsers: { [BROWSER_ID]: session() },
        live: new Set([BROWSER_ID]),
        hydrated: true,
      },
    },
    consoleEntries: {},
    networkEntries: {},
    dialogs: {},
    inspectorOpen: {},
    inspectorTab: {},
    transfers: {},
  });
});

describe('buildCurrentUiStateSnapshot browser files', () => {
  it('reports the Files tab while the inspector shows it', () => {
    useBrowserStore.getState().openFilesPanel(BROWSER_ID);

    expect(buildCurrentUiStateSnapshot({}).browser).toMatchObject({
      activeBrowserId: BROWSER_ID,
      inspectorTab: 'files',
    });
  });

  it('reports no inspector tab while the inspector is closed', () => {
    useBrowserStore.setState({
      inspectorOpen: { [BROWSER_ID]: false },
      inspectorTab: { [BROWSER_ID]: 'files' },
    });

    expect(buildCurrentUiStateSnapshot({}).browser).not.toHaveProperty(
      'inspectorTab',
    );
  });

  it('counts the active browser downloads still in flight', () => {
    useBrowserStore.setState({
      transfers: {
        [BROWSER_ID]: [
          download('running'),
          download('resumable', { status: 'interrupted', canResume: true }),
          download('done', { status: 'complete' }),
          download('stopped', { status: 'interrupted', canResume: false }),
        ],
        'other-browser': [download('elsewhere')],
      },
    });

    expect(buildCurrentUiStateSnapshot({}).browser).toMatchObject({
      activeTransferCount: 2,
    });
  });
});

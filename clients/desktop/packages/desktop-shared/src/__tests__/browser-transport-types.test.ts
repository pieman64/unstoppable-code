import type {
  BrowserApi,
  BrowserSessionSnapshot,
  PersistedWorktreeBrowserStateFile,
  WorktreeBrowserLayoutState,
} from '../types';

const snapshot: BrowserSessionSnapshot = {
  id: 'browser-1',
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  createdAt: 1,
  updatedAt: 1,
  url: 'about:blank',
  title: '',
  status: 'idle',
  canGoBack: false,
  canGoForward: false,
  loading: false,
  themeMode: 'light',
  pickMode: false,
  recording: false,
};

const layout: WorktreeBrowserLayoutState = {
  browserOrder: [snapshot.id],
  activeBrowserId: snapshot.id,
};

const persisted: PersistedWorktreeBrowserStateFile = {
  version: 1,
  ...layout,
  browsers: [snapshot],
};

type SetActiveRequest = Parameters<BrowserApi['setActive']>[0];

const selectBrowser: SetActiveRequest = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  browserId: snapshot.id,
};
const clearBrowser: SetActiveRequest = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  browserId: null,
};

// @ts-expect-error Normalized writers cannot emit legacy group layout data.
const groupState: WorktreeBrowserLayoutState = {
  browserOrder: [],
  activeBrowserId: null,
  groups: [],
};
// @ts-expect-error Normalized writers cannot emit legacy split layout data.
const splitState: WorktreeBrowserLayoutState = {
  browserOrder: [],
  activeBrowserId: null,
  splitSizes: [],
};
// @ts-expect-error Normalized writers cannot emit legacy custom-name data.
const customNameState: WorktreeBrowserLayoutState = {
  browserOrder: [],
  activeBrowserId: null,
  browserCustomNames: {},
};
// @ts-expect-error The explicit browserId field is required, including for clear.
const omittedBrowserId: SetActiveRequest = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};

describe('browser transport types', () => {
  it('represents normalized state and explicit active selection', () => {
    expect(persisted).toEqual({
      version: 1,
      browserOrder: ['browser-1'],
      activeBrowserId: 'browser-1',
      browsers: [snapshot],
    });
    expect(selectBrowser.browserId).toBe('browser-1');
    expect(clearBrowser.browserId).toBeNull();
    expect([
      groupState,
      splitState,
      customNameState,
      omittedBrowserId,
    ]).toHaveLength(4);
  });
});

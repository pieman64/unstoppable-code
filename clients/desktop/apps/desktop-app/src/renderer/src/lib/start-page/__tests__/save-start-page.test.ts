/**
 * @jest-environment jsdom
 */
import type { ToastMeta } from '@/stores/githubStore';

const addToast = jest.fn<
  void,
  [string, 'error' | 'info' | 'success' | 'warning', unknown, ToastMeta?]
>();
const loadProjects = jest.fn<Promise<void>, [{ silent?: boolean }?]>();
const updateChatProject = jest.fn<Promise<void>, [unknown]>();
const openWorkspaceSettings = jest.fn<void, [unknown]>();
const refreshProject = jest.fn<Promise<void>, [string]>();
let projects: Array<{ id: string; type: string }> = [];
let chatProjects: Array<{ id: string }> = [];

jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: { getState: (): object => ({ addToast }) },
}));
jest.mock('@/stores/projectsStore', () => ({
  useProjectsStore: { getState: (): object => ({ projects, loadProjects }) },
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): object => ({ chatProjects, updateChatProject }),
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): object => ({ openWorkspaceSettings }),
  },
}));
jest.mock('@/stores/startPageStore', () => ({
  useStartPageStore: { getState: (): object => ({ refreshProject }) },
}));

import {
  START_PAGE_SAVED,
  START_PAGE_SAVED_FOR_YOU,
  START_PAGE_SAVE_FAILED,
  START_PAGE_SHARE_WITH_TEAM,
  saveStartPageFromAction,
} from '../save-start-page';

const setWorkspaceStartPage = jest.fn<Promise<void>, [unknown]>();

beforeEach(() => {
  jest.clearAllMocks();
  loadProjects.mockResolvedValue(undefined);
  refreshProject.mockResolvedValue(undefined);
  updateChatProject.mockResolvedValue(undefined);
  setWorkspaceStartPage.mockResolvedValue(undefined);
  projects = [];
  chatProjects = [];
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { setWorkspaceStartPage },
  });
});

describe('saveStartPageFromAction', () => {
  it('writes cowork settings without offering team sharing', async () => {
    projects = [{ id: 'cw', type: 'cowork' }];
    chatProjects = [{ id: 'cw' }];
    const startPage = { kind: 'file' as const, path: 'README.md' };

    await saveStartPageFromAction('cw', startPage);

    expect(updateChatProject).toHaveBeenCalledWith({
      projectId: 'cw',
      startPage,
    });
    expect(setWorkspaceStartPage).not.toHaveBeenCalled();
    expect(refreshProject).toHaveBeenCalledWith('cw');
    expect(addToast.mock.calls[0]?.[0]).toBe(START_PAGE_SAVED);
    expect(addToast.mock.calls[0]?.[3]?.action).toBeUndefined();
  });

  it('writes the code local override, reloads projects, and offers Share with team', async () => {
    projects = [{ id: 'code', type: 'single-repo' }];
    const startPage = { kind: 'url' as const, url: 'https://example.com' };

    await saveStartPageFromAction('code', startPage);

    expect(setWorkspaceStartPage).toHaveBeenCalledWith({
      workspaceId: 'code',
      startPage,
    });
    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
    expect(refreshProject).toHaveBeenCalledWith('code');
    expect(setWorkspaceStartPage.mock.invocationCallOrder[0]).toBeLessThan(
      loadProjects.mock.invocationCallOrder[0] ?? 0,
    );
    const [message, type, , meta] = addToast.mock.calls[0] ?? [];
    expect(message).toBe(START_PAGE_SAVED_FOR_YOU);
    expect(type).toBe('success');
    expect(meta?.action?.label).toBe(START_PAGE_SHARE_WITH_TEAM);

    meta?.action?.onClick();
    expect(openWorkspaceSettings).toHaveBeenCalledWith({
      workspaceId: 'code',
      initialTab: 'start-page',
      startPage: { mode: 'source', prefill: startPage },
    });
  });

  it('reports a failed write', async () => {
    projects = [{ id: 'code', type: 'multi-repo' }];
    setWorkspaceStartPage.mockRejectedValue(new Error('disk full'));

    await saveStartPageFromAction('code', null);

    expect(loadProjects).not.toHaveBeenCalled();
    expect(addToast.mock.calls[0]?.[0]).toBe(START_PAGE_SAVE_FAILED);
    expect(addToast.mock.calls[0]?.[1]).toBe('error');
  });
});

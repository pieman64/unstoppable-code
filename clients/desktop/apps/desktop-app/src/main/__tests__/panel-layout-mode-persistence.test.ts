const readPanelLayoutModeFileMock = jest.fn();
const initializePanelLayoutModeFileMock = jest.fn();
const savePanelLayoutModeFileMock = jest.fn();

jest.mock('@canopy/desktop-shared/node/lib/panel-layout-mode', () => ({
  get readPanelLayoutModeFile(): typeof readPanelLayoutModeFileMock {
    return readPanelLayoutModeFileMock;
  },
  get initializePanelLayoutModeFile(): typeof initializePanelLayoutModeFileMock {
    return initializePanelLayoutModeFileMock;
  },
  get savePanelLayoutModeFile(): typeof savePanelLayoutModeFileMock {
    return savePanelLayoutModeFileMock;
  },
}));

jest.mock('../lib/paths', () => ({
  getWorktreePanelLayoutModeFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/data/${projectId}/worktree-data/${worktreeId}/panel-layout-mode.json`,
  ),
}));

import { PanelLayoutModePersistenceStore } from '../panels/layout-mode-persistence';

describe('PanelLayoutModePersistenceStore', () => {
  const store = new PanelLayoutModePersistenceStore();

  beforeEach(() => {
    jest.clearAllMocks();
    readPanelLayoutModeFileMock.mockResolvedValue('minimal');
    initializePanelLayoutModeFileMock.mockResolvedValue('minimal');
    savePanelLayoutModeFileMock.mockResolvedValue(undefined);
  });

  it('delegates normal worktree operations to the shared versioned helper', async () => {
    await expect(store.load('project-1', 'worktree-1')).resolves.toBe(
      'minimal',
    );
    await expect(
      store.initialize('project-1', 'worktree-1', 'minimal'),
    ).resolves.toBe('minimal');
    await expect(
      store.save('project-1', 'worktree-1', 'advanced'),
    ).resolves.toBeUndefined();

    const target = {
      workspaceId: 'project-1',
      worktreeId: 'worktree-1',
      filePath:
        '/data/project-1/worktree-data/worktree-1/panel-layout-mode.json',
    };
    expect(readPanelLayoutModeFileMock).toHaveBeenCalledWith(target);
    expect(initializePanelLayoutModeFileMock).toHaveBeenCalledWith(
      target,
      'minimal',
    );
    expect(savePanelLayoutModeFileMock).toHaveBeenCalledWith(
      target,
      'advanced',
    );
  });

  it('keeps App Advisor advanced without reading or writing a mode file', async () => {
    await expect(store.load('app-advisor', 'entry-1')).resolves.toBeNull();
    await expect(
      store.initialize('app-advisor', 'entry-1', 'minimal'),
    ).resolves.toBe('advanced');
    await expect(
      store.save('app-advisor', 'entry-1', 'minimal'),
    ).resolves.toBeUndefined();

    expect(readPanelLayoutModeFileMock).not.toHaveBeenCalled();
    expect(initializePanelLayoutModeFileMock).not.toHaveBeenCalled();
    expect(savePanelLayoutModeFileMock).not.toHaveBeenCalled();
  });
});

import {
  IPC_CHANNELS,
  type PanelLayoutApi,
} from '@canopy/desktop-shared/types';
import type { SerializablePanelLayoutFile } from '@canopy/protocol';
import { createPanelLayoutApi } from '../api/panel-layout-api';

describe('panel layout preload API', () => {
  const invoke = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    invoke.mockResolvedValue(undefined);
  });

  it('maps the renderer-facing mode methods to their typed IPC channels', async () => {
    const api: PanelLayoutApi = createPanelLayoutApi({ invoke });
    const entity = { projectId: 'project-1', worktreeId: 'worktree-1' };

    await api.loadWorktreeMode(entity);
    await api.initializeWorktreeMode({ ...entity, mode: 'minimal' });
    await api.saveWorktreeMode({ ...entity, mode: 'advanced' });

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      IPC_CHANNELS.panelLayoutLoadMode,
      entity,
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      IPC_CHANNELS.panelLayoutInitializeMode,
      { ...entity, mode: 'minimal' },
    );
    expect(invoke).toHaveBeenNthCalledWith(
      3,
      IPC_CHANNELS.panelLayoutSaveMode,
      { ...entity, mode: 'advanced' },
    );
  });

  it('preserves the existing panel-grid and default-layout channel mappings', async () => {
    const api = createPanelLayoutApi({ invoke });
    const entity = { projectId: 'project-1', worktreeId: 'worktree-1' };
    const layout: SerializablePanelLayoutFile = {
      version: 1,
      grid: {
        orientation: 1,
        width: 1000,
        height: 700,
        root: {
          type: 'leaf',
          groupId: 'group-1',
          panels: [],
          activePanelId: null,
          size: 1000,
        },
      },
      activeGroupId: 'group-1',
      mostRecentActiveGroupIds: ['group-1'],
    };

    await api.loadWorktreeLayout(entity);
    await api.saveWorktreeLayout({ ...entity, layout });
    await api.deleteWorktreeLayout(entity);
    await api.saveDefaultLayout({ surface: 'code', layout });
    await api.loadDefaultLayout({ surface: 'cowork' });

    expect(invoke.mock.calls).toEqual([
      [IPC_CHANNELS.panelLayoutLoad, entity],
      [IPC_CHANNELS.panelLayoutSave, { ...entity, layout }],
      [IPC_CHANNELS.panelLayoutDelete, entity],
      [IPC_CHANNELS.panelLayoutSaveDefault, { surface: 'code', layout }],
      [IPC_CHANNELS.panelLayoutLoadDefault, { surface: 'cowork' }],
    ]);
  });

  it.each<{
    name: string;
    call: (api: PanelLayoutApi) => Promise<unknown>;
  }>([
    {
      name: 'loadWorktreeMode',
      call: (api): Promise<unknown> =>
        api.loadWorktreeMode({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        }),
    },
    {
      name: 'initializeWorktreeMode',
      call: (api): Promise<unknown> =>
        api.initializeWorktreeMode({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          mode: 'minimal',
        }),
    },
    {
      name: 'saveWorktreeMode',
      call: (api): Promise<unknown> =>
        api.saveWorktreeMode({
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          mode: 'advanced',
        }),
    },
  ])('propagates $name invoke failures', async ({ call }) => {
    const failure = new Error('backend unavailable');
    invoke.mockRejectedValueOnce(failure);
    const api = createPanelLayoutApi({ invoke });

    await expect(call(api)).rejects.toBe(failure);
  });
});

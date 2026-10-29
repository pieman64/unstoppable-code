/* eslint-disable @typescript-eslint/unbound-method */
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

jest.mock('../panels/persistence', () => ({
  panelLayoutPersistenceStore: {
    loadWorktreeLayout: jest.fn(),
    saveWorktreeLayout: jest.fn(),
    deleteWorktreeLayout: jest.fn(),
  },
}));

jest.mock('../panels/default-layout-persistence', () => ({
  defaultPanelLayoutStore: {
    loadDefaultLayout: jest.fn(),
    saveDefaultLayout: jest.fn(),
  },
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { SerializablePanelLayoutFile } from '@canopy/protocol/panels';
import { registerIpcHandler } from '../ipc/register';
import {
  registerPanelLayoutHandlers,
  type PanelLayoutModePersistence,
} from '../ipc/panel-layout';
import { defaultPanelLayoutStore } from '../panels/default-layout-persistence';
import { panelLayoutPersistenceStore } from '../panels/persistence';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedStore = jest.mocked(panelLayoutPersistenceStore);
const mockedDefaultStore = jest.mocked(defaultPanelLayoutStore);
const mockedModeStore: jest.Mocked<PanelLayoutModePersistence> = {
  load: jest.fn(),
  initialize: jest.fn(),
  save: jest.fn(),
};

type HandlerFn = (...args: unknown[]) => unknown;

function getHandler(channel: string): HandlerFn {
  const entry = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!entry) {
    throw new Error(`No handler registered for ${channel}`);
  }
  const handler: unknown = entry[1];
  if (typeof handler !== 'function') {
    throw new Error(`Handler for ${channel} is not callable`);
  }
  return handler;
}

function makeLayoutFile(): SerializablePanelLayoutFile {
  return {
    version: 1,
    grid: {
      root: {
        type: 'leaf',
        groupId: 'group-chat',
        panels: [{ panelId: 'panel-chat', kind: 'chat' }],
        activePanelId: 'panel-chat',
        size: 800,
      },
      orientation: 1,
      width: 1200,
      height: 800,
    },
    activeGroupId: 'group-chat',
    mostRecentActiveGroupIds: ['group-chat'],
  };
}

describe('registerPanelLayoutHandlers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    registerPanelLayoutHandlers(mockedModeStore);
  });

  it('registers the panel-layout channels', () => {
    const channels = mockedRegisterIpcHandler.mock.calls.map(
      ([channel]) => channel,
    );
    expect(channels).toEqual([
      IPC_CHANNELS.panelLayoutLoad,
      IPC_CHANNELS.panelLayoutSave,
      IPC_CHANNELS.panelLayoutDelete,
      IPC_CHANNELS.panelLayoutLoadMode,
      IPC_CHANNELS.panelLayoutInitializeMode,
      IPC_CHANNELS.panelLayoutSaveMode,
      IPC_CHANNELS.panelLayoutSaveDefault,
      IPC_CHANNELS.panelLayoutLoadDefault,
    ]);
  });

  it('load validates ids and wraps the store result in a response', () => {
    const layout = makeLayoutFile();
    mockedStore.loadWorktreeLayout.mockReturnValue(layout);
    const handler = getHandler(IPC_CHANNELS.panelLayoutLoad);

    const response = handler(null, { projectId: 'proj-1', worktreeId: 'wt-1' });

    expect(mockedStore.loadWorktreeLayout).toHaveBeenCalledWith(
      'proj-1',
      'wt-1',
    );
    expect(response).toEqual({ layout });

    expect(() =>
      handler(null, { projectId: '../evil', worktreeId: 'wt-1' }),
    ).toThrow();
    expect(() =>
      handler(null, { projectId: 'proj-1', worktreeId: 'Bad/Id' }),
    ).toThrow();
  });

  it('load maps a missing layout to null', () => {
    mockedStore.loadWorktreeLayout.mockReturnValue(null);
    const handler = getHandler(IPC_CHANNELS.panelLayoutLoad);

    expect(handler(null, { projectId: 'proj-1', worktreeId: 'wt-1' })).toEqual({
      layout: null,
    });
  });

  it('save validates ids and forwards the layout to the store', () => {
    const layout = makeLayoutFile();
    const handler = getHandler(IPC_CHANNELS.panelLayoutSave);

    handler(null, { projectId: 'proj-1', worktreeId: 'wt-1', layout });

    expect(mockedStore.saveWorktreeLayout).toHaveBeenCalledWith(
      'proj-1',
      'wt-1',
      layout,
      true,
    );

    expect(() =>
      handler(null, { projectId: '', worktreeId: 'wt-1', layout }),
    ).toThrow();
    expect(mockedStore.saveWorktreeLayout).toHaveBeenCalledTimes(1);
  });

  it('delete validates ids and dispatches to the store', () => {
    const handler = getHandler(IPC_CHANNELS.panelLayoutDelete);

    handler(null, { projectId: 'proj-1', worktreeId: 'wt-1' });

    expect(mockedStore.deleteWorktreeLayout).toHaveBeenCalledWith(
      'proj-1',
      'wt-1',
    );

    expect(() =>
      handler(null, { projectId: 'proj-1', worktreeId: '' }),
    ).toThrow();
    expect(mockedStore.deleteWorktreeLayout).toHaveBeenCalledTimes(1);
  });

  it.each([null, 'minimal', 'advanced'] as const)(
    'load mode forwards valid ids and returns mode %p unchanged',
    async (mode) => {
      mockedModeStore.load.mockResolvedValue(mode);
      const handler = getHandler(IPC_CHANNELS.panelLayoutLoadMode);

      await expect(
        handler(null, { projectId: 'proj-1', worktreeId: 'wt-1' }),
      ).resolves.toEqual({ mode });
      expect(mockedModeStore.load).toHaveBeenCalledWith('proj-1', 'wt-1');
    },
  );

  it('load mode rejects invalid ids before calling persistence', async () => {
    const handler = getHandler(IPC_CHANNELS.panelLayoutLoadMode);

    await expect(
      handler(null, { projectId: '../evil', worktreeId: 'wt-1' }),
    ).rejects.toThrow();
    await expect(
      handler(null, { projectId: 'proj-1', worktreeId: 'bad/id' }),
    ).rejects.toThrow();
    expect(mockedModeStore.load).not.toHaveBeenCalled();
  });

  it('initialize mode validates input and returns the effective stored mode', async () => {
    mockedModeStore.initialize.mockResolvedValue('advanced');
    const handler = getHandler(IPC_CHANNELS.panelLayoutInitializeMode);

    await expect(
      handler(null, {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        mode: 'minimal',
      }),
    ).resolves.toEqual({ mode: 'advanced' });
    expect(mockedModeStore.initialize).toHaveBeenCalledWith(
      'proj-1',
      'wt-1',
      'minimal',
    );

    await expect(
      handler(null, {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        mode: 'unsupported',
      }),
    ).rejects.toThrow(/Invalid project layout mode/);
    expect(mockedModeStore.initialize).toHaveBeenCalledTimes(1);
  });

  it('save mode validates input, awaits persistence, and returns no payload', async () => {
    let finishSave: (() => void) | undefined;
    mockedModeStore.save.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const handler = getHandler(IPC_CHANNELS.panelLayoutSaveMode);

    const result: Promise<unknown> = Promise.resolve(
      handler(null, {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        mode: 'advanced',
      }),
    );
    let settled = false;
    void result.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishSave?.();
    await expect(result).resolves.toBeUndefined();
    expect(mockedModeStore.save).toHaveBeenCalledWith(
      'proj-1',
      'wt-1',
      'advanced',
    );

    await expect(
      handler(null, {
        projectId: '',
        worktreeId: 'wt-1',
        mode: 'minimal',
      }),
    ).rejects.toThrow();
    await expect(
      handler(null, {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        mode: 'unsupported',
      }),
    ).rejects.toThrow(/Invalid project layout mode/);
    expect(mockedModeStore.save).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['load', IPC_CHANNELS.panelLayoutLoadMode],
    ['initialize', IPC_CHANNELS.panelLayoutInitializeMode],
    ['save', IPC_CHANNELS.panelLayoutSaveMode],
  ] as const)(
    'propagates %s mode persistence failures',
    async (method, channel) => {
      const failure = new Error(`${method} failed`);
      mockedModeStore[method].mockRejectedValueOnce(failure);
      const handler = getHandler(channel);
      const request = {
        projectId: 'proj-1',
        worktreeId: 'wt-1',
        ...(method === 'load' ? {} : { mode: 'minimal' }),
      };

      await expect(handler(null, request)).rejects.toBe(failure);
    },
  );

  it('save default forwards the surface and layout to the default store', () => {
    const layout = makeLayoutFile();
    const handler = getHandler(IPC_CHANNELS.panelLayoutSaveDefault);

    handler(null, { surface: 'cowork', layout });

    expect(mockedDefaultStore.saveDefaultLayout).toHaveBeenCalledWith(
      'cowork',
      layout,
    );
  });

  it('save default rejects an unknown surface', () => {
    const layout = makeLayoutFile();
    const handler = getHandler(IPC_CHANNELS.panelLayoutSaveDefault);

    expect(() => handler(null, { surface: 'bogus', layout })).toThrow(
      /Invalid panel layout surface/,
    );
    expect(mockedDefaultStore.saveDefaultLayout).not.toHaveBeenCalled();
  });

  it('load default wraps the per-surface default store result in a response', () => {
    const layout = makeLayoutFile();
    mockedDefaultStore.loadDefaultLayout.mockReturnValue(layout);
    const handler = getHandler(IPC_CHANNELS.panelLayoutLoadDefault);

    expect(handler(null, { surface: 'code' })).toEqual({ layout });
    expect(mockedDefaultStore.loadDefaultLayout).toHaveBeenCalledWith('code');
  });

  it('load default rejects an unknown surface', () => {
    const handler = getHandler(IPC_CHANNELS.panelLayoutLoadDefault);

    expect(() => handler(null, { surface: 'bogus' })).toThrow(
      /Invalid panel layout surface/,
    );
    expect(mockedDefaultStore.loadDefaultLayout).not.toHaveBeenCalled();
  });
});

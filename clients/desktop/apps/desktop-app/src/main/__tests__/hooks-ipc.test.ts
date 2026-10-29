import {
  IPC_CHANNELS,
  type HookRunRequest,
  type SaveProjectHooksRequest,
  type SaveWorkspaceHooksRequest,
  type SaveWorkspaceRepoHooksRequest,
  type SetWorktreePausedHooksRequest,
} from '@canopy/desktop-shared/types';
import { registerHookHandlers } from '../ipc/hooks';
import { registerIpcHandler } from '../ipc/register';
import {
  runHookCommand,
  saveProjectHooksFromService,
  saveWorkspaceHooksFromService,
  saveWorkspaceRepoHooksFromService,
  setWorktreePausedHookKeys,
} from '../services/hooks-service';

jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../services/hooks-service', () => ({
  cancelHook: jest.fn(),
  getHookSourceInfo: jest.fn(),
  loadWorktreeHookRuns: jest.fn(),
  runHookCommand: jest.fn(),
  saveProjectHooksFromService: jest.fn(),
  saveWorkspaceHooksFromService: jest.fn(),
  saveWorkspaceRepoHooksFromService: jest.fn(),
  setWorktreePausedHookKeys: jest.fn(),
}));

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedSetWorktreePausedHookKeys = jest.mocked(setWorktreePausedHookKeys);
const mockedRunHookCommand = jest.mocked(runHookCommand);
const mockedSaveProjectHooks = jest.mocked(saveProjectHooksFromService);
const mockedSaveWorkspaceHooks = jest.mocked(saveWorkspaceHooksFromService);
const mockedSaveWorkspaceRepoHooks = jest.mocked(
  saveWorkspaceRepoHooksFromService,
);

function registeredHandler(
  channel: string,
): (event: unknown, request: unknown) => Promise<unknown> {
  const registration = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  expect(registration).toBeDefined();
  return registration?.[1] as (
    event: unknown,
    request: unknown,
  ) => Promise<unknown>;
}

describe('hooks IPC', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('rejects hook configuration writes and execution for the recipient scope', async () => {
    registerHookHandlers(() => null);
    const projectSave = registeredHandler(IPC_CHANNELS.projectSaveHooks);
    const workspaceSave = registeredHandler(IPC_CHANNELS.workspaceSaveHooks);
    const workspaceRepoSave = registeredHandler(
      IPC_CHANNELS.workspaceSaveRepoHooks,
    );
    const run = registeredHandler(IPC_CHANNELS.hookRun);
    const projectRequest: SaveProjectHooksRequest = {
      projectId: 'shared-container-viewer',
      hooks: {},
    };
    const workspaceRequest: SaveWorkspaceHooksRequest = {
      workspaceId: 'shared-container-viewer',
      hooks: {},
    };
    const workspaceRepoRequest: SaveWorkspaceRepoHooksRequest = {
      workspaceId: 'shared-container-viewer',
      repos: [],
    };
    const runRequest: HookRunRequest = {
      target: 'project',
      triggerName: 'manual',
      projectId: 'shared-container-viewer',
      worktreeId: 'container-1',
    };

    await expect(projectSave({}, projectRequest)).rejects.toThrow(
      'Shared-container recipient workspaces are read-only',
    );
    await expect(workspaceSave({}, workspaceRequest)).rejects.toThrow(
      'Shared-container recipient workspaces are read-only',
    );
    await expect(workspaceRepoSave({}, workspaceRepoRequest)).rejects.toThrow(
      'Shared-container recipient workspaces are read-only',
    );
    await expect(run({}, runRequest)).rejects.toThrow(
      'Shared-container recipient workspaces are read-only',
    );
    expect(mockedSaveProjectHooks).not.toHaveBeenCalled();
    expect(mockedSaveWorkspaceHooks).not.toHaveBeenCalled();
    expect(mockedSaveWorkspaceRepoHooks).not.toHaveBeenCalled();
    expect(mockedRunHookCommand).not.toHaveBeenCalled();
  });

  it('delegates the existing renderer request to the shared hooks service', async () => {
    registerHookHandlers(() => null);
    const registration = mockedRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === IPC_CHANNELS.worktreeSetPausedHooks,
    );
    expect(registration).toBeDefined();
    const handler = registration?.[1] as (
      event: unknown,
      request: SetWorktreePausedHooksRequest,
    ) => Promise<void>;
    const request = {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      pausedHookKeys: ['hook-a'],
    };

    await handler({}, request);

    expect(mockedSetWorktreePausedHookKeys).toHaveBeenCalledWith(request);
  });
});

import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  type HookRunRequest,
  type HookSourceInfoRequest,
  type SaveProjectHooksRequest,
  type SaveWorkspaceHooksRequest,
  type SaveWorkspaceRepoHooksRequest,
  type SetWorktreePausedHooksRequest,
} from '@canopy/desktop-shared/types';
import { registerHookHandlers } from '../ipc/hooks';
import { registerIpcHandler } from '../ipc/register';
import { getHookSourceInfoThroughCore } from '../canopy-runtime/hook-source-dispatch';
import {
  runHookCommand,
  saveProjectHooksFromService,
  saveWorkspaceHooksFromService,
  saveWorkspaceRepoHooksFromService,
  setWorktreePausedHookKeys,
} from '../services/hooks-service';

jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('../canopy-runtime/hook-source-dispatch', () => ({
  getHookSourceInfoThroughCore: jest.fn(),
}));
jest.mock('../services/hooks-service', () => ({
  cancelHook: jest.fn(),
  loadWorktreeHookRuns: jest.fn(),
  runHookCommand: jest.fn(),
  saveProjectHooksFromService: jest.fn(),
  saveWorkspaceHooksFromService: jest.fn(),
  saveWorkspaceRepoHooksFromService: jest.fn(),
  setWorktreePausedHookKeys: jest.fn(),
}));

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedGetHookSourceInfo = jest.mocked(getHookSourceInfoThroughCore);
const ipcCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read'],
};
const runtime = {
  dispatcher: { query: jest.fn() },
  resolveCaller: jest.fn(() => ipcCaller),
};
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
    registerHookHandlers(() => null, runtime);
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
    registerHookHandlers(() => null, runtime);
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

  it('serves hook:source-info through core.initiatedWork.source.get with the sender caller', async () => {
    registerHookHandlers(() => null, runtime);
    const handler = registeredHandler(IPC_CHANNELS.hookSourceInfo);
    const request: HookSourceInfoRequest = {
      target: 'workspace-repo',
      workspaceId: 'ws-1',
      repoId: 'repo-a',
      worktreeId: 'wt-1',
      triggerName: 'pr:merged',
    };
    const response = {
      triggerName: 'pr:merged',
      triggerDisplayName: 'PR Merged',
      effectiveActions: null,
      layers: [],
    };
    mockedGetHookSourceInfo.mockResolvedValueOnce(response);
    const event = { sender: { id: 1 } };

    await expect(handler(event, request)).resolves.toBe(response);
    expect(runtime.resolveCaller).toHaveBeenCalledWith(event);
    expect(mockedGetHookSourceInfo).toHaveBeenCalledWith(
      runtime.dispatcher,
      ipcCaller,
      request,
    );
  });
});

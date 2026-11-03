import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type {
  CreateBranchRequest,
  CreateBranchResponse,
  ListBranchesRequest,
  ListBranchesResponse,
  RenameBranchRequest,
  RenameBranchResponse,
  SetWorktreeLabelRequest,
  SwitchBranchRequest,
  SwitchBranchResponse,
} from '@canopy/desktop-shared/types';

jest.mock('node:fs/promises');
jest.mock('../lib/animals', () => ({
  generateUniqueAnimalName: jest.fn(() => 'test-animal'),
}));
jest.mock('../lib/git', () => ({
  checkoutBranch: jest.fn(),
  createBranchAndCheckout: jest.fn(),
  createWorktree: jest.fn(),
  deleteBranch: jest.fn(),
  getCurrentBranch: jest.fn(),
  getDiffStats: jest.fn(),
  getRemoteDefaultBranch: jest.fn(),
  hasBranchBeenPushedToRemote: jest.fn(),
  hasCommitsAhead: jest.fn(),
  hasRemoteTrackingBranch: jest.fn(),
  hasUncommittedChanges: jest.fn(),
  hasUnpushedCommits: jest.fn(),
  isBranchNameAvailable: jest.fn(),
  listBranches: jest.fn(),
  pruneWorktrees: jest.fn(),
  removeWorktree: jest.fn(),
  renameBranch: jest.fn(),
  validateBranchName: jest.fn(),
}));
jest.mock('../lib/git-default-branch', () => ({
  resolveFreshDefaultBranch: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getWorkspaceWorktreesFilePath: jest.fn(
    (id: string) => `/mock/workspaces/${id}/worktrees.json`,
  ),
  getChatTabsFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/chats/${worktreeId}.json`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (projectId: string, worktreeId: string, repoId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}/repos/${repoId}`,
  ),
  getWorktreeDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
  getWorktreeSummaryFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/summaries/${worktreeId}.json`,
  ),
}));
jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
  resolveRegisteredChatWorktree: jest.fn(
    (projectId: string, worktreeId: string) => ({ projectId, worktreeId }),
  ),
}));
jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
  validateOptionalRepoId: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
  updateWorkspaceWorktree: jest.fn(() => Promise.resolve(true)),
}));
jest.mock('../lib/worktree-update', () => ({
  moveWorktree: jest.fn(),
  updateWorktree: jest.fn(),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(() =>
    Promise.resolve({ version: 1, items: [] }),
  ),
}));
jest.mock('../lib/script-runner', () => ({
  runShellScript: jest.fn(),
}));
jest.mock('../lib/script-events', () => ({
  createProjectScriptDescriptor: jest.fn(),
  createScriptCompleteEvent: jest.fn(),
  createScriptOutputEvent: jest.fn(),
  createScriptStartedEvent: jest.fn(),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  destroyWorktreeSessions: jest.fn(() => Promise.resolve()),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ deleteBranchOnArchive: false }),
  ),
}));
jest.mock('../lib/github-poller', () => ({
  stopTracking: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));
jest.mock('../pipelines/worktree-cleanup', () => ({
  cleanupWorktreePipelines: jest.fn(() => Promise.resolve({ warnings: [] })),
}));
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(() => ({
    executionsDir: '/mock/executions',
    tempRootDir: '/mock/executions',
    bundledActionsDir: '/mock/actions',
    getProjectActionsDir: (repoPath: string): string => repoPath,
  })),
}));
jest.mock('../lib/worktree-summary-scheduler', () => ({
  cancelScheduledGeneration: jest.fn(),
}));

import { registerIpcHandler } from '../ipc/register';
import {
  checkoutBranch,
  createBranchAndCheckout,
  isBranchNameAvailable,
  renameBranch,
  validateBranchName,
} from '../lib/git';
import { getWorkspaceWorktreeRepoDir } from '../lib/paths';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { validateId, validateOptionalRepoId } from '../lib/validation';
import { updateWorkspaceWorktree } from '../lib/workspace-persistence';
import { updateWorktree } from '../lib/worktree-update';
import { registerWorktreeHandlers } from '../ipc/worktrees';
import { createWorkspaceMetadataTestDispatcher } from './fixtures/workspace-metadata-dispatcher';
import type {
  WorkerGitDispatcher,
  WorkerGitWriteDispatcher,
} from '../canopy-runtime/worker-git-adapter';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '@canopy/core-runtime';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedCheckoutBranch = jest.mocked(checkoutBranch);
const mockedCreateBranchAndCheckout = jest.mocked(createBranchAndCheckout);
const mockedIsBranchNameAvailable = jest.mocked(isBranchNameAvailable);
const mockedRenameBranch = jest.mocked(renameBranch);
const mockedValidateBranchName = jest.mocked(validateBranchName);
const mockedUpdateWorkspaceWorktree = jest.mocked(updateWorkspaceWorktree);
const mockedUpdateWorktree = jest.mocked(updateWorktree);
const mockedGetWorkspaceWorktreeRepoDir = jest.mocked(
  getWorkspaceWorktreeRepoDir,
);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedValidateId = jest.mocked(validateId);
const gitQuery: WorkerGitDispatcher['query'] & jest.Mock = jest.fn();
const gitInstruction: WorkerGitWriteDispatcher['instruction'] & jest.Mock =
  jest.fn();
const desktopCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.workspace.read', 'worker.filesystem.read'],
};

type RenameHandler = (
  event: unknown,
  request: RenameBranchRequest,
) => Promise<RenameBranchResponse>;
type ListHandler = (
  event: unknown,
  request: ListBranchesRequest,
) => Promise<ListBranchesResponse>;
type SwitchHandler = (
  event: unknown,
  request: SwitchBranchRequest,
) => Promise<SwitchBranchResponse>;
type CreateHandler = (
  event: unknown,
  request: CreateBranchRequest,
) => Promise<CreateBranchResponse>;
type LabelHandler = (
  event: unknown,
  request: SetWorktreeLabelRequest,
) => Promise<void>;

let renameHandler: RenameHandler;
let listHandler: ListHandler;
let switchHandler: SwitchHandler;
let createHandler: CreateHandler;
let labelHandler: LabelHandler;

function isRenameBranchResponse(value: unknown): value is RenameBranchResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('success' in value) || !('newBranchName' in value)) {
    return false;
  }

  return (
    typeof value.success === 'boolean' &&
    typeof value.newBranchName === 'string'
  );
}

function isListBranchesResponse(value: unknown): value is ListBranchesResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('branches' in value) || !('defaultBranch' in value)) {
    return false;
  }

  return Array.isArray(value.branches);
}

function isSwitchBranchResponse(value: unknown): value is SwitchBranchResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('success' in value) || !('branchName' in value)) {
    return false;
  }

  return (
    typeof value.success === 'boolean' && typeof value.branchName === 'string'
  );
}

function isCreateBranchResponse(value: unknown): value is CreateBranchResponse {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('success' in value) || !('branchName' in value)) {
    return false;
  }

  return (
    typeof value.success === 'boolean' && typeof value.branchName === 'string'
  );
}

beforeEach(() => {
  jest.clearAllMocks();

  mockedCheckoutBranch.mockResolvedValue(undefined);
  mockedCreateBranchAndCheckout.mockResolvedValue('created-branch');
  mockedValidateBranchName.mockResolvedValue(true);
  mockedIsBranchNameAvailable.mockResolvedValue(true);
  gitQuery.mockResolvedValue({
    branches: [],
    defaultBranch: 'main',
    defaultBranchSource: 'hint',
  });
  mockedRenameBranch.mockResolvedValue(undefined);
  gitInstruction.mockReset();
  gitInstruction.mockResolvedValue({ branch: 'renamed' });

  // worktree:set-label projects the registered core.worktree.update
  // (W7b-1b) and the rename channel core.worktree.branch.rename (W7b-4);
  // their Git effects still reach the worker through the stub.
  const workspaceInstruction = createWorkspaceMetadataTestDispatcher()
    .instruction as unknown as (...args: unknown[]) => Promise<unknown>;
  const instruction = (name: string, ...rest: unknown[]): Promise<unknown> =>
    name.startsWith('worker.git.')
      ? Promise.resolve(gitInstruction(name, ...rest))
      : workspaceInstruction(name, ...rest);
  registerWorktreeHandlers(() => null, {
    dispatcher: {
      query: gitQuery,
      instruction,
    } as unknown as Parameters<
      typeof registerWorktreeHandlers
    >[1]['dispatcher'],
    resolveCaller: () => desktopCaller,
  });

  const renameCall = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'worktree:rename-branch',
  );
  if (!renameCall) {
    throw new Error('worktree:rename-branch handler was not registered');
  }

  const handler = renameCall[1];
  if (typeof handler !== 'function') {
    throw new Error('worktree:rename-branch handler is not callable');
  }

  renameHandler = (
    event: unknown,
    request: RenameBranchRequest,
  ): Promise<RenameBranchResponse> =>
    Promise.resolve(Reflect.apply(handler, undefined, [event, request])).then(
      (result: unknown): RenameBranchResponse => {
        if (!isRenameBranchResponse(result)) {
          throw new Error(
            'worktree:rename-branch returned an invalid response',
          );
        }

        return result;
      },
    );

  const listCall = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'worktree:list-branches',
  );
  if (!listCall) {
    throw new Error('worktree:list-branches handler was not registered');
  }

  const listRegisteredHandler = listCall[1];
  if (typeof listRegisteredHandler !== 'function') {
    throw new Error('worktree:list-branches handler is not callable');
  }

  listHandler = (
    event: unknown,
    request: ListBranchesRequest,
  ): Promise<ListBranchesResponse> =>
    Promise.resolve(
      Reflect.apply(listRegisteredHandler, undefined, [event, request]),
    ).then((result: unknown): ListBranchesResponse => {
      if (!isListBranchesResponse(result)) {
        throw new Error('worktree:list-branches returned an invalid response');
      }

      return result;
    });

  const switchCall = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'worktree:switch-branch',
  );
  if (!switchCall) {
    throw new Error('worktree:switch-branch handler was not registered');
  }

  const switchRegisteredHandler = switchCall[1];
  if (typeof switchRegisteredHandler !== 'function') {
    throw new Error('worktree:switch-branch handler is not callable');
  }

  switchHandler = (
    event: unknown,
    request: SwitchBranchRequest,
  ): Promise<SwitchBranchResponse> =>
    Promise.resolve(
      Reflect.apply(switchRegisteredHandler, undefined, [event, request]),
    ).then((result: unknown): SwitchBranchResponse => {
      if (!isSwitchBranchResponse(result)) {
        throw new Error('worktree:switch-branch returned an invalid response');
      }

      return result;
    });

  const createCall = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'worktree:create-branch',
  );
  if (!createCall) {
    throw new Error('worktree:create-branch handler was not registered');
  }

  const createRegisteredHandler = createCall[1];
  if (typeof createRegisteredHandler !== 'function') {
    throw new Error('worktree:create-branch handler is not callable');
  }

  createHandler = (
    event: unknown,
    request: CreateBranchRequest,
  ): Promise<CreateBranchResponse> =>
    Promise.resolve(
      Reflect.apply(createRegisteredHandler, undefined, [event, request]),
    ).then((result: unknown): CreateBranchResponse => {
      if (!isCreateBranchResponse(result)) {
        throw new Error('worktree:create-branch returned an invalid response');
      }

      return result;
    });

  const labelCall = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'worktree:set-label',
  );
  if (!labelCall) {
    throw new Error('worktree:set-label handler was not registered');
  }
  const labelRegisteredHandler = labelCall[1];
  if (typeof labelRegisteredHandler !== 'function') {
    throw new Error('worktree:set-label handler is not callable');
  }
  labelHandler = (
    event: unknown,
    request: SetWorktreeLabelRequest,
  ): Promise<void> =>
    Promise.resolve(
      Reflect.apply(labelRegisteredHandler, undefined, [event, request]),
    ).then(() => undefined);
});

describe('worktree:rename-branch handler', () => {
  it('renames the project root branch using the worktree root path', async () => {
    await renameHandler(null, {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoId: WORKSPACE_ROOT_REPO_ID,
      newBranchName: 'new-root-branch',
    });

    expect(mockedValidateId).toHaveBeenCalledWith('ws-1', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
    expect(mockedValidateId).not.toHaveBeenCalledWith(
      WORKSPACE_ROOT_REPO_ID,
      'repoId',
    );
    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith('ws-1', 'wt-1');
    expect(mockedGetWorkspaceWorktreeRepoDir).not.toHaveBeenCalled();
    expect(mockedValidateBranchName).toHaveBeenCalledWith(
      '/mock/workspaces/ws-1/worktrees/wt-1',
      'new-root-branch',
    );
    expect(mockedIsBranchNameAvailable).toHaveBeenCalledWith(
      '/mock/workspaces/ws-1/worktrees/wt-1',
      'new-root-branch',
    );
    // The Git effect dispatches worker.git.branch.rename with
    // worker.git.write only; the outcomes over real checkouts are pinned by
    // worktree-branch-rename-ipc.test.ts.
    expect(gitInstruction).toHaveBeenCalledWith(
      'worker.git.branch.rename',
      {
        scope: {
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: WORKSPACE_ROOT_REPO_ID,
        },
        name: 'new-root-branch',
      },
      { caller: { ...desktopCaller, grants: ['worker.git.write'] } },
    );
    expect(mockedRenameBranch).not.toHaveBeenCalled();
    expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      expect.any(Function),
    );
    const persistRename = mockedUpdateWorkspaceWorktree.mock.calls[0]?.[2];
    expect(
      persistRename?.({
        id: 'wt-1',
        branchName: 'old-root-branch',
        createdAt: '2026-05-22T00:00:00.000Z',
        status: 'done',
        lastKnownPrStatus: {
          repos: [],
          lastCheckedAt: '2026-05-22T00:00:00.000Z',
        },
      }),
    ).toEqual({
      id: 'wt-1',
      branchName: 'new-root-branch',
      createdAt: '2026-05-22T00:00:00.000Z',
      lastKnownPrStatus: null,
    });
  });

  it('records the rename through the branch rename command, keeping a row already renamed', async () => {
    await renameHandler(null, {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      newBranchName: 'new-root-branch',
    });

    const persistRename = mockedUpdateWorkspaceWorktree.mock.calls[0]?.[2];
    const alreadyRenamed = {
      id: 'wt-1',
      branchName: 'new-root-branch',
      createdAt: '2026-05-22T00:00:00.000Z',
      lastKnownPrStatus: null,
    };
    // The same row back is the persistence layer's "no write".
    expect(persistRename?.(alreadyRenamed)).toBe(alreadyRenamed);
  });

  it('throws when project root branch rename cannot persist metadata', async () => {
    mockedUpdateWorkspaceWorktree.mockResolvedValue(false);

    await expect(
      renameHandler(null, {
        projectId: 'ws-1',
        worktreeId: 'wt-missing',
        repoId: WORKSPACE_ROOT_REPO_ID,
        newBranchName: 'new-root-branch',
      }),
    ).rejects.toThrow('Worktree metadata not found for ws-1/wt-missing');

    expect(gitInstruction).toHaveBeenCalledWith(
      'worker.git.branch.rename',
      {
        scope: {
          workspaceId: 'ws-1',
          worktreeId: 'wt-missing',
          repoId: WORKSPACE_ROOT_REPO_ID,
        },
        name: 'new-root-branch',
      },
      { caller: { ...desktopCaller, grants: ['worker.git.write'] } },
    );
  });

  it('rethrows the host error a failed rename carries, and records nothing', async () => {
    const hostError = new Error(
      'fatal: cannot rename the current branch while not on any',
    );
    gitInstruction.mockRejectedValue(
      new CanopyOperationError(
        {
          kind: 'internal',
          message: 'Git failed',
          retry: { kind: 'never' },
        },
        hostError,
      ),
    );

    await expect(
      renameHandler(null, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        newBranchName: 'new-root-branch',
      }),
    ).rejects.toBe(hostError);
    expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it('checks the name before dispatching, so a refusal never reaches the worker', async () => {
    mockedIsBranchNameAvailable.mockResolvedValue(false);

    await expect(
      renameHandler(null, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        newBranchName: 'taken',
      }),
    ).rejects.toThrow('Branch name "taken" is already in use');
    expect(gitInstruction).not.toHaveBeenCalled();
  });
});

describe('worktree:list-branches handler', () => {
  it('lists the project root checkout through worker.git.branch.list', async () => {
    const branch = {
      name: 'main',
      isRemote: false,
      isCurrent: true,
      isUsedByWorktree: false,
      hasLocalRef: true,
      hasRemoteRef: true,
    };
    gitQuery.mockResolvedValue({
      branches: [branch],
      defaultBranch: 'main',
      defaultBranchSource: 'hint',
    });

    const result = await listHandler(null, {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoId: WORKSPACE_ROOT_REPO_ID,
    });

    expect(result).toEqual({ branches: [branch], defaultBranch: 'main' });
    expect(mockedValidateId).toHaveBeenCalledWith('ws-1', 'projectId');
    expect(mockedValidateId).toHaveBeenCalledWith('wt-1', 'worktreeId');
    expect(gitQuery).toHaveBeenCalledWith(
      'worker.git.branch.list',
      {
        scope: {
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: WORKSPACE_ROOT_REPO_ID,
        },
        repository: { kind: 'checkout' },
      },
      { caller: { ...desktopCaller, grants: ['worker.git.read'] } },
    );
  });
});

// The Git outcomes are pinned against real checkouts by
// worktree-branch-checkout-ipc.test.ts; these pin the projection.
describe('worktree:switch-branch handler', () => {
  it('switches a child repo branch through worker.git.checkout with worker.git.write only', async () => {
    gitInstruction.mockResolvedValue({ branch: 'release' });
    const result = await switchHandler(null, {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoId: 'repo-a',
      branchName: 'release',
      isRemote: false,
    });

    expect(result).toEqual({ success: true, branchName: 'release' });
    expect(jest.mocked(validateOptionalRepoId)).toHaveBeenCalledWith(
      'repo-a',
      'repoId',
    );
    expect(gitInstruction).toHaveBeenCalledWith(
      'worker.git.checkout',
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1', repoId: 'repo-a' },
        branch: 'release',
      },
      { caller: { ...desktopCaller, grants: ['worker.git.write'] } },
    );
    expect(mockedCheckoutBranch).not.toHaveBeenCalled();
  });

  it('rethrows the host error a refusal carries', async () => {
    const hostError = new Error(
      'Branch "release" is already checked out in another worktree',
    );
    gitInstruction.mockRejectedValue(
      new CanopyOperationError(
        {
          kind: 'failed_precondition',
          code: 'worker.git.checkout.branchOccupied',
          message: hostError.message,
          retry: { kind: 'never' },
        },
        hostError,
      ),
    );

    await expect(
      switchHandler(null, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        branchName: 'release',
        isRemote: false,
      }),
    ).rejects.toBe(hostError);
  });
});

describe('worktree:create-branch handler', () => {
  it('creates a branch from a remote base branch through worker.git.branch.create', async () => {
    gitInstruction.mockResolvedValue({ branch: 'feature-2' });

    const result = await createHandler(null, {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      repoId: WORKSPACE_ROOT_REPO_ID,
      newBranchName: 'feature',
      baseBranch: 'main',
      baseBranchIsRemote: true,
    });

    expect(result).toEqual({ success: true, branchName: 'feature-2' });
    expect(gitInstruction).toHaveBeenCalledWith(
      'worker.git.branch.create',
      {
        scope: {
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: WORKSPACE_ROOT_REPO_ID,
        },
        name: 'feature',
        startPoint: { branch: 'main', remote: true },
      },
      { caller: { ...desktopCaller, grants: ['worker.git.write'] } },
    );
    expect(mockedCreateBranchAndCheckout).not.toHaveBeenCalled();
  });

  it('rethrows the host error a refusal carries', async () => {
    const hostError = new Error(
      'Cannot create a branch with uncommitted changes',
    );
    gitInstruction.mockRejectedValue(
      new CanopyOperationError(
        {
          kind: 'failed_precondition',
          code: 'worker.git.branch.uncommittedChanges',
          message: hostError.message,
          retry: { kind: 'never' },
        },
        hostError,
      ),
    );

    await expect(
      createHandler(null, {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        newBranchName: 'feature',
        baseBranch: 'main',
        baseBranchIsRemote: false,
      }),
    ).rejects.toBe(hostError);
  });
});

describe('worktree:set-label handler', () => {
  // The label semantics (trim, clear, unknown worktree) are covered by the
  // update boundary in lib/__tests__/worktree-update.test.ts.
  it('sends the label to the update boundary as a typed patch', async () => {
    mockedUpdateWorktree.mockResolvedValue({
      worktree: {
        id: 'wt-1',
        branchName: 'dev-swan',
        createdAt: '2026-06-01T00:00:00.000Z',
        label: 'My Label',
      },
      changed: true,
    });
    await labelHandler(null, {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      label: '  My Label  ',
    });

    expect(mockedValidateId).toHaveBeenCalledWith('ws-1', 'projectId');
    expect(mockedUpdateWorktree.mock.calls).toEqual([
      [
        {
          workspaceId: 'ws-1',
          worktreeId: 'wt-1',
          patch: { label: '  My Label  ' },
        },
      ],
    ]);
  });

  it('propagates a refusal from the boundary', async () => {
    mockedUpdateWorktree.mockRejectedValue(
      new Error('Worktree wt-missing not found in project ws-1'),
    );

    await expect(
      labelHandler(null, {
        projectId: 'ws-1',
        worktreeId: 'wt-missing',
        label: 'x',
      }),
    ).rejects.toThrow('Worktree wt-missing not found in project ws-1');
  });
});

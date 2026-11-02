import type * as SharedHooks from '@canopy/desktop-shared/hooks';

jest.mock('../../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
}));
jest.mock('../../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
  readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
}));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ scriptTimeoutMinutes: 7 }),
  ),
}));
jest.mock('../../lib/window-send', () => ({
  sendToWindow: jest.fn(() => true),
}));
jest.mock('../../lib/hook-watcher-events', () => {
  const { createHookKey } = jest.requireActual<typeof SharedHooks>(
    '@canopy/desktop-shared/hooks',
  );
  return {
    hookKeyForScope: (args: {
      scope: 'project' | 'workspace-root' | 'workspace-repo';
      triggerName: string;
      repoId?: string;
    }): string => createHookKey(args.scope, args.triggerName, args.repoId),
    buildHookWatcherVariables: jest.fn(() => ({ VARIABLES: 'yes' })),
    fireHookTriggeredWatchers: jest.fn(),
  };
});
jest.mock('../../lib/hook-runner', () => ({
  runHook: jest.fn(() =>
    Promise.resolve({
      success: true,
      stopped: false,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 1,
    }),
  ),
  stopRunningHook: jest.fn(),
}));
jest.mock('../../lib/github-pr-hook-state', () => ({
  getProjectRepoStorageKey: (): string => 'project-storage',
  getWorkspaceRootRepoStorageKey: (): string => 'root-storage',
  getWorkspaceRepoStorageKey: (repoId: string): string =>
    `repo-storage:${repoId}`,
  readCurrentPrTrackingSnapshot: jest.fn(),
}));

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  getHookTriggerDisplayName,
  type HookAction,
} from '@canopy/desktop-shared/hooks';
import {
  IPC_CHANNELS,
  type WorkspaceConfigFile,
} from '@canopy/desktop-shared/types';
import type { PersistedPrSnapshotFileV1 } from '@canopy/desktop-shared/types/github';
import { getProjectConfigFileCandidates } from '../../lib/canopy-json';
import { readCurrentPrTrackingSnapshot } from '../../lib/github-pr-hook-state';
import { createProjectHookDescriptor } from '../../lib/hook-events';
import {
  getResolvedHookActions,
  resolveProjectHooks,
} from '../../lib/hook-resolver';
import { runHook } from '../../lib/hook-runner';
import {
  buildHookWatcherVariables,
  fireHookTriggeredWatchers,
} from '../../lib/hook-watcher-events';
import { getWorktreeDir } from '../../lib/paths';
import { readAllSidebarItems } from '../../lib/sidebar-items';
import { sendToWindow } from '../../lib/window-send';
import { readWorkspaceConfig } from '../../lib/workspace-persistence';
import { triggerWorktreePrecommitFailureHook } from '../../lib/worktree-precommit-failure-hook';
import { runHookCommand } from '../../services/hooks-service';
import {
  acquireSplitLock,
  releaseSplitLock,
  SplitLockError,
} from '../../services/split-lock-service';

const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedFireWatchers = jest.mocked(fireHookTriggeredWatchers);
const mockedBuildVariables = jest.mocked(buildHookWatcherVariables);
const mockedRunHook = jest.mocked(runHook);
const mockedReadSnapshot = jest.mocked(readCurrentPrTrackingSnapshot);

const TRIGGER = 'worktree:precommit:failure';
const ACTIONS: HookAction[] = [{ type: 'command', command: 'notify' }];

function config(
  hooks: WorkspaceConfigFile['hooks'],
  overrides: Partial<WorkspaceConfigFile> = {},
): WorkspaceConfigFile {
  return {
    version: 1,
    type: 'single-repo',
    repoPath: '/does/not/exist',
    repos: [],
    hooks,
    ...overrides,
  };
}

function sidebarWithPaused(
  pausedHookKeys: string[],
): Awaited<ReturnType<typeof readAllSidebarItems>> {
  return {
    items: [
      {
        id: 'p-1',
        type: 'single-repo',
        worktrees: [{ id: 'w-1', pausedHookKeys }],
      },
    ],
  } as unknown as Awaited<ReturnType<typeof readAllSidebarItems>>;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('CAN-5062 golden: automatic hook paused gate', () => {
  const window = { id: 'window' };
  const trigger = (): Promise<void> =>
    triggerWorktreePrecommitFailureHook({
      projectId: 'p-1',
      worktreeId: 'w-1',
      repo: { repoPath: '/repo', repoName: 'Repo' },
      error: Object.assign(new Error('ignored'), { stderr: 'lint failed  \n' }),
      commitMessage: 'feat: x',
      getWindow: () => window as never,
    });

  it('skips a paused hook, tells the renderer, and still fires watchers', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({ [TRIGGER]: ACTIONS }));
    mockedReadAllSidebarItems.mockResolvedValue(
      sidebarWithPaused(['project:worktree:precommit:failure']),
    );

    await trigger();

    const hook = createProjectHookDescriptor(TRIGGER, ACTIONS);
    expect(hook.hookKey).toBe('project:worktree:precommit:failure');
    expect(mockedRunHook).not.toHaveBeenCalled();
    expect(mockedSendToWindow).toHaveBeenCalledTimes(1);
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      window,
      IPC_CHANNELS.hookSkippedPaused,
      {
        projectId: 'p-1',
        worktreeId: 'w-1',
        hook,
        triggerDisplayName: getHookTriggerDisplayName(TRIGGER),
      },
    );
    expect(mockedBuildVariables).toHaveBeenCalledWith({
      projectId: 'p-1',
      worktreeId: 'w-1',
      scope: 'project',
      repoId: undefined,
      env: {
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR: 'lint failed',
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE: 'feat: x',
      },
    });
    expect(mockedFireWatchers).toHaveBeenCalledWith({
      projectId: 'p-1',
      worktreeId: 'w-1',
      triggerName: TRIGGER,
      scope: 'project',
      repoId: undefined,
      repoName: 'Repo',
      hook,
      configured: true,
      paused: true,
      variables: { VARIABLES: 'yes' },
    });
  });

  it('runs an unpaused hook automatically with the failure environment and timeout', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({ [TRIGGER]: ACTIONS }));
    mockedReadAllSidebarItems.mockResolvedValue(sidebarWithPaused(['other']));

    await trigger();
    await settle();

    expect(mockedRunHook).toHaveBeenCalledTimes(1);
    expect(mockedRunHook.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'p-1',
      worktreeId: 'w-1',
      hook: createProjectHookDescriptor(TRIGGER, ACTIONS),
      cwd: '/repo',
      invocation: 'automatic',
      timeoutSeconds: 420,
      env: {
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_ERROR: 'lint failed',
        CANOPY_WORKTREE_PRECOMMIT_FAILURE_COMMIT_MESSAGE: 'feat: x',
      },
    });
    expect(mockedFireWatchers).toHaveBeenCalledWith(
      expect.objectContaining({ configured: true, paused: false }),
    );
  });

  it('fires watchers for an unconfigured or disabled trigger and runs nothing', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({ [TRIGGER]: null }));
    mockedReadAllSidebarItems.mockResolvedValue(
      sidebarWithPaused(['project:worktree:precommit:failure']),
    );

    await trigger();

    expect(mockedRunHook).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
    expect(mockedFireWatchers).toHaveBeenCalledWith(
      expect.objectContaining({
        hook: undefined,
        configured: false,
        paused: true,
      }),
    );
  });

  it('treats an unreadable sidebar as nothing paused', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({ [TRIGGER]: ACTIONS }));
    mockedReadAllSidebarItems.mockRejectedValue(new Error('corrupt'));

    await trigger();
    await settle();

    expect(mockedRunHook).toHaveBeenCalledTimes(1);
  });
});

describe('CAN-5062 golden: manual hook run gates', () => {
  const snapshot = {
    pr: { number: 1 },
  } as unknown as PersistedPrSnapshotFileV1;
  const request = {
    target: 'project',
    projectId: 'p-1',
    worktreeId: 'w-1',
    triggerName: 'pr:create',
  } as const;

  it('refuses a split-locked worktree before reading anything', async () => {
    acquireSplitLock('p-1', 'w-1');
    try {
      const refusal = runHookCommand(request);
      await expect(refusal).rejects.toThrow(SplitLockError);
      await expect(refusal).rejects.toThrow(
        'This worktree is locked while a Split PR is in progress; running a hook is unavailable until it finishes.',
      );
    } finally {
      releaseSplitLock('p-1', 'w-1');
    }
    expect(mockedReadWorkspaceConfig).not.toHaveBeenCalled();
    expect(mockedRunHook).not.toHaveBeenCalled();
  });

  it('succeeds as a no-op when the trigger has no actions, even without a PR', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(config({}));
    expect(await runHookCommand(request)).toEqual({
      success: true,
      stopped: false,
      exitCode: 0,
      output: '',
      timedOut: false,
      durationMs: 0,
    });
    expect(mockedReadSnapshot).not.toHaveBeenCalled();
  });

  it('requires an active PR snapshot for a configured hook', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      config({ 'pr:create': ACTIONS }),
    );
    mockedReadSnapshot.mockResolvedValue({
      snapshot: null,
      currentSnapshotPath: '/current',
      previousSnapshotPath: '/previous',
    });
    await expect(runHookCommand(request)).rejects.toMatchObject({
      code: 'execution_failed',
      message: 'No current PR snapshot exists for this worktree.',
    });
    expect(mockedReadSnapshot).toHaveBeenCalledWith({
      projectId: 'p-1',
      worktreeId: 'w-1',
      repoStorageKey: 'project-storage',
    });
    expect(mockedRunHook).not.toHaveBeenCalled();
  });

  it('runs a configured hook manually in the worktree with the PR snapshot', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      config({ 'pr:create': ACTIONS }),
    );
    mockedReadSnapshot.mockResolvedValue({
      snapshot,
      currentSnapshotPath: '/current',
      previousSnapshotPath: '/previous',
    });
    await runHookCommand(request);
    expect(mockedRunHook.mock.calls[0]?.[0]).toMatchObject({
      projectId: 'p-1',
      worktreeId: 'w-1',
      hook: createProjectHookDescriptor('pr:create', ACTIONS),
      cwd: getWorktreeDir('p-1', 'w-1'),
      invocation: 'manual',
      timeoutSeconds: 420,
      currentSnapshot: snapshot,
      currentSnapshotPath: '/current',
      previousSnapshotPath: '/previous',
    });
  });

  it('refuses an unknown workspace repo', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(
      config({}, { type: 'multi-repo', repos: [] }),
    );
    await expect(
      runHookCommand({
        target: 'workspace-repo',
        workspaceId: 'p-1',
        worktreeId: 'w-1',
        repoId: 'missing',
        triggerName: 'pr:create',
      }),
    ).rejects.toMatchObject({ code: 'not_found', message: 'Repo not found.' });
  });
});

describe('CAN-5062 golden: owner gate on execution-context overlays', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'can-5062-hook-owner-'));
    const configName = basename(getProjectConfigFileCandidates(repo)[0] ?? '');
    await writeFile(
      join(repo, configName),
      JSON.stringify({
        version: 1,
        hooks: { 'pr:create': [{ type: 'chat', prompt: 'Review it' }] },
      }),
      'utf8',
    );
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function resolveWith(
    executionContext: string,
    owner: WorkspaceConfigFile['owner'],
  ): Promise<HookAction[] | null> {
    const resolved = await resolveProjectHooks({
      repoPath: repo,
      owner,
      hooks: {
        'pr:create': [
          {
            type: 'chat',
            prompt: ' Review it ',
            executionContext,
            localExecutionContextOverlay: true,
          },
        ],
      },
    });
    return getResolvedHookActions(resolved, 'pr:create');
  }

  const owner = (organizationId: string): WorkspaceConfigFile['owner'] =>
    ({ type: 'organization', organizationId }) as WorkspaceConfigFile['owner'];

  it('applies an organization overlay only for the owning organization', async () => {
    expect(await resolveWith('org:org-1', owner('org-1'))).toEqual([
      { type: 'chat', prompt: 'Review it', executionContext: 'org:org-1' },
    ]);
    expect(await resolveWith('org:org-1', owner('org-2'))).toEqual([
      { type: 'chat', prompt: 'Review it' },
    ]);
    expect(await resolveWith('org:org-1', undefined)).toEqual([
      { type: 'chat', prompt: 'Review it' },
    ]);
  });

  it('applies a personal overlay regardless of owner', async () => {
    expect(await resolveWith('personal', undefined)).toEqual([
      { type: 'chat', prompt: 'Review it', executionContext: 'personal' },
    ]);
  });
});

import {
  changeWorktreeHookPause,
  saveWorkspaceRepoHooksFromService,
} from '../services/hooks-service';
import { rebindWorkspaceHookExecutionContexts } from '../lib/workspace-ownership';
import { updateWorkspaceConfig } from '../lib/workspace-persistence';
import type {
  WorkspaceConfigFile,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import { readWorkspaceWorktrees } from '../lib/workspace-persistence';
import { getWorktreePausedHookKeys } from '../services/hooks-service';
import {
  ScriptHookSettingsRefusedError,
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
} from '../lib/workspace-script-hook-settings';
import { PortalServiceError } from '../services/portal-service-error';

jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceWorktrees: jest.fn(),
  updateWorkspaceConfig: jest.fn(),
}));

jest.mock('../lib/workspace-script-hook-settings', () => {
  const actual: Record<string, unknown> = jest.requireActual(
    '../lib/workspace-script-hook-settings',
  );
  return {
    ...actual,
    setWorktreeHooksPaused: jest.fn(),
    updateWorkspaceHooks: jest.fn(),
  };
});

const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedSetWorktreeHooksPaused = jest.mocked(setWorktreeHooksPaused);
const mockedUpdateWorkspaceHooks = jest.mocked(updateWorkspaceHooks);

describe('worktree paused hooks', () => {
  it('reads and normalizes persisted keys even when hooks are absent', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        pausedHookKeys: ['deleted-hook', 'deleted-hook', ''],
      } as WorktreeData,
    ]);

    await expect(
      getWorktreePausedHookKeys({
        projectId: 'ws-1',
        worktreeId: 'wt-1',
      }),
    ).resolves.toEqual(['deleted-hook']);
  });

  it('keeps the not_found code for an unknown worktree', async () => {
    mockedSetWorktreeHooksPaused.mockRejectedValue(
      new ScriptHookSettingsRefusedError(
        'not-found',
        'Worktree wt-9 not found in project ws-1',
      ),
    );

    const error: unknown = await changeWorktreeHookPause({
      projectId: 'ws-1',
      worktreeId: 'wt-9',
      change: { kind: 'pause', hookKeys: ['hook-a'] },
      source: 'portal',
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(PortalServiceError);
    expect(error).toMatchObject({
      code: 'not_found',
      message: 'Worktree wt-9 not found in project ws-1',
    });
  });
});

it('keeps the not_found code for an unknown repository hook save', async () => {
  mockedUpdateWorkspaceHooks.mockRejectedValue(
    new ScriptHookSettingsRefusedError(
      'not-found',
      'Repo gone not found in project ws-1',
    ),
  );

  await expect(
    saveWorkspaceRepoHooksFromService({
      workspaceId: 'ws-1',
      repos: [{ repoId: 'gone', hooks: {} }],
    }),
  ).rejects.toMatchObject({
    name: 'PortalServiceError',
    code: 'not_found',
    message: 'Repo gone not found in project ws-1',
  });
});

it('persists rebound hook execution contexts after an ownership change', async (): Promise<void> => {
  const config: WorkspaceConfigFile = {
    version: 1,
    type: 'single-repo',
    hooks: {
      'worktree:created': [
        {
          type: 'pipeline',
          source: 'bundled',
          id: 'personal-pipeline',
          executionContext: 'personal',
        },
        {
          type: 'chat',
          prompt: 'Previously unbound',
        },
        {
          type: 'pipeline',
          source: 'bundled',
          id: 'other-org',
          executionContext: 'org:other',
        },
      ],
    },
    repos: [],
  };
  let written = false;
  jest
    .mocked(updateWorkspaceConfig)
    .mockImplementation(async (_workspaceId, update, options) => {
      const value = await update(config, {
        authority: 'ok',
        ownerMalformed: false,
        memoryMalformed: false,
      });
      written = options?.shouldWrite?.(value) ?? true;
      return value;
    });

  await expect(
    rebindWorkspaceHookExecutionContexts({
      workspaceId: 'ws-1',
      source: 'background_execution_rebinding',
      previousContext: 'personal',
      nextContext: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
  ).resolves.toEqual([
    'workspace-root:worktree:created:0',
    'workspace-root:worktree:created:1',
  ]);
  expect(jest.mocked(updateWorkspaceConfig).mock.calls[0]?.[0]).toBe('ws-1');
  expect(written).toBe(true);
  expect(config.hooks?.['worktree:created']).toEqual([
    expect.objectContaining({
      id: 'personal-pipeline',
      executionContext: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
    expect.objectContaining({
      prompt: 'Previously unbound',
      executionContext: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    }),
    expect.objectContaining({
      id: 'other-org',
      executionContext: 'org:other',
    }),
  ]);
});

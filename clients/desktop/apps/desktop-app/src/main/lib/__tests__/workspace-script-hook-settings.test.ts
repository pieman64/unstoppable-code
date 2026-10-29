// CAN-3816: the typed W5 script, hook, plan detection and paused-hook
// commands. Runs the real sidebar and persistence modules against a
// temporary data dir.
const mockRecordAppDiagnostic = jest.fn();
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: mockRecordAppDiagnostic,
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
const mockCapture = jest.fn<{ kind: string; organizationId?: string }, []>(
  () => ({ kind: 'personal' }),
);
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));
const mockWhenIdle = jest.fn((): Promise<void> => Promise.resolve());
jest.mock('../workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => mockWhenIdle(),
    getState: (): { context: ReturnType<typeof mockCapture> } => ({
      context: mockCapture(),
    }),
  }),
}));

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  MultiRepoSidebarItem,
  SidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  getWorkspaceConfigPath,
  getWorkspaceDir,
  getWorkspaceWorktreesFilePath,
} from '../paths';
import {
  __resetSidebarItemsStateForTests,
  readAllSidebarItems,
  writeAllSidebarItems,
} from '../sidebar-items';
import { nodeW5FileStore } from '../w5-file-store';
import {
  readWorkspaceWorktrees,
  updateWorkspaceConfig,
} from '../workspace-persistence';
import {
  ScriptHookSettingsRefusedError,
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
  updateWorkspacePlanDetection,
  updateWorkspaceScripts,
  type WorkspaceScriptsChange,
  type WorktreeHookPauseChange,
} from '../workspace-script-hook-settings';

type JsonRecord = Record<string, unknown>;

const WORKTREE: WorktreeData = {
  id: 'tree-a',
  branchName: 'tree-a-branch',
  createdAt: '2026-09-01T00:00:00.000Z',
};

const MULTI: MultiRepoSidebarItem = {
  id: 'multi-a',
  name: 'Multi A',
  type: 'multi-repo',
  color: '#0EA5E9',
  collapsed: false,
  order: 0,
  repos: [],
  worktrees: [WORKTREE],
};

const SEEDED: SidebarItem[] = [MULTI];

/** The manifest a test starts from, with a field this version does not know. */
const MANIFEST: JsonRecord = {
  version: 1,
  type: 'multi-repo',
  repos: [
    { id: 'api', name: 'api', repoPath: '/repos/api' },
    { id: 'web', name: 'web', repoPath: '/repos/web' },
  ],
  alwaysShow: true,
  scripts: { setup: { command: 'npm ci', timeoutSeconds: 60 }, lint: 'x' },
  hooks: { 'worktree:created': [{ type: 'command', command: 'echo hi' }] },
  planDetection: { disabledRuleIds: ['builtin-plans'] },
  futureField: { kept: true },
};

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function readManifest(workspaceId = 'multi-a'): Promise<JsonRecord> {
  const parsed: unknown = JSON.parse(
    await readFile(getWorkspaceConfigPath(workspaceId), 'utf8'),
  );
  if (!isRecord(parsed)) throw new Error('Expected a manifest object');
  return parsed;
}

async function repoField(repoId: string, field: string): Promise<unknown> {
  const repos = (await readManifest()).repos;
  if (!Array.isArray(repos)) throw new Error('Expected repositories');
  const repo: unknown = repos.find(
    (candidate: unknown) => isRecord(candidate) && candidate.id === repoId,
  );
  return isRecord(repo) ? repo[field] : undefined;
}

async function inode(filePath: string): Promise<number> {
  return (await stat(filePath)).ino;
}

async function exists(filePath: string): Promise<boolean> {
  return stat(filePath).then(
    () => true,
    () => false,
  );
}

async function expectRefusal(
  promise: Promise<unknown>,
  reason: ScriptHookSettingsRefusedError['reason'],
  message: RegExp,
): Promise<void> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ScriptHookSettingsRefusedError);
  expect(error).toMatchObject({ reason });
  expect(error instanceof Error ? error.message : '').toMatch(message);
}

function scripts(
  change: WorkspaceScriptsChange,
  workspaceId = 'multi-a',
): Promise<void> {
  return updateWorkspaceScripts({ workspaceId, change, source: 'desktop' });
}

function setPaused(
  change: WorktreeHookPauseChange,
  worktreeId = 'tree-a',
): ReturnType<typeof setWorktreeHooksPaused> {
  return setWorktreeHooksPaused({
    workspaceId: 'multi-a',
    worktreeId,
    change,
    source: 'portal',
  });
}

async function pausedKeys(): Promise<string[] | undefined> {
  const [worktree] = await readWorkspaceWorktrees('multi-a');
  return worktree?.pausedHookKeys;
}

describe('W5 script and hook settings commands (real fs)', () => {
  let dataDir: string;
  let originalDataDir: string | undefined;

  beforeEach(async () => {
    __resetSidebarItemsStateForTests();
    originalDataDir = process.env.CANOPY_DATA_DIR;
    dataDir = await mkdtemp(path.join(os.tmpdir(), 'canopy-ws-settings-'));
    process.env.CANOPY_DATA_DIR = dataDir;
    await writeAllSidebarItems(SEEDED);
    await writeFile(
      getWorkspaceConfigPath('multi-a'),
      JSON.stringify(MANIFEST),
    );
    jest.clearAllMocks();
  });

  it('captures hook context before taking the manifest lock so queued context writes finish', async () => {
    let requested: () => void = () => {};
    const contextRequested = new Promise<void>((resolve) => {
      requested = resolve;
    });
    // Created outside the settings call, like an earlier context-service job.
    const contextWrite = (async (): Promise<void> => {
      await contextRequested;
      await updateWorkspaceConfig('multi-a', (config): void => {
        config.alwaysShow = false;
      });
    })();
    mockWhenIdle.mockImplementationOnce((): Promise<void> => {
      requested();
      return contextWrite;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        updateWorkspaceHooks({
          workspaceId: 'multi-a',
          source: 'desktop',
          change: { kind: 'replace', hooks: { 'pr:create': null } },
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error('Hook context/manifest lock deadlock')),
            2000,
          );
        }),
      ]);
      expect((await readManifest()).alwaysShow).toBe(false);
      expect((await readManifest()).hooks).toEqual({ 'pr:create': null });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    mockWhenIdle.mockReset().mockResolvedValue(undefined);
    if (originalDataDir === undefined) {
      delete process.env.CANOPY_DATA_DIR;
    } else {
      process.env.CANOPY_DATA_DIR = originalDataDir;
    }
    await rm(dataDir, { recursive: true, force: true });
  });

  describe('updateWorkspaceScripts', () => {
    it('replaces only the scripts, keeping the type and every other setting', async () => {
      await scripts({
        kind: 'replace',
        scripts: { setup: 'make', teardown: null, launch: '   ' },
      });

      expect(await readManifest()).toMatchObject({
        type: 'multi-repo',
        // A blank script is dropped; a null tombstone is an intentional removal.
        scripts: { setup: 'make', teardown: null },
        hooks: MANIFEST.hooks,
        planDetection: MANIFEST.planDetection,
        futureField: { kept: true },
      });
      expect((await readManifest()).scripts).not.toHaveProperty('launch');
    });

    it('merges commands, keeping definitions and untouched scripts', async () => {
      await scripts({
        kind: 'merge-commands',
        commands: { setup: 'pnpm i', lint: '', teardown: 'make down' },
      });

      expect((await readManifest()).scripts).toEqual({
        setup: { command: 'pnpm i', timeoutSeconds: 60 },
        teardown: 'make down',
      });
    });

    it('leaves every other script as it is when one is edited', async () => {
      await scripts({ kind: 'merge-commands', commands: { lint: 'eslint' } });

      expect((await readManifest()).scripts).toEqual({
        setup: { command: 'npm ci', timeoutSeconds: 60 },
        lint: 'eslint',
      });
    });

    it('replaces the named repositories and skips unknown ones', async () => {
      await scripts({
        kind: 'repositories',
        repos: [
          { repoId: 'api', scripts: { setup: 'go mod download' } },
          { repoId: 'gone', scripts: { setup: 'echo' } },
        ],
      });

      expect(await repoField('api', 'scripts')).toEqual({
        setup: 'go mod download',
      });
      expect(await repoField('web', 'scripts')).toBeUndefined();
      expect((await readManifest()).scripts).toEqual(MANIFEST.scripts);
    });

    it('refuses non-string commands before writing', async () => {
      const before = await inode(getWorkspaceConfigPath('multi-a'));
      const commands: Record<string, string> = {};
      Reflect.set(commands, 'setup', 42);

      await expectRefusal(
        scripts({ kind: 'merge-commands', commands }),
        'invalid-request',
        /Invalid script commands/,
      );
      expect(await inode(getWorkspaceConfigPath('multi-a'))).toBe(before);
    });

    it('refuses the read-only shared-container scope', async () => {
      await expectRefusal(
        scripts(
          { kind: 'replace', scripts: { setup: 'x' } },
          'shared-container-viewer',
        ),
        'read-only-scope',
        /read-only/,
      );
      expect(await exists(getWorkspaceDir('shared-container-viewer'))).toBe(
        false,
      );
    });

    it('refuses a workspace without a manifest and never creates one', async () => {
      await expectRefusal(
        scripts({ kind: 'replace', scripts: { setup: 'x' } }, 'missing'),
        'configuration-unavailable',
        /settings could not be read/,
      );
      expect(await exists(getWorkspaceDir('missing'))).toBe(false);
    });

    it('refuses an unreadable manifest and leaves it as it is', async () => {
      await writeFile(getWorkspaceConfigPath('multi-a'), '{"version": 1, ');

      await expectRefusal(
        scripts({ kind: 'replace', scripts: { setup: 'x' } }),
        'configuration-unavailable',
        /settings could not be read/,
      );
      expect(await readFile(getWorkspaceConfigPath('multi-a'), 'utf8')).toBe(
        '{"version": 1, ',
      );
      expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'workspace_config_write_refused' }),
      );
    });

    it('rejects with the write error when the commit fails', async () => {
      const original = await readFile(
        getWorkspaceConfigPath('multi-a'),
        'utf8',
      );
      jest
        .spyOn(nodeW5FileStore, 'replace')
        .mockRejectedValueOnce(new Error('disk full'));

      await expect(
        scripts({ kind: 'replace', scripts: { setup: 'x' } }),
      ).rejects.toThrow('disk full');
      expect(await readFile(getWorkspaceConfigPath('multi-a'), 'utf8')).toBe(
        original,
      );
    });
  });

  describe('updateWorkspaceHooks', () => {
    const pipelineHook = {
      'worktree:created': [
        { type: 'pipeline' as const, source: 'bundled' as const, id: 'p' },
      ],
    };

    it('binds a newly enabled action and keeps a bound one on later saves', async () => {
      await updateWorkspaceHooks({
        workspaceId: 'multi-a',
        change: { kind: 'replace', hooks: pipelineHook },
        source: 'desktop',
      });
      mockCapture.mockReturnValue({
        kind: 'organization',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      await updateWorkspaceHooks({
        workspaceId: 'multi-a',
        change: { kind: 'replace', hooks: pipelineHook },
        source: 'desktop',
      });

      expect((await readManifest()).hooks).toEqual({
        'worktree:created': [
          expect.objectContaining({ id: 'p', executionContext: 'personal' }),
        ],
      });
      expect((await readManifest()).scripts).toEqual(MANIFEST.scripts);
    });

    it('keeps a disabled trigger and clears removed hooks', async () => {
      await updateWorkspaceHooks({
        workspaceId: 'multi-a',
        change: { kind: 'replace', hooks: { 'worktree:created': null } },
        source: 'desktop',
      });
      expect((await readManifest()).hooks).toEqual({
        'worktree:created': null,
      });

      await updateWorkspaceHooks({
        workspaceId: 'multi-a',
        change: { kind: 'replace', hooks: {} },
        source: 'desktop',
      });
      expect(await readManifest()).not.toHaveProperty('hooks');
    });

    it('refuses an unknown repository without writing any', async () => {
      const before = await inode(getWorkspaceConfigPath('multi-a'));

      await expectRefusal(
        updateWorkspaceHooks({
          workspaceId: 'multi-a',
          change: {
            kind: 'repositories',
            repos: [
              { repoId: 'api', hooks: pipelineHook },
              { repoId: 'gone', hooks: pipelineHook },
            ],
          },
          source: 'desktop',
        }),
        'not-found',
        /^Repo gone not found in project multi-a$/,
      );
      expect(await inode(getWorkspaceConfigPath('multi-a'))).toBe(before);
    });

    it('updates the named repositories', async () => {
      await updateWorkspaceHooks({
        workspaceId: 'multi-a',
        change: {
          kind: 'repositories',
          repos: [{ repoId: 'web', hooks: { 'pr:create': null } }],
        },
        source: 'desktop',
      });

      expect(await repoField('web', 'hooks')).toEqual({ 'pr:create': null });
      expect(await repoField('api', 'hooks')).toBeUndefined();
      expect((await readManifest()).hooks).toEqual(MANIFEST.hooks);
    });
  });

  describe('updateWorkspacePlanDetection', () => {
    it('writes the normalized configuration and clears an empty one', async () => {
      await updateWorkspacePlanDetection({
        workspaceId: 'multi-a',
        planDetection: { disabledRuleIds: [' a ', 'a', 'b'] },
        source: 'desktop',
      });
      expect((await readManifest()).planDetection).toEqual({
        disabledRuleIds: ['a', 'b'],
      });

      await updateWorkspacePlanDetection({
        workspaceId: 'multi-a',
        planDetection: {},
        source: 'desktop',
      });
      expect(await readManifest()).not.toHaveProperty('planDetection');
      expect((await readManifest()).scripts).toEqual(MANIFEST.scripts);
    });

    it('refuses a configuration that is not an object', async () => {
      const before = await inode(getWorkspaceConfigPath('multi-a'));
      // An untyped IPC payload can carry any value.
      const request: Parameters<typeof updateWorkspacePlanDetection>[0] = {
        workspaceId: 'multi-a',
        planDetection: {},
        source: 'desktop',
      };
      Reflect.set(request, 'planDetection', 'all');
      await expectRefusal(
        updateWorkspacePlanDetection(request),
        'invalid-request',
        /Invalid plan detection settings/,
      );
      expect(await inode(getWorkspaceConfigPath('multi-a'))).toBe(before);
    });
  });

  it('keeps every one of competing script, hook and plan detection writes', async () => {
    await Promise.all([
      scripts({ kind: 'merge-commands', commands: { teardown: 'make down' } }),
      scripts({
        kind: 'repositories',
        repos: [{ repoId: 'api', scripts: { setup: 'go' } }],
      }),
      updateWorkspaceHooks({
        workspaceId: 'multi-a',
        change: { kind: 'replace', hooks: { 'pr:create': null } },
        source: 'desktop',
      }),
      updateWorkspacePlanDetection({
        workspaceId: 'multi-a',
        planDetection: { disabledRuleIds: ['b'] },
        source: 'desktop',
      }),
    ]);

    const manifest = await readManifest();
    expect(manifest.scripts).toMatchObject({ teardown: 'make down' });
    expect(manifest.hooks).toEqual({ 'pr:create': null });
    expect(manifest.planDetection).toEqual({ disabledRuleIds: ['b'] });
    expect(await repoField('api', 'scripts')).toEqual({ setup: 'go' });
  });

  describe('setWorktreeHooksPaused', () => {
    it('replaces the paused set and removes the key when it is empty', async () => {
      const paused = await setPaused({
        kind: 'replace',
        pausedHookKeys: ['hook-b', 'hook-a', 'hook-b', '', null],
      });
      expect(paused).toMatchObject({
        pausedHookKeys: ['hook-a', 'hook-b'],
        changed: true,
      });
      expect(await pausedKeys()).toEqual(['hook-a', 'hook-b']);

      const resumed = await setPaused({ kind: 'replace', pausedHookKeys: [] });
      expect(resumed.worktree).not.toHaveProperty('pausedHookKeys');
      expect(await pausedKeys()).toBeUndefined();
    });

    it('pauses and resumes only the named keys', async () => {
      await setPaused({ kind: 'pause', hookKeys: ['hook-a', 'hook-b'] });
      const outcome = await setPaused({ kind: 'resume', hookKeys: ['hook-a'] });

      expect(outcome.pausedHookKeys).toEqual(['hook-b']);
      expect(await pausedKeys()).toEqual(['hook-b']);
    });

    it('writes nothing when the set is unchanged', async () => {
      await setPaused({ kind: 'pause', hookKeys: ['hook-a'] });
      const before = await inode(getWorkspaceWorktreesFilePath('multi-a'));

      const outcome = await setPaused({ kind: 'pause', hookKeys: ['hook-a'] });

      expect(outcome.changed).toBe(false);
      expect(await inode(getWorkspaceWorktreesFilePath('multi-a'))).toBe(
        before,
      );
    });

    it('keeps every one of competing pauses and resumes', async () => {
      await setPaused({ kind: 'pause', hookKeys: ['hook-c'] });

      await Promise.all([
        setPaused({ kind: 'pause', hookKeys: ['hook-a'] }),
        setPaused({ kind: 'pause', hookKeys: ['hook-b'] }),
        setPaused({ kind: 'resume', hookKeys: ['hook-c'] }),
      ]);

      expect(await pausedKeys()).toEqual(['hook-a', 'hook-b']);
    });

    it('a stale sidebar save neither undoes a pause nor brings a resumed key back', async () => {
      const staleSnapshot = await readAllSidebarItems();
      await setPaused({ kind: 'pause', hookKeys: ['hook-a'] });

      await writeAllSidebarItems(staleSnapshot.items);
      expect(await pausedKeys()).toEqual(['hook-a']);

      const pausedSnapshot = await readAllSidebarItems();
      await setPaused({ kind: 'resume', hookKeys: ['hook-a'] });

      await writeAllSidebarItems(pausedSnapshot.items);
      expect(await pausedKeys()).toBeUndefined();
    });

    it('refuses an unknown worktree', async () => {
      await expectRefusal(
        setPaused({ kind: 'pause', hookKeys: ['hook-a'] }, 'tree-gone'),
        'not-found',
        /^Worktree tree-gone not found in project multi-a$/,
      );
    });

    it('refuses an unreadable worktree list and leaves it as it is', async () => {
      await writeFile(getWorkspaceWorktreesFilePath('multi-a'), '{"worktr');

      await expectRefusal(
        setPaused({ kind: 'pause', hookKeys: ['hook-a'] }),
        'worktrees-unavailable',
        /worktree list couldn't be read/,
      );
      expect(
        await readFile(getWorkspaceWorktreesFilePath('multi-a'), 'utf8'),
      ).toBe('{"worktr');
    });

    it('rejects with the write error when the commit fails', async () => {
      jest
        .spyOn(nodeW5FileStore, 'replace')
        .mockRejectedValueOnce(new Error('disk full'));

      await expect(
        setPaused({ kind: 'pause', hookKeys: ['hook-a'] }),
      ).rejects.toThrow('disk full');
      expect(await pausedKeys()).toBeUndefined();
    });

    it('refuses the read-only shared-container scope', async () => {
      await expectRefusal(
        setWorktreeHooksPaused({
          workspaceId: 'shared-container-viewer',
          worktreeId: 'tree-a',
          change: { kind: 'pause', hookKeys: ['hook-a'] },
          source: 'desktop',
        }),
        'read-only-scope',
        /read-only/,
      );
    });
  });
});

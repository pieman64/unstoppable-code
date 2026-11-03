// CAN-4370: keyed replay and revisions of the script, hook, plan detection
// and paused-hook commands, with the real commit-log worker and filesystem.
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import {
  W5CommitLog,
  type W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../../feature-flags', () => ({
  getFeatureFlagService: (): { isEnabled: () => boolean } => ({
    isEnabled: (): boolean => true,
  }),
}));
const ORGANIZATION = {
  kind: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
} as const;
const mockCapture = jest.fn<{ kind: 'personal' } | typeof ORGANIZATION, []>(
  () => ({ kind: 'personal' }),
);
jest.mock('../workspace-context-service', () => ({
  getWorkspaceContextService: (): unknown => ({
    initialize: (): Promise<void> => Promise.resolve(),
    whenIdle: (): Promise<void> => Promise.resolve(),
    getState: (): { context: ReturnType<typeof mockCapture> } => ({
      context: mockCapture(),
    }),
  }),
}));

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  DESKTOP_SCRIPT_CALLER,
  scriptDefinitionsDispatcher,
} from '../../__tests__/helpers/script-definitions-dispatcher';
import {
  mergeWorkspaceScriptCommands,
  saveWorkspaceRepoScripts,
  saveWorkspaceScripts,
} from '../script-definition-saves';
import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5RevisionConflictError,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import * as workspacePersistence from '../workspace-persistence';
import { readWorkspaceWorktrees } from '../workspace-persistence';
import {
  ScriptHookSettingsRefusedError,
  setWorktreeHooksPaused,
  updateWorkspaceHooks,
  updateWorkspacePlanDetection,
  updateWorkspaceScripts,
  type WorktreeHookPauseChange,
} from '../workspace-script-hook-settings';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}

beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: 'one', branchName: 'old', createdAt },
  ]));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  startHost();
  mockCapture.mockImplementation(() => ({ kind: 'personal' }));
  jest.clearAllMocks();
});
afterEach(async () => {
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

async function restartHost(): Promise<void> {
  await host.shutdown();
  startHost();
}

function images(): string[] {
  return ['index.json', 'a/workspace.json', 'a/worktrees.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}

function manifest(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(images()[1] ?? '');
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Expected a manifest object');
  return { ...parsed };
}

const kinds = ['scripts', 'hooks', 'planDetection', 'paused'] as const;
type Kind = (typeof kinds)[number];

function resourceOf(kind: Kind): string {
  return kind === 'paused' ? 'worktree:a/one' : 'workspace:a';
}

function w5Resource(kind: Kind): W5Resource {
  return kind === 'paused'
    ? { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' }
    : { kind: 'workspace', workspaceId: 'a' };
}

function revision(kind: Kind): Promise<number> {
  return host.revision(w5Resource(kind));
}

function invoke(
  kind: Kind,
  options: {
    expectedRevision?: number;
    idempotencyKey?: string;
    changed?: boolean;
  } = {},
): Promise<unknown> {
  const { changed, ...boundary } = options;
  switch (kind) {
    case 'scripts':
      return updateWorkspaceScripts({
        ...boundary,
        workspaceId: 'a',
        source: 'desktop',
        change: {
          kind: 'merge-commands',
          commands: { setup: changed ? 'pnpm i' : 'npm ci' },
        },
      });
    case 'hooks':
      return updateWorkspaceHooks({
        ...boundary,
        workspaceId: 'a',
        source: 'desktop',
        change: {
          kind: 'replace',
          hooks: {
            'worktree:created': [
              { type: 'pipeline', source: 'bundled', id: changed ? 'q' : 'p' },
            ],
          },
        },
      });
    case 'planDetection':
      return updateWorkspacePlanDetection({
        ...boundary,
        workspaceId: 'a',
        source: 'desktop',
        planDetection: { disabledRuleIds: [changed ? 'b' : 'a'] },
      });
    case 'paused':
      return setWorktreeHooksPaused({
        ...boundary,
        workspaceId: 'a',
        worktreeId: 'one',
        source: 'portal',
        change: { kind: 'pause', hookKeys: [changed ? 'hook-b' : 'hook-a'] },
      });
  }
}

/** An unkeyed change that undoes `invoke(kind)`'s change. */
function supersede(kind: Kind): Promise<unknown> {
  return kind === 'paused'
    ? setWorktreeHooksPaused({
        workspaceId: 'a',
        worktreeId: 'one',
        source: 'desktop',
        change: { kind: 'resume', hookKeys: ['hook-a'] },
      })
    : invoke(kind, { changed: true });
}

it.each(kinds)(
  '%s saves its outcome with the settings in one decision and replays it without a write',
  async (kind) => {
    const commits = jest.spyOn(host, 'commit');
    const first = await invoke(kind, {
      idempotencyKey: 'key',
      expectedRevision: 0,
    });
    expect(commits).toHaveBeenCalledTimes(1);
    const [decision] = commits.mock.calls[0] ?? [];
    expect(decision?.operation).toMatch(/^core\./);
    expect(decision?.receipt?.caller).toMatch(/^desktop-host:/);
    expect(typeof decision?.reservationId).toBe('string');
    expect(decision?.expectedRevisions).toEqual([
      { resource: w5Resource(kind), revision: 0 },
    ]);
    expect(decision?.files).toHaveLength(1);
    expect(JSON.stringify(decision?.outcome)).not.toContain(dir);
    expect(await revision(kind)).toBe(1);

    const before = images();
    // Replay precedes the revision check: a stale revision still replays.
    expect(
      await invoke(kind, { idempotencyKey: 'key', expectedRevision: 999 }),
    ).toEqual(first);
    expect(images()).toEqual(before);
    expect(commits).toHaveBeenCalledTimes(1);
  },
);

it.each(kinds)(
  '%s replays after the worker restarts, without a write',
  async (kind) => {
    const first = await invoke(kind, { idempotencyKey: 'key' });
    // A later unkeyed change the replay must not undo.
    await supersede(kind);
    await restartHost();
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    expect(await invoke(kind, { idempotencyKey: 'key' })).toEqual(first);
    expect(images()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
  },
);

it.each(kinds)(
  '%s refuses changed parameters for a used key with unchanged bytes',
  async (kind) => {
    await invoke(kind, { idempotencyKey: 'key' });
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    await expect(
      invoke(kind, { idempotencyKey: 'key', changed: true }),
    ).rejects.toMatchObject({ reason: 'key-reused' });
    expect(images()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
  },
);

it.each(kinds)(
  '%s refuses a stale revision with unchanged bytes and releases the key',
  async (kind) => {
    const before = images();
    for (const idempotencyKey of [undefined, 'key']) {
      const pending = invoke(kind, { idempotencyKey, expectedRevision: 1 });
      await expect(pending).rejects.toBeInstanceOf(W5RevisionConflictError);
      await expect(pending).rejects.toMatchObject({
        resource: resourceOf(kind),
        expected: 1,
        actual: 0,
      });
      expect(images()).toEqual(before);
    }
    expect(await revision(kind)).toBe(0);
    await invoke(kind, { idempotencyKey: 'key', expectedRevision: 0 });
    expect(images()).not.toEqual(before);
  },
);

it.each(kinds)(
  '%s refuses a revision that went stale at the decision with unchanged bytes',
  async (kind) => {
    const before = images();
    // The preflight passes; the worker's decision sees the newer revision.
    jest.spyOn(host, 'revision').mockResolvedValueOnce(1);
    await expect(invoke(kind, { expectedRevision: 1 })).rejects.toBeInstanceOf(
      W5RevisionConflictError,
    );
    expect(images()).toEqual(before);
    expect(await revision(kind)).toBe(0);
  },
);

it.each(kinds)(
  '%s releases the key when the decision refuses a stale revision',
  async (kind) => {
    const before = images();
    jest.spyOn(host, 'revision').mockResolvedValueOnce(1);
    await expect(
      invoke(kind, { idempotencyKey: 'key', expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    expect(images()).toEqual(before);
    expect(await revision(kind)).toBe(0);
    await invoke(kind, { idempotencyKey: 'key', expectedRevision: 0 });
    expect(images()).not.toEqual(before);
    expect(await revision(kind)).toBe(1);
  },
);

it.each(kinds)(
  '%s replays a decision whose response was lost, before and after a restart',
  async (kind) => {
    const before = images();
    const commit = host.commit.bind(host);
    let saved: unknown;
    const commits = jest
      .spyOn(host, 'commit')
      .mockImplementationOnce(async (request) => {
        await commit(request);
        saved = request.outcome;
        throw new Error('response lost');
      });
    await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toThrow(
      'response lost',
    );
    expect(images()).not.toEqual(before);
    expect(await revision(kind)).toBe(1);
    // A later unkeyed change the replays must not undo.
    await supersede(kind);
    const superseded = images();
    expect(commits).toHaveBeenCalledTimes(2);
    const expected = kind === 'paused' ? saved : undefined;
    expect(await invoke(kind, { idempotencyKey: 'key' })).toEqual(expected);
    await restartHost();
    const restarted = jest.spyOn(host, 'commit');
    expect(await invoke(kind, { idempotencyKey: 'key' })).toEqual(expected);
    expect(images()).toEqual(superseded);
    expect(commits).toHaveBeenCalledTimes(2);
    expect(restarted).not.toHaveBeenCalled();
  },
);

it.each(kinds)(
  '%s keeps an attempt interrupted before its decision recovery-required after restart',
  async (kind) => {
    const before = images();
    jest.spyOn(host, 'commit').mockImplementationOnce(async () => {
      await host.shutdown();
      throw new Error('interrupted before decision');
    });
    await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toThrow(
      'interrupted before decision',
    );
    await restartHost();
    expect(images()).toEqual(before);
    const commits = jest.spyOn(host, 'commit');
    await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toMatchObject(
      { reason: 'recovery-required' },
    );
    expect(images()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
  },
);

it.each(kinds)(
  '%s applies a decision interrupted before its files and replays the saved outcome',
  async (kind) => {
    const before = images();
    let saved: unknown;
    jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
      await host.shutdown();
      const log = W5CommitLog.open(join(dir, 'w5', 'commit-log.sqlite'));
      try {
        log.commit(request);
        saved = request.outcome;
      } finally {
        log.close();
      }
      throw new Error('interrupted after decision');
    });
    await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toThrow(
      'interrupted after decision',
    );
    await restartHost();
    expect((await host.recoveryReport()).applied).toHaveLength(1);
    expect(images()).not.toEqual(before);
    await supersede(kind);
    const superseded = images();
    const commits = jest.spyOn(host, 'commit');
    const replayed = await invoke(kind, { idempotencyKey: 'key' });
    if (kind === 'paused') expect(replayed).toEqual(saved);
    else expect(replayed).toBeUndefined();
    expect(images()).toEqual(superseded);
    expect(commits).not.toHaveBeenCalled();
  },
);

it.each(kinds)(
  '%s marks a failed decision recovery-required at once and keeps it',
  async (kind) => {
    const reserve = jest.spyOn(host, 'reserve');
    const error = Object.assign(new Error('worker failed'), { code: 'EIO' });
    jest.spyOn(host, 'commit').mockRejectedValueOnce(error);
    await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toBe(error);
    const receipt = reserve.mock.calls[0]?.[0].receipt;
    if (!receipt) throw new Error('Expected a durable reservation');
    expect(await host.lookupReceipt(receipt)).toMatchObject({
      status: 'recovery-required',
      diagnostics: { errorCode: 'EIO' },
    });
    const before = images();
    await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toMatchObject(
      { reason: 'recovery-required' },
    );
    expect(images()).toEqual(before);
  },
);

it.each(kinds)(
  '%s releases the key of a proven pre-effect refusal',
  async (kind) => {
    const file =
      kind === 'paused'
        ? join(root, 'a', 'worktrees.json')
        : join(root, 'a', 'workspace.json');
    const original = readFileSync(file, 'utf8');
    if (kind === 'paused')
      writeFileSync(file, JSON.stringify({ version: 1, worktrees: [] }));
    else renameSync(file, `${file}.moved`);
    const refused = invoke(kind, { idempotencyKey: 'key' });
    await expect(refused).rejects.toBeInstanceOf(
      ScriptHookSettingsRefusedError,
    );
    await expect(refused).rejects.toMatchObject({
      reason: kind === 'paused' ? 'not-found' : 'configuration-unavailable',
    });
    if (kind === 'paused') writeFileSync(file, original);
    else renameSync(`${file}.moved`, file);
    await invoke(kind, { idempotencyKey: 'key' });
    expect(readFileSync(file, 'utf8')).not.toBe(original);
  },
);

it.each(kinds)(
  '%s without a key commits once, with no receipt',
  async (kind) => {
    const commits = jest.spyOn(host, 'commit');
    await invoke(kind);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0]).toMatchObject({
      receipt: undefined,
      reservationId: undefined,
      expectedRevisions: undefined,
      outcome: null,
    });
    // The same change again writes nothing and makes no decision.
    await invoke(kind);
    expect(commits).toHaveBeenCalledTimes(1);
  },
);

it('competing unrevisioned and keyed settings writes all land', async () => {
  await Promise.all([
    invoke('scripts', { idempotencyKey: 'scripts' }),
    updateWorkspaceScripts({
      workspaceId: 'a',
      source: 'portal',
      change: { kind: 'merge-commands', commands: { teardown: 'make down' } },
    }),
    invoke('hooks'),
    invoke('planDetection', { idempotencyKey: 'plan' }),
  ]);
  expect(manifest()).toMatchObject({
    scripts: { setup: 'npm ci', teardown: 'make down' },
    hooks: {
      'worktree:created': [expect.objectContaining({ id: 'p' })],
    },
    planDetection: { disabledRuleIds: ['a'] },
  });
  expect(await revision('scripts')).toBe(4);
});

function pause(
  change: WorktreeHookPauseChange,
  idempotencyKey?: string,
): ReturnType<typeof setWorktreeHooksPaused> {
  return setWorktreeHooksPaused({
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'app_advisor',
    change,
    idempotencyKey,
  });
}

async function pausedKeys(): Promise<string[] | undefined> {
  const [row] = await readWorkspaceWorktrees('a');
  return row?.pausedHookKeys;
}

it('keyed pause and resume deltas compose with competing writes, and replays never reapply them', async () => {
  await pause({ kind: 'pause', hookKeys: ['hook-c'] });
  const [pausedA, pausedB, resumedC] = await Promise.all([
    pause({ kind: 'pause', hookKeys: ['hook-a'] }, 'pause-a'),
    pause({ kind: 'pause', hookKeys: ['hook-b'] }),
    pause({ kind: 'resume', hookKeys: ['hook-c'] }, 'resume-c'),
  ]);
  expect(pausedB.changed).toBe(true);
  expect(await pausedKeys()).toEqual(['hook-a', 'hook-b']);

  await pause({ kind: 'resume', hookKeys: ['hook-a'] });
  await pause({ kind: 'pause', hookKeys: ['hook-c'] });
  const before = images();
  const commits = jest.spyOn(host, 'commit');
  expect(
    await pause({ kind: 'pause', hookKeys: ['hook-a'] }, 'pause-a'),
  ).toEqual(pausedA);
  expect(
    await pause({ kind: 'resume', hookKeys: ['hook-c'] }, 'resume-c'),
  ).toEqual(resumedC);
  expect(commits).not.toHaveBeenCalled();
  expect(images()).toEqual(before);
  expect(await pausedKeys()).toEqual(['hook-b', 'hook-c']);
});

it('a replacement set and a pause delta are distinct keyed requests', async () => {
  await pause({ kind: 'pause', hookKeys: ['hook-a'] }, 'key');
  await expect(
    pause({ kind: 'replace', pausedHookKeys: ['hook-a'] }, 'key'),
  ).rejects.toMatchObject({ reason: 'key-reused' });
  await expect(
    pause({ kind: 'resume', hookKeys: ['hook-a'] }, 'key'),
  ).rejects.toMatchObject({ reason: 'key-reused' });
  // The admitted replacement set is normalized, so an equivalent one replays.
  const replaced = await pause(
    { kind: 'replace', pausedHookKeys: ['hook-b', 'hook-a', 'hook-b', ''] },
    'replace',
  );
  expect(
    await pause(
      { kind: 'replace', pausedHookKeys: ['hook-a', 'hook-b'] },
      'replace',
    ),
  ).toEqual(replaced);
  expect(replaced).toMatchObject({
    pausedHookKeys: ['hook-a', 'hook-b'],
    worktree: { id: 'one', pausedHookKeys: ['hook-a', 'hook-b'] },
  });
});

it('a keyed pause publishes its notification only after the decision, and its replay none', async () => {
  const commit = host.commit.bind(host);
  const decisions = jest
    .spyOn(host, 'commit')
    .mockImplementation(async (request) => {
      expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
      return commit(request);
    });
  await invoke('paused', { idempotencyKey: 'key' });
  expect(notifyPortalStructureChanged).toHaveBeenCalledTimes(1);
  decisions.mockRestore();
  await supersede('paused');
  jest.mocked(notifyPortalStructureChanged).mockClear();
  await invoke('paused', { idempotencyKey: 'key' });
  expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
  expect(await pausedKeys()).toBeUndefined();
});

it('a hooks replay keeps its binding and never captures a changed host context', async () => {
  const hooks = {
    'worktree:created': [
      { type: 'pipeline' as const, source: 'bundled' as const, id: 'p' },
    ],
  };
  const save = (key: string, executionContext?: string): Promise<void> =>
    updateWorkspaceHooks({
      workspaceId: 'a',
      source: 'desktop',
      idempotencyKey: key,
      change: {
        kind: 'replace',
        hooks: {
          'worktree:created': hooks['worktree:created'].map((action) => ({
            ...action,
            executionContext,
          })),
        },
      },
    });
  await save('key');
  const personal = serializeWorkspaceContext({ kind: 'personal' });
  expect(manifest().hooks).toEqual({
    'worktree:created': [
      expect.objectContaining({ id: 'p', executionContext: personal }),
    ],
  });
  await restartHost();
  mockCapture.mockClear();
  mockCapture.mockImplementation(() => ORGANIZATION);
  const before = images();
  // A caller-echoed context is not part of the admitted change.
  await save('key', serializeWorkspaceContext(ORGANIZATION));
  expect(mockCapture).not.toHaveBeenCalled();
  expect(images()).toEqual(before);

  // A new key binds only a new action; the stored one keeps its context.
  await updateWorkspaceHooks({
    workspaceId: 'a',
    source: 'desktop',
    idempotencyKey: 'second',
    change: {
      kind: 'replace',
      hooks: {
        'worktree:created': [
          ...hooks['worktree:created'],
          { type: 'pipeline', source: 'bundled', id: 'q' },
        ],
      },
    },
  });
  expect(mockCapture).toHaveBeenCalledTimes(1);
  expect(manifest().hooks).toEqual({
    'worktree:created': [
      expect.objectContaining({ id: 'p', executionContext: personal }),
      expect.objectContaining({
        id: 'q',
        executionContext: serializeWorkspaceContext(ORGANIZATION),
      }),
    ],
  });
});

it('keyed scripts keep intentional removals and repository changes', async () => {
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'api', name: 'api', repoPath: join(dir, 'repo') }],
      scripts: { setup: 'npm ci', lint: 'eslint' },
    }),
  );
  await updateWorkspaceScripts({
    workspaceId: 'a',
    source: 'desktop',
    idempotencyKey: 'remove',
    change: { kind: 'merge-commands', commands: { lint: '' } },
  });
  await updateWorkspaceScripts({
    workspaceId: 'a',
    source: 'desktop',
    idempotencyKey: 'repos',
    change: {
      kind: 'repositories',
      repos: [{ repoId: 'api', scripts: { setup: 'go mod download' } }],
    },
  });
  expect(manifest()).toMatchObject({
    scripts: { setup: 'npm ci' },
    repos: [expect.objectContaining({ scripts: { setup: 'go mod download' } })],
  });
  expect(manifest().scripts).not.toHaveProperty('lint');
});

it.each(kinds)(
  '%s lets one of two writes at the same revision land and releases the other key',
  async (kind) => {
    const results = await Promise.allSettled([
      invoke(kind, { idempotencyKey: 'first', expectedRevision: 0 }),
      invoke(kind, {
        idempotencyKey: 'second',
        expectedRevision: 0,
        changed: true,
      }),
    ]);
    const refused = results.filter((result) => result.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]?.reason).toBeInstanceOf(W5RevisionConflictError);
    expect(await revision(kind)).toBe(1);
    const loser = results[0]?.status === 'rejected' ? 'first' : 'second';
    await invoke(kind, {
      idempotencyKey: loser,
      expectedRevision: 1,
      changed: loser === 'second',
    });
    expect(await revision(kind)).toBe(2);
  },
);

it.each(kinds)(
  '%s refuses a same-key attempt while the first is deciding, then replays it',
  async (kind) => {
    const commit = host.commit.bind(host);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let deciding: () => void = () => {};
    const decidingStarted = new Promise<void>((resolve) => {
      deciding = resolve;
    });
    jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
      deciding();
      await gate;
      return commit(request);
    });
    const first = invoke(kind, { idempotencyKey: 'key' });
    await decidingStarted;
    await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toMatchObject(
      { reason: 'in-progress' },
    );
    release();
    const outcome = await first;
    const before = images();
    expect(await invoke(kind, { idempotencyKey: 'key' })).toEqual(outcome);
    expect(images()).toEqual(before);
  },
);

it('a keyed definition change replays its outcome and refuses the key for another change (CAN-4153)', async () => {
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      repos: [],
      scripts: { setup: 'npm ci' },
    }),
  );
  const set = (value: string): Promise<void> =>
    updateWorkspaceScripts({
      workspaceId: 'a',
      source: 'desktop',
      idempotencyKey: 'definition',
      change: { kind: 'definition', name: 'lint', value },
    });
  await set('eslint .');
  await updateWorkspaceScripts({
    workspaceId: 'a',
    source: 'desktop',
    change: { kind: 'remove-definition', name: 'lint' },
  });
  // A retry with the same key returns the saved outcome and writes nothing.
  await set(' eslint . ');
  expect(manifest().scripts).toEqual({ setup: 'npm ci' });
  await expect(set('prettier')).rejects.toMatchObject({ reason: 'key-reused' });
});

it('the save projections change only the edited scripts through keyed upsert and delete (CAN-5369)', async () => {
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      repos: [
        {
          id: 'api',
          name: 'api',
          repoPath: join(dir, 'repo'),
          scripts: { setup: 'old' },
        },
      ],
      scripts: {
        setup: { command: 'npm ci', timeoutSeconds: 60 },
        launch: 'npm run dev',
      },
    }),
  );
  const dispatcher = scriptDefinitionsDispatcher();
  const reserve = jest.spyOn(host, 'reserve');
  await mergeWorkspaceScriptCommands(dispatcher, DESKTOP_SCRIPT_CALLER, {
    workspaceId: 'a',
    commands: { setup: 'pnpm i', launch: '' },
  });
  expect(manifest().scripts).toEqual({
    setup: { command: 'pnpm i', timeoutSeconds: 60 },
  });
  await saveWorkspaceRepoScripts(dispatcher, DESKTOP_SCRIPT_CALLER, {
    workspaceId: 'a',
    repos: [
      { repoId: 'api', scripts: { setup: 'new' } },
      { repoId: 'gone', scripts: { setup: 'x' } },
    ],
  });
  expect(manifest().repos).toEqual([
    expect.objectContaining({ id: 'api', scripts: { setup: 'new' } }),
  ]);
  // One keyed commit per changed script, and none for an unchanged save.
  expect(reserve).toHaveBeenCalledTimes(3);
  await saveWorkspaceScripts(dispatcher, DESKTOP_SCRIPT_CALLER, {
    workspaceId: 'a',
    scripts: { setup: { command: 'pnpm i', timeoutSeconds: 60 } },
  });
  expect(reserve).toHaveBeenCalledTimes(3);
  expect(await revision('scripts')).toBe(3);
});

it('a save projection never creates a manifest and releases its key (CAN-5369)', async () => {
  const reserve = jest.spyOn(host, 'reserve');
  await expect(
    saveWorkspaceScripts(scriptDefinitionsDispatcher(), DESKTOP_SCRIPT_CALLER, {
      workspaceId: 'missing',
      scripts: { setup: 'npm ci' },
    }),
  ).rejects.toThrow(/settings could not be read/);
  const receipt = reserve.mock.calls[0]?.[0].receipt;
  if (receipt)
    expect(await host.lookupReceipt(receipt)).toMatchObject({ status: 'none' });
  expect(existsSync(join(root, 'missing'))).toBe(false);
});

it('a save that clears scripts of a missing manifest is still refused (CAN-5369)', async () => {
  await expect(
    saveWorkspaceScripts(scriptDefinitionsDispatcher(), DESKTOP_SCRIPT_CALLER, {
      workspaceId: 'missing',
      scripts: {},
    }),
  ).rejects.toThrow(/settings could not be read/);
  expect(existsSync(join(root, 'missing'))).toBe(false);
});

it('a keyed hooks change to an unknown repository refuses and releases the key', async () => {
  const before = images();
  const save = (): Promise<void> =>
    updateWorkspaceHooks({
      workspaceId: 'a',
      source: 'desktop',
      idempotencyKey: 'key',
      change: {
        kind: 'repositories',
        repos: [{ repoId: 'api', hooks: { 'pr:create': null } }],
      },
    });
  await expect(save()).rejects.toMatchObject({ reason: 'not-found' });
  expect(images()).toEqual(before);
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      repos: [{ id: 'api', name: 'api', repoPath: join(dir, 'repo') }],
    }),
  );
  await save();
  expect(manifest()).toMatchObject({
    repos: [expect.objectContaining({ hooks: { 'pr:create': null } })],
  });
});

it('a keyed pause of an unreadable worktree list refuses and releases the key', async () => {
  const file = join(root, 'a', 'worktrees.json');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, '{"worktr');
  await expect(
    invoke('paused', { idempotencyKey: 'key' }),
  ).rejects.toMatchObject({ reason: 'worktrees-unavailable' });
  expect(readFileSync(file, 'utf8')).toBe('{"worktr');
  writeFileSync(file, original);
  expect(await invoke('paused', { idempotencyKey: 'key' })).toMatchObject({
    changed: true,
    pausedHookKeys: ['hook-a'],
  });
});

it('a keyed change that writes nothing still saves its outcome and replays it', async () => {
  await invoke('paused');
  const before = images();
  const commits = jest.spyOn(host, 'commit');
  const first = await invoke('paused', { idempotencyKey: 'key' });
  expect(first).toMatchObject({ changed: false, pausedHookKeys: ['hook-a'] });
  expect(commits).toHaveBeenCalledTimes(1);
  expect(commits.mock.calls[0]?.[0].files).toHaveLength(0);
  expect(await revision('paused')).toBe(1);
  await supersede('paused');
  expect(await invoke('paused', { idempotencyKey: 'key' })).toEqual(first);
  expect(commits).toHaveBeenCalledTimes(2);
  expect(before).not.toEqual(images());
});

it.each(kinds)(
  '%s keeps a reservation a crash left behind recovery-required after restart',
  async (kind) => {
    const before = images();
    // The process dies before it can mark the reservation itself.
    jest
      .spyOn(host, 'markReservationRecoveryRequired')
      .mockRejectedValue(new Error('process died'));
    jest.spyOn(host, 'commit').mockRejectedValueOnce(new Error('crash'));
    await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toThrow(
      'crash',
    );
    await restartHost();
    const commits = jest.spyOn(host, 'commit');
    await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toMatchObject(
      { reason: 'recovery-required' },
    );
    expect(images()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
  },
);

it('a keyed hooks change whose context capture fails consumes no key', async () => {
  const before = images();
  const reserve = jest.spyOn(host, 'reserve');
  mockCapture.mockImplementationOnce(() => {
    throw new Error('context unavailable');
  });
  await expect(invoke('hooks', { idempotencyKey: 'key' })).rejects.toThrow(
    'context unavailable',
  );
  expect(reserve).not.toHaveBeenCalled();
  expect(images()).toEqual(before);
  await invoke('hooks', { idempotencyKey: 'key' });
  expect(manifest().hooks).toEqual({
    'worktree:created': [
      expect.objectContaining({
        id: 'p',
        executionContext: serializeWorkspaceContext({ kind: 'personal' }),
      }),
    ],
  });
});

it.each(['scripts', 'hooks', 'planDetection'] as const)(
  '%s whose manifest admission read fails consumes no key',
  async (kind) => {
    const before = images();
    const reserve = jest.spyOn(host, 'reserve');
    const error = Object.assign(new Error('manifest read failed'), {
      code: 'EIO',
    });
    const read = jest
      .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
      .mockRejectedValueOnce(error);
    await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
    expect(reserve).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    expect(await revision(kind)).toBe(0);
    await invoke(kind, { idempotencyKey: 'key' });
    expect(images()).not.toEqual(before);
    expect(await revision(kind)).toBe(1);
  },
);

// The file store reads a failed or malformed manifest as unreadable rather
// than rejecting, so admission passes and the staged write refuses it.
it.each(
  (['scripts', 'hooks', 'planDetection'] as const).flatMap((kind) => [
    [kind, 'malformed'] as const,
    [kind, 'directory'] as const,
  ]),
)('%s of a %s manifest refuses and releases the key', async (kind, damage) => {
  const file = join(root, 'a', 'workspace.json');
  const original = readFileSync(file, 'utf8');
  if (damage === 'malformed') writeFileSync(file, '{"vers');
  else {
    rmSync(file);
    mkdirSync(file);
  }
  const reserve = jest.spyOn(host, 'reserve');
  await expect(invoke(kind, { idempotencyKey: 'key' })).rejects.toMatchObject({
    reason: 'configuration-unavailable',
  });
  const receipt = reserve.mock.calls[0]?.[0].receipt;
  if (!receipt) throw new Error('Expected a reservation');
  expect(await host.lookupReceipt(receipt)).toMatchObject({ status: 'none' });
  if (damage === 'malformed') expect(readFileSync(file, 'utf8')).toBe('{"vers');
  else rmSync(file, { recursive: true });
  expect(await revision(kind)).toBe(0);
  writeFileSync(file, original);
  await invoke(kind, { idempotencyKey: 'key' });
  expect(readFileSync(file, 'utf8')).not.toBe(original);
  expect(await revision(kind)).toBe(1);
});

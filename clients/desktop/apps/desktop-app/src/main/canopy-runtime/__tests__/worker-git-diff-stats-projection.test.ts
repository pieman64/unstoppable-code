// The `worktree:diff-stats` and `worktree:diff-stats-batch` projection over
// `worker.git.diff.get` on real checkouts (CAN-4103): the reader dispatches
// the host-selected base against WORKTREE, rebuilds the legacy totals from
// that call's reads byte for byte, runs its legacy-only reads inside the
// projection only, and keeps the direct read where the dispatch reads
// nothing.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import {
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import type { WorkerGitDiffHost } from '@canopy/core-runtime/node/git';
import type * as GitModule from '../../lib/git';

jest.mock('../../lib/git', () => {
  const actual = jest.requireActual<typeof GitModule>('../../lib/git');
  return {
    ...actual,
    readDiffShortstat: jest.fn(actual.readDiffShortstat),
    readGitQuotePath: jest.fn(actual.readGitQuotePath),
  };
});

const mockHandlers = new Map<
  string,
  (event: unknown, request: unknown) => Promise<unknown>
>();
jest.mock('../../ipc/register', () => ({
  registerIpcHandler: (
    channel: string,
    handler: (event: unknown, request: unknown) => Promise<unknown>,
  ): void => {
    mockHandlers.set(channel, handler);
  },
}));

import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { registerWorktreeHandlers } from '../../ipc/worktrees';
import { resetWorktreeDiffStatsCacheForTests } from '../../services/worktree-diff-stats-cache';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  desktopWorkerGitDiffHost,
  type WorkerGitDispatcher,
} from '../worker-git-adapter';
import {
  createLegacyDiffStatsReader,
  listUncommittedChangedFiles,
} from '../worker-git-dispatch';
import {
  CONFLICT_WS,
  GONE_BASE_WORKTREE,
  MANY_WS,
  MULTI_WS,
  NO_ORIGIN_WS,
  POSIX,
  POSIX_WS,
  SINGLE_WS,
  UNBORN_WS,
  WORKTREE,
  createDiffGoldenFixture,
  git,
  type DiffGoldenFixture,
} from '../../__tests__/helpers/diff-golden-fixtures';
import {
  getChangedFilesList,
  getDiffStats,
  readDiffShortstat,
  readGitQuotePath,
} from '../../lib/git';
import {
  getWorkspaceType,
  listRegisteredWorkspaceIds,
  registerWorkspaceTypes,
} from '../../lib/workspace-registry';
import { registerCodeReviewTarget } from '../../lib/code-review-registry';

jest.setTimeout(180_000);

const posixIt = POSIX ? it : it.skip;

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};
const gitCaller: CanopyCallerDescriptor = {
  ...caller,
  grants: [WORKER_GIT_GRANTS.read],
};

/** Repository configuration the legacy totals follow. */
const CONFIG_WORKSPACES = {
  'quote-on-ws': [
    ['core.quotePath', 'true'],
    ['diff.renames', 'true'],
  ],
  'quote-off-ws': [
    ['core.quotePath', 'false'],
    ['diff.renames', 'true'],
  ],
  'renames-off-ws': [
    ['core.quotePath', 'true'],
    ['diff.renames', 'false'],
  ],
  'copies-ws': [
    ['core.quotePath', 'true'],
    ['diff.renames', 'copies'],
  ],
} as const;
type ConfigWorkspace = keyof typeof CONFIG_WORKSPACES;
const CONFIG_IDS = Object.keys(CONFIG_WORKSPACES).filter(
  (id): id is ConfigWorkspace => id in CONFIG_WORKSPACES,
);

/**
 * Uncommitted changes whose tracked totals the engine's numstat either equals
 * or, under a rename limit, cannot (its copy sources exceed the limit, so it
 * reports an add and a delete that the legacy `-M` pairs as a rename).
 */
const SCENARIO_WORKSPACES = {
  'modified-ws': (path: string): void => {
    write(join(path, 'a.txt'), lines('a', 31));
    write(join(path, 'b.txt'), lines('b', 10));
    write(join(path, 'new.txt'), lines('new', 3));
    git(path, ['add', 'new.txt']);
    write(join(path, 'untracked.txt'), lines('u', 2));
  },
  'rename-limit-ws': (path: string): void => {
    git(path, ['config', 'diff.renameLimit', '1']);
    git(path, ['mv', 'a.txt', 'moved.txt']);
    write(join(path, 'moved.txt'), lines('a', 30) + 'moved\n');
    write(join(path, 'b.txt'), lines('b', 30) + 'tail\n');
  },
} as const;
type ScenarioWorkspace = keyof typeof SCENARIO_WORKSPACES;
const SCENARIO_IDS = Object.keys(SCENARIO_WORKSPACES).filter(
  (id): id is ScenarioWorkspace => id in SCENARIO_WORKSPACES,
);

let fixture: DiffGoldenFixture;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;

const seenGrants: Array<readonly string[]> = [];
let sampled = 0;
const countingHost: WorkerGitDiffHost<string> = {
  ...desktopWorkerGitDiffHost,
  resolveRepository: (params, context: CanopyHandlerContext) => {
    seenGrants.push(context.caller.grants);
    return desktopWorkerGitDiffHost.resolveRepository(params, context);
  },
  observe: (repoPath, sample) => {
    sampled += 1;
    desktopWorkerGitDiffHost.observe?.(repoPath, sample);
  },
};

const mockedShortstat = jest.mocked(readDiffShortstat);
const mockedQuotePath = jest.mocked(readGitQuotePath);

const lines = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join('');

function write(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function initRepository(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'config@example.com']);
  git(path, ['config', 'user.name', 'Config']);
  git(path, ['config', 'commit.gpgsign', 'false']);
}

function registerSingleRepoWorkspace(id: string, path: string): void {
  const workspaceDir = join(fixture.dataDir, 'workspaces', id);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: path,
      repos: [],
    }),
  );
  writeFileSync(
    join(workspaceDir, 'worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: [{ id: WORKTREE, branchName: 'main', createdAt: '2026' }],
    }),
  );
}

/** Two committed files, then the scenario's uncommitted changes. */
function createScenarioWorkspace(id: ScenarioWorkspace): void {
  const path = fixture.worktreePath(id);
  initRepository(path);
  write(join(path, 'a.txt'), lines('a', 30));
  write(join(path, 'b.txt'), lines('b', 30));
  git(path, ['add', '-A']);
  git(path, ['commit', '-q', '-m', 'base']);
  SCENARIO_WORKSPACES[id](path);
  registerSingleRepoWorkspace(id, path);
}

/** A checkout with a committed rename and copy, and non-ASCII untracked names. */
function createConfigWorkspace(
  id: ConfigWorkspace,
  config: ReadonlyArray<readonly [string, string]>,
): void {
  const path = fixture.worktreePath(id);
  initRepository(path);
  write(join(path, 'rename-src.txt'), lines('rename', 20));
  write(join(path, 'copy-src.txt'), lines('copy', 20));
  git(path, ['add', '-A']);
  git(path, ['commit', '-q', '-m', 'base']);
  git(path, ['branch', 'base']);
  git(path, ['mv', 'rename-src.txt', 'renamed.txt']);
  write(join(path, 'renamed.txt'), lines('rename', 19) + 'edited\n');
  write(join(path, 'copied.txt'), lines('copy', 20) + 'extra\n');
  write(join(path, 'copy-src.txt'), lines('copy', 20) + 'tail\n');
  git(path, ['add', '-A']);
  git(path, ['commit', '-q', '-m', 'feature']);
  write(join(path, 'plain.txt'), lines('plain', 2));
  if (POSIX) {
    write(join(path, 'naïve.txt'), lines('naive', 3));
    write(join(path, 'dir', '日本.txt'), lines('nihon', 4));
  }
  for (const [key, value] of config) git(path, ['config', key, value]);
  registerSingleRepoWorkspace(id, path);
}

beforeAll(async () => {
  fixture = createDiffGoldenFixture('worker-git-diff-stats-');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = fixture.dataDir;
  for (const id of CONFIG_IDS) createConfigWorkspace(id, CONFIG_WORKSPACES[id]);
  for (const id of SCENARIO_IDS) createScenarioWorkspace(id);
  registerWorkspaceTypes(
    new Map([
      ...listRegisteredWorkspaceIds().flatMap(
        (id): Array<[string, WorkspaceType]> => {
          const type = getWorkspaceType(id);
          return type === null ? [] : [[id, type]];
        },
      ),
      ...[...CONFIG_IDS, ...SCENARIO_IDS].map((id): [string, WorkspaceType] => [
        id,
        'single-repo',
      ]),
    ]),
  );
  await registerCodeReviewTarget(`${SINGLE_WS}--${WORKTREE}`, {
    projectId: SINGLE_WS,
    worktreeId: WORKTREE,
  });
  runtime = createDesktopRuntime({ workerGitDiffHost: countingHost });
});

afterAll(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  fixture.cleanup();
});

const spies: jest.SpyInstance[] = [];

function spyOnQuery(): jest.SpyInstance {
  const spy = jest.spyOn(runtime, 'query');
  spies.push(spy);
  return spy;
}

beforeEach(() => {
  seenGrants.length = 0;
  sampled = 0;
  mockedShortstat.mockClear();
  mockedQuotePath.mockClear();
});

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

interface Target {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly repoId: string;
  readonly repoPath: string;
}

function targets(): Target[] {
  const root = (projectId: string, worktreeId = WORKTREE): Target => ({
    projectId,
    worktreeId,
    repoId: WORKSPACE_ROOT_REPO_ID,
    repoPath: fixture.worktreePath(projectId, worktreeId),
  });
  const multi = fixture.worktreePath(MULTI_WS);
  return [
    root(SINGLE_WS),
    root(MANY_WS),
    root(UNBORN_WS),
    root(CONFLICT_WS),
    root(NO_ORIGIN_WS),
    root(NO_ORIGIN_WS, GONE_BASE_WORKTREE),
    ...(POSIX ? [root(POSIX_WS)] : []),
    ...CONFIG_IDS.map((id) => root(id)),
    ...SCENARIO_IDS.map((id) => root(id)),
    root(MULTI_WS),
    ...['alpha', 'beta', 'notes'].map((repoId) => ({
      projectId: MULTI_WS,
      worktreeId: WORKTREE,
      repoId,
      repoPath: join(multi, 'repos', repoId),
    })),
  ];
}

type Outcome = { value: unknown } | { error: string };

function outcome(read: Promise<unknown>): Promise<Outcome> {
  return read.then(
    (value): Outcome => ({ value }),
    (error: unknown): Outcome => ({
      error: String(Reflect.get(Object(error), 'message')),
    }),
  );
}

const readerFor = (
  dispatcher: WorkerGitDispatcher,
  { projectId, worktreeId }: Target,
  resolveCaller: () => CanopyCallerDescriptor = () => caller,
): ReturnType<typeof createLegacyDiffStatsReader> =>
  createLegacyDiffStatsReader(dispatcher, resolveCaller, {
    projectId,
    worktreeId,
  });

function diffCalls(spy: jest.SpyInstance): number {
  return spy.mock.calls.filter(([name]) => name === 'worker.git.diff.get')
    .length;
}

describe('diff-stats projection', () => {
  it('returns the direct stats byte for byte through the dispatcher', async () => {
    const spy = spyOnQuery();
    let reads = 0;
    for (const target of targets())
      for (const base of [undefined, 'main', 'base', 'gone']) {
        const label = `${target.projectId}/${target.worktreeId}/${target.repoId} ${String(base)}`;
        expect({
          label,
          stats: await outcome(readerFor(runtime, target)(target, base)),
        }).toEqual({
          label,
          stats: await outcome(getDiffStats(target.repoPath, base)),
        });
        reads += 1;
      }
    // Every read dispatched and sampled: none took the direct fallback.
    expect(diffCalls(spy)).toBe(reads);
    expect(sampled).toBe(reads);
    expect(mockedShortstat.mock.calls.length).toBeLessThan(reads);
    expect(seenGrants).toHaveLength(reads);
    expect(
      seenGrants.every(
        (grants) => grants.length === 1 && grants[0] === WORKER_GIT_GRANTS.read,
      ),
    ).toBe(true);
  });

  posixIt('follows the repository configuration, as Git did', async () => {
    const stats: Record<string, unknown> = {};
    for (const id of CONFIG_IDS) {
      const target = targets().find((entry) => entry.projectId === id);
      if (target === undefined) throw new Error(`No target ${id}`);
      stats[id] = await readerFor(runtime, target)(target, 'base');
    }
    // Quoted non-ASCII names were unreadable (7 lines); renames off counts a
    // delete and an add; copies count only the copy's new line.
    expect(stats).toEqual({
      'quote-on-ws': { insertions: 25, deletions: 1 },
      'quote-off-ws': { insertions: 32, deletions: 1 },
      'renames-off-ws': { insertions: 44, deletions: 20 },
      'copies-ws': { insertions: 5, deletions: 1 },
    });
  });

  it('passes the merge base it selected and adds only worker.git.read', async () => {
    const spy = spyOnQuery();
    const [target] = targets();
    if (target === undefined) throw new Error('No target');
    const mergeBase = git(target.repoPath, [
      'merge-base',
      'origin/main',
      'HEAD',
    ]);
    await readerFor(runtime, target)(target, 'main');
    await readerFor(runtime, target)(target, undefined);
    expect(spy.mock.calls).toEqual([
      [
        'worker.git.diff.get',
        {
          scope: { workspaceId: SINGLE_WS, worktreeId: WORKTREE },
          repoId: WORKSPACE_ROOT_REPO_ID,
          base: mergeBase,
          head: 'WORKTREE',
        },
        { caller: gitCaller },
      ],
      [
        'worker.git.diff.get',
        {
          scope: { workspaceId: SINGLE_WS, worktreeId: WORKTREE },
          repoId: WORKSPACE_ROOT_REPO_ID,
          base: 'HEAD',
          head: 'WORKTREE',
        },
        { caller: gitCaller },
      ],
    ]);
  });

  it('reads the shortstat only where the engine counts cannot stand in for it', async () => {
    const shortstats: Record<string, number> = {};
    for (const target of targets().filter(({ projectId }) =>
      [...SCENARIO_IDS, ...CONFIG_IDS].some((id) => id === projectId),
    ))
      for (const base of [undefined, 'base']) {
        mockedShortstat.mockClear();
        const label = `${target.projectId} ${String(base)}`;
        expect({
          label,
          stats: await outcome(readerFor(runtime, target)(target, base)),
        }).toEqual({
          label,
          stats: await outcome(getDiffStats(target.repoPath, base)),
        });
        // Only the projection's own reads reach the mock.
        shortstats[label] = mockedShortstat.mock.calls.length;
      }
    // Without a rename, a copy, or an add beside a delete, the numstat sum is
    // the shortstat; the config checkouts' committed rename and copy, and the
    // rename limit's add and delete, read it.
    expect(shortstats).toEqual({
      'modified-ws undefined': 0,
      'modified-ws base': 0,
      'rename-limit-ws undefined': 1,
      'rename-limit-ws base': 1,
      ...Object.fromEntries(
        CONFIG_IDS.flatMap((id) => [
          [`${id} undefined`, 0],
          [`${id} base`, 1],
        ]),
      ),
    });
  });

  posixIt('runs its legacy reads only inside the projection', async () => {
    const result = await runtime.query(
      'worker.git.diff.get',
      {
        scope: { workspaceId: 'quote-on-ws', worktreeId: WORKTREE },
        repoId: WORKSPACE_ROOT_REPO_ID,
        base: 'HEAD',
        head: 'WORKTREE',
      },
      { caller: gitCaller },
    );
    // The canonical result counts the names the legacy totals cannot read.
    expect(
      result.files
        .filter((file) => file.status === 'untracked')
        .map(({ path, additions }) => ({ path, additions })),
    ).toEqual([
      { path: 'dir/日本.txt', additions: 4 },
      { path: 'naïve.txt', additions: 3 },
      { path: 'plain.txt', additions: 2 },
    ]);
    expect(mockedShortstat).not.toHaveBeenCalled();
    expect(mockedQuotePath).not.toHaveBeenCalled();
  });

  posixIt(
    'reads core.quotePath only when an untracked name needs it',
    async () => {
      const [single] = targets();
      if (single === undefined) throw new Error('No target');
      await readerFor(runtime, single)(single, 'main');
      expect(mockedQuotePath).not.toHaveBeenCalled();
      const quoted = targets().find(
        (entry) => entry.projectId === 'quote-on-ws',
      );
      if (quoted === undefined) throw new Error('No target');
      await readerFor(runtime, quoted)(quoted, 'base');
      expect(mockedQuotePath).toHaveBeenCalledTimes(1);
    },
  );

  it('dispatches a registered code-review scope as the worktree it borrows', async () => {
    const spy = spyOnQuery();
    const target: Target = {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: `${SINGLE_WS}--${WORKTREE}`,
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoPath: fixture.worktreePath(SINGLE_WS),
    };
    expect(await readerFor(runtime, target)(target, undefined)).toEqual(
      await getDiffStats(target.repoPath, undefined),
    );
    expect(spy).toHaveBeenCalledWith(
      'worker.git.diff.get',
      {
        scope: { workspaceId: SINGLE_WS, worktreeId: WORKTREE },
        repoId: WORKSPACE_ROOT_REPO_ID,
        base: 'HEAD',
        head: 'WORKTREE',
      },
      { caller: gitCaller },
    );
  });

  it('keeps the direct read when the dispatch reads nothing', async () => {
    const failing: WorkerGitDispatcher = {
      query: (): Promise<never> =>
        Promise.reject(
          new CanopyOperationError({
            kind: 'internal',
            message: 'The dispatcher is unavailable.',
            retry: { kind: 'never' },
          }),
        ),
    };
    const ghost: Target = {
      projectId: MULTI_WS,
      worktreeId: WORKTREE,
      repoId: 'ghost',
      repoPath: join(fixture.worktreePath(MULTI_WS), 'repos', 'ghost'),
    };
    const [single, , unborn] = targets();
    if (single === undefined || unborn === undefined)
      throw new Error('No target');
    for (const [dispatcher, target] of [
      [failing, single],
      [failing, unborn],
      // The host locates no checkout for a missing member directory.
      [runtime, ghost],
    ] as const)
      for (const base of [undefined, 'main'])
        expect(
          await outcome(readerFor(dispatcher, target)(target, base)),
        ).toEqual(await outcome(getDiffStats(target.repoPath, base)));
    expect(mockedShortstat).not.toHaveBeenCalled();
  });

  it('keeps the direct read for an unregistered app-managed scope', async () => {
    const spy = spyOnQuery();
    const resolveCaller = jest.fn(() => caller);
    const target: Target = {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'unregistered--scope',
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoPath: fixture.worktreePath(SINGLE_WS),
    };
    expect(
      await readerFor(runtime, target, resolveCaller)(target, 'main'),
    ).toEqual(await getDiffStats(target.repoPath, 'main'));
    expect(diffCalls(spy)).toBe(0);
    expect(resolveCaller).not.toHaveBeenCalled();
  });

  it('resolves the caller once, when it first dispatches', async () => {
    const resolveCaller = jest.fn(() => caller);
    const multi = targets().filter((entry) => entry.projectId === MULTI_WS);
    const [first] = multi;
    if (first === undefined) throw new Error('No target');
    const read = readerFor(runtime, first, resolveCaller);
    expect(resolveCaller).not.toHaveBeenCalled();
    for (const target of multi) await read(target, 'main');
    expect(resolveCaller).toHaveBeenCalledTimes(1);
  });

  it('refuses a caller the resolver refuses before reading', async () => {
    const spy = spyOnQuery();
    const [target] = targets();
    if (target === undefined) throw new Error('No target');
    const refused = new Error('permission denied');
    await expect(
      readerFor(runtime, target, () => {
        throw refused;
      })(target, 'main'),
    ).rejects.toBe(refused);
    expect(diffCalls(spy)).toBe(0);
  });
});

// The changed-files rebuild shares the quoting helper; its listing is always
// quoted as core.quotePath=false, whatever the repository says.
describe('activity:changed-files projection beside the diff-stats quoting', () => {
  posixIt('keeps non-ASCII untracked names raw at every position', async () => {
    for (const id of CONFIG_IDS) {
      const target = targets().find((entry) => entry.projectId === id);
      if (target === undefined) throw new Error(`No target ${id}`);
      const listed = await listUncommittedChangedFiles(runtime, caller, target);
      expect(listed).toEqual(await getChangedFilesList(target.repoPath));
      expect(listed.map((file) => file.path)).toEqual(
        expect.arrayContaining(['dir/日本.txt', 'naïve.txt']),
      );
    }
  });
});

describe('diff-stats IPC channels', () => {
  async function invoke(channel: string, request: unknown): Promise<unknown> {
    const handler = mockHandlers.get(channel);
    if (!handler) throw new Error(`${channel} was not registered`);
    return handler({}, request);
  }

  it('read every repository through worker.git.diff.get for their caller', async () => {
    const resolveCaller = jest.fn(() => caller);
    registerWorktreeHandlers(() => null, {
      dispatcher: runtime,
      resolveCaller,
    });
    resetWorktreeDiffStatsCacheForTests();
    const spy = spyOnQuery();
    const reads: Array<[string, number, number]> = [];
    const count = async (
      label: string,
      run: () => Promise<unknown>,
    ): Promise<void> => {
      const before = diffCalls(spy);
      mockedShortstat.mockClear();
      await run();
      reads.push([
        label,
        diffCalls(spy) - before,
        mockedShortstat.mock.calls.length,
      ]);
    };
    for (const projectId of [SINGLE_WS, MULTI_WS]) {
      const worktree = { projectId, worktreeId: WORKTREE };
      await count(`${projectId} diff-stats`, () =>
        invoke(IPC_CHANNELS.worktreeDiffStats, worktree),
      );
      for (const mode of ['diff_only', 'full'] as const)
        await count(`${projectId} batch ${mode}`, () =>
          invoke(IPC_CHANNELS.worktreeDiffStatsBatch, {
            worktrees: [{ ...worktree, mode }],
            skipFetch: true,
            source: 'user-explicit',
          }),
        );
    }
    // Label, dispatches, shortstat reads. The multi-repository worktree reads
    // its root, alpha, beta and the non-checkout notes directory. Only the
    // single checkout's renames and the members' copies (each committed file
    // copies lines of the modified shared.txt) read the shortstat.
    expect(reads).toEqual([
      [`${SINGLE_WS} diff-stats`, 1, 1],
      [`${SINGLE_WS} batch diff_only`, 1, 1],
      [`${SINGLE_WS} batch full`, 1, 1],
      [`${MULTI_WS} diff-stats`, 4, 2],
      [`${MULTI_WS} batch diff_only`, 4, 2],
      [`${MULTI_WS} batch full`, 4, 2],
    ]);
    // Every dispatch was rebuilt from its own reads; none fell back.
    expect(sampled).toBe(15);
    // Once per channel call or batch row.
    expect(resolveCaller).toHaveBeenCalledTimes(6);
    expect(
      spy.mock.calls.every(
        ([, , options]) =>
          JSON.stringify(options) === JSON.stringify({ caller: gitCaller }),
      ),
    ).toBe(true);
  });
});

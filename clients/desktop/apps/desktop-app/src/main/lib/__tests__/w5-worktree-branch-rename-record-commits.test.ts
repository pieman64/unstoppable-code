// W6f1 (CAN-4836): the W5 commits of `core.worktree.branch.rename`'s record
// step through the record decision port, on the real commit log worker and a
// real Git checkout.
//
// One log interleaves the Git rename, each port decision (as JSON, so it is
// plain data), each reservation, release, recovery mark and commit the worker
// receives, and the post-commit hooks. Admission, the expected-revision
// preflight and the name checks run before Git; the record follows it in one
// commit under the list lock. Without the decision entries, each expected log
// is the one the code before the port produced.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as hostPlatform from '@canopy/core-platform/host-platform';
import type {
  W5CommitRequest,
  W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import type {
  WorktreeData,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as RenamePort from '../worktree-branch-rename-decision-port';
import type {
  WorktreeBranchRenameDecision,
  WorktreeRecordTarget,
} from '../worktree-record-decisions';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';

const mockEvents: unknown[] = [];

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn((diagnostic: { kind?: string }) =>
      mockEvents.push(`diagnostic:${diagnostic.kind ?? 'unknown'}`),
    ),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(() => mockEvents.push('sync')),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(() => mockEvents.push('notify')),
}));
jest.mock('../worktree-branch-rename-decision-port', () => {
  const actual = jest.requireActual<typeof RenamePort>(
    '../worktree-branch-rename-decision-port',
  );
  return {
    ...actual,
    applyWorktreeBranchRenameDecision: (
      target: WorktreeRecordTarget,
      decision: WorktreeBranchRenameDecision,
    ): ReturnType<typeof actual.applyWorktreeBranchRenameDecision> => {
      // Applied as its JSON copy, so the rename's decision is plain data.
      const copy = JSON.parse(
        JSON.stringify(decision),
      ) as WorktreeBranchRenameDecision;
      mockEvents.push({
        target: `${target.workspaceId}/${target.worktreeId}`,
        decision: copy,
      });
      return actual.applyWorktreeBranchRenameDecision(target, copy);
    },
  };
});

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import * as git from '../git';
import {
  createW5CommitLogFileStore,
  w5ResourceKey,
  W5RevisionConflictError,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  readWorkspaceWorktrees,
  setBeforeProjectPluginDefaultsChangeHandler,
} from '../workspace-persistence';
import {
  renameWorktreeBranch,
  WorktreeBranchRenameRefusedError,
  type WorktreeBranchRenameRequest,
} from '../worktree-branch-rename';
import { inProcessBranchRenameGit } from '../../__tests__/helpers/in-process-branch-rename-git';

jest.setTimeout(60_000);

const PR_STATUS: WorktreePrStatus = {
  lastCheckedAt: '2026-10-02T00:00:00.000Z',
  repos: [{ repoId: 'repo', repoName: 'repo', status: null }],
};

let dir: string;
let root: string;
let repo: string;
let createdAt: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
/** Runs, once, before the worker receives a commit, as a writer outside the locks. */
let beforeWorkerCommit:
  | ((
      request: W5CommitRequest,
      commit: W5CommitLogHost['commit'],
    ) => Promise<void>)
  | undefined;

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  const commit = host.commit.bind(host);
  jest
    .spyOn(host, 'commit')
    .mockImplementation(async (request: W5CommitRequest) => {
      mockEvents.push(commitEvent(request));
      const before = beforeWorkerCommit;
      beforeWorkerCommit = undefined;
      await before?.(request, commit);
      return commit(request);
    });
  const reserve = host.reserve.bind(host);
  jest.spyOn(host, 'reserve').mockImplementation(async (input) => {
    mockEvents.push(`reserve:${input.operation}`);
    return reserve(input);
  });
  const release = host.releaseReservation.bind(host);
  jest
    .spyOn(host, 'releaseReservation')
    .mockImplementation(async (reservationId) => {
      mockEvents.push('release');
      return release(reservationId);
    });
  const markRecovery = host.markReservationRecoveryRequired.bind(host);
  jest
    .spyOn(host, 'markReservationRecoveryRequired')
    .mockImplementation(async (reservationId, diagnostics) => {
      mockEvents.push('mark-recovery-required');
      return markRecovery(reservationId, diagnostics);
    });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
}

async function restartHost(): Promise<void> {
  await host.shutdown();
  startHost();
  __resetSidebarItemsStateForTests();
}

function checkout(...segments: string[]): string {
  return join(root, 'a', 'worktrees', ...segments);
}
function addCheckout(path: string, branch: string): void {
  mkdirSync(dirname(path), { recursive: true });
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    branch,
    path,
  ]);
}
function currentBranch(path: string): string {
  return execFileSync('git', ['-C', path, 'branch', '--show-current'], {
    encoding: 'utf8',
  }).trim();
}

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture((at) => {
    createdAt = at;
    return [
      {
        id: 'one',
        branchName: 'old',
        createdAt: at,
        lastKnownPrStatus: PR_STATUS,
        status: 'done',
      },
      { id: 'two', branchName: 'second', createdAt: at },
    ];
  }));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  beforeWorkerCommit = undefined;
  addCheckout(checkout('one'), 'old');
  startHost();
  const renameBranch = git.renameBranch;
  jest.spyOn(git, 'renameBranch').mockImplementation(async (path, newName) => {
    mockEvents.push(`git:rename:${relative(root, path)}:${newName}`);
    await renameBranch(path, newName);
  });
  mockEvents.length = 0;
});
afterEach(async () => {
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

interface CommitEvent {
  commit: string;
  advance: string[];
  files: string[];
  expected?: string[];
  reservation?: true;
  receipt?: true;
}
function commitEvent(request: W5CommitRequest): CommitEvent {
  return {
    commit: request.operation,
    advance: request.advance.map(w5ResourceKey),
    files: request.files.map((file) => relative(root, file.path)),
    ...(request.expectedRevisions?.length
      ? {
          expected: request.expectedRevisions.map(
            ({ resource, revision }) =>
              `${w5ResourceKey(resource)}@${revision}`,
          ),
        }
      : {}),
    ...(request.reservationId ? { reservation: true } : {}),
    ...(request.receipt ? { receipt: true } : {}),
  };
}

const CANONICAL_FILES = ['index.json', 'a/workspace.json', 'a/worktrees.json'];
function images(): Record<string, string> {
  return Object.fromEntries(
    CANONICAL_FILES.map((file) => [
      file,
      readFileSync(join(root, file), 'utf8'),
    ]),
  );
}
const RESOURCES: W5Resource[] = [
  { kind: 'workspaces' },
  { kind: 'workspace', workspaceId: 'a' },
  { kind: 'worktrees', workspaceId: 'a' },
  ...['one', 'two', 'ghost'].map(
    (worktreeId): W5Resource => ({
      kind: 'worktree',
      workspaceId: 'a',
      worktreeId,
    }),
  ),
];
async function revisions(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    RESOURCES.map(
      async (resource): Promise<[string, number]> => [
        w5ResourceKey(resource),
        await host.revision(resource),
      ],
    ),
  );
  return Object.fromEntries(entries);
}

interface Observed<T> {
  result: T;
  events: unknown[];
  /** The resources whose revision moved, by how much. */
  advanced: Record<string, number>;
  /** The canonical files whose bytes changed. */
  changed: string[];
}
async function observe<T>(work: () => Promise<T>): Promise<Observed<T>> {
  const beforeRevisions = await revisions();
  const beforeImages = images();
  mockEvents.length = 0;
  const result = await work();
  await settleDetachedWork();
  const events = [...mockEvents];
  const afterRevisions = await revisions();
  const afterImages = images();
  const advanced: Record<string, number> = {};
  for (const [key, value] of Object.entries(afterRevisions))
    if (value !== beforeRevisions[key])
      advanced[key] = value - (beforeRevisions[key] ?? 0);
  return {
    result,
    events,
    advanced,
    changed: CANONICAL_FILES.filter(
      (file) => afterImages[file] !== beforeImages[file],
    ),
  };
}
function observeRefusal(
  work: () => Promise<unknown>,
): Promise<Observed<unknown>> {
  return observe(() =>
    work().then(
      () => {
        throw new Error('Expected a refusal');
      },
      (error: unknown) => error,
    ),
  );
}
function withoutResult<T>(observed: Observed<T>): Omit<Observed<T>, 'result'> {
  const { events, advanced, changed } = observed;
  return { events, advanced, changed };
}

function rename(
  fields: Partial<WorktreeBranchRenameRequest> = {},
): Promise<unknown> {
  return renameWorktreeBranch(
    {
      source: 'desktop',
      workspaceId: 'a',
      worktreeId: 'one',
      newBranchName: 'renamed',
      ...fields,
    },
    inProcessBranchRenameGit,
  );
}

const OPERATION = 'core.worktree.branch.rename';
/**
 * The rename's one record commit of the list, advancing each row's revision
 * as every list write does, checked against `worktree:a/one@expected`.
 */
function record(expected?: number): CommitEvent {
  return {
    commit: OPERATION,
    advance: ['worktree:a/one', 'worktree:a/two'],
    files: ['a/worktrees.json'],
    ...(expected === undefined
      ? {}
      : { expected: [`worktree:a/one@${expected}`] }),
  };
}
const ROWS_ADVANCED = { 'worktree:a/one': 1, 'worktree:a/two': 1 };
function branchDecision(
  worktreeId: string,
  branchName: string,
  updatesSidebarBranch = true,
): unknown {
  return {
    target: `a/${worktreeId}`,
    decision: {
      kind: 'worktree.branch.rename',
      branchName,
      updatesSidebarBranch,
    },
  };
}
const RECEIPT: CommitEvent = {
  commit: OPERATION,
  advance: [],
  files: [],
  reservation: true,
  receipt: true,
};
/** The list write's post-commit hooks. */
const HOOKS = ['sync', 'notify'];

function renamedOne(): WorktreeData {
  return {
    id: 'one',
    branchName: 'renamed',
    createdAt,
    lastKnownPrStatus: null,
  };
}
/** An unkeyed rename returns the persisted row, with its replica projection. */
function persisted(row: WorktreeData): WorktreeData {
  return { ...row, replica: { state: 'never-recorded' } };
}
/** A keyed rename returns the portable row fields its outcome schema keeps. */
function portable(row: WorktreeData): WorktreeData {
  const { id, branchName, createdAt: at } = row;
  return { id, branchName, createdAt: at };
}
/** The stored rows without their minted replica sets. */
async function storedRows(): Promise<WorktreeData[]> {
  return (await readWorkspaceWorktrees('a')).map((stored) => {
    const row = { ...stored };
    delete row.replica;
    return row;
  });
}

describe('record after Git', () => {
  it('records a root rename in one list commit after Git, clearing the PR status', async () => {
    const renamed = await observe(() => rename());
    expect(renamed.result).toEqual({
      branchName: 'renamed',
      worktree: persisted(renamedOne()),
    });
    expect(withoutResult(renamed)).toEqual({
      events: [
        'git:rename:a/worktrees/one:renamed',
        branchDecision('one', 'renamed'),
        record(),
        ...HOOKS,
      ],
      advanced: ROWS_ADVANCED,
      changed: ['a/worktrees.json'],
    });
    expect(currentBranch(checkout('one'))).toBe('renamed');
    expect(await storedRows()).toEqual([
      renamedOne(),
      { id: 'two', branchName: 'second', createdAt },
    ]);
  });

  it('keeps the sidebar branch on a member repository rename', async () => {
    addCheckout(checkout('two', 'repos', 'repo-b'), 'member');
    mockEvents.length = 0;
    const renamed = await observe(() =>
      rename({
        worktreeId: 'two',
        repoId: 'repo-b',
        newBranchName: 'member-renamed',
      }),
    );
    const two: WorktreeData = {
      id: 'two',
      branchName: 'second',
      createdAt,
      lastKnownPrStatus: null,
    };
    expect(renamed.result).toEqual({
      branchName: 'member-renamed',
      worktree: persisted(two),
    });
    expect(withoutResult(renamed)).toEqual({
      events: [
        'git:rename:a/worktrees/two/repos/repo-b:member-renamed',
        branchDecision('two', 'member-renamed', false),
        record(),
        ...HOOKS,
      ],
      advanced: ROWS_ADVANCED,
      changed: ['a/worktrees.json'],
    });
    expect(currentBranch(checkout('two', 'repos', 'repo-b'))).toBe(
      'member-renamed',
    );
    expect((await storedRows())[1]).toEqual(two);
  });

  it('commits nothing for a row already in the renamed state', async () => {
    writeFileSync(
      join(root, 'a', 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: [renamedOne()] }),
    );
    const renamed = await observe(() => rename());
    expect(renamed.result).toEqual({
      branchName: 'renamed',
      worktree: persisted(renamedOne()),
    });
    expect(withoutResult(renamed)).toEqual({
      events: [
        'git:rename:a/worktrees/one:renamed',
        branchDecision('one', 'renamed'),
      ],
      advanced: {},
      changed: [],
    });
  });

  it('records the name exactly as Git renamed it, without trimming', async () => {
    // Git accepts a trailing no-break space, which `String#trim` would strip.
    const name = 'renamed\u00a0';
    const renamed = await observe(() => rename({ newBranchName: name }));
    expect(withoutResult(renamed)).toEqual({
      events: [
        `git:rename:a/worktrees/one:${name}`,
        branchDecision('one', name),
        record(),
        ...HOOKS,
      ],
      advanced: ROWS_ADVANCED,
      changed: ['a/worktrees.json'],
    });
    expect(
      execFileSync('git', ['-C', checkout('one'), 'branch', '--show-current'], {
        encoding: 'utf8',
      }),
    ).toBe(`${name}\n`);
    expect((await storedRows())[0]).toEqual({
      ...renamedOne(),
      branchName: name,
    });
  });

  it.each([
    ['an invalid name', 'bad..name', 'invalid-branch-name'],
    ['a name in use', 'main', 'branch-unavailable'],
  ])(
    'refuses %s before Git or any decision, releasing a key',
    async (_label, newBranchName, reason) => {
      // Exercise Linux's exit-code check on every host. Real subprocess errors
      // come from outside Jest's realm and need not be instanceof Error here.
      jest.spyOn(hostPlatform, 'hostOperatingSystem').mockReturnValue('linux');
      const refused = await observeRefusal(() =>
        rename({ newBranchName, idempotencyKey: 'key' }),
      );
      expect(refused.result).toBeInstanceOf(WorktreeBranchRenameRefusedError);
      expect(refused.result).toMatchObject({ reason });
      expect(withoutResult(refused)).toEqual({
        events: [`reserve:${OPERATION}`, 'release'],
        advanced: {},
        changed: [],
      });
      expect(currentBranch(checkout('one'))).toBe('old');
      // The released key admits a new request.
      expect(
        (await observe(() => rename({ idempotencyKey: 'key' }))).result,
      ).toEqual({ branchName: 'renamed', worktree: portable(renamedOne()) });
    },
  );

  it('reports a missing row after Git without a commit, keeping the rename', async () => {
    addCheckout(checkout('ghost'), 'ghost');
    mockEvents.length = 0;
    const before = images();
    const missing = await observeRefusal(() => rename({ worktreeId: 'ghost' }));
    expect(missing.result).toBeInstanceOf(WorktreeBranchRenameRefusedError);
    expect(missing.result).toMatchObject({
      reason: 'not-found',
      message: 'Worktree metadata not found for a/ghost',
    });
    expect(withoutResult(missing)).toEqual({
      events: [
        'git:rename:a/worktrees/ghost:renamed',
        branchDecision('ghost', 'renamed'),
      ],
      advanced: {},
      changed: [],
    });
    expect(images()).toEqual(before);
    expect(currentBranch(checkout('ghost'))).toBe('renamed');
  });

  it('keeps the Git rename when the row revision moves after Git, with nothing recorded', async () => {
    beforeWorkerCommit = async (request, commit): Promise<void> => {
      expect(request.operation).toBe(OPERATION);
      await commit({
        operation: 'test.concurrent-edit',
        outcome: null,
        files: [],
        advance: [{ kind: 'worktree', workspaceId: 'a', worktreeId: 'one' }],
      });
    };
    const conflicted = await observeRefusal(() =>
      rename({ expectedRevision: 0 }),
    );
    expect(conflicted.result).toBeInstanceOf(W5RevisionConflictError);
    expect(withoutResult(conflicted)).toEqual({
      events: [
        'git:rename:a/worktrees/one:renamed',
        branchDecision('one', 'renamed'),
        record(0),
      ],
      advanced: { 'worktree:a/one': 1 },
      changed: [],
    });
    expect(currentBranch(checkout('one'))).toBe('renamed');
  });
});

describe('keyed rename (KA)', () => {
  it('reserves before Git, records, then saves the receipt last; replays after a restart with nothing written', async () => {
    const request = { expectedRevision: 0, idempotencyKey: 'key' };
    const first = await observe(() => rename(request));
    expect(first.result).toEqual({
      branchName: 'renamed',
      worktree: portable(renamedOne()),
    });
    expect(withoutResult(first)).toEqual({
      events: [
        `reserve:${OPERATION}`,
        'git:rename:a/worktrees/one:renamed',
        branchDecision('one', 'renamed'),
        record(0),
        ...HOOKS,
        RECEIPT,
      ],
      advanced: ROWS_ADVANCED,
      changed: ['a/worktrees.json'],
    });
    const recorded = images();

    await restartHost();
    // A replay ignores the now-stale revision and writes nothing.
    const replay = await observe(() =>
      rename({ ...request, expectedRevision: 99 }),
    );
    expect(replay.result).toEqual(first.result);
    expect(withoutResult(replay)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    const reused = await observeRefusal(() =>
      rename({ ...request, newBranchName: 'other' }),
    );
    expect(reused.result).toMatchObject({ reason: 'key-reused' });
    expect(withoutResult(reused)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    expect(images()).toEqual(recorded);
    expect(currentBranch(checkout('one'))).toBe('renamed');
  });

  it('refuses a stale revision before Git with no canonical change and releases the key', async () => {
    const stale = await observeRefusal(() =>
      rename({ expectedRevision: 7, idempotencyKey: 'key' }),
    );
    expect(stale.result).toBeInstanceOf(W5RevisionConflictError);
    expect(withoutResult(stale)).toEqual({
      events: [`reserve:${OPERATION}`, 'release'],
      advanced: {},
      changed: [],
    });
    expect(currentBranch(checkout('one'))).toBe('old');
    expect(
      (
        await observe(() =>
          rename({ expectedRevision: 0, idempotencyKey: 'key' }),
        )
      ).result,
    ).toEqual({ branchName: 'renamed', worktree: portable(renamedOne()) });
  });

  it('keeps the Git rename and reports recovery-required when the row revision moves after Git', async () => {
    beforeWorkerCommit = async (request, commit): Promise<void> => {
      // An edit of the row lands between the preflight and the record.
      expect(request.operation).toBe(OPERATION);
      await commit({
        operation: 'test.concurrent-edit',
        outcome: null,
        files: [],
        advance: [{ kind: 'worktree', workspaceId: 'a', worktreeId: 'one' }],
      });
    };
    const request = { expectedRevision: 0, idempotencyKey: 'key' };
    const conflicted = await observeRefusal(() => rename(request));
    expect(conflicted.result).toBeInstanceOf(W5RevisionConflictError);
    expect(withoutResult(conflicted)).toEqual({
      events: [
        `reserve:${OPERATION}`,
        'git:rename:a/worktrees/one:renamed',
        branchDecision('one', 'renamed'),
        record(0),
        'mark-recovery-required',
      ],
      // Only the concurrent edit's revision moved.
      advanced: { 'worktree:a/one': 1 },
      changed: [],
    });
    expect(currentBranch(checkout('one'))).toBe('renamed');

    const retried = await observeRefusal(() => rename(request));
    expect(retried.result).toMatchObject({ reason: 'recovery-required' });
    expect(withoutResult(retried)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    await restartHost();
    const afterRestart = await observeRefusal(() => rename(request));
    expect(afterRestart.result).toMatchObject({ reason: 'recovery-required' });
    expect(withoutResult(afterRestart)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    expect(currentBranch(checkout('one'))).toBe('renamed');
  });

  it('keeps the Git rename and reports recovery-required when the row is missing after Git', async () => {
    addCheckout(checkout('ghost'), 'ghost');
    mockEvents.length = 0;
    const request = { worktreeId: 'ghost', idempotencyKey: 'key' };
    const missing = await observeRefusal(() => rename(request));
    expect(missing.result).toBeInstanceOf(WorktreeBranchRenameRefusedError);
    expect(missing.result).toMatchObject({ reason: 'not-found' });
    expect(withoutResult(missing)).toEqual({
      events: [
        `reserve:${OPERATION}`,
        'git:rename:a/worktrees/ghost:renamed',
        branchDecision('ghost', 'renamed'),
        'mark-recovery-required',
      ],
      advanced: {},
      changed: [],
    });
    expect(currentBranch(checkout('ghost'))).toBe('renamed');
    await restartHost();
    const retried = await observeRefusal(() => rename(request));
    expect(retried.result).toMatchObject({ reason: 'recovery-required' });
    expect(withoutResult(retried)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
  });

  it('retains and diagnoses an attempt interrupted between Git and the record', async () => {
    beforeWorkerCommit = async (): Promise<void> => {
      await host.shutdown();
      throw new Error('interrupted before the record commit');
    };
    const request = { expectedRevision: 0, idempotencyKey: 'key' };
    const before = images();
    mockEvents.length = 0;
    await expect(rename(request)).rejects.toThrow(
      'interrupted before the record commit',
    );
    expect(mockEvents).toEqual([
      `reserve:${OPERATION}`,
      'git:rename:a/worktrees/one:renamed',
      branchDecision('one', 'renamed'),
      // The stopped worker takes no recovery mark; launch recovery finds the
      // reservation instead.
      record(0),
    ]);
    expect(currentBranch(checkout('one'))).toBe('renamed');
    expect(images()).toEqual(before);

    await restartHost();
    expect(
      (await host.recoveryReport()).recoveryRequiredReservations,
    ).toHaveLength(1);
    const retried = await observeRefusal(() => rename(request));
    expect(retried.result).toMatchObject({ reason: 'recovery-required' });
    expect(withoutResult(retried)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    expect(currentBranch(checkout('one'))).toBe('renamed');
  });
});

// CAN-4934: inactive foreground acceptance with real canonical files, Git and worker.
import { jsonRecordRoundTrip } from './fixtures/json-record-round-trip';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { fingerprintW5File } from '@canopy/desktop-shared/node/w5-commit-log/fingerprint';
import type {
  ProjectApplySourceChangesResponse,
  WorkspaceApplySourceChangesResponse,
} from '@canopy/desktop-shared/types';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../workspace-worktree-runtime', () => ({
  resolveWorkspaceWorktreeBranchName: jest.fn(),
  startWorkspaceRepoSetupAndDiscovery: jest.fn(),
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
}));

import * as git from '../git';
import * as persistence from '../workspace-persistence';
import * as canopy from '../canopy-json';
import * as recordPort from '../workspace-record-decision-port';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  withW5Commit,
  W5FileWriteRefusedError,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  applySourceChanges,
  type WorkspaceSourceChangesRequest,
} from '../workspace-source-changes';
import { getWorktreeDir, getWorkspaceWorktreeRootRepoDir } from '../paths';
import { w5CompositionLocks } from '../w5-composition-operation';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let reservations: jest.SpiedFunction<W5CommitLogHost['reserve']>;
let commits: jest.SpiedFunction<W5CommitLogHost['commit']>;
let commitOriginal: W5CommitLogHost['commit'];
const workspace = { kind: 'workspace', workspaceId: 'a' } as const;
const collection = { kind: 'worktrees', workspaceId: 'a' } as const;
const interruption = new Error('interrupted');
const image = (path: string): string =>
  existsSync(path) ? readFileSync(path, 'utf8') : '<absent>';
const manifestPath = (): string => join(root, 'a', 'workspace.json');
const worktreeListSchema = z.object({
  worktrees: z.array(z.object({ id: z.string() }).passthrough()),
});

interface SourceChangeObservation {
  files: Record<string, string>;
  sources: string[];
  revisions: number[];
  journal: Awaited<ReturnType<W5CommitLogHost['snapshot']>> | undefined;
  reservations: NonNullable<
    Awaited<ReturnType<W5CommitLogHost['recoveryReport']>>['reservations']
  >;
}

function start(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'data', 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}
function request(
  kind: 'workspace' | 'project',
  newTarget = true,
): WorkspaceSourceChangesRequest {
  writeFileSync(
    manifestPath(),
    JSON.stringify({
      version: 1,
      ...(kind === 'workspace'
        ? { type: 'multi-repo', sourceRepoPath: repo }
        : { type: 'single-repo', repoPath: repo }),
      repos: [],
    }),
  );
  const options = {
    idempotencyKey: 'apply',
    expectedRevisions: [
      { resource: workspace, revision: 0 },
      { resource: collection, revision: 0 },
    ],
    getWindow: (): null => null,
  };
  const target = newTarget
    ? { mode: 'new' as const, existingWorktreeIds: [] }
    : { mode: 'existing' as const, worktreeId: 'otter' };
  return kind === 'workspace'
    ? {
        ...options,
        kind,
        source: 'workspace_settings',
        request: {
          workspaceId: 'a',
          target,
          workspaceScripts: { dev: 'echo dev' },
        },
      }
    : {
        ...options,
        kind,
        source: 'project_settings',
        request: { projectId: 'a', target, scripts: { dev: 'echo dev' } },
      };
}
// Preserve overload-specific result checking at call sites through a common adapter.
function apply(
  input: WorkspaceSourceChangesRequest,
): Promise<
  WorkspaceApplySourceChangesResponse | ProjectApplySourceChangesResponse
> {
  return input.kind === 'workspace'
    ? applySourceChanges(input)
    : applySourceChanges(input);
}
function receipt(): Parameters<W5CommitLogHost['lookupReceipt']>[0] {
  const value = reservations.mock.calls[0]?.[0].receipt;
  if (!value) throw new Error('Expected reservation');
  return value;
}
async function observation(
  includeJournal = true,
): Promise<SourceChangeObservation> {
  const rows = worktreeListSchema.parse(
    JSON.parse(image(join(root, 'a', 'worktrees.json'))),
  ).worktrees;
  return {
    files: Object.fromEntries(
      [
        'index.json',
        'index.json.bak',
        'a/workspace.json',
        'a/worktrees.json',
        'b/workspace.json',
        'b/worktrees.json',
      ].map((name) => [name, image(join(root, name))]),
    ),
    sources: rows.map((row) =>
      image(join(root, 'a', 'worktrees', row.id, 'canopy.json')),
    ),
    revisions: [
      await host.revision(workspace),
      await host.revision(collection),
    ],
    journal: includeJournal ? await host.snapshot() : undefined,
    reservations: (await host.recoveryReport()).reservations ?? [],
  };
}
async function expectRecoveryReplay(
  input: WorkspaceSourceChangesRequest,
  includeJournal = true,
): Promise<void> {
  const before = await observation(includeJournal);
  await expect(apply(input)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(await observation(includeJournal)).toEqual(before);
  await host.shutdown();
  start();
  const restarted = await observation(includeJournal);
  await expect(apply(input)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(await observation(includeJournal)).toEqual(restarted);
}
beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture(() => [], ['b']));
  writeFileSync(
    join(repo, 'canopy.json'),
    JSON.stringify({ version: 1, repos: [] }),
  );
  writeFileSync(join(repo, '.gitignore'), 'repos/\n');
  writeFileSync(join(repo, 'AGENTS.md'), 'Keep instructions\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'source',
  ]);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  start();
  reservations = jest.spyOn(host, 'reserve');
  commitOriginal = host.commit.bind(host);
  commits = jest.spyOn(host, 'commit');
});
afterEach(async () => {
  await settleDetachedWork();
  jest.restoreAllMocks();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

it.each(['workspace', 'project'] as const)(
  'records %s foreground acceptance and replays without hooks or writes across restart',
  async (kind) => {
    const input = request(kind);
    const onApplied = jest.fn();
    const create = git.createWorktree;
    jest.spyOn(git, 'createWorktree').mockImplementation(async (...args) => {
      expect(await host.lookupReceipt(receipt())).toMatchObject({
        status: 'in-progress',
      });
      return create(...args);
    });
    const result = await apply({ ...input, onApplied });
    await settleDetachedWork();
    expect(result.createdWorktree).toBe(true);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(commits).toHaveBeenCalledTimes(2);
    expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
    expect(commits.mock.calls[1]?.[0]).toMatchObject({
      files: [],
      outcome: result,
      expectedRevisions: [
        { resource: workspace, revision: 0 },
        { resource: collection, revision: 1 },
      ],
    });
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'replay',
      outcome: result,
    });
    const before = await observation();
    const replayHook = jest.fn(() => {
      throw interruption;
    });
    await expect(
      apply({
        ...input,
        getWindow: () => {
          throw interruption;
        },
        onApplied: replayHook,
      }),
    ).resolves.toEqual(result);
    expect(await observation()).toEqual(before);
    expect(replayHook).not.toHaveBeenCalled();
    await host.shutdown();
    start();
    const restarted = await observation();
    await expect(apply(input)).resolves.toEqual(result);
    expect(await observation()).toEqual(restarted);
  },
);

it.each(['workspace', 'project'] as const)(
  'keeps the %s foreground transition for revision-only requests',
  async (kind) => {
    const input = request(kind);
    delete input.idempotencyKey;
    const onApplied = jest.fn();
    const result = await apply({ ...input, onApplied });
    await settleDetachedWork();

    expect(result.createdWorktree).toBe(true);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(reservations).not.toHaveBeenCalled();
    expect(commits).toHaveBeenCalledTimes(2);
    expect(commits.mock.calls[1]?.[0]).toMatchObject({
      files: [],
      expectedRevisions: [
        { resource: workspace, revision: 0 },
        { resource: collection, revision: 1 },
      ],
    });
    for (const [change] of commits.mock.calls)
      expect(change.receipt).toBeUndefined();
    expect((await observation()).revisions).toEqual([0, 1]);
  },
);

it.each(['workspace', 'project'] as const)(
  'refuses changed %s semantics but not a changed revision',
  async (kind) => {
    const input = request(kind);
    const result = await apply(input);
    await settleDetachedWork();
    const before = await observation();
    const changed =
      input.kind === 'workspace'
        ? { ...input, request: { ...input.request, startPage: null } }
        : { ...input, request: { ...input.request, startPage: null } };
    await expect(apply(changed)).rejects.toMatchObject({
      reason: 'key-reused',
    });
    await expect(
      apply({
        ...input,
        expectedRevisions: [{ resource: workspace, revision: 999 }],
      }),
    ).resolves.toEqual(result);
    expect(await observation()).toEqual(before);
  },
);

it.each([workspace, collection])(
  'releases stale $kind admission without any canonical changes',
  async (resource) => {
    const input = request('workspace');
    const before = await observation();
    await expect(
      apply({ ...input, expectedRevisions: [{ resource, revision: 7 }] }),
    ).rejects.toMatchObject({ reason: 'revision-conflict' });
    expect(await host.lookupReceipt(receipt())).toEqual({ status: 'none' });
    expect(await observation()).toEqual(before);
    await expect(apply(input)).resolves.toHaveProperty('createdWorktree', true);
  },
);

it.each(['workspace', 'project'] as const)(
  'releases safe missing %s target refusals',
  async (kind) => {
    const input = request(kind, false);
    const before = await observation();
    await expect(apply(input)).rejects.toMatchObject({ reason: 'not-found' });
    expect(await host.lookupReceipt(receipt())).toEqual({ status: 'none' });
    expect(await observation()).toEqual(before);
  },
);

it.each(['workspace', 'project'] as const)(
  'keeps %s recovery required after callback failure even though rollback ran',
  async (kind) => {
    const input = request(kind);
    const before = await observation();
    await expect(
      apply({
        ...input,
        onApplied: () => {
          throw interruption;
        },
      }),
    ).rejects.toBe(interruption);
    const after = await observation();
    expect(after.files['a/workspace.json']).toEqual(
      before.files['a/workspace.json'],
    );
    expect(
      worktreeListSchema.parse(
        JSON.parse(after.files['a/worktrees.json'] ?? ''),
      ).worktrees,
    ).toEqual([]);
    expect(after.revisions).toEqual([0, 2]);
    expect(after.reservations).toHaveLength(1);
    expect(after.reservations[0]).toMatchObject({
      diagnostics: { errorName: 'Error' },
    });
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'recovery-required',
    });
    await host.shutdown();
    start();
    const restarted = await observation();
    await expect(apply(input)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(await observation()).toEqual(restarted);
  },
);

it.each(['workspace', 'project'] as const)(
  'preserves %s effects on a final revision conflict',
  async (kind) => {
    const input = request(kind);
    const create = jest.spyOn(git, 'createWorktree');
    const write = jest.spyOn(canopy, 'writeCanopyJson');
    const onApplied = jest.fn();
    const commit = commitOriginal;
    commits.mockImplementation(async (change) => {
      if (change.receipt) {
        const previousRaw = image(manifestPath());
        // The file-store queue is held here; inject the rival worker decision directly.
        await commit({
          operation: 'core.workspace.update',
          files: [
            {
              path: manifestPath(),
              previousFingerprint: fingerprintW5File(previousRaw),
              contents: JSON.stringify({
                ...JSON.parse(previousRaw),
                itemSortMode: 'last-updated',
              }),
            },
          ],
          advance: [workspace],
          outcome: null,
        });
      }
      return commit(change);
    });
    await expect(apply({ ...input, onApplied })).rejects.toMatchObject({
      reason: 'revision-conflict',
    });
    const rows = await persistence.readWorkspaceWorktrees('a');
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (!row) throw new Error('Expected preserved worktree');
    const path =
      kind === 'workspace'
        ? getWorkspaceWorktreeRootRepoDir('a', row.id)
        : getWorktreeDir('a', row.id);
    expect(image(join(path, 'canopy.json'))).toContain('echo dev');
    expect(image(manifestPath())).toContain('last-updated');
    expect((await observation()).revisions).toEqual([1, 1]);
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'recovery-required',
    });
    await expectRecoveryReplay({ ...input, onApplied });
    expect(create).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(image(join(path, 'canopy.json'))).toContain('echo dev');
  },
);

it.each([false, true])(
  'background binding never rewrites the foreground receipt; failed=%s',
  async (failed) => {
    const input = request('workspace', false);
    await git.createWorktree(
      repo,
      getWorkspaceWorktreeRootRepoDir('a', 'otter'),
      'otter',
    );
    writeFileSync(
      join(root, 'a', 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'otter',
            branchName: 'otter',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    writeFileSync(
      manifestPath(),
      JSON.stringify({
        version: 1,
        type: 'multi-repo',
        sourceRepoPath: repo,
        repos: [{ id: 'r', name: 'R', repoPath: repo }],
      }),
    );
    const read = canopy.readCanopyJson;
    jest
      .spyOn(canopy, 'readCanopyJson')
      .mockImplementation(async (...args) => ({
        ...(await read(...args)),
        version: 1,
        repos: [{ id: 'r', name: 'R', url: 'https://example.com/r.git' }],
      }));
    const logged = jest.spyOn(console, 'error').mockImplementation(() => {});
    if (failed)
      jest
        .spyOn(persistence, 'updateWorkspaceConfig')
        .mockRejectedValueOnce(interruption);
    const result = await apply(input);
    expect(result).toHaveProperty('localRepoBindingsUpdated', true);
    await settleDetachedWork();
    expect(await host.revision(workspace)).toBe(failed ? 0 : 1);
    if (failed) expect(logged).toHaveBeenCalled();
    else expect(logged).not.toHaveBeenCalled();
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'replay',
      outcome: result,
    });
    expect(
      commits.mock.calls.filter(([change]) => change.receipt),
    ).toHaveLength(1);
    const before = await observation();
    await expect(apply(input)).resolves.toEqual(result);
    expect(await observation()).toEqual(before);
  },
);

it.each(['workspace', 'project'] as const)(
  'keeps a lost %s receipt acknowledgement replayable without rollback or repeated effects across restart',
  async (kind) => {
    const input = request(kind);
    const create = jest.spyOn(git, 'createWorktree');
    const write = jest.spyOn(canopy, 'writeCanopyJson');
    const onApplied = jest.fn();
    const commit = commitOriginal;
    commits.mockImplementation(async (change) => {
      const result = await commit(change);
      if (change.receipt) throw interruption;
      return result;
    });
    await expect(apply({ ...input, onApplied })).rejects.toBe(interruption);
    const saved = await host.lookupReceipt(receipt());
    if (saved.status !== 'replay') throw new Error('Expected saved acceptance');
    const before = await observation();
    expect(before.sources[0]).toContain('echo dev');
    expect(before.revisions).toEqual([0, 1]);
    expect(before.reservations).toEqual([]);
    await expect(apply({ ...input, onApplied })).resolves.toEqual(
      saved.outcome,
    );
    expect(await observation()).toEqual(before);
    await host.shutdown();
    start();
    const restarted = await observation();
    await expect(apply({ ...input, onApplied })).resolves.toEqual(
      saved.outcome,
    );
    expect(await observation()).toEqual(restarted);
    expect(create).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
  },
);

it('rejects parent bindings before reserving and preserves unkeyed behavior', async () => {
  const input = request('project');
  await expect(
    withW5Commit(
      { operation: 'parent', locks: w5CompositionLocks({ lists: ['a'] }) },
      () => apply(input),
    ),
  ).rejects.toMatchObject({ reason: 'invalid-request' });
  expect(reservations).not.toHaveBeenCalled();
  const unkeyed = { ...input };
  delete unkeyed.expectedRevisions;
  delete unkeyed.idempotencyKey;
  await expect(apply(unkeyed)).resolves.toHaveProperty('createdWorktree', true);
  expect(reservations).not.toHaveBeenCalled();
  expect(commits).toHaveBeenCalledTimes(1);
  expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
});

it.each(['workspace', 'project'] as const)(
  'accepts an existing %s target with a receipt-only decision',
  async (kind) => {
    const input = request(kind, false);
    const target =
      kind === 'workspace'
        ? getWorkspaceWorktreeRootRepoDir('a', 'otter')
        : getWorktreeDir('a', 'otter');
    await git.createWorktree(repo, target, 'otter');
    writeFileSync(
      join(root, 'a', 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'otter',
            branchName: 'otter',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    const result = await apply(input);
    expect(result.createdWorktree).toBe(false);
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0]).toMatchObject({
      files: [],
      outcome: result,
    });
    expect((await observation()).revisions).toEqual([0, 0]);
  },
);

it('releases a typed pre-effect file preflight refusal, but retains unknown interrupted admission across restart', async () => {
  const input = request('project');
  const before = await observation();
  const read = jest.spyOn(persistence, 'readWorkspaceConfig');
  read.mockRejectedValueOnce(new W5FileWriteRefusedError(manifestPath()));
  await expect(apply(input)).rejects.toMatchObject({
    reason: 'fingerprint-conflict',
  });
  expect(await host.lookupReceipt(receipt())).toEqual({ status: 'none' });
  expect(await observation()).toEqual(before);
  read.mockRejectedValueOnce(interruption);
  jest
    .spyOn(host, 'markReservationRecoveryRequired')
    .mockRejectedValueOnce(new Error('worker unavailable'));
  await expect(apply(input)).rejects.toBe(interruption);
  expect((await observation()).files).toEqual(before.files);
  await host.shutdown();
  start();
  const restarted = await observation();
  await expect(apply(input)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(await observation()).toEqual(restarted);
});

it.each(['workspace', 'project'] as const)(
  'preserves %s checkout and recovery when the row decision conflicts after Git',
  async (kind) => {
    const input = request(kind);
    const create = git.createWorktree;
    const write = jest.spyOn(canopy, 'writeCanopyJson');
    const onApplied = jest.fn();
    let target = '';
    const createSpy = jest
      .spyOn(git, 'createWorktree')
      .mockImplementationOnce(async (...args) => {
        target = args[1];
        const branch = await create(...args);
        await persistence.updateWorkspaceConfig('a', (config): void => {
          config.itemSortMode = 'last-updated';
        });
        return branch;
      });
    await expect(apply({ ...input, onApplied })).rejects.toMatchObject({
      reason: 'revision-conflict',
    });
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'recovery-required',
    });
    expect((await observation()).revisions).toEqual([1, 0]);
    await expectRecoveryReplay({ ...input, onApplied });
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  },
);

it.each(['workspace', 'project'] as const)(
  'preserves %s checkout when an unapplied list decision blocks the row after Git',
  async (kind) => {
    const input = request(kind);
    expect(
      await host.commit({
        operation: 'core.worktree.update',
        files: [
          {
            path: join(root, 'a', 'worktrees.json'),
            previousFingerprint: null,
            contents: JSON.stringify({
              version: 1,
              worktrees: [],
              pending: true,
            }),
          },
        ],
        advance: [collection],
        outcome: null,
      }),
    ).toMatchObject({ status: 'recovery-required' });
    input.expectedRevisions = [
      { resource: workspace, revision: 0 },
      { resource: collection, revision: 1 },
    ];
    const before = await observation(false);
    const create = git.createWorktree;
    let target = '';
    const createSpy = jest
      .spyOn(git, 'createWorktree')
      .mockImplementation(async (...args) => {
        target = args[1];
        return create(...args);
      });
    const write = jest.spyOn(canopy, 'writeCanopyJson');
    const onApplied = jest.fn();
    await expect(apply({ ...input, onApplied })).rejects.toMatchObject({
      reason: 'unapplied-change',
    });
    expect(target).not.toBe('');
    expect(existsSync(join(target, '.git'))).toBe(true);
    const after = await observation(false);
    expect(after.files).toEqual(before.files);
    expect(after.revisions).toEqual([0, 1]);
    expect(after.reservations).toHaveLength(1);
    expect(after.reservations[0]).toMatchObject({
      diagnostics: { errorName: 'W5CommitRefusedError' },
    });
    await expectRecoveryReplay({ ...input, onApplied }, false);
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(write).not.toHaveBeenCalled();
    expect(onApplied).not.toHaveBeenCalled();
  },
);

it.each(['', '../a', 'A'])(
  'validates scope %j before reserving',
  async (projectId) => {
    const input = request('project');
    if (input.kind !== 'project') throw new Error('Expected project');
    await expect(
      apply({ ...input, request: { ...input.request, projectId } }),
    ).rejects.toThrow('Invalid projectId');
    expect(reservations).not.toHaveBeenCalled();
  },
);

// W6f3 record-seam equivalence; substituted host hooks are not unmodified
// product lifecycle evidence. The port applies JSON copies of each decision.
function recordSourceChangeSeam(): unknown[] {
  const events: unknown[] = [];
  const update = recordPort.applyWorktreeListUpdate;
  jest
    .spyOn(recordPort, 'applyWorktreeListUpdate')
    .mockImplementation(async (id, decision, preconditions) => {
      events.push(`decision:${decision.kind}`);
      return update(id, jsonRecordRoundTrip(decision), preconditions);
    });
  const remove = recordPort.applyWorktreeListRemoval;
  jest
    .spyOn(recordPort, 'applyWorktreeListRemoval')
    .mockImplementation(async (id, decision, preconditions) => {
      events.push(`decision:${decision.kind}`);
      return remove(id, jsonRecordRoundTrip(decision), preconditions);
    });
  const manifest = recordPort.applyWorkspaceManifestDecision;
  jest
    .spyOn(recordPort, 'applyWorkspaceManifestDecision')
    .mockImplementation(async (id, decision) => {
      events.push(`decision:${decision.kind}`);
      return manifest(id, jsonRecordRoundTrip(decision));
    });
  const create = git.createWorktree;
  jest.spyOn(git, 'createWorktree').mockImplementation(async (...args) => {
    events.push('git');
    return create(...args);
  });
  const write = canopy.writeCanopyJson;
  jest.spyOn(canopy, 'writeCanopyJson').mockImplementation(async (...args) => {
    events.push('canopy.json');
    return write(...args);
  });
  reservations.mockImplementation(async (input) => {
    events.push('reserve');
    return W5CommitLogHost.prototype.reserve.call(host, input);
  });
  commits.mockImplementation(async (input) => {
    events.push({
      files: input.files.map((file) => relative(root, file.path)),
      receipt: Boolean(input.receipt),
    });
    return commitOriginal(input);
  });
  return events;
}

it.each(['workspace', 'project'] as const)(
  'W6f3 commits the %s target row between Git and canopy.json, then saves only the receipt',
  async (kind) => {
    const input = request(kind);
    const events = recordSourceChangeSeam();
    const result = await apply(input);
    await settleDetachedWork();
    expect(events).toEqual([
      'reserve',
      'git',
      'decision:workspace.sourceChanges.target.record',
      { files: [join('a', 'worktrees.json')], receipt: false },
      'canopy.json',
      { files: [], receipt: true },
    ]);
    const before = await observation();
    events.length = 0;
    await expect(apply(input)).resolves.toEqual(result);
    expect(events).toEqual([]);
    expect(await observation()).toEqual(before);
  },
);

it.each(['workspace', 'project'] as const)(
  'W6f3 keeps the %s rollback removal outside the boundary step and recovery required',
  async (kind) => {
    const input = request(kind);
    const events = recordSourceChangeSeam();
    await expect(
      apply({
        ...input,
        onApplied: () => {
          throw interruption;
        },
      }),
    ).rejects.toBe(interruption);
    expect(events).toEqual([
      'reserve',
      'git',
      'decision:workspace.sourceChanges.target.record',
      { files: [join('a', 'worktrees.json')], receipt: false },
      'canopy.json',
      'decision:workspace.sourceChanges.target.remove',
      { files: [join('a', 'worktrees.json')], receipt: false },
    ]);
    expect((await observation()).revisions).toEqual([0, 2]);
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'recovery-required',
    });
  },
);

it.each([
  ['workspace', 'row'],
  ['project', 'row'],
  ['workspace', 'receipt'],
  ['project', 'receipt'],
] as const)(
  'W6f3 preserves %s effects and decides no rollback removal when the %s commit conflicts after Git',
  async (kind, step) => {
    const input = request(kind);
    const events = recordSourceChangeSeam();
    const seamCommit = commits.getMockImplementation();
    if (!seamCommit) throw new Error('Expected the seam commit');
    let rivalCommitted = false;
    commits.mockImplementation(async (change) => {
      if (!rivalCommitted && Boolean(change.receipt) === (step === 'receipt')) {
        rivalCommitted = true;
        const previousRaw = image(manifestPath());
        // The file-store queue is held here; inject the rival worker decision directly.
        await commitOriginal({
          operation: 'core.workspace.update',
          files: [
            {
              path: manifestPath(),
              previousFingerprint: fingerprintW5File(previousRaw),
              contents: JSON.stringify({
                ...JSON.parse(previousRaw),
                itemSortMode: 'last-updated',
              }),
            },
          ],
          advance: [workspace],
          outcome: null,
        });
      }
      return seamCommit(change);
    });
    await expect(apply(input)).rejects.toMatchObject({
      reason: 'revision-conflict',
    });
    const rowStep = [
      'reserve',
      'git',
      'decision:workspace.sourceChanges.target.record',
      { files: [join('a', 'worktrees.json')], receipt: false },
    ];
    expect(events).toEqual(
      step === 'row'
        ? rowStep
        : [...rowStep, 'canopy.json', { files: [], receipt: true }],
    );
    const target = jest.mocked(git.createWorktree).mock.calls[0]?.[1] ?? '';
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(image(manifestPath())).toContain('last-updated');
    const rows = await persistence.readWorkspaceWorktrees('a');
    expect(rows).toHaveLength(step === 'row' ? 0 : 1);
    expect((await observation()).revisions).toEqual(
      step === 'row' ? [1, 0] : [1, 1],
    );
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'recovery-required',
    });
    events.length = 0;
    await expectRecoveryReplay(input);
    expect(events).toEqual([]);
    expect(existsSync(join(target, '.git'))).toBe(true);
  },
);

it('W6f3 decides background bindings after the foreground receipt, never with it', async () => {
  const input = request('workspace', false);
  await git.createWorktree(
    repo,
    getWorkspaceWorktreeRootRepoDir('a', 'otter'),
    'otter',
  );
  writeFileSync(
    join(root, 'a', 'worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: [
        {
          id: 'otter',
          branchName: 'otter',
          createdAt: new Date().toISOString(),
        },
      ],
    }),
  );
  writeFileSync(
    manifestPath(),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: repo,
      repos: [{ id: 'r', name: 'R', repoPath: repo }],
    }),
  );
  const read = canopy.readCanopyJson;
  jest.spyOn(canopy, 'readCanopyJson').mockImplementation(async (...args) => ({
    ...(await read(...args)),
    version: 1,
    repos: [{ id: 'r', name: 'R', url: 'https://example.com/r.git' }],
  }));
  const events = recordSourceChangeSeam();
  const result = await apply(input);
  await settleDetachedWork();
  expect(result).toHaveProperty('localRepoBindingsUpdated', true);
  expect(events).toEqual([
    'reserve',
    'canopy.json',
    { files: [], receipt: true },
    'decision:workspace.sourceChanges.bindings',
    { files: [join('a', 'workspace.json')], receipt: false },
  ]);
  expect(JSON.parse(image(manifestPath()))).toMatchObject({
    repos: [
      {
        id: 'r',
        source: 'manifest',
        manifestUrl: 'https://example.com/r.git',
      },
    ],
  });
});

// CAN-4928: inactive W3c1 lifecycle, real canonical files, Git and commit-log worker.
import { jsonRecordRoundTrip } from './fixtures/json-record-round-trip';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import * as recordPort from '../workspace-record-decision-port';
import type { WorkspaceInitGitResponse } from '@canopy/desktop-shared/types';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () => {
  const fixture = jest.requireActual<typeof TsxWorkerThreads>(
    '../../ledger/__tests__/fixtures/tsx-worker-threads',
  );
  return fixture.createTsxWorkerThreads();
});
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({ recordAppDiagnostic: jest.fn() })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import * as git from '../git';
import * as persistence from '../workspace-persistence';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  withW5Commit,
} from '../w5-commit-log-file-store';
import { w5CompositionLocks } from '../w5-composition-operation';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { initializeWorkspaceSourceRepo as initialize } from '../workspace-source-control';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let reservations: jest.SpiedFunction<W5CommitLogHost['reserve']>;
let commits: jest.SpiedFunction<W5CommitLogHost['commit']>;
let commitOriginal: W5CommitLogHost['commit'];
let reserveOriginal: W5CommitLogHost['reserve'];
const resource = { kind: 'workspace', workspaceId: 'a' } as const;
const request = {
  workspaceId: 'a',
  source: 'workspace_settings',
  idempotencyKey: 'initialize',
  expectedRevision: 0,
} as const;
const interruption = new Error('interrupted');
const manifest = (): string => join(root, 'a', 'workspace.json');
const source = (): string => join(dir, 'data', 'repos', 'original');
const image = (path: string): string =>
  existsSync(path) ? readFileSync(path, 'utf8') : '<absent>';
interface Observation {
  files: Record<string, string>;
  sourceManifest: string;
  revision: number;
  journal: Awaited<ReturnType<W5CommitLogHost['snapshot']>>;
  reservations: NonNullable<
    Awaited<ReturnType<W5CommitLogHost['recoveryReport']>>['reservations']
  >;
}
async function observation(): Promise<Observation> {
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
    sourceManifest: image(join(source(), 'canopy.json')),
    revision: await host.revision(resource),
    journal: await host.snapshot(),
    reservations: (await host.recoveryReport()).reservations ?? [],
  };
}
function receipt(): NonNullable<
  Parameters<W5CommitLogHost['reserve']>[0]['receipt']
> {
  const value = reservations.mock.calls[0]?.[0].receipt;
  if (!value) throw new Error('Expected reservation receipt');
  return value;
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
beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture(() => [], ['b']));
  writeFileSync(
    manifest(),
    JSON.stringify({ version: 1, type: 'multi-repo', repos: [] }),
  );
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  start();
  commitOriginal = host.commit.bind(host);
  reserveOriginal = host.reserve.bind(host);
  reservations = jest.spyOn(host, 'reserve');
  commits = jest.spyOn(host, 'commit');
});
afterEach(async () => {
  jest.restoreAllMocks();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

it('reserves before Git and saves the result only after repair, replaying without writes across restart', async () => {
  const init = git.initGitRepo;
  const initializeGit = jest
    .spyOn(git, 'initGitRepo')
    .mockImplementation(async (path) => {
      expect(await host.lookupReceipt(receipt())).toMatchObject({
        status: 'in-progress',
      });
      expect(commits).not.toHaveBeenCalled();
      return init(path);
    });
  const lists = persistence.readWorkspaceWorktrees;
  jest
    .spyOn(persistence, 'readWorkspaceWorktrees')
    .mockImplementationOnce(async (...args) => {
      expect(await host.lookupReceipt(receipt())).toMatchObject({
        status: 'in-progress',
      });
      expect(await host.revision(resource)).toBe(1);
      return lists(...args);
    });
  const result = await initialize(request);
  expect(result).toEqual({
    sourceRepoPath: source(),
    manifest: { version: 1, repos: [] },
    warnings: [],
  });
  expect(commits).toHaveBeenCalledTimes(2);
  expect(commits.mock.calls[0]?.[0]).toMatchObject({
    expectedRevisions: [{ resource, revision: 0 }],
  });
  expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
  expect(commits.mock.calls[1]?.[0]).toMatchObject({
    files: [],
    expectedRevisions: [{ resource, revision: 1 }],
    outcome: result,
  });
  expect(await host.lookupReceipt(receipt())).toMatchObject({
    status: 'replay',
    outcome: result,
  });
  const before = await observation();
  await expect(initialize(request)).resolves.toStrictEqual(result);
  expect(await observation()).toEqual(before);
  expect(initializeGit).toHaveBeenCalledTimes(1);
  expect(commits).toHaveBeenCalledTimes(2);
  await host.shutdown();
  start();
  const afterRestart = await observation();
  await expect(initialize(request)).resolves.toStrictEqual(result);
  expect(await observation()).toEqual(afterRestart);
  expect(initializeGit).toHaveBeenCalledTimes(1);
});

it.each(['repoName', 'workspaceName', 'source'] as const)(
  'rejects changed semantic %s without effects',
  async (field) => {
    await initialize(request);
    const before = await observation();
    const changed =
      field === 'source'
        ? { ...request, source: 'temporary_promote' as const }
        : { ...request, [field]: 'changed' };
    await expect(initialize(changed)).rejects.toMatchObject({
      reason: 'key-reused',
    });
    expect(await observation()).toEqual(before);
  },
);

it('rejects stale revision without a folder or canonical changes and releases the key', async () => {
  const before = await observation();
  await expect(
    initialize({ ...request, expectedRevision: 7 }),
  ).rejects.toMatchObject({ reason: 'revision-conflict' });
  expect(await observation()).toEqual(before);
  expect(await host.lookupReceipt(receipt())).toEqual({ status: 'none' });
  expect(existsSync(source())).toBe(false);
  await expect(initialize(request)).resolves.toHaveProperty(
    'sourceRepoPath',
    source(),
  );
});

it.each(['missing', 'unreadable', 'temporary', 'already-initialized'] as const)(
  'releases a safe %s refusal before any effects',
  async (state) => {
    if (state === 'missing') rmSync(manifest());
    else if (state === 'unreadable') writeFileSync(manifest(), '{');
    else
      writeFileSync(
        manifest(),
        JSON.stringify({
          version: 1,
          type: 'multi-repo',
          repos: [],
          ...(state === 'temporary'
            ? { temporary: true }
            : { sourceRepoPath: '/existing' }),
        }),
      );
    const before = await observation();
    const reason =
      state === 'missing'
        ? 'not-found'
        : state === 'unreadable'
          ? 'configuration-unavailable'
          : state;
    await expect(initialize(request)).rejects.toMatchObject({ reason });
    expect(await host.lookupReceipt(receipt())).toEqual({ status: 'none' });
    expect(await observation()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
    expect(existsSync(source())).toBe(false);
  },
);

it.each(['git', 'record', 'repair', 'receipt'] as const)(
  'keeps the folder and diagnosed recovery after %s failure',
  async (stage) => {
    if (stage === 'git')
      jest.spyOn(git, 'initGitRepo').mockRejectedValueOnce(interruption);
    if (stage === 'record')
      jest
        .spyOn(persistence, 'updateWorkspaceConfig')
        .mockRejectedValueOnce(interruption);
    if (stage === 'repair')
      jest
        .spyOn(persistence, 'readWorkspaceWorktrees')
        .mockRejectedValueOnce(interruption);
    if (stage === 'receipt') {
      commits.mockImplementation(async (input) => {
        if (input.receipt) throw interruption;
        return commitOriginal(input);
      });
    }
    const before = await observation();
    await expect(initialize(request)).rejects.toBe(interruption);
    expect(existsSync(source())).toBe(true);
    const after = await observation();
    expect(after.revision).toBe(
      stage === 'repair' || stage === 'receipt' ? 1 : 0,
    );
    if (after.revision === 0) expect(after.files).toEqual(before.files);
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'recovery-required',
    });
    expect(after.reservations).toHaveLength(1);
    expect(after.reservations[0]).toMatchObject({
      diagnostics: { errorName: 'Error' },
    });
    await host.shutdown();
    start();
    const restarted = await observation();
    await expect(initialize(request)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(await observation()).toEqual(restarted);
  },
);

it('keeps Git effects and recovery on a rival source recorded before its record', async () => {
  const commit = git.commitWithLocalIdentity;
  jest
    .spyOn(git, 'commitWithLocalIdentity')
    .mockImplementationOnce(async (...args) => {
      const result = await commit(...args);
      await persistence.updateWorkspaceConfig('a', (config): void => {
        config.sourceRepoPath = '/rival';
      });
      return result;
    });
  await expect(initialize(request)).rejects.toMatchObject({
    reason: 'already-initialized',
  });
  expect(image(manifest())).toContain('/rival');
  expect(existsSync(join(source(), '.git'))).toBe(true);
  expect(await host.lookupReceipt(receipt())).toMatchObject({
    status: 'recovery-required',
  });
});

it('retains the reservation across restart when recording succeeds but failure diagnostics cannot be saved', async () => {
  jest
    .spyOn(persistence, 'readWorkspaceWorktrees')
    .mockRejectedValueOnce(interruption);
  jest
    .spyOn(host, 'markReservationRecoveryRequired')
    .mockRejectedValueOnce(new Error('worker unavailable'));
  await expect(initialize(request)).rejects.toBe(interruption);
  expect(await host.revision(resource)).toBe(1);
  expect(image(manifest())).toContain(source());
  expect(await host.lookupReceipt(receipt())).toMatchObject({
    status: 'in-progress',
  });
  await host.shutdown();
  start();
  const before = await observation();
  await expect(initialize(request)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(await observation()).toEqual(before);
  expect(existsSync(join(source(), '.git'))).toBe(true);
});

it.each([false, true])(
  'keeps existing removal cleanup only for unkeyed callers; keyed=%s',
  async (keyed) => {
    const list = join(root, 'a', 'worktrees.json');
    const createdAt = new Date().toISOString();
    writeFileSync(
      list,
      JSON.stringify({
        version: 1,
        worktrees: [{ id: 'removed', branchName: 'removed', createdAt }],
      }),
    );
    persistence.markWorkspaceWorktreeRecentlyRemoved('a', 'removed', createdAt);
    const before = image(list);
    const worktreesResource = { kind: 'worktrees', workspaceId: 'a' } as const;
    await initialize(
      keyed ? request : { workspaceId: 'a', source: 'workspace_settings' },
    );
    if (keyed) {
      expect(image(list)).toBe(before);
      expect(await host.revision(worktreesResource)).toBe(0);
      expect(commits).toHaveBeenCalledTimes(2);
      expect(commits.mock.calls.map(([input]) => input.operation)).toEqual([
        'core.workspace.sourceRepo.initialize',
        'core.workspace.sourceRepo.initialize',
      ]);
    } else {
      expect(image(list)).not.toBe(before);
      expect(await host.revision(worktreesResource)).toBe(1);
      expect(commits).toHaveBeenCalledTimes(2);
      expect(reservations).not.toHaveBeenCalled();
    }
  },
);

it.each(['success', 'partial-failure'] as const)(
  'keeps real root worktree repair %s behind the final receipt',
  async (state) => {
    const roots = ['first', 'second'].map((id) =>
      join(root, 'a', 'worktrees', id),
    );
    writeFileSync(
      join(root, 'a', 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: ['first', 'second'].map((id) => ({
          id,
          branchName: id,
          createdAt: '2026-10-24T00:00:00.000Z',
        })),
      }),
    );
    for (const path of roots) {
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'user.txt'), `keep ${path}`);
    }
    const create = git.createWorktree;
    const repair = jest
      .spyOn(git, 'createWorktree')
      .mockImplementation(async (...args) => {
        expect(await host.lookupReceipt(receipt())).toMatchObject({
          status: 'in-progress',
        });
        expect(commits).toHaveBeenCalledTimes(1);
        if (state === 'partial-failure' && args[2] === 'second')
          throw interruption;
        return create(...args);
      });
    let result: WorkspaceInitGitResponse | undefined;
    if (state === 'partial-failure') {
      await expect(initialize(request)).rejects.toThrow(
        'Failed to repair 1 project root worktrees',
      );
      expect(commits).toHaveBeenCalledTimes(1);
      expect(await host.lookupReceipt(receipt())).toMatchObject({
        status: 'recovery-required',
      });
    } else {
      result = await initialize(request);
      expect(commits).toHaveBeenCalledTimes(2);
    }
    const repairedRoots = roots.map((path) => ({
      git: image(join(path, '.git')),
      manifest: image(join(path, 'canopy.json')),
      user: image(join(path, 'user.txt')),
    }));
    expect(repairedRoots[0]?.git).toContain('gitdir:');
    expect(repairedRoots[1]?.git).toEqual(
      state === 'success' ? expect.stringContaining('gitdir:') : '<absent>',
    );
    for (const path of roots)
      expect(image(join(path, 'user.txt'))).toBe(`keep ${path}`);
    expect(await host.revision(resource)).toBe(1);
    await host.shutdown();
    start();
    const before = await observation();
    if (state === 'success')
      await expect(initialize(request)).resolves.toStrictEqual(result);
    else
      await expect(initialize(request)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
    expect(await observation()).toEqual(before);
    expect(
      roots.map((path) => ({
        git: image(join(path, '.git')),
        manifest: image(join(path, 'canopy.json')),
        user: image(join(path, 'user.txt')),
      })),
    ).toEqual(repairedRoots);
    expect(repair).toHaveBeenCalledTimes(2);
  },
);

it.each(['record', 'outcome'] as const)(
  'retains recovery for a revision conflict at %s after effects',
  async (stage) => {
    const intervene = (): Promise<void> =>
      persistence.updateWorkspaceConfig('a', (config): void => {
        config.itemSortMode = 'last-updated';
      });
    if (stage === 'record') {
      const commit = git.commitWithLocalIdentity;
      jest
        .spyOn(git, 'commitWithLocalIdentity')
        .mockImplementationOnce(async (...args) => {
          const result = await commit(...args);
          await intervene();
          return result;
        });
    } else {
      const lists = persistence.readWorkspaceWorktrees;
      jest
        .spyOn(persistence, 'readWorkspaceWorktrees')
        .mockImplementationOnce(async (...args) => {
          await intervene();
          return lists(...args);
        });
    }
    await expect(initialize(request)).rejects.toMatchObject({
      reason: 'revision-conflict',
    });
    expect(existsSync(join(source(), '.git'))).toBe(true);
    expect(await host.revision(resource)).toBe(stage === 'record' ? 1 : 2);
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'recovery-required',
    });
  },
);

it('does not release a key for a file preflight conflict after Git effects', async () => {
  const update = persistence.updateWorkspaceConfig;
  let armed = false;
  jest
    .spyOn(persistence, 'updateWorkspaceConfig')
    .mockImplementation(async (...args) => {
      const result = await update(...args);
      armed = true;
      return result;
    });
  const read = nodeW5FileStore.read.bind(nodeW5FileStore);
  jest.spyOn(nodeW5FileStore, 'read').mockImplementation(async (path) => {
    if (armed && path === manifest()) {
      armed = false;
      writeFileSync(path, `${image(path)}\n`);
    }
    return read(path);
  });
  await expect(initialize(request)).rejects.toMatchObject({
    reason: 'fingerprint-conflict',
  });
  expect(await host.revision(resource)).toBe(0);
  expect(commits).not.toHaveBeenCalled();
  expect(existsSync(join(source(), '.git'))).toBe(true);
  expect(await host.lookupReceipt(receipt())).toMatchObject({
    status: 'recovery-required',
  });
});

it.each([
  { idempotencyKey: 'initialize' },
  { expectedRevision: 0 },
  { idempotencyKey: 'initialize', expectedRevision: 0 },
])(
  'rejects standalone options %j in explicit and ambient parent bindings before reserving',
  async (options) => {
    const child = {
      workspaceId: 'a',
      source: 'workspace_settings' as const,
      ...options,
    };
    const before = await observation();
    const commit = { operation: 'core.workspace.composition.promote' };
    await expect(initialize(child, { commit })).rejects.toMatchObject({
      reason: 'invalid-request',
    });
    await expect(
      withW5Commit(
        { ...commit, locks: w5CompositionLocks({ manifests: ['a'] }) },
        () => initialize(child),
      ),
    ).rejects.toMatchObject({ reason: 'invalid-request' });
    expect(reservations).not.toHaveBeenCalled();
    expect(await observation()).toEqual(before);
  },
);

it.each(['', '../a', 'A'])(
  'validates scope %j before retry lookup or reservation',
  async (workspaceId) => {
    const before = await observation();
    const lookup = jest.spyOn(host, 'lookupReceipt');
    await expect(initialize({ ...request, workspaceId })).rejects.toThrow(
      'Invalid workspaceId',
    );
    expect(lookup).not.toHaveBeenCalled();
    expect(reservations).not.toHaveBeenCalled();
    expect(await observation()).toEqual(before);
  },
);

it('refuses a concurrent same-key attempt without repeating Git', async () => {
  let enter: () => void = () => {};
  let resume: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const init = git.initGitRepo;
  const initializeGit = jest
    .spyOn(git, 'initGitRepo')
    .mockImplementationOnce(async (path) => {
      enter();
      await resumed;
      return init(path);
    });
  const first = initialize(request);
  try {
    await entered;
    const before = await observation();
    await expect(initialize(request)).rejects.toMatchObject({
      reason: 'in-progress',
    });
    expect(await observation()).toEqual(before);
  } finally {
    resume();
  }
  await first;
  expect(initializeGit).toHaveBeenCalledTimes(1);
});

it('retains an interrupted reservation before Git and diagnoses it across restart', async () => {
  reservations.mockImplementationOnce(async (input) => {
    await reserveOriginal(input);
    throw interruption;
  });
  await expect(initialize(request)).rejects.toBe(interruption);
  expect(existsSync(source())).toBe(false);
  await host.shutdown();
  start();
  const before = await observation();
  await expect(initialize(request)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(await observation()).toEqual(before);
});

it('replays a final receipt whose acknowledgement was lost without repeating effects', async () => {
  commits.mockImplementation(async (input) => {
    const result = await commitOriginal(input);
    if (input.receipt) throw interruption;
    return result;
  });
  const initializeGit = jest.spyOn(git, 'initGitRepo');
  await expect(initialize(request)).rejects.toBe(interruption);
  const before = await observation();
  const lookup = await host.lookupReceipt(receipt());
  expect(lookup.status).toBe('replay');
  if (lookup.status !== 'replay') throw new Error('Expected saved receipt');
  await expect(initialize(request)).resolves.toStrictEqual(lookup.outcome);
  expect(await observation()).toEqual(before);
  expect(initializeGit).toHaveBeenCalledTimes(1);
});

it('projects warnings, structured scripts and portable hooks identically on first response and historical replay', async () => {
  const scripts = {
    dev: { command: 'echo dev', timeoutSeconds: 900, interactive: true },
  };
  const portableHook = {
    type: 'chat',
    prompt: 'Review project PR',
    'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
  };
  writeFileSync(
    manifest(),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      scripts: { ...scripts, launch: null },
      hooks: {
        'pr:create': [
          {
            ...portableHook,
            pluginSelections: {
              collectionIds: ['local-only'],
              skillRefs: [],
              pluginRefs: [],
            },
          },
        ],
      },
      repos: [{ id: 'local', name: 'Local', repoPath: join(dir, 'repo') }],
    }),
  );
  const result = await initialize(request);
  expect(result.warnings).toHaveLength(2);
  expect(result.warnings[0]).toMatchObject({
    code: 'missing-remote',
    repoId: 'local',
  });
  expect(result.warnings[1]).toMatchObject({
    code: 'local-hook-plugin-selections',
  });
  expect(result.manifest.scripts).toEqual(scripts);
  expect(result.manifest.hooks).toEqual({ 'pr:create': [portableHook] });
  const saved = await host.lookupReceipt(receipt());
  expect(saved).toMatchObject({ status: 'replay', outcome: result });
  await persistence.updateWorkspaceConfig('a', (config): void => {
    config.scripts = { other: 'echo later' };
    config.hooks = undefined;
  });
  const before = await observation();
  await expect(
    initialize({ ...request, expectedRevision: 99 }),
  ).resolves.toStrictEqual(result);
  expect(await observation()).toEqual(before);
  await host.shutdown();
  start();
  const restarted = await observation();
  await expect(initialize(request)).resolves.toStrictEqual(result);
  expect(await observation()).toEqual(restarted);
});

it('accepts an empty repository name and replays the chosen fallback path', async () => {
  const result = await initialize({ ...request, repoName: '' });
  expect(result.sourceRepoPath).toBe(join(dir, 'data', 'repos', 'workspace'));
  const before = await observation();
  await expect(initialize({ ...request, repoName: '' })).resolves.toStrictEqual(
    result,
  );
  expect(await observation()).toEqual(before);
});

it('keeps standalone unkeyed initialization without a reservation or receipt-only decision', async () => {
  const result = await initialize({
    workspaceId: 'a',
    source: 'workspace_settings',
  });
  expect(result.sourceRepoPath).toBe(source());
  expect(reservations).not.toHaveBeenCalled();
  expect(commits).toHaveBeenCalledTimes(1);
  expect(commits.mock.calls[0]?.[0].operation).toBe(
    'w5.workspace_manifest.write',
  );
  expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
});

it('keeps unkeyed and parent callers unkeyed without a child final receipt', async () => {
  const commit = { operation: 'core.workspace.composition.promote' };
  const beforeEffects = jest.fn();
  await initialize(
    { workspaceId: 'a', source: 'temporary_promote' },
    { commit, beforeEffects },
  );
  expect(beforeEffects).toHaveBeenCalledTimes(1);
  expect(reservations).not.toHaveBeenCalled();
  expect(commits).toHaveBeenCalledTimes(1);
  expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
});

// W6f2 record-seam equivalence; substituted host hooks are not unmodified
// product lifecycle evidence. The port applies JSON copies of each decision.
it('W6f2 keeps source recording between Git and repair, then saves only the receipt', async () => {
  const events: unknown[] = [];
  const apply = recordPort.applyWorkspaceManifestDecision;
  jest
    .spyOn(recordPort, 'applyWorkspaceManifestDecision')
    .mockImplementation(async (id, decision) => {
      events.push(`decision:${decision.kind}`);
      return apply(id, jsonRecordRoundTrip(decision));
    });
  const init = git.initGitRepo;
  jest.spyOn(git, 'initGitRepo').mockImplementation(async (...args) => {
    events.push('git');
    return init(...args);
  });
  const lists = persistence.readWorkspaceWorktrees;
  jest
    .spyOn(persistence, 'readWorkspaceWorktrees')
    .mockImplementation(async (...args) => {
      events.push('repair');
      return lists(...args);
    });
  reservations.mockImplementation(async (input) => {
    events.push('reserve');
    return reserveOriginal(input);
  });
  commits.mockImplementation(async (input) => {
    events.push({
      files: input.files.map((file) => relative(root, file.path)),
      receipt: Boolean(input.receipt),
    });
    return commitOriginal(input);
  });
  const result = await initialize(request);
  expect(events).toEqual([
    'reserve',
    'git',
    'decision:workspace.source.initialize',
    { files: [join('a', 'workspace.json')], receipt: false },
    'repair',
    { files: [], receipt: true },
  ]);
  const before = await observation();
  events.length = 0;
  await expect(initialize(request)).resolves.toEqual(result);
  expect(events).toEqual([]);
  expect(await observation()).toEqual(before);
});

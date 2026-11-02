// CAN-4614: inactive W3b contracts, using the real W5 worker and canonical files.
import { jsonRecordRoundTrip } from './fixtures/json-record-round-trip';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as recordPort from '../workspace-record-decision-port';
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

import { onScriptActionsRepositoryAdd } from '../../services/script-actions-lifecycle';
import { W5CommitLog } from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  withW5Commit,
  W5RevisionConflictError,
  type W5CommitOptions as Parent,
} from '../w5-commit-log-file-store';
import { w5CompositionLocks } from '../w5-composition-operation';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import * as persistence from '../workspace-persistence';
const { readWorkspaceWorktreesDetailed: readWorktrees } = persistence;
const manifestUpdates = (): jest.SpiedFunction<
  typeof persistence.updateWorkspaceConfig
> => jest.spyOn(persistence, 'updateWorkspaceConfig');
import {
  convertWorkspaceType as convert,
  WorkspaceTypeConversionRefusedError as ConversionRefused,
} from '../workspace-type-conversion';
import {
  addWorkspaceRepository as addRepository,
  removeWorkspaceRepository as removeRepository,
} from '../workspace-repositories';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
const manifest = (): string => join(root, 'a', 'workspace.json');
const index = (): string => join(root, 'index.json');
const worktrees = (): string => join(root, 'a', 'worktrees.json');
const readImage = (path: string): string =>
  existsSync(path) ? readFileSync(path, 'utf8') : '<absent>';
function images(): Record<string, string> {
  const paths = {
    index: index(),
    backup: `${index()}.bak`,
    manifest: manifest(),
    worktrees: worktrees(),
    otherManifest: join(root, 'b', 'workspace.json'),
    otherWorktrees: join(root, 'b', 'worktrees.json'),
    gitignore: join(repo, '.gitignore'),
    canopy: join(repo, 'canopy.json'),
    instructions: join(repo, 'AGENTS.md'),
    mirror: join(repo, 'CLAUDE.md'),
  };
  return Object.fromEntries(
    Object.entries(paths).map(([name, path]) => [name, readImage(path)]),
  );
}

let commits: jest.SpiedFunction<W5CommitLogHost['commit']>;
let reservations: jest.SpiedFunction<W5CommitLogHost['reserve']>;
let commitOriginal: W5CommitLogHost['commit'];
let reserveOriginal: W5CommitLogHost['reserve'];
function receipt(): Parameters<W5CommitLogHost['lookupReceipt']>[0] {
  const value = reservations.mock.calls[0]?.[0].receipt;
  if (!value) throw new Error('Expected reservation receipt');
  return value;
}
type Checkpoint = Partial<Snapshot> & {
  retry?: 'none' | 'replay' | 'recovery-required';
  outcome?: unknown;
};
async function checkpoint(expected: Checkpoint): Promise<void> {
  const { retry, outcome, ...snapshot } = expected;
  expect(await observation()).toEqual(expect.objectContaining(snapshot));
  if (retry) {
    const lookup = await host.lookupReceipt(receipt());
    if (retry === 'none') expect(lookup).toEqual({ status: 'none' });
    else expect(lookup).toMatchObject({ status: retry });
    if ('outcome' in expected)
      expect(lookup).toHaveProperty('outcome', outcome);
  }
}

function afterCall<Args extends unknown[], Result>(
  effect: (...args: Args) => Promise<Result>,
  after: (result: Result) => unknown,
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    const result = await effect(...args);
    await after(result);
    return result;
  };
}
function interrupt(): never {
  throw interruption;
}

const observation = async (): Promise<Snapshot> => ({
  files: images(),
  revision: await host.revision(resource),
  worktreesRevision: await host.revision(worktreesResource),
  journal: await host.snapshot(),
});

async function refuses(
  work: Pending,
  reason: string,
  before?: Snapshot,
): Promise<void> {
  await expect(work).rejects.toMatchObject({ reason });
  if (before) await checkpoint({ ...before, retry: 'none' });
}

function expectCalls(count: number, ...spies: jest.SpyInstance[]): void {
  for (const spy of spies) expect(spy).toHaveBeenCalledTimes(count);
}
async function safeRefusal(
  kind: Kind,
  reason: string,
  before: Snapshot,
): Promise<void> {
  for (const options of [retry, {}])
    await refuses(run(kind, options), reason, before);
  expectCalls(0, commits);
}

async function replay(
  work: Action,
  result: unknown,
  before?: Snapshot,
): Promise<void> {
  before ??= await observation();
  const commit = jest.spyOn(host, 'commit');
  const count = commit.mock.calls.length;
  await expect(work()).resolves.toStrictEqual(result);
  expect(await observation()).toEqual(before);
  expect(commit).toHaveBeenCalledTimes(count);
}

async function restartReplay(work: Action, result: unknown): Promise<void> {
  const before = await observation();
  await restart();
  await replay(work, result, before);
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

async function restart(): Promise<void> {
  await host.shutdown();
  start();
}

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture(() => [], ['b']));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  start();
  commitOriginal = host.commit.bind(host);
  reserveOriginal = host.reserve.bind(host);
  commits = jest.spyOn(host, 'commit');
  reservations = jest.spyOn(host, 'reserve');
});

afterEach(async () => {
  jest.restoreAllMocks();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const requestBase = { workspaceId: 'a', source: 'workspace_settings' } as const;
const conversion = conversionFor('convert-multi');
const noOpKinds = ['remove', 'restore'] as const;

it('refuses a manifest recording failure without a split index decision', async () => {
  const before = images();
  manifestUpdates().mockRejectedValueOnce(interruption);
  await expect(convert(conversion)).rejects.toBe(interruption);
  expect(readFileSync(index(), 'utf8')).toBe(before.index);
  expect(readFileSync(manifest(), 'utf8')).toBe(before.manifest);
  expect(commits).not.toHaveBeenCalled();
  expect(existsSync(join(repo, 'canopy.json'))).toBe(true);
});

it('records conversion index and manifest together', async () => {
  await convert(conversion);
  expect(commits).toHaveBeenCalledTimes(1);
  const paths = commits.mock.calls[0]?.[0].files.map((file) => file.path);
  expect(paths).toEqual(expect.arrayContaining([index(), manifest()]));
});

type Snapshot = {
  files: ReturnType<typeof images>;
  revision: number;
  worktreesRevision: number;
  journal: Awaited<ReturnType<W5CommitLogHost['snapshot']>>;
};
type Pending = Promise<unknown>;
type Action = () => Pending;
type Options = { idempotencyKey?: string; expectedRevision?: number };
const refusalCases = [
  ['missing', (): void => rmSync(manifest())],
  ['unreadable', (): void => writeFileSync(manifest(), '{')],
  ['duplicate', (): ReturnType<typeof run> => run('add')],
  ['relative-path', (): string => 'relative'],
  ['not-git', (): string => root],
] as const;
const listStates = ['unreadable', 'partial', 'io', 'absent'] as const;
const repositoryKinds = ['add', 'remove', 'restore'] as const;
const conversionKinds = ['convert-multi', 'convert-single'] as const;
const kinds = [...repositoryKinds, ...conversionKinds] as const;
type Kind = (typeof kinds)[number];
const savedRepo = {
  id: 'old',
  name: 'Old',
  repoPath: '/retained/checkout',
  scripts: { setup: 'echo keep' },
  hooks: { 'worktree:created': null },
};
const writeJson = (path: string, value: unknown): void =>
  writeFileSync(path, JSON.stringify(value));
function prepare(kind: Kind): void {
  if (kind === 'convert-multi') return;
  const repos = kind === 'remove' ? [savedRepo] : [];
  writeJson(manifest(), {
    version: 1,
    type: 'multi-repo',
    repos,
    sourceRepoPath: repo,
    sentinel: 'keep',
  });
  const contents = readFileSync(index(), 'utf8');
  writeFileSync(index(), contents.replace('single-repo', 'multi-repo'));
}

function conversionFor(
  kind: Kind,
  options: Options = {},
  changed = false,
): Parameters<typeof convert>[0] {
  return {
    ...requestBase,
    ...options,
    targetType: kind === 'convert-multi' ? 'multi-repo' : 'single-repo',
    claudeMdMode: changed ? 'replace' : 'unchanged',
  } as const;
}
function addition(
  options: Options = {},
  changed = false,
): Parameters<typeof addRepository>[0] {
  return {
    ...requestBase,
    ...options,
    repository: { repoPath: repo, name: changed ? 'Different' : 'Added' },
  };
}
function run(
  kind: Kind,
  options?: Options,
  changed = false,
  parent?: Parent,
): Pending {
  const request = { ...requestBase, ...options };
  if (kind === 'remove') {
    const repoId = changed ? 'different' : 'old';
    return removeRepository({ ...request, repoId }, parent);
  }
  if (kind === 'add') return addRepository(addition(options, changed), parent);
  if (kind === 'restore') {
    const source = 'organization_sync_revert';
    const restore = { repository: savedRepo, index: changed ? 1 : 0 };
    return addRepository({ ...request, source, restore }, parent);
  }
  return convert(conversionFor(kind, options, changed));
}

const resource = { kind: 'workspace', workspaceId: 'a' } as const;
const worktreesResource = { kind: 'worktrees', workspaceId: 'a' } as const;
const retry = { idempotencyKey: 'retry' };
const initialRevision = { ...retry, expectedRevision: 0 };
const revisionGuard = [{ resource, revision: 0 }];
const interruption = new Error('interrupted');
const durableWorktrees = { includeRecentlyRemoved: true } as const;
const projectedWorktrees = { persistRemovalCleanup: false } as const;

it.each(kinds)('%s: durable response-loss replay', async (kind) => {
  prepare(kind);
  const before = images();
  commits.mockImplementationOnce(afterCall(commitOriginal, interrupt));
  await expect(run(kind, initialRevision)).rejects.toBe(interruption);
  expect(commits).toHaveBeenCalledTimes(1);
  const decision = commits.mock.calls[0]?.[0];
  expect(decision?.receipt).toBeDefined();
  expect(decision?.reservationId).toBeDefined();
  expect(decision?.expectedRevisions).toEqual(revisionGuard);
  const lookup = await host.lookupReceipt(receipt());
  expect(lookup.status).toBe('replay');
  if (lookup.status !== 'replay') throw new Error('Expected saved outcome');
  const expected = kind.startsWith('convert') ? undefined : lookup.outcome;
  const applied = images();
  expect(applied.manifest).not.toBe(before.manifest);
  expect(applied.otherManifest).toBe(before.otherManifest);
  expect(await host.revision(resource)).toBe(1);
  const position = await observation();
  await replay(() => run(kind, initialRevision), expected, position);
  await restart();
  await replay(() => run(kind, retry), expected, position);
  await refuses(run(kind, retry, true), 'key-reused');
  expect(images()).toEqual(applied);
});
it.each(kinds)('%s: stale revision releases key', async (kind) => {
  prepare(kind);
  const before = await observation();
  const stale = { ...retry, expectedRevision: 7 };
  await refuses(run(kind, stale), 'revision-conflict', before);
  await run(kind, initialRevision);
  expect(await host.revision(resource)).toBe(1);
});

it.each(noOpKinds)('%s: durable no-op outcome', async (kind) => {
  prepare(kind === 'remove' ? 'add' : 'remove');
  const before = images();
  const unkeyed = await run(kind);
  if (kind === 'remove') expect(unkeyed).toEqual({ removed: null });
  expectCalls(0, commits);
  await checkpoint({ files: before });
  const result = await run(kind, initialRevision);
  expect(result).toEqual(unkeyed);
  expectCalls(1, commits);
  const empty = { files: [], advance: [] };
  expect(commits.mock.calls[0]?.[0]).toMatchObject(empty);
  await checkpoint({ files: before, revision: 0 });
  await restartReplay(() => run(kind, retry), result);
});

it.each(refusalCases)('%s: repository safe refusal', async (_, arrange) => {
  prepare('add');
  const candidate = await arrange();
  const repoPath = typeof candidate === 'string' ? candidate : repo;
  const before = await observation();
  const request = {
    ...requestBase,
    repository: { repoPath },
    idempotencyKey: 'safe',
  };
  await expect(addRepository(request)).rejects.toThrow();
  await checkpoint(before);
  for (const [reservation] of reservations.mock.calls) {
    if (!reservation.receipt) throw new Error('Expected receipt');
    const lookup = await host.lookupReceipt(reservation.receipt);
    expect(lookup).toEqual({ status: 'none' });
  }
});

it('a preflight manifest conflict releases a standalone key without a decision', async () => {
  prepare('add');
  const before = images();
  const update = persistence.updateWorkspaceConfig;
  let armed = false;
  manifestUpdates().mockImplementation(
    afterCall(update, () => {
      armed = true;
    }),
  );
  const read = nodeW5FileStore.read.bind(nodeW5FileStore);
  jest.spyOn(nodeW5FileStore, 'read').mockImplementation(async (path) => {
    if (armed && path === manifest()) {
      armed = false;
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
    }
    return read(path);
  });
  await refuses(run('add', retry), 'fingerprint-conflict');
  expectCalls(0, commits);
  const changed = { ...before, manifest: `${before.manifest}\n` };
  await checkpoint({ revision: 0, retry: 'none', files: changed });
  jest.restoreAllMocks();
  await run('add', retry);
  expect(await host.revision(resource)).toBe(1);
});

async function resolveCold(): Promise<void> {
  await host.shutdown();
  const log = W5CommitLog.open(join(dir, 'data', 'w5', 'commit-log.sqlite'));
  try {
    for (const { reservationId } of log.listReservations())
      log.resolveRecovery(reservationId);
  } finally {
    log.close();
  }
  start();
}
it.each(kinds)('%s: interruption and recovery', async (kind) => {
  prepare(kind);
  const before = await observation();
  if (kind.startsWith('convert'))
    reservations.mockImplementationOnce(afterCall(reserveOriginal, interrupt));
  else {
    commits.mockImplementationOnce(async () => {
      await host.shutdown();
      throw interruption;
    });
    jest
      .spyOn(host, 'markReservationRecoveryRequired')
      .mockRejectedValueOnce(new Error('process interrupted'));
  }
  await expect(run(kind, retry)).rejects.toBe(interruption);
  jest.restoreAllMocks();
  await restart();
  await checkpoint({ ...before, retry: 'recovery-required' });
  await refuses(run(kind, retry), 'recovery-required');
  await host.shutdown();
  const { diagnoseW5State } = await import('../w5-maintenance-diagnosis');
  const diagnosis = await diagnoseW5State(join(dir, 'data'));
  expect(diagnosis.commits).toEqual([]);
  expect(diagnosis.reservations).toEqual([
    expect.objectContaining({ state: 'recovery-required' }),
  ]);
  await resolveCold();
  const retried = jest.spyOn(host, 'commit');
  const result = await run(kind, retry);
  await replay(() => run(kind, retry), result);
  expectCalls(1, retried);
  await checkpoint({ revision: 1 });
});

async function interveningWrite(): Promise<void> {
  await persistence.updateWorkspaceConfig('a', (config) => {
    config.itemSortMode = 'last-updated';
  });
}

it('a resolved interrupted revision-paired request refuses after an intervening write', async () => {
  prepare('add');
  commits.mockRejectedValueOnce(interruption);
  await expect(run('add', initialRevision)).rejects.toBe(interruption);
  jest.restoreAllMocks();
  await resolveCold();
  await interveningWrite();
  const beforeRetry = images();
  await refuses(run('add', initialRevision), 'revision-conflict');
  await checkpoint({ files: beforeRetry, revision: 1 });
  await run('add', { ...retry, expectedRevision: 1 });
  expect(await host.revision(resource)).toBe(2);
});

it.each(repositoryKinds)('%s: parent equivalence', async (kind) => {
  prepare(kind);
  const before = images();
  const expected = await run(kind);
  const written = readFileSync(manifest(), 'utf8');
  writeFileSync(manifest(), before.manifest);
  commits.mockClear();
  const parent = { operation: 'core.workspace.composition.combine' };
  const result = await withW5Commit(
    { ...parent, locks: w5CompositionLocks({ manifests: ['a'] }) },
    () => run(kind, {}, false, parent),
  );
  // Separate successful additions get distinct discovery receipts.
  const operationIdMatcher: unknown = expect.any(String);
  expect(result).toEqual(
    kind === 'add' && expected
      ? { ...expected, scriptActionsOperationId: operationIdMatcher }
      : expected,
  );
  expect(readFileSync(manifest(), 'utf8')).toBe(written);
  expect(commits).toHaveBeenCalledTimes(1);
  expect(commits.mock.calls[0]?.[0].operation).toBe(parent.operation);
  expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
});

it.each(repositoryKinds)('%s: parent identity exclusion', async (kind) => {
  prepare(kind);
  const before = await observation();
  const parent = { operation: 'parent' };
  const optionsList = [{ expectedRevision: 7 }, { idempotencyKey: 'child' }];
  for (const options of optionsList) {
    await refuses(run(kind, options, false, parent), 'invalid-request');
    const composed = withW5Commit(parent, () => run(kind, options));
    await refuses(composed, 'invalid-request');
  }
  expectCalls(0, reservations, commits);
  await checkpoint(before);
});

it('first keyed results and historical replays remain identical after another mutation', async () => {
  prepare('add');
  const result = await addRepository(addition(retry));
  expect(typeof result.id).toBe('string');
  await removeRepository({ ...requestBase, repoId: result.id });
  await restartReplay(() => run('add', retry), result);
});

describe.each(conversionKinds)('%s worktree admission', (kind) => {
  beforeEach(() => prepare(kind));
  it.each([false, true])('worktrees; tombstone=%s', async (removed) => {
    const createdAt = new Date().toISOString();
    writeJson(worktrees(), {
      version: 1,
      worktrees: [{ id: 'one', branchName: 'main', createdAt }],
    });
    if (removed)
      persistence.markWorkspaceWorktreeRecentlyRemoved('a', 'one', createdAt);
    const before = await observation();
    const projected = { worktrees: removed ? [] : [{ id: 'one' }] };
    const projectedState = await readWorktrees('a', projectedWorktrees);
    expect(projectedState).toMatchObject(projected);
    const durable = { authority: 'ok', worktrees: [{ id: 'one' }] };
    expect(await readWorktrees('a', durableWorktrees)).toMatchObject(durable);
    await safeRefusal(kind, 'has-worktrees', before);
    if (!removed) return;
    // Reload host modules too: process-local tombstones must vanish.
    await restart();
    await jest.isolateModulesAsync(async () => {
      const fresh = await import('../workspace-persistence');
      const store = await import('../w5-commit-log-file-store');
      store.__setDesktopW5FileStoreForTests(
        store.createW5CommitLogFileStore(() => host),
      );
      expect(
        fresh.isWorkspaceWorktreeRecentlyRemoved('a', 'one', createdAt),
      ).toBe(false);
      expect(
        await fresh.readWorkspaceWorktreesDetailed('a', projectedWorktrees),
      ).toMatchObject(durable);
      const { convertWorkspaceType: freshConvert } =
        await import('../workspace-type-conversion');
      await refuses(freshConvert(conversionFor(kind, retry)), 'has-worktrees');
    });
    await checkpoint({ ...before, retry: 'none' });
    await readWorktrees('a');
    const cleaned = readFileSync(worktrees(), 'utf8');
    expect(JSON.parse(cleaned)).toMatchObject({ worktrees: [] });
    await checkpoint({ revision: 0, worktreesRevision: 1 });
    await run(kind, initialRevision);
    expect(readFileSync(worktrees(), 'utf8')).toBe(cleaned);
    await checkpoint({ revision: 1, worktreesRevision: 1, retry: 'replay' });
  });
  it.each(listStates)('%s: no worktree repair or revision', async (state) => {
    const list = worktrees();
    if (state === 'absent') rmSync(list);
    if (state === 'unreadable') writeFileSync(list, '{');
    if (state === 'partial')
      writeJson(list, { version: 1, worktrees: [{ id: 'unknown' }] });
    if (state === 'io') {
      const read = nodeW5FileStore.read.bind(nodeW5FileStore);
      jest
        .spyOn(nodeW5FileStore, 'read')
        .mockImplementation((path) =>
          path === list ? Promise.resolve({ state: 'unreadable' }) : read(path),
        );
    }
    const before = await observation();
    const expected = {
      authority: state === 'io' ? 'unreadable' : state,
      worktrees: [],
    };
    expect(await readWorktrees('a', durableWorktrees)).toEqual(expected);
    if (state !== 'absent')
      return safeRefusal(kind, 'worktrees-unavailable', before);
    await run(kind, retry);
    expect(images().worktrees).toBe(before.files.worktrees);
    const worktreesRevision = before.worktreesRevision;
    await checkpoint({ revision: 1, worktreesRevision, retry: 'replay' });
  });
});

it.each(conversionKinds)('%s: lost-manifest refusal', async (kind) => {
  prepare(kind);
  writeJson(join(repo, 'canopy.json'), {
    version: 1,
    repos: [],
    scripts: { dev: 'echo keep' },
  });
  const before = await observation();
  const sidebar = await import('../sidebar-items');
  const canopy = await import('../canopy-json');
  const repositoryWrite = jest.spyOn(canopy, 'writeCanopyJson');
  const recordManifest = manifestUpdates();
  const read = sidebar.readAllSidebarItems;
  // Delete after a real projection so not-found must come from manifest admission.
  jest.spyOn(sidebar, 'readAllSidebarItems').mockImplementationOnce(
    afterCall(read, (result) => {
      const type = kind === 'convert-multi' ? 'single-repo' : 'multi-repo';
      const expected = { id: 'a', type };
      expect(result.items).toContainEqual(expect.objectContaining(expected));
      rmSync(manifest());
    }),
  );
  const released = jest.spyOn(host, 'releaseReservation');
  const refused = run(kind, initialRevision);
  await expect(refused).rejects.toBeInstanceOf(ConversionRefused);
  await refuses(refused, 'not-found', {
    ...before,
    files: { ...before.files, manifest: '<absent>' },
  });
  expectCalls(0, commits, repositoryWrite, recordManifest);
  expectCalls(1, reservations, released);
  const reservationId = reservations.mock.calls[0]?.[0].reservationId;
  expect(released).toHaveBeenCalledWith(reservationId);
  await checkpoint({ retry: 'none' });

  await restart();
  await checkpoint({ retry: 'none' });
  writeFileSync(manifest(), before.files.manifest);
  const retried = jest.spyOn(host, 'commit');
  await expect(run(kind, initialRevision)).resolves.toBeUndefined();
  expectCalls(1, retried, repositoryWrite, recordManifest);
  expect(await host.revision(resource)).toBe(1);
  await checkpoint({ retry: 'replay', outcome: null });
  await replay(() => run(kind, initialRevision), undefined);
  expectCalls(1, retried, repositoryWrite, recordManifest);
});

const failureStages = [
  'resolve',
  'partial-write',
  'metadata',
  'foreign-revision',
] as const;
type ConversionFailure = (typeof failureStages)[number];
async function injectConversionFault(stage: ConversionFailure): Promise<void> {
  const instructions = await import('../instruction-files');
  if (stage === 'resolve')
    jest
      .spyOn(instructions, 'resolveOptionalProjectInstructionFile')
      .mockRejectedValueOnce(interruption);
  else if (stage === 'metadata')
    manifestUpdates().mockRejectedValueOnce(
      new W5RevisionConflictError('workspace:a', 0, 1),
    );
  else if (stage === 'foreign-revision') {
    const canopy = await import('../canopy-json');
    const write = canopy.writeCanopyJson;
    jest
      .spyOn(canopy, 'writeCanopyJson')
      .mockImplementationOnce(afterCall(write, interveningWrite));
  } else {
    const write = instructions.writeProjectInstructionFile;
    jest
      .spyOn(instructions, 'writeProjectInstructionFile')
      .mockImplementationOnce(async (target, contents) => {
        expect(target.mirrorPath).toBe(join(repo, 'CLAUDE.md'));
        await write({ filePath: target.filePath }, contents);
        throw interruption;
      });
  }
}

it.each(failureStages)('conversion fault: %s', async (stage) => {
  for (const name of ['AGENTS.md', 'CLAUDE.md'])
    writeFileSync(join(repo, name), 'original instructions');
  const before = await observation();
  await injectConversionFault(stage);
  const request = conversionFor('convert-multi', initialRevision, true);
  const failure = expect(convert(request)).rejects;
  const foreign = stage === 'foreign-revision';
  if (stage === 'metadata' || foreign)
    await failure.toMatchObject({ reason: 'revision-conflict' });
  else await failure.toThrow('interrupted');
  expect(commits).toHaveBeenCalledTimes(foreign ? 2 : 0);
  const after = await observation();
  const appliedDecisions = after.journal.commitId - before.journal.commitId;
  expect(appliedDecisions).toBe(foreign ? 1 : 0);
  if (foreign) {
    expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
    expect(commits.mock.calls[1]?.[0].expectedRevisions).toEqual(revisionGuard);
  }
  expect(after.revision).toBe(foreign ? 1 : 0);
  expect(readFileSync(index(), 'utf8')).toBe(before.files.index);
  if (foreign) {
    const expected = { type: 'single-repo', itemSortMode: 'last-updated' };
    const manifestState: unknown = JSON.parse(readFileSync(manifest(), 'utf8'));
    expect(manifestState).toMatchObject(expected);
  } else expect(readFileSync(manifest(), 'utf8')).toBe(before.files.manifest);
  if (stage === 'resolve') {
    await checkpoint({ ...before, retry: 'none' });
    return;
  }
  expect(after.files.canopy).toContain('repos');
  expect(after.files.instructions).not.toBe(before.files.instructions);
  if (stage === 'partial-write')
    expect(after.files.mirror).toBe(before.files.mirror);
  await checkpoint({ retry: 'recovery-required' });
  jest.restoreAllMocks();
  await restart();
  await refuses(convert(request), 'recovery-required');
  expect(await observation()).toEqual(after);
});

it('conversion publication failure cannot erase a committed receipt or repeat file effects', async () => {
  const portal = await import('../../portal/portal-event-bus');
  const publish = jest.spyOn(portal, 'notifyPortalStructureChanged');
  publish.mockImplementationOnce(interrupt);
  const request = { ...conversion, idempotencyKey: 'publication' };
  await expect(convert(request)).rejects.toBe(interruption);
  expectCalls(1, commits);
  await checkpoint({ revision: 1, retry: 'replay', outcome: null });
  jest.restoreAllMocks();
  await restartReplay(() => convert(request), undefined);
});

it('replays the script discovery receipt after restart without notifying again', async () => {
  prepare('add');
  const notified = jest.fn();
  const unsubscribe = onScriptActionsRepositoryAdd(notified);
  try {
    const result = await addRepository(addition(retry));
    expect(result).toHaveProperty(
      'scriptActionsOperationId',
      expect.any(String),
    );
    expect(notified).toHaveBeenCalledTimes(1);
    expect(notified).toHaveBeenCalledWith({
      projectId: 'a',
      repoIds: [result.id],
      operationId: result.scriptActionsOperationId,
    });
    await restartReplay(() => run('add', retry), result);
    expect(notified).toHaveBeenCalledTimes(1);
  } finally {
    unsubscribe();
  }
});

// W6f2: plain decisions retain the index + manifest atomic decision and
// receipt in that same decision. Existing tests above retain recovery coverage.
it.each(conversionKinds)(
  'W6f2 %s applies JSON decisions in the existing commit sequence',
  async (kind) => {
    prepare(kind);
    const events: unknown[] = [];
    const applyIndex = recordPort.applyWorkspaceIndexDecision;
    const applyManifest = recordPort.applyWorkspaceManifestDecision;
    jest
      .spyOn(recordPort, 'applyWorkspaceIndexDecision')
      .mockImplementation(async (decision) => {
        events.push(`decision:${decision.kind}`);
        return applyIndex(jsonRecordRoundTrip(decision));
      });
    jest
      .spyOn(recordPort, 'applyWorkspaceManifestDecision')
      .mockImplementation(async (id, decision) => {
        events.push(`decision:${decision.kind}`);
        return applyManifest(id, jsonRecordRoundTrip(decision));
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
    const request = conversionFor(kind, {
      idempotencyKey: 'port',
      expectedRevision: 0,
    });
    await convert(request);
    expect(events).toEqual([
      'reserve',
      'decision:workspace.conversion.index',
      'decision:workspace.conversion.manifest',
      {
        files: ['index.json', 'index.json.bak', join('a', 'workspace.json')],
        receipt: true,
      },
    ]);
    const config: unknown = JSON.parse(readFileSync(manifest(), 'utf8'));
    expect(config).not.toHaveProperty(
      kind === 'convert-multi' ? 'repoPath' : 'sourceRepoPath',
    );
    expect(config).toHaveProperty('type', request.targetType);
    const before = await observation();
    events.length = 0;
    await convert(request);
    expect(events).toEqual([]);
    expect(await observation()).toEqual(before);
  },
);

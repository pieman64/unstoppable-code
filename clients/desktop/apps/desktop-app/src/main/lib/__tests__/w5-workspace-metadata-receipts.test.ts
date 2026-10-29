import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
// Same real worker/filesystem harness as the other keyed W5 boundary suites.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
}));

import { notifyPortalStructureChanged } from '../../portal/portal-event-bus';
import { schedulePortalStructuralSync } from '../../portal/portal-structural-sync';
import { recordWorkspaceCrudTelemetry } from '../desktop-telemetry';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  updateWorkspaceMetadata,
  type WorkspaceMetadataPatch,
  type WorkspaceMetadataUpdateRequest,
} from '../workspace-metadata';

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
  ({ dir, root } = createW5BoundaryFixture(() => [], ['b']));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  startHost();
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
  return ['index.json', 'a/workspace.json', 'b/workspace.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}
function publications(): number[] {
  return [
    notifyPortalStructureChanged,
    schedulePortalStructuralSync,
    recordWorkspaceCrudTelemetry,
  ].map((effect) => jest.mocked(effect).mock.calls.length);
}
function update(
  overrides: Partial<WorkspaceMetadataUpdateRequest> = {},
): ReturnType<typeof updateWorkspaceMetadata> {
  return updateWorkspaceMetadata({
    workspaceId: 'a',
    source: 'portal',
    patch: { name: '  Edited  ', itemSortMode: 'last-updated' },
    expectedRevision: 0,
    idempotencyKey: 'key',
    ...overrides,
  });
}
const workspaceRevision = (): Promise<number> =>
  host.revision({ kind: 'workspace', workspaceId: 'a' });

it('commits both namespaces and the receipt, publishes once, then replays after a lost response', async () => {
  const commits = jest.spyOn(host, 'commit');
  const first = await update();
  expect(first).toEqual({
    workspaceId: 'a',
    indexWritten: true,
    manifestWritten: true,
  });
  const writes = commits.mock.calls.filter(([call]) => call.files.length > 0);
  expect(writes).toHaveLength(1);
  expect(writes[0]?.[0].files.map((file) => file.path)).toEqual(
    expect.arrayContaining([
      join(root, 'a', 'workspace.json'),
      join(root, 'index.json'),
    ]),
  );
  const saved = commits.mock.calls.find(([call]) => call.receipt)?.[0];
  expect(saved?.operation).toBe('core.workspace.update');
  expect(saved?.reservationId).toEqual(expect.any(String));
  expect(saved?.outcome).toEqual(first);
  expect(JSON.stringify(saved?.outcome)).not.toContain(dir);
  expect(images()[0]).toContain('"Edited"');
  expect(images()[1]).toContain('last-updated');
  const published = publications();
  expect(published.every((calls) => calls > 0)).toBe(true);
  expect(await workspaceRevision()).toBe(1);

  const before = images();
  const count = commits.mock.calls.length;
  // The stale revision does not matter: the saved outcome replays first.
  expect(await update({ expectedRevision: 999 })).toEqual(first);
  expect(commits).toHaveBeenCalledTimes(count);
  expect(images()).toEqual(before);
  expect(publications()).toEqual(published);
  expect(await workspaceRevision()).toBe(1);
});

it('replays the committed outcome after a restart without effects', async () => {
  const first = await update();
  await restartHost();
  const before = images();
  const commits = jest.spyOn(host, 'commit');
  jest.clearAllMocks();
  expect(await update()).toEqual(first);
  expect(commits).not.toHaveBeenCalled();
  expect(images()).toEqual(before);
  expect(publications()).toEqual([0, 0, 0]);
  expect(await workspaceRevision()).toBe(1);
});

it('fingerprints the normalized patch, so an untrimmed retry replays', async () => {
  const first = await update();
  const commits = jest.spyOn(host, 'commit');
  expect(
    await update({ patch: { name: 'Edited', itemSortMode: 'last-updated' } }),
  ).toEqual(first);
  expect(commits).not.toHaveBeenCalled();
});

it('fingerprints only typed fields of an untyped patch', async () => {
  const untyped: WorkspaceMetadataPatch = { startPage: { kind: 'inherit' } };
  Reflect.set(untyped, 'settings', { anything: true });
  Reflect.set(untyped.startPage ?? {}, 'extra', true);
  const first = await update({ patch: untyped });
  expect(first).toMatchObject({ manifestWritten: true });
  const commits = jest.spyOn(host, 'commit');
  expect(await update({ patch: { startPage: { kind: 'inherit' } } })).toEqual(
    first,
  );
  expect(commits).not.toHaveBeenCalled();
});

it('fingerprints an unknown start page kind without its other keys', async () => {
  const unknownKind = (
    extra: Record<string, unknown>,
  ): WorkspaceMetadataPatch => {
    const patch: WorkspaceMetadataPatch = { startPage: { kind: 'inherit' } };
    Reflect.set(patch, 'startPage', { kind: 'clear', ...extra });
    return patch;
  };
  const manifest = (): unknown => JSON.parse(images()[1] ?? '');
  const startPage = { kind: 'url', url: 'https://example.com/' } as const;
  await update({
    idempotencyKey: undefined,
    patch: { startPage: { kind: 'set', startPage } },
  });
  const first = await update({
    patch: unknownKind({ note: 'first' }),
    expectedRevision: 1,
  });
  expect(first).toEqual({
    workspaceId: 'a',
    indexWritten: false,
    manifestWritten: true,
  });
  expect(manifest()).toHaveProperty('startPage', startPage);
  const commits = jest.spyOn(host, 'commit');
  // A bigint is not JSON, so fingerprinting it would throw.
  for (const extra of [
    { startPage: null, url: 'https://other.test/' },
    { huge: 1n },
  ]) {
    expect(
      await update({ patch: unknownKind(extra), expectedRevision: 1 }),
    ).toEqual(first);
  }
  expect(commits).not.toHaveBeenCalled();
  expect(manifest()).toHaveProperty('startPage', startPage);
});

it.each<[string, Partial<WorkspaceMetadataUpdateRequest>]>([
  ['patch value', { patch: { name: 'Other', itemSortMode: 'last-updated' } }],
  ['patch field', { patch: { name: 'Edited' } }],
  ['workspace', { workspaceId: 'b', patch: { name: 'Edited' } }],
  ['source', { source: 'desktop_canopy_client' }],
])(
  'refuses a changed %s for a used key before effects',
  async (_label, overrides) => {
    await update();
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    jest.clearAllMocks();
    await expect(update(overrides)).rejects.toMatchObject({
      reason: 'key-reused',
    });
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
    expect(publications()).toEqual([0, 0, 0]);
  },
);

it('refuses a stale revision without writing either file and releases the key', async () => {
  const before = images();
  const commits = jest.spyOn(host, 'commit');
  await expect(update({ expectedRevision: 99 })).rejects.toBeInstanceOf(
    W5RevisionConflictError,
  );
  expect(commits).not.toHaveBeenCalled();
  expect(images()).toEqual(before);
  expect(publications()).toEqual([0, 0, 0]);
  expect(await workspaceRevision()).toBe(0);
  await expect(update()).resolves.toMatchObject({ indexWritten: true });
});

it('refuses a stale revision observed after another edit', async () => {
  await updateWorkspaceMetadata({
    workspaceId: 'a',
    source: 'portal',
    patch: { color: '#0EA5E9' },
  });
  const before = images();
  await expect(update({ expectedRevision: 0 })).rejects.toBeInstanceOf(
    W5RevisionConflictError,
  );
  expect(images()).toEqual(before);
  await expect(update({ expectedRevision: 1 })).resolves.toMatchObject({
    manifestWritten: true,
  });
});

it.each<[string, WorkspaceMetadataPatch, boolean, boolean]>([
  ['index-only', { collapsed: true }, true, false],
  ['manifest-only', { alwaysShow: true }, false, true],
  ['empty', {}, false, false],
])(
  'saves and replays an %s outcome',
  async (_label, patch, indexWritten, manifestWritten) => {
    const first = await update({ patch });
    expect(first).toEqual({ workspaceId: 'a', indexWritten, manifestWritten });
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    expect(await update({ patch })).toEqual(first);
    expect(commits).not.toHaveBeenCalled();
    expect(images()).toEqual(before);
  },
);

it('an interruption at the single decision leaves the files unchanged and the key recovery-required', async () => {
  const before = images();
  const commits = jest.spyOn(host, 'commit').mockImplementation(async () => {
    await host.shutdown();
    throw new Error('interrupted at decision');
  });
  await expect(update()).rejects.toThrow('interrupted at decision');
  // The canonical commit carries the receipt and outcome (CAN-4393).
  expect(commits).toHaveBeenCalledTimes(1);
  const canonical = commits.mock.calls[0]?.[0];
  expect(canonical?.receipt).toMatchObject({
    caller: 'desktop-host:workspace-metadata',
    operation: 'core.workspace.update',
  });
  expect(canonical?.reservationId).toEqual(expect.any(String));
  expect(canonical?.outcome).toEqual({
    workspaceId: 'a',
    indexWritten: true,
    manifestWritten: true,
  });
  expect(canonical?.files.map((file) => file.path)).toEqual(
    expect.arrayContaining([
      join(root, 'a', 'workspace.json'),
      join(root, 'index.json'),
    ]),
  );
  startHost();
  expect(images()).toEqual(before);
  const retried = jest.spyOn(host, 'commit');
  jest.clearAllMocks();
  await expect(update()).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(retried).not.toHaveBeenCalled();
  expect(images()).toEqual(before);
  expect(publications()).toEqual([0, 0, 0]);
});

it('a publication failure after the decision reaches the first caller; the same-key retry replays without a commit or a second publication', async () => {
  jest.mocked(notifyPortalStructureChanged).mockImplementationOnce(() => {
    throw new Error('publication failed');
  });
  const commits = jest.spyOn(host, 'commit');
  await expect(update()).rejects.toThrow('publication failed');
  expect(images()[0]).toContain('"Edited"');
  expect(commits).toHaveBeenCalledTimes(1);
  const applied = images();
  const published = publications();
  expect(published[0]).toBe(1);
  expect(await update()).toEqual({
    workspaceId: 'a',
    indexWritten: true,
    manifestWritten: true,
  });
  expect(commits).toHaveBeenCalledTimes(1);
  expect(images()).toEqual(applied);
  expect(publications()).toEqual(published);
});

it('publishes only after canonical application', async () => {
  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementation(async (input) => {
    if (input.files.length > 0) {
      expect(notifyPortalStructureChanged).not.toHaveBeenCalled();
      expect(schedulePortalStructuralSync).not.toHaveBeenCalled();
    }
    return commit(input);
  });
  await update();
  expect(publications().every((calls) => calls > 0)).toBe(true);
});

it('an unkeyed update keeps one receipt-free decision', async () => {
  const commits = jest.spyOn(host, 'commit');
  await update({ idempotencyKey: undefined });
  expect(commits).toHaveBeenCalledTimes(1);
  expect(commits.mock.calls[0]?.[0]).toMatchObject({
    operation: 'core.workspace.update',
  });
  expect(commits.mock.calls[0]?.[0].receipt).toBeUndefined();
  expect(commits.mock.calls[0]?.[0].reservationId).toBeUndefined();
  expect(commits.mock.calls[0]?.[0].files.map((file) => file.path)).toEqual(
    expect.arrayContaining([
      join(root, 'a', 'workspace.json'),
      join(root, 'index.json'),
    ]),
  );
  // Without a key every call is a new edit.
  await update({
    idempotencyKey: undefined,
    expectedRevision: 1,
    patch: { name: 'Again', itemSortMode: 'manual' },
  });
  expect(await workspaceRevision()).toBe(2);
});

it.each<[string, () => void, Partial<WorkspaceMetadataUpdateRequest>, string]>([
  [
    'an unknown workspace',
    (): void => {},
    { workspaceId: 'missing' },
    'not-found',
  ],
  [
    'a missing manifest',
    (): void => rmSync(join(root, 'a', 'workspace.json')),
    {},
    'configuration-unavailable',
  ],
])(
  'releases the key after %s refuses before the decision',
  async (_label, arrange, overrides, reason) => {
    arrange();
    const commits = jest.spyOn(host, 'commit');
    await expect(update(overrides)).rejects.toMatchObject({ reason });
    // Released, not recovery-required: the retry is admitted and refused again.
    await expect(update(overrides)).rejects.toMatchObject({ reason });
    expect(commits).not.toHaveBeenCalled();
    expect(publications()).toEqual([0, 0, 0]);
  },
);

it('refuses a stale revision for an empty patch and releases the key', async () => {
  const commits = jest.spyOn(host, 'commit');
  await expect(
    update({ patch: {}, expectedRevision: 5 }),
  ).rejects.toBeInstanceOf(W5RevisionConflictError);
  expect(commits).not.toHaveBeenCalled();
  await expect(update({ patch: {} })).resolves.toEqual({
    workspaceId: 'a',
    indexWritten: false,
    manifestWritten: false,
  });
});

it('releases the key when a file changes on disk before the decision', async () => {
  const read = nodeW5FileStore.read.bind(nodeW5FileStore);
  const indexPath = join(root, 'index.json');
  let indexReads = 0;
  // The third index read is the decision's preflight, after staging.
  const reads = jest
    .spyOn(nodeW5FileStore, 'read')
    .mockImplementation(async (path) => {
      if (path === indexPath && ++indexReads === 3) {
        writeFileSync(
          indexPath,
          readFileSync(indexPath, 'utf8').replace('"name":"b"', '"name":"B"'),
        );
      }
      return read(path);
    });
  const commits = jest.spyOn(host, 'commit');
  await expect(update()).rejects.toBeInstanceOf(W5FileWriteRefusedError);
  expect(commits).not.toHaveBeenCalled();
  expect(publications()).toEqual([0, 0, 0]);
  expect(await workspaceRevision()).toBe(0);
  reads.mockRestore();
  await expect(update()).resolves.toMatchObject({ indexWritten: true });
  expect(images()[0]).toContain('"Edited"');
  expect(images()[0]).toContain('"B"');
});

it('admits one of two concurrent same-key attempts', async () => {
  const results = await Promise.allSettled([update(), update()]);
  const fulfilled = results.filter((result) => result.status === 'fulfilled');
  expect(fulfilled.length).toBeGreaterThan(0);
  for (const result of results) {
    if (result.status === 'rejected')
      expect(result.reason).toMatchObject({ reason: 'in-progress' });
  }
  expect(await workspaceRevision()).toBe(1);
  expect(jest.mocked(notifyPortalStructureChanged)).toHaveBeenCalledTimes(1);
});

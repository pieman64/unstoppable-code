// W7a-3 (CAN-5548): the daemon's `core.workspace.*` metadata commands over
// W5d1's binding (CAN-5522), on the wire, on a real W5 commit-log worker and
// real files: path-free output, stale refusal, the bounded retry, restart
// replay, legacy ownership and the RX2 exits.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  const rows: CoreStorage.StorageOwnershipRow[] = [...actual.STORAGE_OWNERSHIP];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (namespaceIds: readonly string[]): void => {
      actual.STORAGE_OWNERSHIP.forEach((row, index) => {
        rows[index] = namespaceIds.includes(row.id)
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : row;
      });
    },
  };
});

import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import { W5CommitLogHost } from '@canopy/core-runtime/node/w5/commit-log-host';
import { withW5RepositoryLock } from '@canopy/core-runtime/node/w5/repository-locks';
import { CANOPY_DEFAULT_MAX_FRAME_BYTES } from '@canopy/core-transport';
import { w5RepositoryAddOutcome } from '@canopy/core-runtime/node/w5/workspace-metadata/projectors';
import { hasHostAbsolutePath } from '@canopy/protocol/canopy-core';
import {
  callHostedMetadata,
  pickerSelection,
  startW5HostedMetadataHarness,
  type W5HostedMetadataClient,
  type W5HostedMetadataHarness,
  type W5HostedMetadataRequest,
} from './fixtures/w5-hosted-metadata-harness';
import type { W5RecordPortClient } from '../w5-daemon-record-store';
import {
  runW5Maintenance,
  type W5MaintenanceContext,
  type W5MaintenanceDecision,
} from '../w5-maintenance';
import { W5_RESOLVABLE_RESERVATION_OPERATIONS } from '../w5-maintenance-decisions';

jest.setTimeout(60_000);

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];
const WORKER = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');

let dir: string;
let dataDir: string;
let root: string;
let repo: string;
let harness: W5HostedMetadataHarness;
let client: W5HostedMetadataClient;

function gitRepo(path: string): void {
  mkdirSync(path);
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
}

/*
 * Folder names no byte-limited file system can hold: 255 `İ` (510 UTF-8
 * bytes; APFS and NTFS allow it) slugifies to 509 characters, and 500 ASCII
 * characters is the longest derived id the hosted add takes. Never created.
 */
const UNICODE_FOLDER = 'İ'.repeat(255);
const EDGE_FOLDER = 'e'.repeat(500);
// The longest folder name an add takes as the repository's name, and one more.
const NAME_FOLDER = '_'.repeat(512);
const LONG_NAME_FOLDER = '_'.repeat(513);
const UNCREATED_FOLDERS = new Set([
  UNICODE_FOLDER,
  EDGE_FOLDER,
  NAME_FOLDER,
  LONG_NAME_FOLDER,
]);

/** When set, a repository check waits for it, holding its call in admission. */
let repositoryCheckGate: Promise<void> | undefined;

async function isRepository(path: string): Promise<boolean> {
  await repositoryCheckGate;
  return isRepositoryNow(path);
}

function isRepositoryNow(path: string): Promise<boolean> {
  if (UNCREATED_FOLDERS.has(basename(path))) return Promise.resolve(true);
  try {
    execFileSync('git', ['-C', path, 'rev-parse', '--git-dir'], {
      stdio: 'ignore',
    });
    return Promise.resolve(true);
  } catch {
    return Promise.resolve(false);
  }
}

const files = (): Record<string, string | null> =>
  Object.fromEntries(
    [
      'index.json',
      'index.json.bak',
      'a/workspace.json',
      'b/workspace.json',
    ].map((name) => {
      try {
        return [name, readFileSync(join(root, name), 'utf8')];
      } catch {
        return [name, null];
      }
    }),
  );

function seed(): void {
  mkdirSync(join(root, 'a'), { recursive: true });
  mkdirSync(join(root, 'b'));
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify(
      {
        version: 1,
        workspaces: [
          {
            id: 'a',
            name: 'A',
            type: 'multi-repo',
            color: '#7C3AED',
            order: 0,
          },
          {
            id: 'b',
            name: 'B',
            type: 'single-repo',
            color: '#7C3AED',
            order: 1,
          },
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify(
      {
        version: 1,
        type: 'multi-repo',
        repos: [
          // A local clone's remote: a host path the wire must never show.
          {
            id: 'web',
            name: 'web',
            repoPath: repo,
            source: 'manifest',
            manifestUrl: join(dir, 'origin.git'),
          },
          {
            id: 'api',
            name: 'api',
            repoPath: join(dir, 'api'),
            source: 'manifest',
            manifestUrl: 'https://user:secret-token@github.com/acme/api.git',
          },
        ],
        defaultPluginSelections: { mcpServers: ['account:legacy'] },
        alwaysShow: true,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(root, 'b', 'workspace.json'),
    JSON.stringify(
      { version: 1, type: 'single-repo', repoPath: repo, repos: [] },
      null,
      2,
    ),
  );
}

/** The selection projection, counting each time a selection is resolved. */
class Selections extends Map<string, string> {
  resolved = 0;
  /** Each selection resolves once, as a picker's one-time token would. */
  oneTime = false;
  override get(selection: string): string | undefined {
    this.resolved += 1;
    const repoPath = super.get(selection);
    if (this.oneTime) this.delete(selection);
    return repoPath;
  }
}
/** The test's projection; it outlives a host restart, as a picker's would. */
let selections: Selections;

function start(epoch?: string): Promise<W5HostedMetadataHarness> {
  return startW5HostedMetadataHarness({
    dbPath: join(dataDir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: WORKER,
    daemonOwned: W5_NAMESPACES,
    repositorySelections: selections,
    isRepository,
    ...(epoch !== undefined && { epoch }),
  });
}

const apply = (
  params: W5HostedMetadataRequest,
  via: W5HostedMetadataClient = client,
): Promise<unknown> => callHostedMetadata(via, params);

/** The drag move that puts `b` before `a`. */
const MOVE: Extract<
  W5HostedMetadataRequest,
  { operation: 'core.workspace.reorder' }
> = {
  operation: 'core.workspace.reorder',
  visibleWorkspaceIds: ['a', 'b'],
  activeWorkspaceId: 'b',
  overWorkspaceId: 'a',
};

interface RefusalPayload {
  kind?: unknown;
  code?: unknown;
  message?: unknown;
  details?: unknown;
  retry?: unknown;
}

/** The rejection's payload, for assertions on code, kind and details. */
async function refusal(call: Promise<unknown>): Promise<RefusalPayload> {
  return refusalPayload(
    await call.then(
      () => {
        throw new Error('Expected a refusal');
      },
      (caught: unknown) => caught,
    ),
  );
}

function refusalPayload(error: unknown): RefusalPayload {
  if (
    typeof error === 'object' &&
    error !== null &&
    'payload' in error &&
    typeof error.payload === 'object' &&
    error.payload !== null
  )
    return { ...error.payload };
  throw error;
}

/** A routed writer's edit of `a/workspace.json` through the record port. */
async function routedManifestEdit(
  records: W5RecordPortClient,
  field: string,
  value: unknown,
): Promise<void> {
  const capture = await records.query('core.workspaceRecords.capture', {
    files: [{ kind: 'manifest', workspaceId: 'a' }],
    discoverWorkspaces: false,
  });
  const [image] = capture.files;
  if (image?.state !== 'present' || image.base64 === undefined)
    throw new Error('manifest not captured');
  const raw = Buffer.from(image.base64, 'base64').toString('utf8');
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null)
    throw new Error('manifest shape');
  await records.instruction('core.workspaceRecords.commit', {
    operation: 'w5d1.test.routed-writer',
    advance: [{ kind: 'workspace', workspaceId: 'a' }],
    files: [
      {
        target: { kind: 'manifest', workspaceId: 'a' },
        contents: JSON.stringify({ ...parsed, [field]: value }, null, 2),
        previousFingerprint: createHash('sha256')
          .update(raw, 'utf8')
          .digest('hex'),
      },
    ],
    outcome: null,
  });
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'w5d1-wire-')));
  dataDir = join(dir, 'data');
  root = join(dataDir, 'workspaces');
  repo = join(dir, 'repo');
  gitRepo(repo);
  gitRepo(join(dir, 'other'));
  seed();
  repositoryCheckGate = undefined;
  selections = new Selections([
    ['pick-other', join(dir, 'other')],
    // Another selection of the same folder, and of a different one.
    ['pick-other-again', join(dir, 'other')],
    ['pick-third', join(dir, 'third')],
    ['pick-unicode', join(dir, UNICODE_FOLDER)],
    ['pick-edge', join(dir, EDGE_FOLDER)],
    ['pick-edge-elsewhere', join(dir, 'elsewhere', EDGE_FOLDER)],
    ['pick-name', join(dir, NAME_FOLDER)],
    ['pick-long-name', join(dir, LONG_NAME_FOLDER)],
  ]);
  harness = await start();
  client = await harness.connectMetadata();
});
afterEach(async () => {
  await harness.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the hosted metadata commands over the wire', () => {
  it('reaches its preflight while Electron holds its own lock on the same file', async () => {
    // Electron's lock lives in the default registry; the daemon's own does not
    // wait on it, as two processes never share one.
    await withW5RepositoryLock(
      { kind: 'manifest', path: join(root, 'a', 'workspace.json') },
      async () => {
        await expect(
          apply({
            operation: 'core.workspace.scripts.update',
            workspaceId: 'a',
            change: { kind: 'merge-commands', commands: { setup: 'pnpm i' } },
          }),
        ).resolves.toEqual({});
      },
    );
    expect(harness.commits).toEqual(['core.workspace.scripts.update']);
    expect(harness.isolated).toBe(true);
  });

  it('publishes one committed event per applied decision, with no publishedBy, and none for a refusal or a replay', async () => {
    const move: W5HostedMetadataRequest = {
      operation: 'core.workspace.reorder',
      visibleWorkspaceIds: ['a', 'b'],
      activeWorkspaceId: 'b',
      overWorkspaceId: 'a',
      idempotencyKey: 'move-1',
    };
    const first = await apply(move);
    expect(first).toEqual({ acknowledged: true });
    await expect(apply(move)).resolves.toEqual(first);
    await expect(
      refusal(
        apply({
          operation: 'core.workspace.update',
          workspaceId: 'missing',
          patch: { name: 'X' },
        }),
      ),
    ).resolves.toMatchObject({
      kind: 'not_found',
      code: 'core.workspace.notFound',
      details: { reason: 'not-found' },
    });
    const events = harness.committedEvents();
    expect(events).toHaveLength(1);
    const [event] = events;
    if (typeof event !== 'object' || event === null || Array.isArray(event))
      throw new Error('Expected a committed payload');
    expect(event.changes).toContainEqual({ kind: 'index', revision: 1 });
    expect(event.files).toContainEqual({ kind: 'index' });
    expect(event).not.toHaveProperty('publishedBy');
    expect(harness.commits).toEqual(['core.workspace.reorder']);
  });

  it('never names a host path in results, replays, refusals or events', async () => {
    const outputs: unknown[] = [];
    const run = async (params: W5HostedMetadataRequest): Promise<void> => {
      outputs.push(await apply(params));
      if (params.idempotencyKey) outputs.push(await apply(params));
    };
    await run({
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: { selection: pickerSelection('pick-other') },
      idempotencyKey: 'add-1',
    });
    await run({
      operation: 'core.workspace.repository.remove',
      workspaceId: 'a',
      repoId: 'web',
      idempotencyKey: 'remove-1',
    });
    await run({
      operation: 'core.workspace.repository.remove',
      workspaceId: 'a',
      repoId: 'api',
      idempotencyKey: 'remove-2',
    });
    await run({
      operation: 'core.workspace.update',
      workspaceId: 'a',
      patch: { name: 'Renamed', alwaysShow: false },
      idempotencyKey: 'update-1',
    });
    await run({
      operation: 'core.workspace.privateMemory.update',
      workspaceId: 'a',
      privateMemory: true,
      idempotencyKey: 'memory-1',
    });
    await run({
      operation: 'core.workspace.planDetection.update',
      workspaceId: 'a',
      planDetection: { disabledRuleIds: ['plans-dir'] },
    });
    for (const params of [
      // Not a multi-repo workspace, a duplicate, not a repository, unknown.
      {
        operation: 'core.workspace.repository.add',
        workspaceId: 'b',
        repository: { selection: pickerSelection('pick-other') },
      },
      {
        operation: 'core.workspace.repository.add',
        workspaceId: 'a',
        repository: { selection: pickerSelection('pick-other') },
      },
      {
        operation: 'core.workspace.repository.add',
        workspaceId: 'a',
        repository: { selection: pickerSelection('pick-unknown') },
      },
      // Refused for its read-only scope before it is addressed.
      {
        operation: 'core.workspace.scripts.update',
        workspaceId: 'shared-container-viewer',
        change: { kind: 'replace' },
      },
      // A hex color outside the project palette.
      {
        operation: 'core.workspace.update',
        workspaceId: 'a',
        patch: { color: '#123456' },
      },
      {
        operation: 'core.workspace.update',
        workspaceId: 'a',
        patch: { name: 'Again' },
        idempotencyKey: 'update-1',
      },
    ] satisfies W5HostedMetadataRequest[])
      outputs.push(await refusal(apply(params)));
    const [added, addReplay, removed, removeReplay, remote, remoteReplay] =
      outputs;
    expect(added).toEqual({ repository: { id: 'other', name: 'other' } });
    expect(addReplay).toEqual(added);
    // A stored remote that is a host path never crosses.
    expect(removed).toEqual({
      removed: { id: 'web', name: 'web', source: 'manifest' },
    });
    expect(removeReplay).toEqual(removed);
    // One with credentials crosses sanitized, as the desktop projects it.
    expect(remote).toEqual({
      removed: {
        id: 'api',
        name: 'api',
        source: 'manifest',
        manifestUrl: 'https://github.com/acme/api.git',
      },
    });
    expect(remoteReplay).toEqual(remote);
    expect(outputs.slice(-6)).toEqual([
      expect.objectContaining({
        code: 'core.workspace.invalidState',
        details: { reason: 'not-multi-repo' },
      }),
      expect.objectContaining({
        kind: 'already_exists',
        details: { reason: 'duplicate' },
      }),
      expect.objectContaining({
        kind: 'not_found',
        details: { reason: 'selection-unknown' },
      }),
      expect.objectContaining({
        kind: 'failed_precondition',
        code: 'core.workspace.readOnly',
        details: { reason: 'read-only-scope' },
        retry: { kind: 'never' },
      }),
      expect.objectContaining({
        kind: 'invalid_argument',
        details: { reason: 'invalid-patch' },
      }),
      expect.objectContaining({ code: 'core.workspace.idempotencyKeyReused' }),
    ]);
    const published = harness.committedEvents();
    for (const value of [...outputs, ...published]) {
      expect(hasHostAbsolutePath(value)).toBe(false);
      for (const path of [dir, root, repo, 'secret-token'])
        expect(JSON.stringify(value)).not.toContain(path);
    }
  });

  it('keeps the desktop v1 outcome, repoPath included, in the host-local log', async () => {
    const saved: unknown[] = [];
    harness.hooks.commit.before = (request): Promise<void> => {
      if (request.operation === 'core.workspace.repository.add')
        saved.push(request.outcome);
      return Promise.resolve();
    };
    await apply({
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: {
        selection: pickerSelection('pick-other'),
        name: 'Other repo',
      },
      idempotencyKey: 'add-v1',
    });
    expect(saved).toEqual([
      { id: 'other-repo', name: 'Other repo', repoPath: join(dir, 'other') },
    ]);
    expect(w5RepositoryAddOutcome.parse(saved[0])).toEqual(saved[0]);
  });

  it('fingerprints a keyed add as sent, by its selection, without resolving a retry', async () => {
    gitRepo(join(dir, 'third'));
    const add = (repository: {
      selection: string;
      name?: string;
    }): W5HostedMetadataRequest => ({
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: {
        ...repository,
        selection: pickerSelection(repository.selection),
      },
      idempotencyKey: 'add-folder',
    });
    await apply(add({ selection: 'pick-other' }));
    expect(selections.resolved).toBe(1);
    // Another selection is another request, even of the same folder; an
    // unknown one is refused for the key, not resolved.
    for (const repository of [
      { selection: 'pick-other-again' },
      { selection: 'pick-third' },
      { selection: 'pick-gone' },
      { selection: 'pick-other', name: 'Other' },
    ])
      await expect(refusal(apply(add(repository)))).resolves.toMatchObject({
        code: 'core.workspace.idempotencyKeyReused',
      });
    expect(selections.resolved).toBe(1);
    expect(harness.commits).toEqual(['core.workspace.repository.add']);
  });

  it('replays a committed keyed add after its selection expired or was rebound, on this host and after a restart', async () => {
    gitRepo(join(dir, 'third'));
    const params: W5HostedMetadataRequest = {
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: { selection: pickerSelection('pick-other') },
      idempotencyKey: 'add-replay',
    };
    const first = await apply(params);
    expect(first).toEqual({
      repository: { id: 'other', name: 'other' },
    });
    const after = files();
    const replays = async (): Promise<void> => {
      selections.delete('pick-other');
      await expect(apply(params)).resolves.toEqual(first);
      selections.set('pick-other', join(dir, 'third'));
      await expect(apply(params)).resolves.toEqual(first);
      await expect(
        refusal(
          apply({
            ...params,
            repository: { selection: pickerSelection('pick-other-again') },
          }),
        ),
      ).resolves.toMatchObject({ code: 'core.workspace.idempotencyKeyReused' });
    };
    await replays();
    expect(harness.commits).toEqual(['core.workspace.repository.add']);
    await harness.close();
    harness = await start('runtime:w5d1-add-restarted');
    client = await harness.connectMetadata();
    await replays();
    expect(harness.commits).toEqual([]);
    expect(harness.committedEvents()).toEqual([]);
    expect(files()).toEqual(after);
    // Only the first call resolved its selection.
    expect(selections.resolved).toBe(1);
  });

  it('resolves a repository add selection once across its stale-file retries', async () => {
    const records = await harness.connectRecords('another-peer');
    let races = 0;
    harness.hooks.afterRead = async (
      filePath,
      _read,
      staging,
    ): Promise<void> => {
      if (!staging || !filePath.endsWith(join('a', 'workspace.json'))) return;
      races += 1;
      if (races > 2) return;
      // The selection expires after the call resolved it.
      selections.delete('pick-other');
      await routedManifestEdit(records, 'routed', races);
    };
    await expect(
      apply({
        operation: 'core.workspace.repository.add',
        workspaceId: 'a',
        repository: { selection: pickerSelection('pick-other') },
        idempotencyKey: 'add-stale',
      }),
    ).resolves.toEqual({
      repository: { id: 'other', name: 'other' },
    });
    expect(races).toBe(3);
    expect(selections.resolved).toBe(1);
    expect(harness.retryCounts()).toEqual(
      new Map([['core.workspace.repository.add fingerprint retried', 2]]),
    );
    expect(harness.commits).toEqual([
      'w5d1.test.routed-writer',
      'w5d1.test.routed-writer',
      'core.workspace.repository.add',
    ]);
    expect(JSON.parse(files()['a/workspace.json'] ?? '')).toMatchObject({
      routed: 2,
      repos: [
        expect.objectContaining({ id: 'web' }),
        expect.objectContaining({ id: 'api' }),
        expect.objectContaining({ id: 'other', repoPath: join(dir, 'other') }),
      ],
    });
  });

  it('resolves a one-time selection only under its key reservation, so a concurrent duplicate is in progress, never selection-unknown', async () => {
    selections.oneTime = true;
    const params: W5HostedMetadataRequest = {
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: { selection: pickerSelection('pick-other') },
      idempotencyKey: 'add-race',
    };
    let release = (): void => {};
    repositoryCheckGate = new Promise((resolve) => {
      release = resolve;
    });
    // The duplicate starts once the first call found no receipt, and the
    // first call's repository check waits until the duplicate found none too.
    let lookups = 0;
    let startDuplicate: (call: Promise<unknown>) => void = () => {};
    const duplicate = new Promise<unknown>((resolve) => {
      startDuplicate = resolve;
    });
    harness.hooks.afterLookup = (): Promise<void> => {
      lookups += 1;
      if (lookups === 1) startDuplicate(apply(params));
      if (lookups === 2) release();
      return Promise.resolve();
    };
    const settled = await Promise.allSettled([apply(params), duplicate]);
    const added = {
      repository: { id: 'other', name: 'other' },
    };
    const fulfilled = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    const refused = settled.flatMap((result) =>
      result.status === 'rejected' ? [refusalPayload(result.reason)] : [],
    );
    expect(fulfilled).toEqual([added]);
    expect(refused).toEqual([
      expect.objectContaining({ code: 'core.workspace.requestInProgress' }),
    ]);
    expect(selections.resolved).toBe(1);
    expect(harness.commits).toEqual(['core.workspace.repository.add']);
    harness.hooks.afterLookup = undefined;
    // The refused duplicate's retry replays, its selection long redeemed.
    await expect(apply(params)).resolves.toEqual(added);
    expect(selections.resolved).toBe(1);
  });

  it('holds the key reservation across a stale-file retry, so a concurrent duplicate between attempts is in progress and the selection is redeemed once', async () => {
    selections.oneTime = true;
    const records = await harness.connectRecords('another-peer');
    const params: W5HostedMetadataRequest = {
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: { selection: pickerSelection('pick-other') },
      idempotencyKey: 'add-stale-race',
    };
    // The duplicate runs to completion at the first call's next step after
    // its stale refusal: its next receipt lookup or its next staging read.
    let staled = false;
    let duplicate: Promise<PromiseSettledResult<unknown>> | undefined;
    const raceDuplicate = async (): Promise<void> => {
      if (!staled || duplicate) return;
      duplicate = Promise.allSettled([apply(params)]).then(
        ([result]) => result,
      );
      await duplicate;
    };
    let races = 0;
    harness.hooks.afterLookup = raceDuplicate;
    harness.hooks.afterRead = async (
      filePath,
      _read,
      staging,
    ): Promise<void> => {
      if (!staging || !filePath.endsWith(join('a', 'workspace.json'))) return;
      races += 1;
      if (races === 1) {
        await routedManifestEdit(records, 'routed', races);
        staled = true;
        return;
      }
      await raceDuplicate();
    };
    const added = {
      repository: { id: 'other', name: 'other' },
    };
    await expect(apply(params)).resolves.toEqual(added);
    expect(races).toBe(2);
    const raced = await duplicate;
    expect(
      raced?.status === 'rejected' ? refusalPayload(raced.reason) : raced,
    ).toMatchObject({ code: 'core.workspace.requestInProgress' });
    expect(selections.resolved).toBe(1);
    expect(harness.retryCounts()).toEqual(
      new Map([['core.workspace.repository.add fingerprint retried', 1]]),
    );
    expect(harness.commits).toEqual([
      'w5d1.test.routed-writer',
      'core.workspace.repository.add',
    ]);
    harness.hooks.afterLookup = undefined;
    harness.hooks.afterRead = undefined;
    // The refused duplicate's retry replays the one decision.
    await expect(apply(params)).resolves.toEqual(added);
    expect(selections.resolved).toBe(1);
    expect(harness.commits).toEqual([
      'w5d1.test.routed-writer',
      'core.workspace.repository.add',
    ]);
  });

  it('keeps a duplicate in progress during the exhausting attempt, then releases the key once for a retry', async () => {
    const records = await harness.connectRecords('another-peer');
    const params: W5HostedMetadataRequest = {
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: { selection: pickerSelection('pick-other') },
      idempotencyKey: 'add-stale-exhaust',
    };
    let races = 0;
    let duplicate: PromiseSettledResult<unknown> | undefined;
    harness.hooks.afterRead = async (
      filePath,
      _read,
      staging,
    ): Promise<void> => {
      if (!staging || !filePath.endsWith(join('a', 'workspace.json'))) return;
      races += 1;
      if (races === 3) [duplicate] = await Promise.allSettled([apply(params)]);
      await routedManifestEdit(records, 'routed', races);
    };
    await expect(refusal(apply(params))).resolves.toMatchObject({
      code: 'core.workspace.revisionConflict',
    });
    expect(races).toBe(3);
    expect(
      duplicate?.status === 'rejected'
        ? refusalPayload(duplicate.reason)
        : duplicate,
    ).toMatchObject({ code: 'core.workspace.requestInProgress' });
    expect(selections.resolved).toBe(1);
    expect(harness.retryCounts()).toEqual(
      new Map([
        ['core.workspace.repository.add fingerprint retried', 2],
        ['core.workspace.repository.add fingerprint exhausted', 1],
      ]),
    );
    const routed = Array.from({ length: 3 }, () => 'w5d1.test.routed-writer');
    expect(harness.commits).toEqual(routed);
    harness.hooks.afterRead = undefined;
    // Released after the last attempt: the same key decides once, then replays.
    const added = {
      repository: { id: 'other', name: 'other' },
    };
    await expect(apply(params)).resolves.toEqual(added);
    await expect(apply(params)).resolves.toEqual(added);
    expect(harness.commits).toEqual([
      ...routed,
      'core.workspace.repository.add',
    ]);
  });

  it('refuses an unsafe or over-long repository id before any decision, and suffixes the longest one within the remove repoId bound', async () => {
    gitRepo(join(dir, 'third'));
    const add = (
      repository: { selection: string; id?: string; name?: string },
      idempotencyKey: string,
    ): W5HostedMetadataRequest => ({
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: {
        ...repository,
        selection: pickerSelection(repository.selection),
      },
      idempotencyKey,
    });
    const before = files();
    for (const repository of [
      { selection: 'pick-other', id: '../../outside' },
      { selection: 'pick-other', id: 'Outside' },
      { selection: 'pick-other', id: 'a/b' },
      { selection: 'pick-other', id: 'w'.repeat(512) },
      { selection: 'pick-other', name: 'n'.repeat(512) },
    ])
      await expect(
        refusal(apply(add(repository, 'add-id'))),
      ).resolves.toMatchObject({ kind: 'invalid_argument' });
    expect(files()).toEqual(before);
    expect(harness.commits).toEqual([]);
    expect(harness.committedEvents()).toEqual([]);

    // No refusal took the key, and a colliding id still fits a remove's repoId.
    const longest = 'w'.repeat(128);
    await expect(
      apply(add({ selection: 'pick-other', id: longest }, 'add-id')),
    ).resolves.toEqual({
      repository: { id: longest, name: 'other' },
    });
    const collision = add(
      { selection: 'pick-third', id: longest },
      'add-collision',
    );
    const suffixed = {
      repository: { id: `${longest}-2`, name: 'third' },
    };
    await expect(apply(collision)).resolves.toEqual(suffixed);
    await expect(apply(collision)).resolves.toEqual(suffixed);
    expect(harness.commits).toEqual([
      'core.workspace.repository.add',
      'core.workspace.repository.add',
    ]);
  });

  it('refuses a folder name that derives an over-long id before any decision, and suffixes the longest derived id within the remove repoId bound', async () => {
    const add = (
      selection: string,
      idempotencyKey: string,
      name?: string,
    ): W5HostedMetadataRequest => ({
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: {
        selection: pickerSelection(selection),
        ...(name !== undefined && { name }),
      },
      idempotencyKey,
    });
    const before = files();
    // With no name, the folder's name is the fallback; the wire refuses a
    // blank one before the handler.
    await expect(
      refusal(apply(add('pick-unicode', 'add-unicode'))),
    ).resolves.toMatchObject({
      kind: 'invalid_argument',
      details: { reason: 'invalid-request' },
    });
    await expect(
      refusal(apply(add('pick-unicode', 'add-unicode', '  '))),
    ).resolves.toMatchObject({ kind: 'invalid_argument' });
    expect(files()).toEqual(before);
    expect(harness.commits).toEqual([]);
    expect(harness.committedEvents()).toEqual([]);

    // No refusal took the key; a sent name names the same folder.
    const named = add('pick-unicode', 'add-unicode', 'unicode');
    const namedResult = {
      repository: { id: 'unicode', name: 'unicode' },
    };
    await expect(apply(named)).resolves.toEqual(namedResult);
    await expect(apply(named)).resolves.toEqual(namedResult);

    const longest = 'e'.repeat(500);
    await expect(apply(add('pick-edge', 'add-edge'))).resolves.toEqual({
      repository: { id: longest, name: longest },
    });
    const collision = add('pick-edge-elsewhere', 'add-edge-collision');
    const suffixed = {
      repository: { id: `${longest}-2`, name: longest },
    };
    await expect(apply(collision)).resolves.toEqual(suffixed);
    await expect(apply(collision)).resolves.toEqual(suffixed);
    expect(harness.commits).toEqual([
      'core.workspace.repository.add',
      'core.workspace.repository.add',
      'core.workspace.repository.add',
    ]);
  });

  it('refuses a folder name above the result name cap before any decision, and returns the longest one', async () => {
    const add = (
      repository: { selection: string; id?: string; name?: string },
      idempotencyKey: string,
    ): W5HostedMetadataRequest => ({
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: {
        ...repository,
        selection: pickerSelection(repository.selection),
      },
      idempotencyKey,
    });
    const before = files();
    // A sent id still takes its name from the folder.
    for (const repository of [
      { selection: 'pick-long-name' },
      { selection: 'pick-long-name', id: 'named' },
    ])
      await expect(
        refusal(apply(add(repository, 'add-long-name'))),
      ).resolves.toMatchObject({
        kind: 'invalid_argument',
        details: { reason: 'invalid-request' },
      });
    expect(files()).toEqual(before);
    expect(harness.commits).toEqual([]);
    expect(harness.committedEvents()).toEqual([]);

    // No refusal took the key; a sent name names the same folder.
    const named = add(
      { selection: 'pick-long-name', name: 'Long' },
      'add-long-name',
    );
    await expect(apply(named)).resolves.toEqual({
      repository: { id: 'long', name: 'Long' },
    });
    const longest = add({ selection: 'pick-name' }, 'add-name');
    const result = {
      repository: { id: 'repo', name: NAME_FOLDER },
    };
    await expect(apply(longest)).resolves.toEqual(result);
    await expect(apply(longest)).resolves.toEqual(result);
    expect(harness.commits).toEqual([
      'core.workspace.repository.add',
      'core.workspace.repository.add',
    ]);
  });

  it('refuses a stale keyed revision before any decision, then applies the same key once', async () => {
    const change = {
      operation: 'core.workspace.scripts.update',
      workspaceId: 'a',
      change: { kind: 'merge-commands', commands: { setup: 'pnpm i' } },
    } as const;
    await apply(change);
    const current = await harness.revision({
      kind: 'workspace',
      workspaceId: 'a',
    });
    expect(current).toBe(1);
    const before = files();
    const commits = harness.commits.length;
    const events = harness.committedEvents().length;
    const keyed = {
      ...change,
      change: { kind: 'merge-commands', commands: { launch: 'pnpm dev' } },
      idempotencyKey: 'stale-1',
    } as const;
    await expect(
      refusal(apply({ ...keyed, expectedRevision: current - 1 })),
    ).resolves.toMatchObject({
      kind: 'conflict',
      code: 'core.workspace.revisionConflict',
      retry: { kind: 'after_refresh', resource: 'core.workspace.get' },
      details: { resource: 'workspace:a', expected: 0, actual: 1 },
    });
    expect(files()).toEqual(before);
    expect(harness.commits).toHaveLength(commits);
    expect(harness.committedEvents()).toHaveLength(events);
    await expect(
      harness.revision({ kind: 'workspace', workspaceId: 'a' }),
    ).resolves.toBe(1);

    // The key was released: the same key with the current revision applies.
    await apply({ ...keyed, expectedRevision: current });
    await apply({ ...keyed, expectedRevision: current });
    expect(harness.commits).toHaveLength(commits + 1);
    expect(harness.committedEvents()).toHaveLength(events + 1);
    await expect(
      harness.revision({ kind: 'workspace', workspaceId: 'a' }),
    ).resolves.toBe(2);
  });

  it('retries a stale read twice, then refuses the conflict and releases the key', async () => {
    const records = await harness.connectRecords('another-peer');
    let races = 0;
    harness.hooks.afterRead = async (
      filePath,
      _read,
      staging,
    ): Promise<void> => {
      if (!staging || !filePath.endsWith(join('a', 'workspace.json'))) return;
      races += 1;
      await routedManifestEdit(records, 'routed', races);
    };
    const keyed = {
      operation: 'core.workspace.privateMemory.update',
      workspaceId: 'a',
      privateMemory: true,
      idempotencyKey: 'exhaust-1',
    } as const;
    await expect(refusal(apply(keyed))).resolves.toMatchObject({
      kind: 'conflict',
      code: 'core.workspace.revisionConflict',
      // The file the conflict was on stays off the wire.
      details: { reason: 'concurrent-write' },
    });
    expect(races).toBe(3);
    expect(harness.retryCounts()).toEqual(
      new Map([
        ['core.workspace.privateMemory.update fingerprint retried', 2],
        ['core.workspace.privateMemory.update fingerprint exhausted', 1],
      ]),
    );
    // Every routed write landed; the hosted one decided nothing.
    expect(harness.commits).toEqual(Array(3).fill('w5d1.test.routed-writer'));
    expect(JSON.parse(files()['a/workspace.json'] ?? '')).toMatchObject({
      routed: 3,
    });
    harness.hooks.afterRead = undefined;
    await expect(apply(keyed)).resolves.toEqual({
      workspaceId: 'a',
      privateMemory: true,
    });
    expect(JSON.parse(files()['a/workspace.json'] ?? '')).toMatchObject({
      routed: 3,
      privateMemory: true,
    });
  });

  it('refuses a second call on a key in progress, then replays the decision', async () => {
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = (): void => undefined;
    const deciding = new Promise<void>((resolve) => {
      reached = resolve;
    });
    harness.hooks.commit.before = async (): Promise<void> => {
      harness.hooks.commit.before = undefined;
      reached();
      await held;
    };
    const params: W5HostedMetadataRequest = {
      operation: 'core.workspace.scripts.update',
      workspaceId: 'a',
      change: { kind: 'merge-commands', commands: { setup: 'pnpm i' } },
      idempotencyKey: 'busy-1',
    };
    const first = apply(params);
    await deciding;
    const other = await harness.connectMetadata('other-client');
    await expect(refusal(apply(params, other))).resolves.toMatchObject({
      code: 'core.workspace.requestInProgress',
    });
    release();
    await expect(first).resolves.toEqual({});
    await expect(apply(params, other)).resolves.toEqual({});
    expect(harness.commits).toEqual(['core.workspace.scripts.update']);
    expect(harness.retryCounts()).toEqual(new Map());
  });

  it('replays a decided request after the transport drops', async () => {
    const lossy = await harness.connectMetadata('lossy');
    harness.hooks.commit.after = async (): Promise<void> => {
      harness.hooks.commit.after = undefined;
      await lossy.close();
    };
    const params = {
      operation: 'core.workspace.update',
      workspaceId: 'a',
      patch: { name: 'Dropped' },
      idempotencyKey: 'drop-1',
    } as const;
    await expect(apply(params, lossy)).rejects.toBeDefined();
    const retried = await apply(params);
    // The workspace its decision left, saved with the receipt (DM-2).
    expect(retried).toEqual({
      workspaceId: 'a',
      name: 'Dropped',
      kind: 'git',
      repositorySources: [
        { repoId: 'api', remoteUrl: 'https://github.com/acme/api.git' },
      ],
      settings: {},
      color: '#7C3AED',
      pinned: false,
      collapsed: false,
      activitySectionOrder: [],
      itemSortMode: 'manual',
      alwaysShow: true,
      startPage: { kind: 'inherit' },
    });
    await expect(apply(params)).resolves.toEqual(retried);
    // The lost response's decision only: the retries decided nothing.
    expect(harness.commits).toEqual(['core.workspace.update']);
    expect(harness.committedEvents()).toHaveLength(1);
  });

  it('answers a version 1 #3 receipt, as the retired port saved it, with the current projection', async () => {
    const field = (value: unknown, key: string): unknown =>
      typeof value === 'object' && value !== null && key in value
        ? Reflect.get(value, key)
        : undefined;
    harness.hooks.commit.before = (request): Promise<void> => {
      harness.hooks.commit.before = undefined;
      // The retired port's outcome: no decided workspace.
      Object.assign(request, {
        outcome: {
          workspaceId: field(request.outcome, 'workspaceId'),
          indexWritten: field(request.outcome, 'indexWritten'),
          manifestWritten: field(request.outcome, 'manifestWritten'),
        },
      });
      return Promise.resolve();
    };
    const params = {
      operation: 'core.workspace.update',
      workspaceId: 'a',
      patch: { name: 'Version 1' },
      idempotencyKey: 'v1-update',
    } as const;
    await expect(apply(params)).resolves.toMatchObject({ name: 'Version 1' });
    await apply({
      operation: 'core.workspace.update',
      workspaceId: 'a',
      patch: { name: 'Later' },
      idempotencyKey: 'v1-later',
    });
    await expect(apply(params)).resolves.toMatchObject({
      workspaceId: 'a',
      name: 'Later',
    });
    expect(harness.commits).toEqual([
      'core.workspace.update',
      'core.workspace.update',
    ]);
  });

  it('replays across a host restart in a new epoch, and refuses the key for other details', async () => {
    const params = {
      operation: 'core.workspace.repository.remove',
      workspaceId: 'a',
      repoId: 'web',
      idempotencyKey: 'restart-1',
    } as const;
    const first = await apply(params);
    const after = files();
    await harness.close();
    harness = await start('runtime:w5d1-restarted');
    client = await harness.connectMetadata();
    await expect(apply(params)).resolves.toEqual(first);
    await expect(
      refusal(apply({ ...params, repoId: 'other' })),
    ).resolves.toMatchObject({ code: 'core.workspace.idempotencyKeyReused' });
    expect(files()).toEqual(after);
    expect(harness.commits).toEqual([]);
    expect(harness.committedEvents()).toEqual([]);
  });

  /*
   * Stored values the index and manifest readers take but no request could
   * send: beyond the request caps, and above one transport frame. A removal's
   * result carries the removed repository as stored, so one it could not
   * deliver is refused before its decision; every committed decision is
   * delivered.
   */
  describe.each([
    {
      size: 'beyond the request caps',
      deliverable: true,
      ids: ['w'.repeat(600)],
      name: 'n'.repeat(600),
      url: `https://github.com/acme/${'u'.repeat(5000)}.git`,
    },
    {
      size: 'above one transport frame',
      deliverable: false,
      // Ids that total more than a frame, and a name and remote each above one.
      ids: ['x', 'y'].map((id) =>
        id.repeat(CANOPY_DEFAULT_MAX_FRAME_BYTES / 2 + 1),
      ),
      name: 'n'.repeat(CANOPY_DEFAULT_MAX_FRAME_BYTES + 1),
      url: `https://github.com/acme/${'u'.repeat(CANOPY_DEFAULT_MAX_FRAME_BYTES + 1)}.git`,
    },
  ])('on stored values $size', ({ deliverable, ids, name, url }) => {
    const json = (file: string): Record<string, unknown> => {
      const parsed: unknown = JSON.parse(files()[file] ?? '');
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        Array.isArray(parsed)
      )
        throw new Error(`${file} shape`);
      return { ...parsed };
    };
    const list = (value: unknown): readonly unknown[] =>
      Array.isArray(value) ? value : [];

    /**
     * A result the control plane could not send never arrives: fail on this
     * deadline, well under Jest's, rather than on Jest's timeout.
     */
    async function delivered(
      params: W5HostedMetadataRequest,
    ): Promise<unknown> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          apply(params),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('The result was never delivered')),
              15_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }

    /** The same key again on this host, then after a restart in a new epoch. */
    async function replays(
      params: W5HostedMetadataRequest,
      expected: unknown,
    ): Promise<void> {
      await expect(delivered(params)).resolves.toEqual(expected);
      await harness.close();
      harness = await start('runtime:w5d1-stored-restarted');
      client = await harness.connectMetadata();
      await expect(delivered(params)).resolves.toEqual(expected);
      expect(harness.commits).toEqual([]);
    }

    beforeEach(async () => {
      // Logged commits of both files first, so the out-of-band edit below
      // meets each file's logged fingerprint, as a desktop or hand edit would.
      await apply({
        operation: 'core.workspace.update',
        workspaceId: 'b',
        patch: { name: 'B2' },
      });
      await apply({
        operation: 'core.workspace.scripts.update',
        workspaceId: 'a',
        change: { kind: 'merge-commands', commands: { setup: 'pnpm i' } },
      });
      expect(harness.commits).toEqual([
        'core.workspace.update',
        'core.workspace.scripts.update',
      ]);
      const index = json('index.json');
      const manifest = json('a/workspace.json');
      await harness.close();
      writeFileSync(
        join(root, 'index.json'),
        JSON.stringify({
          ...index,
          workspaces: [
            ...list(index.workspaces),
            ...[...ids, ''].map((id, order) => ({
              id,
              name: 'Stored',
              type: 'single-repo',
              color: '#7C3AED',
              order: order + 2,
            })),
          ],
        }),
      );
      writeFileSync(
        join(root, 'a', 'workspace.json'),
        JSON.stringify({
          ...manifest,
          repos: [
            ...list(manifest.repos),
            {
              id: 'long',
              name,
              repoPath: join(dir, 'long'),
              source: 'manifest',
              manifestUrl: url,
            },
          ],
        }),
      );
      harness = await start();
      client = await harness.connectMetadata();
    });

    it('reports a committed repository removal, first and on replay after a restart, or refuses one it could not deliver', async () => {
      const remove = {
        operation: 'core.workspace.repository.remove',
        workspaceId: 'a',
        repoId: 'long',
        idempotencyKey: 'stored-remove',
      } as const;
      if (!deliverable) {
        const before = files();
        await expect(refusal(delivered(remove))).resolves.toEqual({
          kind: 'capability_unavailable',
          message:
            "This project's details can't be returned here, so nothing was changed.",
          details: { reason: 'result-unavailable' },
          retry: { kind: 'never' },
        });
        expect(files()).toEqual(before);
        expect(harness.commits).toEqual([]);
        // The key was released: it decides another removal.
        await expect(delivered({ ...remove, repoId: 'web' })).resolves.toEqual({
          removed: { id: 'web', name: 'web', source: 'manifest' },
        });
        return;
      }
      const removed = {
        removed: { id: 'long', name, source: 'manifest', manifestUrl: url },
      };
      await expect(delivered(remove)).resolves.toEqual(removed);
      expect(harness.commits).toEqual(['core.workspace.repository.remove']);
      await replays(remove, removed);
      expect(json('a/workspace.json').repos).toEqual([
        expect.objectContaining({ id: 'web' }),
        expect.objectContaining({ id: 'api' }),
      ]);
    });

    it('acknowledges a committed reorder, first and on replay after a restart', async () => {
      const reorder: W5HostedMetadataRequest = {
        ...MOVE,
        idempotencyKey: 'stored-reorder',
      };
      const acknowledged = { acknowledged: true };
      await expect(delivered(reorder)).resolves.toEqual(acknowledged);
      expect(harness.commits).toEqual(['core.workspace.reorder']);
      await replays(reorder, acknowledged);
      expect(
        list(json('index.json').workspaces).map((entry) =>
          typeof entry === 'object' && entry !== null && 'id' in entry
            ? entry.id
            : undefined,
        ),
      ).toEqual(['b', 'a', ...ids, '']);
    });
  });

  describe('recovery classes on daemon keys (RX2)', () => {
    /** Maintenance runs on a cold host once the daemon side has stopped. */
    function maintenanceContext(): W5MaintenanceContext {
      // Maintenance needs the private data root and runtime directory.
      chmodSync(dataDir, 0o700);
      mkdirSync(join(dataDir, 'runtime'), { recursive: true, mode: 0o700 });
      const os = hostPlatformOperatingSystem();
      const platform = hostPlatformServices(createPlatformEndpointServices(os));
      return {
        host: new W5CommitLogHost({
          dbPath: join(dataDir, 'w5', 'commit-log.sqlite'),
          root,
          workerEntry: WORKER,
        }),
        dataRoot: dataDir,
        platform: {
          ...platform,
          supervision: {
            ...platform.supervision,
            inspectProcess: ({ pid }) =>
              Promise.resolve(
                pid === process.pid
                  ? { state: 'running', startIdentity: 'fixture-self-start' }
                  : { state: 'absent' },
              ),
          },
        },
      };
    }

    const maintain = (
      decisions?: readonly W5MaintenanceDecision[],
    ): ReturnType<typeof runW5Maintenance> =>
      runW5Maintenance(
        maintenanceContext(),
        decisions
          ? { source: 'offline_maintenance', mode: 'resolve', decisions }
          : { source: 'offline_maintenance', mode: 'diagnose' },
      );

    async function restart(): Promise<void> {
      harness = await start('runtime:w7a3-recovered');
      client = await harness.connectMetadata();
    }

    const posix = process.platform === 'win32' ? it.skip : it;

    posix.each<[string, W5HostedMetadataRequest]>([
      [
        'core.workspace.update',
        {
          operation: 'core.workspace.update',
          workspaceId: 'a',
          patch: { pinned: true },
        },
      ],
      ['core.workspace.reorder', MOVE],
      [
        'core.workspace.scripts.update',
        {
          operation: 'core.workspace.scripts.update',
          workspaceId: 'a',
          change: { kind: 'merge-commands', commands: { dev: 'x' } },
        },
      ],
      [
        'core.workspace.planDetection.update',
        {
          operation: 'core.workspace.planDetection.update',
          workspaceId: 'a',
          planDetection: { disabledRuleIds: ['x'] },
        },
      ],
      [
        'core.workspace.privateMemory.update',
        {
          operation: 'core.workspace.privateMemory.update',
          workspaceId: 'a',
          privateMemory: true,
        },
      ],
      [
        'core.workspace.repository.add',
        {
          operation: 'core.workspace.repository.add',
          workspaceId: 'a',
          repository: { selection: pickerSelection('pick-other') },
        },
      ],
      [
        'core.workspace.repository.remove',
        {
          operation: 'core.workspace.repository.remove',
          workspaceId: 'a',
          repoId: 'web',
        },
      ],
    ])(
      '%s: a request that failed before its decision is recoveryRequired, diagnosed, then resolved on its key',
      async (operation, request) => {
        const before = files();
        const params = { ...request, idempotencyKey: 'rx-reservation' };
        harness.hooks.commit.before = (): Promise<void> =>
          Promise.reject(new Error('The worker stopped.'));
        await expect(refusal(apply(params))).resolves.toMatchObject({
          kind: 'internal',
        });
        harness.hooks.commit.before = undefined;
        await expect(refusal(apply(params))).resolves.toMatchObject({
          kind: 'failed_precondition',
          code: 'core.workspace.recoveryRequired',
        });
        expect(files()).toEqual(before);
        expect(W5_RESOLVABLE_RESERVATION_OPERATIONS.has(operation)).toBe(true);
        await harness.close();
        const diagnosis = await maintain();
        if (diagnosis.mode !== 'diagnose')
          throw new Error('Expected diagnosis');
        const [reservation] = diagnosis.diagnosis.reservations;
        expect(reservation).toMatchObject({
          operation,
          state: 'recovery-required',
        });
        await expect(
          maintain([
            {
              kind: 'resolve-reservation',
              reservationId: reservation?.reservationId ?? '',
            },
          ]),
        ).resolves.toMatchObject({ results: [{ status: 'resolved' }] });
        await restart();
        // The released key decides again.
        await expect(apply(params)).resolves.toBeDefined();
        expect(harness.commits).toEqual([operation]);
      },
    );

    const FOREIGN = '{"foreign":true}\n';

    /**
     * A call whose decision commits but whose files changed out of band
     * before they applied: decided but unapplied. Returns the files' original
     * bytes so a test can restore them.
     */
    async function decidedButUnapplied(
      params: W5HostedMetadataRequest,
    ): Promise<Map<string, string>> {
      const originals = new Map<string, string>();
      harness.hooks.commit.before = (request): Promise<void> => {
        harness.hooks.commit.before = undefined;
        for (const { path, previousFingerprint } of request.files) {
          // A file the change replaces; one it creates has nothing to restore.
          if (previousFingerprint === null) continue;
          originals.set(path, readFileSync(path, 'utf8'));
          writeFileSync(path, FOREIGN);
        }
        return Promise.resolve();
      };
      for (let attempt = 0; attempt < 2; attempt += 1)
        // The key holds the decided commit, not a new decision.
        await expect(refusal(apply(params))).resolves.toMatchObject({
          kind: 'failed_precondition',
          code: 'core.workspace.recoveryRequired',
        });
      expect(originals.size).toBeGreaterThan(0);
      await harness.close();
      return originals;
    }

    async function wedgedCommitId(operation: string): Promise<number> {
      const diagnosis = await maintain();
      if (diagnosis.mode !== 'diagnose') throw new Error('Expected diagnosis');
      const [commit] = diagnosis.diagnosis.commits;
      expect(commit).toMatchObject({ operation, state: 'recovery-required' });
      return commit?.commitId ?? 0;
    }

    posix(
      'a decided but unapplied #3 retries once its files are restored, then replays its first outcome',
      async () => {
        const params: W5HostedMetadataRequest = {
          operation: 'core.workspace.update',
          workspaceId: 'a',
          patch: { name: 'Decided', itemSortMode: 'last-updated' },
          idempotencyKey: 'rx-commit',
        };
        const originals = await decidedButUnapplied(params);
        const commitId = await wedgedCommitId('core.workspace.update');
        for (const [path, bytes] of originals) writeFileSync(path, bytes);
        await expect(
          maintain([{ kind: 'retry-commit', commitId }]),
        ).resolves.toMatchObject({ results: [{ status: 'applied' }] });
        await restart();
        expect(JSON.parse(files()['a/workspace.json'] ?? '')).toMatchObject({
          itemSortMode: 'last-updated',
        });
        await expect(apply(params)).resolves.toMatchObject({
          workspaceId: 'a',
          name: 'Decided',
          itemSortMode: 'last-updated',
        });
        expect(harness.commits).toEqual([]);
      },
    );

    posix(
      'a decided but unapplied #10 whose retry fails again is abandoned, which releases its key',
      async () => {
        const params: W5HostedMetadataRequest = {
          operation: 'core.workspace.privateMemory.update',
          workspaceId: 'a',
          privateMemory: true,
          idempotencyKey: 'rx-abandon',
        };
        const originals = await decidedButUnapplied(params);
        const commitId = await wedgedCommitId(
          'core.workspace.privateMemory.update',
        );
        await expect(
          maintain([{ kind: 'retry-commit', commitId }]),
        ).resolves.toMatchObject({
          results: [{ status: 'recovery-required' }],
        });
        await expect(
          maintain([{ kind: 'abandon-commit', commitId }]),
        ).resolves.toMatchObject({
          results: [{ status: 'abandoned' }],
          diagnosis: { commits: [], reservations: [] },
        });
        for (const [path, bytes] of originals) writeFileSync(path, bytes);
        await restart();
        await expect(apply(params)).resolves.toEqual({
          workspaceId: 'a',
          privateMemory: true,
        });
        expect(harness.commits).toEqual([
          'core.workspace.privateMemory.update',
        ]);
        expect(JSON.parse(files()['a/workspace.json'] ?? '')).toMatchObject({
          privateMemory: true,
        });
      },
    );

    posix(
      'a decided key whose saved outcome expired is refused outcomeExpired, with nothing decided again',
      async () => {
        const params: W5HostedMetadataRequest = {
          ...MOVE,
          idempotencyKey: 'rx-expired',
        };
        await expect(apply(params)).resolves.toEqual({ acknowledged: true });
        const after = files();
        await harness.close();
        // Retention past the retry window drops the saved outcome.
        const db = new DatabaseSync(join(dataDir, 'w5', 'commit-log.sqlite'));
        try {
          db.exec(
            "UPDATE w5_commits SET outcome_expired = 1, outcome_json = 'null'",
          );
        } finally {
          db.close();
        }
        const diagnosis = await maintain();
        if (diagnosis.mode !== 'diagnose')
          throw new Error('Expected diagnosis');
        expect(diagnosis.diagnosis).toMatchObject({
          commits: [],
          reservations: [],
        });
        await restart();
        await expect(refusal(apply(params))).resolves.toMatchObject({
          code: 'core.workspace.outcomeExpired',
          retry: { kind: 'never' },
        });
        expect(files()).toEqual(after);
        expect(harness.commits).toEqual([]);
      },
    );
  });

  it('is capability_unavailable under legacy rows, writing nothing and consuming no key', async () => {
    harness.setDaemonOwned([]);
    const before = files();
    const params: W5HostedMetadataRequest = {
      ...MOVE,
      idempotencyKey: 'legacy-1',
    };
    await expect(refusal(apply(params))).resolves.toMatchObject({
      kind: 'capability_unavailable',
      details: { reason: 'unlisted_writer' },
    });
    expect(files()).toEqual(before);
    expect(harness.commits).toEqual([]);
    harness.setDaemonOwned(W5_NAMESPACES);
    // A consumed key would replay, or be in progress or recovery-required.
    await expect(apply(params)).resolves.toEqual({ acknowledged: true });
    expect(harness.commits).toEqual(['core.workspace.reorder']);
  });

  it('redeems no repository selection under legacy rows', async () => {
    selections.oneTime = true;
    harness.setDaemonOwned([]);
    const params: W5HostedMetadataRequest = {
      operation: 'core.workspace.repository.add',
      workspaceId: 'a',
      repository: { selection: pickerSelection('pick-other') },
      idempotencyKey: 'legacy-add',
    };
    await expect(refusal(apply(params))).resolves.toMatchObject({
      kind: 'capability_unavailable',
    });
    expect(selections.resolved).toBe(0);
    harness.setDaemonOwned(W5_NAMESPACES);
    await expect(apply(params)).resolves.toEqual({
      repository: { id: 'other', name: 'other' },
    });
    expect(selections.resolved).toBe(1);
  });
});

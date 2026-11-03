import * as fsPromises from 'node:fs/promises';
// CAN-5318: the request-local W5 read view over the real commit-log worker.
import {
  mkdirSync,
  readFileSync,
  realpathSync,
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

import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  __setDesktopW5FileStoreForTests,
  createW5CommitLogFileStore,
  desktopW5FileStore,
  runW5ReadView,
  withW5Commit,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore, type W5FileRead } from '../w5-file-store';
import {
  deferUntilW5ReadViewCloses,
  W5ReadViewWriteRefusedError,
} from '../w5-read-view';
import { WORKTREE_LIST_STORAGE, withStorageAdmission } from '../w5-storage';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let host: W5CommitLogHost;

const listPath = (): string => join(root, 'a', 'worktrees.json');
const list = (ids: readonly string[]): string =>
  JSON.stringify({
    version: 1,
    worktrees: ids.map((id) => ({
      id,
      branchName: id,
      createdAt: '2026-10-28T00:00:00Z',
    })),
  });
const scoped = {
  files: [{ kind: 'index' }, { kind: 'worktrees', workspaceId: 'a' }] as const,
  discoverWorkspaces: false,
};
function raw(read: W5FileRead): string | null {
  return read.state === 'present' ? read.raw : null;
}

beforeEach(() => {
  ({ dir } = createW5BoundaryFixture());
  dir = realpathSync(dir);
  root = join(dir, 'data', 'workspaces');
  writeFileSync(listPath(), list(['one']));
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
});
afterEach(async () => {
  jest.restoreAllMocks();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  rmSync(dir, { recursive: true, force: true });
});

it('serves the captured bytes after the file changes, without a live read', async () => {
  const live = jest.spyOn(nodeW5FileStore, 'read');
  const outcome = await runW5ReadView(scoped, async (view) => {
    writeFileSync(listPath(), list(['one', 'cli']));
    return { view, read: await desktopW5FileStore.read(listPath()) };
  });
  expect(raw(outcome.read)).toBe(list(['one']));
  expect(outcome.view).toMatchObject({
    status: 'captured',
    uncapturedReads: [],
  });
  expect(live).not.toHaveBeenCalled();
  expect(raw(await desktopW5FileStore.read(listPath()))).toBe(
    list(['one', 'cli']),
  );
});

it('fails an uncaptured W5 dependency closed and records it', async () => {
  const live = jest.spyOn(nodeW5FileStore, 'read');
  const manifest = join(root, 'a', 'workspace.json');
  const outcome = await runW5ReadView(scoped, async (view) => ({
    view,
    manifest: await desktopW5FileStore.read(manifest),
    outside: await desktopW5FileStore.read(join(dir, 'elsewhere.json')),
  }));
  expect(outcome.manifest.state).toBe('unreadable');
  expect(outcome.outside.state).toBe('unreadable');
  expect(outcome.view).toMatchObject({
    uncapturedReads: [{ kind: 'manifest', workspaceId: 'a' }],
  });
  expect(live).not.toHaveBeenCalled();
});

it('refuses writes and commit scopes from the view', async () => {
  const before = readFileSync(listPath(), 'utf8');
  await runW5ReadView(scoped, async () => {
    await expect(
      desktopW5FileStore.replace(
        listPath(),
        list(['two']),
        WORKTREE_LIST_STORAGE,
        {
          operation: 'test.write',
          advance: [],
          previousRaw: before,
        },
      ),
    ).rejects.toBeInstanceOf(W5ReadViewWriteRefusedError);
    await expect(
      withW5Commit({ operation: 'test.scope' }, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(W5ReadViewWriteRefusedError);
  });
  expect(readFileSync(listPath(), 'utf8')).toBe(before);
});

it('runs deferred writes in order once the view closes, keeping the read', async () => {
  const before = readFileSync(listPath(), 'utf8');
  const order: string[] = [];
  const write = (): Promise<void> =>
    withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
      desktopW5FileStore.replace(
        listPath(),
        list(['two']),
        WORKTREE_LIST_STORAGE,
        {
          operation: 'test.deferred',
          advance: [],
          previousRaw: before,
        },
      ),
    );
  const read = await runW5ReadView(scoped, async () => {
    expect(
      deferUntilW5ReadViewCloses(() => {
        order.push('failed');
        return Promise.reject(new Error('deferred write failed'));
      }),
    ).toBe(true);
    expect(
      deferUntilW5ReadViewCloses(async () => {
        order.push('written');
        await write();
      }),
    ).toBe(true);
    expect(order).toEqual([]);
    return raw(await desktopW5FileStore.read(listPath()));
  });
  expect(read).toBe(before);
  expect(order).toEqual(['failed', 'written']);
  expect(readFileSync(listPath(), 'utf8')).toBe(list(['two']));
  expect(deferUntilW5ReadViewCloses(() => Promise.resolve())).toBe(false);
});

it('keeps a mutation scope on its staged reads, without capturing', async () => {
  const capture = jest.spyOn(host, 'capture');
  const previousRaw = readFileSync(listPath(), 'utf8');
  const outcome = await withStorageAdmission([WORKTREE_LIST_STORAGE], () =>
    withW5Commit({ operation: 'test.stage' }, async () => {
      await desktopW5FileStore.replace(
        listPath(),
        list(['staged']),
        WORKTREE_LIST_STORAGE,
        { operation: 'test.stage', advance: [], previousRaw },
      );
      return runW5ReadView(scoped, async (view) => ({
        view,
        read: await desktopW5FileStore.read(listPath()),
      }));
    }),
  );
  expect(outcome.view).toEqual({
    status: 'uncaptured',
    reason: 'mutation-scope',
  });
  expect(raw(outcome.read)).toBe(list(['staged']));
  expect(capture).not.toHaveBeenCalled();
});

it('isolates concurrent views at their own positions', async () => {
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const capture = host.capture.bind(host);
  let captured = (): void => {};
  const firstCaptured = new Promise<void>((resolve) => {
    captured = resolve;
  });
  jest.spyOn(host, 'capture').mockImplementationOnce(async (request) => {
    const result = await capture(request);
    captured();
    return result;
  });
  const first = runW5ReadView(scoped, async () => {
    await held;
    return raw(await desktopW5FileStore.read(listPath()));
  });
  await firstCaptured;
  writeFileSync(listPath(), list(['one', 'later']));
  const second = await runW5ReadView(scoped, async () =>
    raw(await desktopW5FileStore.read(listPath())),
  );
  release();
  expect(await first).toBe(list(['one']));
  expect(second).toBe(list(['one', 'later']));
});

it('leaves a finished view inert for timers it started', async () => {
  let timer: Promise<string | null> = Promise.resolve(null);
  await runW5ReadView(scoped, () => {
    timer = new Promise((resolve) => {
      setTimeout(() => {
        void desktopW5FileStore.read(listPath()).then((read) => {
          resolve(raw(read));
        });
      }, 50);
    });
    return Promise.resolve();
  });
  writeFileSync(listPath(), list(['after']));
  expect(await timer).toBe(list(['after']));
});

it.each([
  [
    'capture-limit',
    new W5CommitRefusedError('invalid-state', 'limit', {
      capture: 'limit-exceeded',
    }),
    'present',
  ],
  [
    'unsupported-platform',
    new W5CommitRefusedError('invalid-state', 'platform', {
      capture: 'unsupported-platform',
    }),
    'present',
  ],
  // A missing addon is never caused by a path swap, so it keeps live reads.
  [
    'confinement-unavailable',
    new W5CommitRefusedError('invalid-state', 'platform', {
      capture: 'confinement-unavailable',
    }),
    'present',
  ],
  // A root swapped after anchoring never falls back to a pathname read.
  [
    'root-changed',
    new W5CommitRefusedError('invalid-state', 'root', {
      capture: 'root-changed',
    }),
    'unreadable',
  ],
  [
    'root-unavailable',
    new W5CommitRefusedError('invalid-state', 'root', {
      capture: 'root-unavailable',
      code: 'ENOENT',
    }),
    'unreadable',
  ],
  ['capture-failed', new Error('worker stopped'), 'unreadable'],
] as const)('reports %s and reads %s', async (reason, error, state) => {
  jest.spyOn(host, 'capture').mockRejectedValueOnce(error);
  const outcome = await runW5ReadView(scoped, async (view) => {
    await expect(
      withW5Commit({ operation: 'test.scope' }, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(W5ReadViewWriteRefusedError);
    return { view, read: await desktopW5FileStore.read(listPath()) };
  });
  expect(outcome.view).toEqual({ status: 'uncaptured', reason });
  expect(outcome.read.state).toBe(state);
});

it('reads a direct test store live and says so', async () => {
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  const outcome = await runW5ReadView(scoped, async (view) => ({
    view,
    read: await desktopW5FileStore.read(listPath()),
  }));
  expect(outcome.view).toEqual({
    status: 'uncaptured',
    reason: 'direct-store',
  });
  expect(raw(outcome.read)).toBe(list(['one']));
});

it('serves an opted-in disk projection after authority loss without any write or commit', async () => {
  const { W5AuthorityUnreachableError } =
    await import('@canopy/core-runtime/node/w5/file-store');
  const { withW5ProjectionOnlyRead, W5_PROJECTION_ONLY_READ } =
    await import('../w5-fallback-read');
  jest
    .spyOn(host, 'capture')
    .mockRejectedValue(new W5AuthorityUnreachableError('refused', 'lost'));
  const commit = jest.spyOn(host, 'commit');
  const atomic = jest.spyOn(nodeW5FileStore, 'replace');
  const deferred = jest.fn(() => Promise.resolve());
  const result = await withW5ProjectionOnlyRead(W5_PROJECTION_ONLY_READ, () =>
    runW5ReadView(scoped, async (view) => {
      expect(await desktopW5FileStore.read(listPath())).toEqual({
        state: 'present',
        raw: list(['one']),
      });
      expect(await desktopW5FileStore.read(join(root, 'missing.json'))).toEqual(
        { state: 'absent' },
      );
      expect(deferUntilW5ReadViewCloses(deferred)).toBe(true);
      await expect(
        withW5Commit({ operation: 'forbidden' }, () => Promise.resolve()),
      ).rejects.toBeInstanceOf(W5ReadViewWriteRefusedError);
      await expect(
        desktopW5FileStore.replace(listPath(), 'bad', WORKTREE_LIST_STORAGE, {
          operation: 'forbidden',
          advance: [],
          previousRaw: null,
        }),
      ).rejects.toBeInstanceOf(W5ReadViewWriteRefusedError);
      return view;
    }),
  );
  expect(result).toEqual({
    status: 'uncaptured',
    reason: 'daemon-unavailable',
  });
  expect(deferred).not.toHaveBeenCalled();
  expect(commit).not.toHaveBeenCalled();
  expect(atomic).not.toHaveBeenCalled();
});

it('does not opt decision reads into fallback, or degrade a live typed refusal', async () => {
  const { W5AuthorityUnreachableError } =
    await import('@canopy/core-runtime/node/w5/file-store');
  const { withW5ProjectionOnlyRead, W5_PROJECTION_ONLY_READ } =
    await import('../w5-fallback-read');
  const lost = new W5AuthorityUnreachableError('refused', 'lost');
  const capture = jest.spyOn(host, 'capture').mockRejectedValue(lost);
  const read = await runW5ReadView(scoped, () =>
    desktopW5FileStore.read(listPath()),
  );
  expect(read).toEqual({ state: 'unreadable', error: lost });
  capture.mockRejectedValue(
    new W5CommitRefusedError('invalid-state', 'root', {
      capture: 'root-changed',
    }),
  );
  await withW5ProjectionOnlyRead(W5_PROJECTION_ONLY_READ, () =>
    runW5ReadView(scoped, async (view) => {
      expect(view).toEqual({ status: 'uncaptured', reason: 'root-changed' });
      expect((await desktopW5FileStore.read(listPath())).state).toBe(
        'unreadable',
      );
    }),
  );
});

it('does not mask a nested live refusal with an outer disk projection', async () => {
  const { W5AuthorityUnreachableError } =
    await import('@canopy/core-runtime/node/w5/file-store');
  const { withW5ProjectionOnlyRead, W5_PROJECTION_ONLY_READ } =
    await import('../w5-fallback-read');
  jest
    .spyOn(host, 'capture')
    .mockRejectedValueOnce(new W5AuthorityUnreachableError('refused', 'lost'))
    .mockRejectedValueOnce(
      new W5CommitRefusedError('invalid-state', 'root', {
        capture: 'root-changed',
      }),
    );
  await withW5ProjectionOnlyRead(W5_PROJECTION_ONLY_READ, () =>
    runW5ReadView(scoped, async () => {
      expect(raw(await desktopW5FileStore.read(listPath()))).toBe(
        list(['one']),
      );
      await runW5ReadView(scoped, async () => {
        expect((await desktopW5FileStore.read(listPath())).state).toBe(
          'unreadable',
        );
      });
      expect(raw(await desktopW5FileStore.read(listPath()))).toBe(
        list(['one']),
      );
    }),
  );
});

it('never labels outer fallback bytes as a nested authoritative capture', async () => {
  const { W5AuthorityUnreachableError } =
    await import('@canopy/core-runtime/node/w5/file-store');
  const {
    allowsW5ProjectionOnlyRead,
    isW5ProjectionOnlyView,
    withW5ProjectionOnlyRead,
    W5_PROJECTION_ONLY_READ,
  } = await import('../w5-fallback-read');
  const deferred = jest.fn(() => Promise.resolve());
  const captured = await host.capture(scoped);
  writeFileSync(listPath(), list(['disk-only']));
  jest
    .spyOn(host, 'capture')
    .mockRejectedValueOnce(new W5AuthorityUnreachableError('refused', 'lost'))
    .mockResolvedValueOnce(captured);
  await withW5ProjectionOnlyRead(W5_PROJECTION_ONLY_READ, () =>
    runW5ReadView(scoped, async () => {
      expect(raw(await desktopW5FileStore.read(listPath()))).toBe(
        list(['disk-only']),
      );
      await runW5ReadView(scoped, async (view) => {
        expect(view.status).toBe('captured');
        expect(isW5ProjectionOnlyView()).toBe(false);
        expect(allowsW5ProjectionOnlyRead()).toBe(false);
        expect(raw(await desktopW5FileStore.read(listPath()))).toBe(
          list(['one']),
        );
        expect(deferUntilW5ReadViewCloses(deferred)).toBe(true);
        await expect(
          withW5Commit({ operation: 'forbidden' }, () => Promise.resolve()),
        ).rejects.toBeInstanceOf(W5ReadViewWriteRefusedError);
      });
      expect(raw(await desktopW5FileStore.read(listPath()))).toBe(
        list(['disk-only']),
      );
      expect(deferred).not.toHaveBeenCalled();
    }),
  );
});

it('does not lend a presentation opt-in to a nested decision query', async () => {
  const { W5AuthorityUnreachableError } =
    await import('@canopy/core-runtime/node/w5/file-store');
  const {
    allowsW5ProjectionOnlyRead,
    isW5ProjectionOnlyView,
    withW5ProjectionOnlyRead,
    W5_PROJECTION_ONLY_READ,
  } = await import('../w5-fallback-read');
  const lost = new W5AuthorityUnreachableError('refused', 'lost');
  jest.spyOn(host, 'capture').mockRejectedValue(lost);
  await withW5ProjectionOnlyRead(W5_PROJECTION_ONLY_READ, () =>
    runW5ReadView(scoped, async () => {
      expect(isW5ProjectionOnlyView()).toBe(true);
      expect(allowsW5ProjectionOnlyRead()).toBe(false);
      await runW5ReadView(scoped, async (view) => {
        expect(view).toEqual({
          status: 'uncaptured',
          reason: 'capture-failed',
          error: lost,
        });
        expect(isW5ProjectionOnlyView()).toBe(false);
        expect(allowsW5ProjectionOnlyRead()).toBe(false);
        expect(await desktopW5FileStore.read(listPath())).toEqual({
          state: 'unreadable',
          error: lost,
        });
      });
      expect(isW5ProjectionOnlyView()).toBe(true);
      expect(raw(await desktopW5FileStore.read(listPath()))).toBe(
        list(['one']),
      );
    }),
  );
});

it.each(['single-repo', 'multi-repo'] as const)(
  'lists a stale %s sidebar without revisions, pinned pages or registry changes',
  async (type) => {
    const { W5AuthorityUnreachableError } =
      await import('@canopy/core-runtime/node/w5/file-store');
    const { withW5ProjectionOnlyRead, W5_PROJECTION_ONLY_READ } =
      await import('../w5-fallback-read');
    const { createDesktopRuntime } =
      await import('../../canopy-runtime/desktop-runtime');
    const {
      getWorkspaceType,
      getWorkspaceExternalPath,
      registerWorkspaceTypes,
      registerWorkspaceExternalPaths,
    } = await import('../workspace-registry');
    const workspaceSource = await import('../workspace-source');
    const sourceResolution = jest.spyOn(
      workspaceSource,
      'readEffectiveWorkspaceConfig',
    );
    if (type === 'multi-repo') {
      writeFileSync(
        join(root, 'a', 'workspace.json'),
        JSON.stringify({
          version: 1,
          type,
          sourceRepoPath: '/unavailable/source',
          repos: [],
        }),
      );
    }
    mkdirSync(join(root, 'b'));
    writeFileSync(
      join(root, 'b', 'workspace.json'),
      readFileSync(join(root, 'a', 'workspace.json')),
    );
    writeFileSync(
      join(root, 'b', 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: [] }),
    );
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: ['a', 'b'].map((id, order) => ({
          id,
          name: id,
          type,
          color: '#7C3AED',
          collapsed: false,
          order,
        })),
      }),
    );
    const originalDataDir = process.env.CANOPY_DATA_DIR;
    process.env.CANOPY_DATA_DIR = join(dir, 'data');
    registerWorkspaceTypes(new Map([['a', 'cowork']]));
    registerWorkspaceExternalPaths(new Map([['a', '/previous/external']]));
    jest
      .spyOn(host, 'capture')
      .mockRejectedValue(new W5AuthorityUnreachableError('refused', 'lost'));
    const commit = jest.spyOn(host, 'commit');
    const reserve = jest.spyOn(host, 'reserve');
    const release = jest.spyOn(host, 'releaseReservation');
    const atomic = jest.spyOn(nodeW5FileStore, 'replace');
    const runtime = createDesktopRuntime();
    const writes = [
      jest.spyOn(fsPromises, 'writeFile'),
      jest.spyOn(fsPromises, 'appendFile'),
      jest.spyOn(fsPromises, 'mkdir'),
      jest.spyOn(fsPromises, 'rename'),
      jest.spyOn(fsPromises, 'unlink'),
    ];
    try {
      const listed = await withW5ProjectionOnlyRead(
        W5_PROJECTION_ONLY_READ,
        () =>
          runtime.queryWorkspaceListForLegacyIpc(
            { pageSize: 1 },
            {
              caller: {
                principalId: 'test',
                clientInstanceId: 'test',
                authorityId: 'local-desktop',
                interfaceKind: 'test',
                grants: ['core.workspace.read'],
              },
            },
          ),
      );
      expect(listed.legacyResult).toMatchObject({
        stale: true,
        items: [
          { id: 'a', type, worktrees: [{ id: 'one' }] },
          { id: 'b', type, worktrees: [] },
        ],
      });
      expect(listed.canonicalResult?.nextCursor).toBeNull();
      expect(listed.canonicalResult).not.toHaveProperty('collectionRevision');
      expect(listed.canonicalResult?.items[0]).not.toHaveProperty('revision');
      expect(listed.legacyAuthority?.provenance).toMatchObject({
        position: { status: 'uncaptured', reason: 'daemon-unavailable' },
        result: { filters: ['page', 'possibly-stale'] },
      });
      expect(getWorkspaceType('a')).toBe('cowork');
      expect(getWorkspaceExternalPath('a')).toBe('/previous/external');
      expect(sourceResolution).not.toHaveBeenCalled();
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(commit).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
      expect(atomic).not.toHaveBeenCalled();
    } finally {
      if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
      else process.env.CANOPY_DATA_DIR = originalDataDir;
      await runtime.shutdown();
    }
  },
);

it('expires projection permission and the active fallback even in escaped async work', async () => {
  const {
    allowsW5ProjectionOnlyRead,
    isW5ProjectionOnlyView,
    runW5FallbackRead,
    withW5ProjectionOnlyRead,
    W5_PROJECTION_ONLY_READ,
  } = await import('../w5-fallback-read');
  let resume: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let escaped: Promise<boolean[]> | undefined;
  await withW5ProjectionOnlyRead(W5_PROJECTION_ONLY_READ, () =>
    runW5FallbackRead(() => {
      expect(allowsW5ProjectionOnlyRead()).toBe(false);
      expect(isW5ProjectionOnlyView()).toBe(true);
      escaped = gate.then(() => [
        allowsW5ProjectionOnlyRead(),
        isW5ProjectionOnlyView(),
      ]);
      return Promise.resolve();
    }),
  );
  resume();
  await expect(escaped).resolves.toEqual([false, false]);
});

it('keeps project discovery and the App Advisor owner inventory fail-closed', async () => {
  const { W5AuthorityUnreachableError } =
    await import('@canopy/core-runtime/node/w5/file-store');
  const { createDesktopRuntime } =
    await import('../../canopy-runtime/desktop-runtime');
  const { readProjectWorktrees } =
    await import('../../project-discovery/sources');
  const { listAuthorizedProjectInventory } =
    await import('../../project-discovery/owner-policy');
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  const lost = new W5AuthorityUnreachableError('refused', 'lost');
  const capture = jest.spyOn(host, 'capture').mockRejectedValue(lost);
  const runtime = createDesktopRuntime();
  try {
    await expect(readProjectWorktrees('a')).rejects.toMatchObject({
      runtimeCause: lost,
    });
    await expect(
      listAuthorizedProjectInventory({ kind: 'app_advisor', chatId: 'chat' }),
    ).rejects.toMatchObject({ runtimeCause: lost });
    expect(capture).toHaveBeenCalledTimes(2);
  } finally {
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    await runtime.shutdown();
  }
});

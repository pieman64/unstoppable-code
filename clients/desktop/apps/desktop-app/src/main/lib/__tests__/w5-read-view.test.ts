// CAN-5318: the request-local W5 read view over the real commit-log worker.
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

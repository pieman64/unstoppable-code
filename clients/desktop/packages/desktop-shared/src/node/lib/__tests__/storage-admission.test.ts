// CAN-3944: composite W5 operations admit every namespace they write at
// entry, and an ownership change cannot interleave with an admitted operation.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as StorageModule from '@canopy/core-runtime/storage';
import type { StorageOwnershipRow } from '@canopy/core-runtime/storage';
import { writeFileAtomically } from '../atomic-file';
import {
  detachedWorkCallback,
  settleAll,
  settleDetachedWork,
  trackDetachedWork,
} from '../detached-work';
import {
  StorageAdmissionError,
  withStorageAdmission,
  withStorageOwnershipChange,
  type StorageAdmissionTarget,
} from '../storage-admission';

jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof StorageModule>(
    '@canopy/core-runtime/storage',
  );
  return { ...actual, STORAGE_OWNERSHIP: [...actual.STORAGE_OWNERSHIP] };
});

const actualStorage = jest.requireActual<typeof StorageModule>(
  '@canopy/core-runtime/storage',
);
// Mutated in place: modules hold the mocked array by reference.
const mockedOwnership = jest.requireMock<{
  STORAGE_OWNERSHIP: StorageOwnershipRow[];
}>('@canopy/core-runtime/storage').STORAGE_OWNERSHIP;

function setDaemonOwned(...namespaces: string[]): void {
  mockedOwnership.splice(
    0,
    mockedOwnership.length,
    ...actualStorage.STORAGE_OWNERSHIP.map((row) =>
      namespaces.includes(row.id)
        ? { ...row, transitionOwner: 'daemon' as const, currentWriters: [] }
        : row,
    ),
  );
}

const INDEX: StorageAdmissionTarget = {
  namespace: 'workspace_index',
  writer: 'desktop_cli',
};
const LIST: StorageAdmissionTarget = {
  namespace: 'worktree_list',
  writer: 'desktop_cli',
};

const turn = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let root: string;
const target = (): string => join(root, 'worktrees.json');

beforeEach(async () => {
  setDaemonOwned();
  root = await mkdtemp(join(tmpdir(), 'storage-admission-'));
});

afterEach(() => rm(root, { recursive: true, force: true }));

describe('admission scope', () => {
  it('fails an unadmitted checked write as a programming error', async () => {
    await expect(
      writeFileAtomically(target(), '{}', { storage: LIST }),
    ).rejects.toBeInstanceOf(StorageAdmissionError);
    expect(await readdir(root)).toEqual([]);
  });

  it('fails a checked write to a namespace the operation did not admit', async () => {
    await expect(
      withStorageAdmission([INDEX], () =>
        writeFileAtomically(target(), '{}', { storage: LIST }),
      ),
    ).rejects.toBeInstanceOf(StorageAdmissionError);
    await expect(
      withStorageAdmission([INDEX], () =>
        withStorageAdmission([LIST], () => Promise.resolve()),
      ),
    ).rejects.toBeInstanceOf(StorageAdmissionError);
    expect(await readdir(root)).toEqual([]);
  });

  it('fails a write by another principal under the same namespace', async () => {
    await expect(
      withStorageAdmission([LIST], () =>
        writeFileAtomically(target(), '{}', {
          storage: { namespace: 'worktree_list', writer: 'electron_main' },
        }),
      ),
    ).rejects.toBeInstanceOf(StorageAdmissionError);
  });

  it('admits nested writers inside the operation', async () => {
    await withStorageAdmission([INDEX, LIST], () =>
      withStorageAdmission([LIST], () =>
        writeFileAtomically(target(), '{}', { storage: LIST }),
      ),
    );
    expect(await readdir(root)).toEqual(['worktrees.json']);
  });

  it('stops admitting background work once the operation settles', async () => {
    let background: Promise<void> | undefined;
    await withStorageAdmission([LIST], () => {
      background = turn()
        .then(turn)
        .then(() => writeFileAtomically(target(), '{}', { storage: LIST }));
      return Promise.resolve();
    });
    await expect(background).rejects.toBeInstanceOf(StorageAdmissionError);
  });

  it('keeps the per-write check for an unadmitted write outside tests', async () => {
    const environment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await writeFileAtomically(target(), '{}', { storage: LIST });
      setDaemonOwned('worktree_list');
      await expect(
        writeFileAtomically(target(), '[]', { storage: LIST }),
      ).rejects.toMatchObject({ reason: 'daemon_owned' });
    } finally {
      process.env.NODE_ENV = environment;
    }
  });

  it('holds an unadmitted write outside tests until it completes', async () => {
    const environment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const write = writeFileAtomically(target(), '{}', { storage: LIST });
      let seen: string[] | undefined;
      const change = withStorageOwnershipChange(['worktree_list'], async () => {
        seen = await readdir(root);
        setDaemonOwned('worktree_list');
      });
      await write;
      await change;
      expect(seen).toEqual(['worktrees.json']);
    } finally {
      process.env.NODE_ENV = environment;
    }
  });

  it('refuses a daemon-owned namespace before the operation starts', async () => {
    setDaemonOwned('worktree_list');
    const operation = jest.fn(() => Promise.resolve());

    await expect(
      withStorageAdmission([INDEX, LIST], operation),
    ).rejects.toMatchObject({
      name: 'StorageWriteRefusedError',
      namespaceId: 'worktree_list',
      reason: 'daemon_owned',
    });
    expect(operation).not.toHaveBeenCalled();
  });

  it('starts the operation synchronously', () => {
    let started = false;
    void withStorageAdmission([LIST], () => {
      started = true;
      return Promise.resolve();
    });
    expect(started).toBe(true);
  });
});

describe('ownership change', () => {
  it('waits for an admitted operation and never interleaves with it', async () => {
    const gate = deferred();
    const events: string[] = [];
    const operation = withStorageAdmission([INDEX, LIST], async () => {
      events.push('first write');
      await gate.promise;
      await writeFileAtomically(target(), '{}', { storage: LIST });
      events.push('last write');
    });
    const change = withStorageOwnershipChange(['worktree_list'], () => {
      setDaemonOwned('worktree_list');
      events.push('change');
    });

    await turn();
    expect(events).toEqual(['first write']);
    gate.resolve();
    await operation;
    await change;

    expect(events).toEqual(['first write', 'last write', 'change']);
    await expect(
      withStorageAdmission([LIST], () => Promise.resolve()),
    ).rejects.toMatchObject({ reason: 'daemon_owned' });
  });

  it('keeps a nested admission held after its enclosing operation settles', async () => {
    const gate = deferred();
    let detached: Promise<void> | undefined;
    await withStorageAdmission([INDEX, LIST], () => {
      detached = withStorageAdmission([LIST], async () => {
        await gate.promise;
        await writeFileAtomically(target(), '{}', { storage: LIST });
      });
      return Promise.resolve();
    });
    let changed = false;
    const change = withStorageOwnershipChange(['worktree_list'], () => {
      changed = true;
    });

    await turn();
    expect(changed).toBe(false);
    gate.resolve();
    await detached;
    await change;
    expect(changed).toBe(true);
    expect(await readdir(root)).toEqual(['worktrees.json']);
  });

  it('keeps a failed operation held until its parallel siblings settle', async () => {
    const gate = deferred();
    const events: string[] = [];
    const operation = withStorageAdmission([LIST], () =>
      settleAll([
        Promise.reject(new Error('sibling failed')),
        gate.promise.then(() => {
          events.push('sibling write');
        }),
      ]),
    );
    const change = withStorageOwnershipChange(['worktree_list'], () => {
      events.push('change');
    });

    await turn();
    expect(events).toEqual([]);
    gate.resolve();
    await expect(operation).rejects.toThrow('sibling failed');
    await change;
    expect(events).toEqual(['sibling write', 'change']);
  });

  it('holds new admissions until the change settles', async () => {
    const gate = deferred();
    const events: string[] = [];
    const change = withStorageOwnershipChange(['worktree_list'], async () => {
      await gate.promise;
      setDaemonOwned('worktree_list');
      events.push('change');
    });
    await turn();
    const operation = withStorageAdmission([LIST], () => {
      events.push('operation');
      return Promise.resolve();
    });
    const unrelated = withStorageAdmission([INDEX], () => {
      events.push('unrelated');
      return Promise.resolve();
    });

    await unrelated;
    expect(events).toEqual(['unrelated']);
    gate.resolve();
    await change;
    await expect(operation).rejects.toMatchObject({ reason: 'daemon_owned' });
    expect(events).toEqual(['unrelated', 'change']);
  });

  it('admits an operation that holds a lock an admitted one awaits while a change waits', async () => {
    // A lock taken before admission, as find-or-create takes its
    // split-destination lock.
    const lock = deferred();
    const events: string[] = [];
    const holder = withStorageAdmission([LIST], async () => {
      await lock.promise;
      events.push('holder');
    });
    const change = withStorageOwnershipChange(['worktree_list'], () => {
      events.push('change');
    });
    await turn();
    const lockOwner = withStorageAdmission([LIST], () => {
      events.push('lock owner');
      lock.resolve();
      return Promise.resolve();
    });

    await Promise.all([holder, lockOwner, change]);
    expect(events).toEqual(['lock owner', 'holder', 'change']);
  });

  it('proceeds once a refused admission releases its hold', async () => {
    setDaemonOwned('workspace_index');
    await expect(
      withStorageAdmission([INDEX, LIST], () => Promise.resolve()),
    ).rejects.toMatchObject({ namespaceId: 'workspace_index' });

    await expect(
      withStorageOwnershipChange(['worktree_list'], () => 'changed'),
    ).resolves.toBe('changed');
  });

  it('cannot start inside an admitted operation', async () => {
    await expect(
      withStorageAdmission([LIST], () =>
        withStorageOwnershipChange(['workspace_index'], () => undefined),
      ),
    ).rejects.toThrow('An admitted operation cannot change storage ownership');
  });
});

describe('detached-work helpers', () => {
  it('keeps tracked detached work admitted after its caller settles', async () => {
    const gate = deferred();
    const events: string[] = [];
    await withStorageAdmission([INDEX, LIST], () => {
      trackDetachedWork(async () => {
        await gate.promise;
        await writeFileAtomically(target(), '{}', { storage: LIST });
        events.push('detached write');
      });
      return Promise.resolve();
    });
    const change = withStorageOwnershipChange(['worktree_list'], () => {
      setDaemonOwned('worktree_list');
      events.push('change');
    });

    await turn();
    expect(events).toEqual([]);
    gate.resolve();
    await settleDetachedWork();
    await change;
    expect(events).toEqual(['detached write', 'change']);
    expect(await readdir(root)).toEqual(['worktrees.json']);
  });

  it('admits nothing for work tracked outside an admitted operation', async () => {
    let failure: unknown;
    trackDetachedWork(() =>
      writeFileAtomically(target(), '{}', { storage: LIST }).catch(
        (error: unknown) => {
          failure = error;
        },
      ),
    );
    await settleDetachedWork();
    expect(failure).toBeInstanceOf(StorageAdmissionError);
  });

  it('admits a detachedWorkCallback write at its sink, not under its scheduler', async () => {
    const fired = deferred();
    await withStorageAdmission([INDEX], async () => {
      const callback = detachedWorkCallback(() =>
        withStorageAdmission([LIST], () =>
          writeFileAtomically(target(), '{}', { storage: LIST }),
        ).finally(fired.resolve),
      );
      setImmediate(callback);
      // Fires while the scheduler still holds its own admission.
      await fired.promise;
    });
    await settleDetachedWork();
    expect(await readdir(root)).toEqual(['worktrees.json']);
  });

  it('refuses a detachedWorkCallback write once ownership changed', async () => {
    const gate = deferred();
    let refusal: unknown;
    await withStorageAdmission([LIST], () => {
      const callback = detachedWorkCallback(() =>
        withStorageAdmission([LIST], () =>
          writeFileAtomically(target(), '{}', { storage: LIST }),
        ).catch((error: unknown) => {
          refusal = error;
        }),
      );
      void gate.promise.then(callback);
      return Promise.resolve();
    });
    await withStorageOwnershipChange(['worktree_list'], () => {
      setDaemonOwned('worktree_list');
    });

    gate.resolve();
    await turn();
    await settleDetachedWork();
    expect(refusal).toMatchObject({ reason: 'daemon_owned' });
    expect(await readdir(root)).toEqual([]);
  });
});

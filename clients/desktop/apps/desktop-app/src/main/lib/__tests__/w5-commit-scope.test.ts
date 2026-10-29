import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  WorkspaceIndexEntry,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  W5CommitLog,
  type W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);

import {
  W5CommitLogHost,
  W5CommitLogHostError,
} from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../w5-commit-log-file-store';
import { createWorkspaceIndexRepository } from '../workspace-index-repository';
import { createWorkspaceManifestRepository } from '../workspace-manifest-repository';
import { createWorktreeListRepository } from '../worktree-list-repository';
import {
  WORKSPACE_INDEX_STORAGE,
  WORKSPACE_MANIFEST_STORAGE,
  WORKTREE_LIST_STORAGE,
  withStorageAdmission,
  PROJECT_W5_STORAGE,
} from '../w5-storage';
import {
  afterW5Apply,
  afterW5Commit,
  currentW5CommitScope,
  onW5Abort,
  outsideW5CommitScope,
  w5CommitsSettling,
} from '../w5-commit-scope';
import {
  ownsW5RepositoryLock,
  withW5RepositoryLock,
} from '../w5-repository-locks';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'w5-repositories-'));
  root = join(dir, 'workspaces');
  mkdirSync(root);
  dbPath = join(dir, 'w5', 'commit-log.sqlite');
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
});
afterEach(async () => {
  await host.shutdown();
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function entry(id: string, order = 0): WorkspaceIndexEntry {
  return {
    id,
    name: id,
    type: 'cowork',
    color: '#fff',
    collapsed: false,
    order,
  };
}
function row(id: string): WorktreeData {
  return { id, branchName: id, createdAt: '2026-10-14T00:00:00Z' };
}
function repositories(): {
  store: ReturnType<typeof createW5CommitLogFileStore>;
  index: ReturnType<typeof createWorkspaceIndexRepository>;
  manifest: ReturnType<typeof createWorkspaceManifestRepository>;
  list: ReturnType<typeof createWorktreeListRepository>;
} {
  const store = createW5CommitLogFileStore(() => host);
  const index = createWorkspaceIndexRepository({
    store,
    filePath: () => join(root, 'index.json'),
    storage: WORKSPACE_INDEX_STORAGE,
    onCommitted: () => {},
    onRefused: () => {},
  });
  const manifest = createWorkspaceManifestRepository({
    store,
    filePath: (id) => join(root, id, 'workspace.json'),
    storage: WORKSPACE_MANIFEST_STORAGE,
    knownFields: new Set(['version', 'type', 'repos']),
    knownRepoFields: new Set(['id', 'name', 'repoPath']),
  });
  const list = createWorktreeListRepository({
    store,
    filePath: (id) => join(root, id, 'worktrees.json'),
    storage: WORKTREE_LIST_STORAGE,
    knownRowFields: new Set(['id', 'branchName', 'createdAt', 'label']),
  });
  return { store, index, manifest, list };
}
async function revisions(resources: W5Resource[]): Promise<number[]> {
  return Promise.all(resources.map((resource) => host.revision(resource)));
}
const workspaces: W5Resource = { kind: 'workspaces' };
const workspace = (workspaceId: string): W5Resource => ({
  kind: 'workspace',
  workspaceId,
});
const worktrees: W5Resource = { kind: 'worktrees', workspaceId: 'a' };
const worktree = (worktreeId: string): W5Resource => ({
  kind: 'worktree',
  workspaceId: 'a',
  worktreeId,
});

function itAdmitted(name: string, work: () => Promise<void>): void {
  it(name, () => withStorageAdmission(PROJECT_W5_STORAGE, work));
}

async function stageAll(repos: ReturnType<typeof repositories>): Promise<void> {
  await repos.index.update(() => ({ result: null, entries: [entry('a')] }));
  await repos.manifest.serialize('a', async () =>
    repos.manifest.replace(
      'a',
      { version: 1, type: 'cowork', repos: [] },
      await repos.manifest.read('a'),
    ),
  );
  await repos.list.replace('a', [row('one')], await repos.list.read('a'));
}

function commitCount():
  | number
  | bigint
  | null
  | Uint8Array
  | string
  | undefined {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare('SELECT COUNT(*) AS count FROM w5_commits').get()?.count;
  } finally {
    db.close();
  }
}

itAdmitted(
  'commits index, manifest and list once, joining nested scopes and advancing the union once',
  async () => {
    const repos = repositories();
    const commits = jest.spyOn(host, 'commit');
    await repos.store.withCommit({ operation: 'test.mutation' }, async () => {
      await stageAll(repos);
      await repos.store.withCommit({ operation: 'nested' }, async () => {
        await repos.index.update(({ entries }) => ({
          result: null,
          entries: entries.map((item) => ({ ...item, name: 'Final' })),
        }));
      });
      expect(commits).not.toHaveBeenCalled();
    });
    expect(commits).toHaveBeenCalledTimes(1);
    expect(commits.mock.calls[0]?.[0].operation).toBe('test.mutation');
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toContain('Final');
    expect(
      await revisions([workspaces, workspace('a'), worktrees, worktree('one')]),
    ).toEqual([1, 1, 1, 1]);
    await host.shutdown();
    expect(commitCount()).toBe(1);
  },
);

it.each(['observe', 'stage', 'overlap', 'conflict'])(
  'fenced scopes preserve the first preimage and refuse foreign images (%s)',
  (first) =>
    withStorageAdmission(PROJECT_W5_STORAGE, async () => {
      const { store } = repositories();
      const path = join(root, 'a', 'worktrees.json');
      mkdirSync(join(root, 'a'));
      writeFileSync(path, 'original');
      const commits = jest.spyOn(host, 'commit');
      const stage = (contents: string, previousRaw: string): Promise<void> =>
        store.replace(path, contents, WORKTREE_LIST_STORAGE, {
          operation: 'test.stage',
          advance: [worktrees],
          previousRaw,
        });
      const options = {
        operation: 'test.fenced',
        fenceLockedFiles: true,
        locks: [{ kind: 'list' as const, path }],
      };
      if (first === 'conflict') {
        await expect(
          store.withCommit(options, async () => {
            writeFileSync(path, 'foreign');
            await stage('final', 'foreign');
          }),
        ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
        expect(readFileSync(path, 'utf8')).toBe('foreign');
        expect(await host.revision(worktrees)).toBe(0);
        expect(commits).not.toHaveBeenCalled();
        return;
      }
      if (first === 'overlap') {
        const read = store.read.bind(store);
        jest.spyOn(store, 'read').mockImplementationOnce(async (file) => {
          const observed = await read(file);
          // Complete a competing stage while this older observation is suspended.
          await store.withCommit(options, () => stage('first', 'original'));
          return observed;
        });
      }
      await store.withCommit(
        first === 'stage' ? { operation: 'outer' } : options,
        async () => {
          if (first === 'stage') await stage('first', 'original');
          await store.withCommit(options, async () => {
            await stage('second', first === 'observe' ? 'original' : 'first');
          });
          await stage('final', 'second');
        },
      );
      expect(readFileSync(path, 'utf8')).toBe('final');
      expect(await host.revision(worktrees)).toBe(1);
      expect(commits).toHaveBeenCalledTimes(1);
      expect(commits.mock.calls[0]?.[0].files).toEqual([
        expect.objectContaining({ contents: 'final' }),
      ]);
    }),
);

itAdmitted('abandons every staged file when work throws', async () => {
  const repos = repositories();
  const commits = jest.spyOn(host, 'commit');
  const failure = new Error('work failed');
  await expect(
    repos.store.withCommit({ operation: 'test.mutation' }, async () => {
      await stageAll(repos);
      throw failure;
    }),
  ).rejects.toBe(failure);
  expect(commits).not.toHaveBeenCalled();
  expect(await repos.index.read()).toEqual({
    authority: 'absent',
    entries: [],
  });
  expect((await repos.manifest.read('a')).authority).toBe('absent');
  expect((await repos.list.read('a')).authority).toBe('absent');
  expect(await revisions([workspaces, workspace('a'), worktrees])).toEqual([
    0, 0, 0,
  ]);
});

itAdmitted(
  'reads its staged contents while an outside reader sees only committed files',
  async () => {
    const repos = repositories();
    let staged: () => void = () => {};
    let finish: () => void = () => {};
    const stagedReady = new Promise<void>((resolve) => {
      staged = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = repos.store.withCommit(
      { operation: 'test.mutation' },
      async () => {
        await stageAll(repos);
        expect(
          (await repos.index.read()).entries.map((item) => item.id),
        ).toEqual(['a']);
        expect((await repos.manifest.read('a')).authority).toBe('ok');
        expect((await repos.list.read('a')).authority).toBe('ok');
        staged();
        await finished;
      },
    );
    await stagedReady;
    try {
      expect((await repos.index.read()).authority).toBe('absent');
      expect((await repos.manifest.read('a')).authority).toBe('absent');
      expect((await repos.list.read('a')).authority).toBe('absent');
    } finally {
      finish();
    }
    await pending;
    expect((await repos.index.read()).authority).toBe('ok');
  },
);

itAdmitted(
  'refuses stale expected revisions in SQLite with a typed conflict and no staged file applied',
  async () => {
    const repos = repositories();
    const expectedRevisions = await repos.store.readRevisions([workspaces]);
    await repos.index.update(() => ({
      result: null,
      entries: [entry('outside')],
    }));
    const before = readFileSync(join(root, 'index.json'), 'utf8');
    const pending = repos.store.withCommit(
      { operation: 'test.mutation', expectedRevisions },
      () => stageAll(repos),
    );
    await expect(pending).rejects.toBeInstanceOf(W5RevisionConflictError);
    await expect(pending).rejects.toMatchObject({
      resource: 'workspaces',
      expected: 0,
      actual: 1,
    });
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(before);
    expect((await repos.manifest.read('a')).authority).toBe('absent');
    expect((await repos.list.read('a')).authority).toBe('absent');
    expect(await revisions([workspaces, workspace('a')])).toEqual([1, 0]);
    await host.shutdown();
    expect(commitCount()).toBe(1);
  },
);

itAdmitted(
  'refuses a genuinely external write between staging and commit without overwrite or rerun',
  async () => {
    const repos = repositories();
    let staged: () => void = () => {};
    let finish: () => void = () => {};
    const stagedReady = new Promise<void>((resolve) => {
      staged = resolve;
    });
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const work = jest.fn(async () => {
      await stageAll(repos);
      staged();
      await finished;
    });
    const pending = repos.store.withCommit(
      { operation: 'test.mutation' },
      work,
    );
    // Attach the rejection before releasing the scope.
    const refused = expect(pending).rejects.toBeInstanceOf(
      W5FileWriteRefusedError,
    );
    await stagedReady;
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({ version: 1, workspaces: [entry('outside')] }),
    );
    const before = readFileSync(join(root, 'index.json'), 'utf8');
    finish();
    await refused;
    expect(work).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toBe(before);
    expect((await repos.manifest.read('a')).authority).toBe('absent');
    expect((await repos.list.read('a')).authority).toBe('absent');
    expect(await revisions([workspaces, workspace('a')])).toEqual([0, 0]);
    await host.shutdown();
    expect(commitCount()).toBe(0);
  },
);

itAdmitted(
  'recovers before the waiting writer reads after an earlier commit reports an unknown outcome',
  async () => {
    const repos = repositories();
    const interruptedHost = host;
    const failure = new W5CommitLogHostError('outcome-unknown', 'Lost answer');
    let started: () => void = () => {};
    let release: () => void = () => {};
    const committing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .spyOn(interruptedHost, 'commit')
      .mockImplementationOnce(async (request) => {
        started();
        await released;
        await interruptedHost.shutdown();
        // Same interrupted-decision fixture as part 4: real SQLite records the
        // first decision, but its file has not been applied by a worker yet.
        const log = W5CommitLog.open(dbPath);
        try {
          log.commit(request);
        } finally {
          log.close();
        }
        host = new W5CommitLogHost({
          dbPath,
          root,
          workerEntry: join(
            __dirname,
            '../../w5-commit-log/commit-log-worker.ts',
          ),
        });
        throw failure;
      });
    const work = jest.fn(async () =>
      repos.index.update(() => ({ result: null, entries: [entry('first')] })),
    );
    const first = repos.store.withCommit({ operation: 'test.first' }, work);
    const refused = expect(first).rejects.toBe(failure);
    await committing;
    const second = repos.store.withCommit(
      { operation: 'test.second' },
      async () => {
        await repos.index.update(({ entries }) => ({
          result: null,
          entries: [...entries, entry('second')],
        }));
      },
    );

    // Drain staging/queue microtasks while the first decision is held.
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await refused;
    await second;
    expect(work).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toContain('first');
    expect(readFileSync(join(root, 'index.json'), 'utf8')).toContain('second');
    expect(
      await revisions([workspaces, workspace('first'), workspace('second')]),
    ).toEqual([2, 1, 1]);
  },
);

itAdmitted(
  'refuses out-of-order scope acquisition and releases its earlier file lock',
  async () => {
    const repos = repositories();
    await expect(
      repos.store.withCommit({ operation: 'test.inverse-files' }, async () => {
        await repos.manifest.serialize('a', async () => {});
        await repos.index.update(() => ({ result: undefined }));
      }),
    ).rejects.toThrow(
      'W5 commit lock order must be index, manifests, then lists',
    );
    await repos.manifest.serialize('a', async () =>
      repos.manifest.replace(
        'a',
        { version: 1, type: 'cowork', repos: [] },
        await repos.manifest.read('a'),
      ),
    );
    expect((await repos.manifest.read('a')).authority).toBe('ok');
  },
);

itAdmitted(
  'serializes concurrent queued updates of the same staged file',
  async () => {
    const repos = repositories();
    await repos.store.withCommit({ operation: 'test.parallel' }, async () => {
      await repos.index.update(() => ({
        result: undefined,
        entries: [entry('a')],
      }));
      await Promise.all([
        repos.index.update(({ entries }) => ({
          result: undefined,
          entries: entries.map((item) => ({ ...item, name: 'Renamed' })),
        })),
        repos.index.update(({ entries }) => ({
          result: undefined,
          entries: entries.map((item) => ({ ...item, pinned: true })),
        })),
      ]);
    });
    expect((await repos.index.read()).entries[0]).toMatchObject({
      name: 'Renamed',
      pinned: true,
    });
  },
);

itAdmitted(
  'runs apply hooks after the decision and before same-file waiters',
  async () => {
    const repos = repositories();
    const lock = {
      kind: 'list' as const,
      path: join(root, 'a', 'worktrees.json'),
    };
    const events: string[] = [];
    let staged = (): void => {};
    const stagedSignal = new Promise<void>((resolve) => {
      staged = resolve;
    });
    // The waiter starts outside the scope's async context, as another writer.
    const waiter = stagedSignal.then(() =>
      withW5RepositoryLock(lock, () => {
        events.push('waiter');
        return Promise.resolve();
      }),
    );
    await repos.store.withCommit(
      { operation: 'test.mutation', locks: [lock] },
      async () => {
        await repos.list.replace('a', [row('one')], await repos.list.read('a'));
        await afterW5Apply(async () => {
          // A released lock would let the waiter run during this yield.
          await new Promise((resolve) => setTimeout(resolve, 20));
          events.push(
            readFileSync(join(root, 'a', 'worktrees.json'), 'utf8').includes(
              'one',
            )
              ? 'apply-after-decision'
              : 'apply-before-decision',
          );
        });
        await afterW5Commit(() => {
          events.push('after-commit');
        });
        staged();
        // Give the waiter every chance to run before the scope's decision.
        await new Promise((resolve) => setTimeout(resolve, 20));
      },
    );
    await waiter;
    expect(events.indexOf('apply-after-decision')).toBe(0);
    expect(events).toEqual(expect.arrayContaining(['waiter', 'after-commit']));
  },
);

itAdmitted(
  'a refused decision runs abort undos and no apply hooks',
  async () => {
    const repos = repositories();
    const events: string[] = [];
    await expect(
      repos.store.withCommit(
        {
          operation: 'test.mutation',
          expectedRevisions: [{ resource: worktrees, revision: 7 }],
        },
        async () => {
          await repos.list.replace(
            'a',
            [row('one')],
            await repos.list.read('a'),
          );
          onW5Abort(() => events.push('undo'));
          await afterW5Apply(() => {
            events.push('apply');
          });
        },
      ),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    expect(events).toEqual(['undo']);
  },
);

/**
 * Runs `work` under the scope's manifest lease, as the manifest queue runs
 * chat normalization, and settles the list write it defers past the scope.
 */
async function deferListWritePastScope(
  repos: ReturnType<typeof repositories>,
  work: (defer: () => Promise<void>) => Promise<void>,
): Promise<unknown> {
  const manifest = {
    kind: 'manifest',
    path: join(root, 'a', 'workspace.json'),
  } as const;
  let settled: (outcome: Promise<unknown>) => void = () => {};
  const deferred = new Promise<unknown>((resolve) => {
    settled = resolve;
  });
  await repos.store.withCommit(
    { operation: 'test.mutation', locks: [manifest] },
    () =>
      withW5RepositoryLock(manifest, () =>
        work((): Promise<void> => {
          setTimeout(() => {
            settled(
              repos.list
                .read('a')
                .then((read) => repos.list.replace('a', [row('late')], read))
                .then(
                  () => 'committed',
                  (error: unknown) => error,
                ),
            );
          }, 20);
          return Promise.resolve();
        }),
      ),
  );
  return deferred;
}

itAdmitted(
  'work outside the commit scope keeps the lease it runs under, and its own and deferred writes commit alone',
  async () => {
    const repos = repositories();
    const listPath = join(root, 'a', 'worktrees.json');
    const seen: unknown[] = [];
    const outcome = await deferListWritePastScope(repos, (defer) =>
      outsideW5CommitScope(async (): Promise<void> => {
        seen.push(currentW5CommitScope(), ownsW5RepositoryLock());
        await repos.list.replace(
          'a',
          [row('early')],
          await repos.list.read('a'),
        );
        // Applied now, not staged into the enclosing scope.
        seen.push(readFileSync(listPath, 'utf8').includes('early'));
        await defer();
      }),
    );
    expect(seen).toEqual([undefined, true, true]);
    expect(outcome).toBe('committed');
    expect(readFileSync(listPath, 'utf8')).toContain('late');
  },
);

itAdmitted(
  'a write deferred from inside the commit scope past its end is refused',
  async () => {
    const outcome = await deferListWritePastScope(repositories(), (defer) =>
      defer(),
    );
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toMatch(/has finished/);
  },
);

describe('the settling mark of a written file', () => {
  const manifestFile = (): string => join(root, 'a', 'workspace.json');
  const settling = (): number => w5CommitsSettling(manifestFile()).length;
  const manifestLock = (): { kind: 'manifest'; path: string } => ({
    kind: 'manifest',
    path: manifestFile(),
  });

  async function writeManifest(
    repos: ReturnType<typeof repositories>,
  ): Promise<void> {
    await repos.manifest.serialize('a', async () =>
      repos.manifest.replace(
        'a',
        { version: 1, type: 'cowork', repos: [] },
        await repos.manifest.read('a'),
      ),
    );
  }

  function barrier(): { promise: Promise<void>; open: () => void } {
    let open: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  itAdmitted(
    'holds from before the locks release until the post-commit work finishes, and is cleared after',
    async () => {
      const repos = repositories();
      const holding = barrier();
      const gate = barrier();
      const nextRan = barrier();
      const seen: Array<[string, number]> = [];
      const committed = repos.store.withCommit(
        { operation: 'test.mutation', locks: [manifestLock()] },
        async () => {
          await writeManifest(repos);
          await afterW5Apply(() => {
            seen.push(['after apply', settling()]);
          });
          await afterW5Commit(async () => {
            seen.push(['post-commit', settling()]);
            // Keeps the post-commit work running until the next holder ran.
            await nextRan.promise;
          });
          holding.open();
          await gate.promise;
        },
      );
      await holding.promise;
      // The next holder of the manifest lock queues behind the scope.
      const next = withW5RepositoryLock(manifestLock(), () => {
        seen.push(['next holder', settling()]);
        nextRan.open();
        return Promise.resolve();
      });
      gate.open();
      await Promise.all([committed, next]);
      expect(seen).toEqual(
        expect.arrayContaining([
          ['after apply', 0],
          ['next holder', 1],
          ['post-commit', 1],
        ]),
      );
      expect(seen).toHaveLength(3);
      expect(w5CommitsSettling(manifestFile())).toEqual([]);
    },
  );

  itAdmitted(
    'is cleared when a post-commit callback throws, before later callbacks run',
    async () => {
      const repos = repositories();
      const later = jest.fn();
      await expect(
        repos.store.withCommit(
          { operation: 'test.mutation', locks: [manifestLock()] },
          async () => {
            await writeManifest(repos);
            await afterW5Commit(() => {
              throw new Error('post-commit failed');
            });
            await afterW5Commit(later);
          },
        ),
      ).rejects.toThrow('post-commit failed');
      expect(later).not.toHaveBeenCalled();
      expect((await repos.manifest.read('a')).authority).toBe('ok');
      expect(w5CommitsSettling(manifestFile())).toEqual([]);
    },
  );

  itAdmitted('is never set when an apply-phase callback throws', async () => {
    const repos = repositories();
    await expect(
      repos.store.withCommit(
        { operation: 'test.mutation', locks: [manifestLock()] },
        async () => {
          await writeManifest(repos);
          await afterW5Apply(() => {
            throw new Error('apply phase failed');
          });
        },
      ),
    ).rejects.toThrow('apply phase failed');
    expect(w5CommitsSettling(manifestFile())).toEqual([]);
  });

  it.each([
    ['before the decision', false],
    ['after the decision landed', true],
  ] as const)('is never set when the commit fails %s', (_name, lands) =>
    withStorageAdmission(PROJECT_W5_STORAGE, async () => {
      const repos = repositories();
      const commit = host.commit.bind(host);
      jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
        if (lands) await commit(request);
        throw new Error('commit failed');
      });
      const postCommit = jest.fn();
      await expect(
        repos.store.withCommit(
          { operation: 'test.mutation', locks: [manifestLock()] },
          async () => {
            await writeManifest(repos);
            await afterW5Commit(postCommit);
          },
        ),
      ).rejects.toThrow('commit failed');
      expect(postCommit).not.toHaveBeenCalled();
      expect((await repos.manifest.read('a')).authority).toBe(
        lands ? 'ok' : 'absent',
      );
      expect(w5CommitsSettling(manifestFile())).toEqual([]);
    }),
  );

  itAdmitted(
    'is set once by the enclosing scope of a joined one, and cleared after it',
    async () => {
      const repos = repositories();
      const seen: Array<[string, number]> = [];
      await repos.store.withCommit(
        { operation: 'test.mutation', locks: [manifestLock()] },
        async () => {
          await repos.store.withCommit(
            { operation: 'nested', locks: [manifestLock()] },
            async () => {
              await writeManifest(repos);
              await afterW5Commit(() => {
                seen.push(['joined post-commit', settling()]);
              });
            },
          );
          seen.push(['joined returned', settling()]);
        },
      );
      expect(seen).toEqual([
        ['joined returned', 0],
        ['joined post-commit', 1],
      ]);
      expect(w5CommitsSettling(manifestFile())).toEqual([]);
    },
  );
});

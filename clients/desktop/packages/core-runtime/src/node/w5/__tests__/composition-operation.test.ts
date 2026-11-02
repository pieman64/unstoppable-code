import type { W5Resource } from '../commit-log/commit-log';
import { w5ResourceKey } from '../commit-log-file-store';
import {
  admitW5Composition,
  createW5BoundaryStep,
  createW5CompositionLocks,
  createW5CompositionRevisionCheck,
  type W5CommitRunner,
} from '../composition-operation';
import {
  currentW5CommitScope,
  runW5Commit,
  type W5CommitOptions,
} from '../commit-scope';
import type { W5KeyedAttempt } from '../keyed-operation';
import { withW5RepositoryLock } from '../repository-locks';

const STAGED: W5Resource = { kind: 'workspace', workspaceId: 'staged' };
const READ: W5Resource = { kind: 'worktrees', workspaceId: 'read' };

function stage(resource: W5Resource): void {
  const scope = currentW5CommitScope();
  if (!scope) throw new Error('Expected a commit scope');
  scope.advance.set(w5ResourceKey(resource), resource);
}

/** A host commit that runs the step inside a real scope and records its options. */
function commitRunner(commits: W5CommitOptions[]): W5CommitRunner {
  const store = {};
  return (options, work) => {
    commits.push(options);
    return runW5Commit(store, options, work, () => Promise.resolve());
  };
}

describe('createW5BoundaryStep', () => {
  it('runs work directly, without a commit, when no commit options are given', async () => {
    const commits: W5CommitOptions[] = [];
    const step = createW5BoundaryStep(commitRunner(commits));
    await expect(
      step(undefined, [{ kind: 'index', path: '/w5/index.json' }], () =>
        Promise.resolve(currentW5CommitScope()),
      ),
    ).resolves.toBeUndefined();
    expect(commits).toEqual([]);
  });

  it('commits under its locks and advances only revisions for resources it staged', async () => {
    const commits: W5CommitOptions[] = [];
    const step = createW5BoundaryStep(commitRunner(commits));
    const locks = [{ kind: 'manifest' as const, path: '/w5/staged.json' }];
    const options: W5CommitOptions = {
      operation: 'test.step',
      expectedRevisions: [
        { resource: STAGED, revision: 4 },
        { resource: READ, revision: 7 },
      ],
    };
    const result = await step(options, locks, () => {
      stage(STAGED);
      return Promise.resolve('recorded');
    });
    expect(result).toBe('recorded');
    expect(commits).toEqual([
      {
        operation: 'test.step',
        locks,
        expectedRevisions: [
          { resource: STAGED, revision: 4 },
          { resource: READ, revision: 7 },
        ],
      },
    ]);
    expect(options.expectedRevisions).toEqual([
      { resource: STAGED, revision: 5 },
      { resource: READ, revision: 7 },
    ]);
  });

  it('carries the advanced revision into a later step of the same attempt', async () => {
    const commits: W5CommitOptions[] = [];
    const step = createW5BoundaryStep(commitRunner(commits));
    const options: W5CommitOptions = {
      operation: 'test.step',
      expectedRevisions: [{ resource: STAGED, revision: 1 }],
    };
    await step(options, [], () => Promise.resolve(stage(STAGED)));
    await step(options, [], () => Promise.resolve());
    expect(commits.map((commit) => commit.expectedRevisions)).toEqual([
      [{ resource: STAGED, revision: 1 }],
      [{ resource: STAGED, revision: 2 }],
    ]);
    expect(options.expectedRevisions).toEqual([
      { resource: STAGED, revision: 2 },
    ]);
  });

  it('leaves revisions unchanged when the step fails or carries none', async () => {
    const step = createW5BoundaryStep(commitRunner([]));
    const failure = new Error('refused');
    const options: W5CommitOptions = {
      operation: 'test.step',
      expectedRevisions: [{ resource: STAGED, revision: 3 }],
    };
    await expect(
      step(options, [], () => {
        stage(STAGED);
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    expect(options.expectedRevisions).toEqual([
      { resource: STAGED, revision: 3 },
    ]);
    const unguarded: W5CommitOptions = { operation: 'test.step' };
    await step(unguarded, [], () => Promise.resolve(stage(STAGED)));
    expect(unguarded.expectedRevisions).toBeUndefined();
  });

  it('holds its locks until the commit finishes', async () => {
    const lock = { kind: 'list' as const, path: '/w5/held.json' };
    const events: string[] = [];
    let release = (): void => {};
    const committed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const step = createW5BoundaryStep(async (options, work) => {
      const value = await work();
      events.push('work');
      await committed;
      events.push('commit');
      return value;
    });
    const running = step({ operation: 'test.step' }, [lock], () =>
      Promise.resolve(),
    );
    const waiting = withW5RepositoryLock(lock, () => {
      events.push('next holder');
      return Promise.resolve();
    });
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([running, waiting]);
    expect(events).toEqual(['work', 'commit', 'next holder']);
  });
});

describe('createW5CompositionLocks', () => {
  it('projects each declared record through the host paths in index, manifest, list order', () => {
    const locks = createW5CompositionLocks({
      workspaceIndex: () => '/host/index.json',
      workspaceManifest: (id) => `/host/${id}/workspace.json`,
      worktreeList: (id) => `/host/${id}/worktrees.json`,
    });
    expect(locks({ lists: ['c'], manifests: ['a', 'b'], index: true })).toEqual(
      [
        { kind: 'index', path: '/host/index.json' },
        { kind: 'manifest', path: '/host/a/workspace.json' },
        { kind: 'manifest', path: '/host/b/workspace.json' },
        { kind: 'list', path: '/host/c/worktrees.json' },
      ],
    );
    expect(locks({ index: false, manifests: [], lists: [] })).toEqual([]);
  });

  it('reads host paths on each call, never at creation', () => {
    let root = '/first';
    const locks = createW5CompositionLocks({
      workspaceIndex: () => `${root}/index.json`,
      workspaceManifest: (id) => `${root}/${id}.json`,
      worktreeList: (id) => `${root}/${id}.list.json`,
    });
    root = '/second';
    expect(locks({ index: true, lists: ['a'] })).toEqual([
      { kind: 'index', path: '/second/index.json' },
      { kind: 'list', path: '/second/a.list.json' },
    ]);
  });
});

describe('createW5CompositionRevisionCheck', () => {
  it('checks each carried revision in order and stops at the first conflict', async () => {
    const checked: Array<[W5Resource, number | undefined]> = [];
    const conflict = new Error('conflict');
    const check = createW5CompositionRevisionCheck((resource, revision) => {
      checked.push([resource, revision]);
      return resource === READ ? Promise.reject(conflict) : Promise.resolve();
    });
    await expect(
      check({
        operation: 'test.check',
        expectedRevisions: [
          { resource: STAGED, revision: 1 },
          { resource: READ, revision: 2 },
          { resource: STAGED, revision: 3 },
        ],
      }),
    ).rejects.toBe(conflict);
    expect(checked).toEqual([
      [STAGED, 1],
      [READ, 2],
    ]);
    await expect(check({ operation: 'test.check' })).resolves.toBeUndefined();
    expect(checked).toHaveLength(2);
  });
});

describe('admitW5Composition', () => {
  const tagged = new Error('tagged');
  const attempt: W5KeyedAttempt = {
    beforeEffects: () => {},
    validate: (check) => check(),
    validationError: () => tagged,
  };

  it('tags an error from a keyed attempt and passes others through', async () => {
    const error = new Error('stale');
    await expect(
      admitW5Composition(attempt, () => Promise.reject(error)),
    ).rejects.toBe(tagged);
    await expect(
      admitW5Composition(undefined, () => Promise.reject(error)),
    ).rejects.toBe(error);
    await expect(
      admitW5Composition(attempt, () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
  });
});

it('loads its entrypoints without node:sqlite', () => {
  jest.isolateModules(() => {
    jest.doMock('node:sqlite', () => {
      throw new Error('node:sqlite was loaded');
    });
    expect((): void => {
      jest.requireActual<object>('../composition-operation');
      jest.requireActual<object>('../composition-outcome');
    }).not.toThrow();
  });
});

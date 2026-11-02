// `worker.git.diff.get` on the desktop dispatcher over real checkouts: the
// canonical result fixes the legacy defects, named paths get Git's patches,
// the query is pure, and the
// `activity:changed-files` projection rebuilt from the same reads equals the
// direct legacy listing byte for byte.
import {
  chmodSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  CODE_REVIEW_CHAT_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type WorkspaceType,
} from '@canopy/desktop-shared/types';
import {
  WORKER_GIT_GRANTS,
  type CanopyCallerDescriptor,
  type WorkerGitDiffGetParams,
  type WorkerGitDiffGetResult,
} from '@canopy/protocol/canopy-core';
import {
  CanopyOperationError,
  type CanopyHandlerContext,
} from '@canopy/core-runtime';
import type { WorkerGitDiffHost } from '@canopy/core-runtime/node/git';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';
import {
  desktopWorkerGitDiffHost,
  type WorkerGitDispatcher,
} from '../worker-git-adapter';
import {
  listCommittedChangedFiles,
  listUncommittedChangedFiles,
  type ChangedFilesTarget,
} from '../worker-git-dispatch';
import {
  CONFLICT_WS,
  GONE_BASE_WORKTREE,
  MANY_WS,
  MULTI_WS,
  NO_ORIGIN_WS,
  POSIX,
  POSIX_WS,
  SINGLE_WS,
  UNBORN_WS,
  WORKTREE,
  createDiffGoldenFixture,
  git,
  type DiffGoldenFixture,
} from '../../__tests__/helpers/diff-golden-fixtures';
import { getChangedFilesList, getCommittedFilesList } from '../../lib/git';
import { gitPatchReads } from '../../lib/git-patch-reads';
import { registerCodeReviewTarget } from '../../lib/code-review-registry';
import {
  getWorkspaceType,
  listRegisteredWorkspaceIds,
  registerWorkspaceTypes,
} from '../../lib/workspace-registry';

jest.setTimeout(180_000);

const posixIt = POSIX ? it : it.skip;

const caller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'electron-web-contents:1',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['worker.filesystem.read', 'core.workspace.read'],
};
const gitCaller: CanopyCallerDescriptor = {
  ...caller,
  grants: [WORKER_GIT_GRANTS.read],
};

const EDGE_WS = 'edge-ws';

let fixture: DiffGoldenFixture;
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;

/** What the counting host saw, in order. */
const seen: Array<{ repoId: string; grants: readonly string[] }> = [];
const countingHost: WorkerGitDiffHost<string> = {
  ...desktopWorkerGitDiffHost,
  resolveRepository: (params, context: CanopyHandlerContext) => {
    seen.push({ repoId: params.repoId, grants: context.caller.grants });
    return desktopWorkerGitDiffHost.resolveRepository(params, context);
  },
};

function write(path: string, content: string | Buffer): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

const lines = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join('');

/** Git's rename display forms, a name equal to one, and trimmed edges. */
function createEdgeWorkspace(): void {
  const path = fixture.worktreePath(EDGE_WS);
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  git(path, ['config', 'user.email', 'edge@example.com']);
  git(path, ['config', 'user.name', 'Edge']);
  write(join(path, 'src', 'deep', 'one.txt'), lines('one', 20));
  write(join(path, 'two.txt'), lines('two', 20));
  write(join(path, 'p.txt'), lines('p', 20));
  write(join(path, 'q"old.txt'), lines('q', 20));
  const bin = Buffer.alloc(300, 'b');
  bin[2] = 0;
  write(join(path, 'img.bin'), bin);
  write(join(path, 'zz-last.txt '), 'last\n');
  write(join(path, 'p.txt => r.txt'), 'collides\n');
  write(join(path, 'src', '{deep => ~other}', 'one.txt'), 'collides\n');
  git(path, ['add', '-A']);
  git(path, ['commit', '-q', '-m', 'base']);
  git(path, ['branch', 'base']);
  mkdirSync(join(path, 'src', '~other'), { recursive: true });
  mkdirSync(join(path, 'x', 'deep'), { recursive: true });
  // Sorts after the colliding name, so the legacy numstat key lands on it.
  git(path, ['mv', 'src/deep/one.txt', 'src/~other/one.txt']);
  git(path, ['mv', 'two.txt', 'x/deep/two.txt']);
  git(path, ['mv', 'p.txt', 'r.txt']);
  git(path, ['mv', 'q"old.txt', 'q"new.txt']);
  git(path, ['mv', 'img.bin', 'img2.bin']);
  write(join(path, 'p.txt => r.txt'), 'collides\nedited\n');
  write(join(path, 'src', '{deep => ~other}', 'one.txt'), 'collides\nedited\n');
  git(path, ['add', '-A']);
  git(path, ['commit', '-q', '-m', 'renames']);
  // Uncommitted: the same rename kinds staged, and a trailing-space path
  // that sorts last in both listings.
  git(path, ['mv', 'r.txt', 'r2.txt']);
  git(path, ['mv', 'x/deep/two.txt', 'x/two.txt']);
  write(join(path, 'zz-last.txt '), 'last\nmore\n');
  write(join(path, ' lead untracked.txt'), 'lead\n');
  writeFileSync(
    join(fixture.dataDir, 'workspaces', EDGE_WS, 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: path,
      repos: [],
    }),
  );
  writeFileSync(
    join(fixture.dataDir, 'workspaces', EDGE_WS, 'worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: [{ id: WORKTREE, branchName: 'main', createdAt: '2026' }],
    }),
  );
}

beforeAll(async () => {
  fixture = createDiffGoldenFixture('worker-git-diff-adapter-');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = fixture.dataDir;
  if (POSIX) createEdgeWorkspace();
  registerWorkspaceTypes(
    new Map([
      ...listRegisteredWorkspaceIds().flatMap(
        (id): Array<[string, WorkspaceType]> => {
          const type = getWorkspaceType(id);
          return type === null ? [] : [[id, type]];
        },
      ),
      [EDGE_WS, 'single-repo'],
    ]),
  );
  await registerCodeReviewTarget(`${SINGLE_WS}--${WORKTREE}`, {
    projectId: SINGLE_WS,
    worktreeId: WORKTREE,
  });
  runtime = createDesktopRuntime({ workerGitDiffHost: countingHost });
});

afterAll(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  fixture.cleanup();
});

beforeEach(() => {
  seen.length = 0;
  jest.restoreAllMocks();
});

function diffCalls(spy: jest.SpyInstance): number {
  return spy.mock.calls.filter(([name]) => name === 'worker.git.diff.get')
    .length;
}

function targets(): ChangedFilesTarget[] {
  const root = (
    projectId: string,
    worktreeId = WORKTREE,
  ): ChangedFilesTarget => ({
    projectId,
    worktreeId,
    repoId: WORKSPACE_ROOT_REPO_ID,
    repoPath: fixture.worktreePath(projectId, worktreeId),
  });
  const multi = fixture.worktreePath(MULTI_WS);
  return [
    root(SINGLE_WS),
    root(MANY_WS),
    root(UNBORN_WS),
    root(CONFLICT_WS),
    root(NO_ORIGIN_WS),
    root(NO_ORIGIN_WS, GONE_BASE_WORKTREE),
    ...(POSIX ? [root(POSIX_WS), root(EDGE_WS)] : []),
    { ...root(MULTI_WS), repoPath: multi },
    ...['alpha', 'beta', 'notes'].map((repoId) => ({
      projectId: MULTI_WS,
      worktreeId: WORKTREE,
      repoId,
      repoPath: join(multi, 'repos', repoId),
    })),
    // A member whose directory is missing reads as empty, as before.
    {
      projectId: MULTI_WS,
      worktreeId: WORKTREE,
      repoId: 'ghost',
      repoPath: join(multi, 'repos', 'ghost'),
    },
  ];
}

describe('activity:changed-files projection', () => {
  it('returns the direct legacy lists byte for byte through the dispatcher', async () => {
    const spy = jest.spyOn(runtime, 'query');
    let dispatched = 0;
    for (const target of targets()) {
      const label = `${target.projectId}/${target.worktreeId}/${target.repoId}`;
      expect({
        label,
        list: await listUncommittedChangedFiles(runtime, caller, target),
      }).toEqual({ label, list: await getChangedFilesList(target.repoPath) });
      for (const base of [undefined, 'main', 'base', 'gone'])
        expect({
          label,
          base,
          list: await listCommittedChangedFiles(runtime, caller, target, base),
        }).toEqual({
          label,
          base,
          list: await getCommittedFilesList(target.repoPath, base),
        });
      dispatched += 1;
    }
    // Every target dispatched its uncommitted read; committed reads
    // dispatch whenever a merge base exists.
    expect(diffCalls(spy)).toBeGreaterThanOrEqual(dispatched);
    expect(
      seen.every(
        ({ grants }) =>
          grants.length === 1 && grants[0] === WORKER_GIT_GRANTS.read,
      ),
    ).toBe(true);
  });

  posixIt('keeps the legacy quirks the canonical result fixes', async () => {
    const target: ChangedFilesTarget = {
      projectId: EDGE_WS,
      worktreeId: WORKTREE,
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoPath: fixture.worktreePath(EDGE_WS),
    };
    const committed = await listCommittedChangedFiles(
      runtime,
      caller,
      target,
      'base',
    );
    expect(committed).toEqual(
      expect.arrayContaining([
        {
          path: 'img2.bin',
          previousPath: 'img.bin',
          status: 'renamed',
          insertions: 0,
          deletions: 0,
        },
        {
          path: '"q\\"new.txt"',
          previousPath: '"q\\"old.txt"',
          status: 'renamed',
          insertions: 0,
          deletions: 0,
        },
      ]),
    );
    const uncommitted = await listUncommittedChangedFiles(
      runtime,
      caller,
      target,
    );
    expect(uncommitted.map((file) => file.path)).toEqual(
      expect.arrayContaining(['zz-last.txt', 'lead untracked.txt']),
    );
  });

  it('dispatches a registered code-review scope as the worktree it borrows', async () => {
    const spy = jest.spyOn(runtime, 'query');
    const target: ChangedFilesTarget = {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: `${SINGLE_WS}--${WORKTREE}`,
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoPath: fixture.worktreePath(SINGLE_WS),
    };
    expect(await listUncommittedChangedFiles(runtime, caller, target)).toEqual(
      await getChangedFilesList(target.repoPath),
    );
    expect(spy).toHaveBeenCalledWith(
      'worker.git.diff.get',
      {
        scope: { workspaceId: SINGLE_WS, worktreeId: WORKTREE },
        repoId: WORKSPACE_ROOT_REPO_ID,
        base: 'HEAD',
        head: 'WORKTREE',
      },
      { caller: gitCaller },
    );
  });

  // The legacy lists read a Git failure as empty and never throw (defect 3).
  it('keeps the direct listing when the dispatch fails before reading', async () => {
    const failing: WorkerGitDispatcher = {
      query: (): Promise<never> =>
        Promise.reject(
          new CanopyOperationError({
            kind: 'internal',
            message: 'The dispatcher is unavailable.',
            retry: { kind: 'never' },
          }),
        ),
    };
    const target = targets()[0];
    if (target === undefined) throw new Error('No target');
    expect(await listUncommittedChangedFiles(failing, caller, target)).toEqual(
      await getChangedFilesList(target.repoPath),
    );
    expect(
      await listCommittedChangedFiles(failing, caller, target, 'main'),
    ).toEqual(await getCommittedFilesList(target.repoPath, 'main'));
  });

  it('keeps the direct read for an unregistered app-managed scope', async () => {
    const spy = jest.spyOn(runtime, 'query');
    const target: ChangedFilesTarget = {
      projectId: CODE_REVIEW_CHAT_PROJECT_ID,
      worktreeId: 'unregistered--scope',
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoPath: fixture.worktreePath(SINGLE_WS),
    };
    expect(await listUncommittedChangedFiles(runtime, caller, target)).toEqual(
      await getChangedFilesList(target.repoPath),
    );
    expect(diffCalls(spy)).toBe(0);
  });
});

const query = (
  params: WorkerGitDiffGetParams,
  queryCaller: CanopyCallerDescriptor = gitCaller,
): Promise<WorkerGitDiffGetResult> =>
  runtime.query('worker.git.diff.get', params, { caller: queryCaller });

const rootParams = (
  workspaceId: string,
  worktreeId = WORKTREE,
): WorkerGitDiffGetParams => ({
  scope: { workspaceId, worktreeId },
  repoId: WORKSPACE_ROOT_REPO_ID,
  base: 'HEAD',
  head: 'WORKTREE',
});

async function failure(
  promise: Promise<unknown>,
): Promise<CanopyOperationError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyOperationError) return error;
    throw error;
  }
  throw new Error('Expected the query to fail');
}

describe('worker.git.diff.get on the desktop dispatcher', () => {
  it('counts renames and flags renamed binaries in committed changes', async () => {
    const mergeBase = git(fixture.worktreePath(SINGLE_WS), [
      'merge-base',
      'origin/main',
      'HEAD',
    ]);
    const result = await query({
      ...rootParams(SINGLE_WS),
      base: mergeBase,
      head: 'HEAD',
    });
    expect(result.truncated).toBe(false);
    expect(result.files).toEqual(
      expect.arrayContaining([
        {
          path: 'bin-renamed.bin',
          previousPath: 'bin-rename.bin',
          status: 'renamed',
          additions: 0,
          deletions: 0,
          patch: null,
          binary: true,
        },
        {
          path: 'renamed.txt',
          previousPath: 'rename-src.txt',
          status: 'renamed',
          additions: 1,
          deletions: 1,
          patch: null,
        },
        expect.objectContaining({
          path: 'copied.txt',
          previousPath: 'copy-src.txt',
          status: 'copied',
          additions: 1,
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain(fixture.dir);
  });

  it('flags untracked files past the cap as truncated', async () => {
    const result = await query(rootParams(MANY_WS));
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(200);
  });

  posixIt('returns raw paths and the spec statuses', async () => {
    const result = await query(rootParams(POSIX_WS));
    expect(result.files.map(({ path, status }) => [path, status])).toEqual(
      expect.arrayContaining([
        [' lead.txt', 'untracked'],
        ['q"t.txt', 'modified'],
        ['tab\tname.txt', 'untracked'],
        ['zz-trail.txt ', 'untracked'],
        ['type-change.txt', 'type_changed'],
      ]),
    );
  });

  it('refuses an unborn HEAD, another target and a branch base', async () => {
    expect((await failure(query(rootParams(UNBORN_WS)))).payload).toMatchObject(
      { kind: 'failed_precondition', code: 'worker.git.diff.invalidState' },
    );
    expect(
      (
        await failure(
          query({
            ...rootParams(SINGLE_WS),
            scope: {
              workspaceId: SINGLE_WS,
              worktreeId: WORKTREE,
              targetId: 't',
            },
          }),
        )
      ).payload.kind,
    ).toBe('capability_unavailable');
    expect(
      (
        await failure(
          query({ ...rootParams(SINGLE_WS), base: 'main', head: 'HEAD' }),
        )
      ).payload.kind,
    ).toBe('capability_unavailable');
    expect(seen.map((entry) => entry.repoId)).toEqual([WORKSPACE_ROOT_REPO_ID]);
  });

  it('refuses app-managed scopes and unknown repositories', async () => {
    expect(
      (
        await failure(
          query(rootParams(CODE_REVIEW_CHAT_PROJECT_ID, 'some--scope')),
        )
      ).payload,
    ).toMatchObject({
      kind: 'failed_precondition',
      code: 'worker.git.diff.scopeUnsupported',
    });
    for (const [workspaceId, repoId] of [
      [SINGLE_WS, 'alpha'],
      [MULTI_WS, 'ghost'],
      [MULTI_WS, '..'],
    ] as const)
      expect(
        (await failure(query({ ...rootParams(workspaceId), repoId }))).payload,
      ).toMatchObject({ kind: 'not_found', code: 'worker.git.diff.notFound' });
  });

  it('denies a caller without worker.git.read before the host', async () => {
    expect(
      (await failure(query(rootParams(SINGLE_WS), caller))).payload.kind,
    ).toBe('permission_denied');
    expect(seen).toEqual([]);
  });

  it('fetches nothing and writes no Canopy store', async () => {
    const repo = fixture.repos[SINGLE_WS];
    const before = git(repo, ['rev-parse', 'refs/remotes/origin/main']);
    const listing = (): string[] =>
      readdirSync(fixture.dataDir, {
        recursive: true,
        encoding: 'utf8',
      }).sort();
    const files = listing();
    await query(rootParams(SINGLE_WS));
    expect(git(repo, ['rev-parse', 'refs/remotes/origin/main'])).toBe(before);
    expect(before).not.toBe(fixture.upstreamTip);
    expect(listing()).toEqual(files);
  });
});

describe('worker.git.diff.get patches on the desktop dispatcher', () => {
  const singleTree = (): string => fixture.worktreePath(SINGLE_WS);

  it('patches named working-tree files as Git prints them', async () => {
    const result = await query({
      ...rootParams(SINGLE_WS),
      paths: [
        'uncommitted-edit.txt',
        'staged-rename.txt',
        'untracked.txt',
        'untracked.bin',
        'empty-untracked.txt',
      ],
    });
    expect(result.truncated).toBe(false);
    const byPath = new Map(result.files.map((file) => [file.path, file]));
    expect([...byPath.keys()].sort()).toEqual([
      'empty-untracked.txt',
      'staged-renamed.txt',
      'uncommitted-edit.txt',
      'untracked.bin',
      'untracked.txt',
    ]);
    for (const path of ['uncommitted-edit.txt'])
      expect(byPath.get(path)?.patch).toBe(
        `${git(singleTree(), ['diff', 'HEAD', '--no-color', '--', path])}\n`,
      );
    expect(byPath.get('staged-renamed.txt')).toMatchObject({
      previousPath: 'staged-rename.txt',
      status: 'renamed',
    });
    expect(byPath.get('staged-renamed.txt')?.patch).toContain(
      'rename from staged-rename.txt\nrename to staged-renamed.txt\n',
    );
    expect(byPath.get('untracked.txt')?.patch).toBe(
      'diff --git a/untracked.txt b/untracked.txt\nnew file mode 100644\n--- /dev/null\n+++ b/untracked.txt\n@@ -0,0 +1,3 @@\n+untracked 1\n+untracked 2\n+untracked 3\n',
    );
    expect(byPath.get('empty-untracked.txt')?.patch).toBe(
      'diff --git a/empty-untracked.txt b/empty-untracked.txt\nnew file mode 100644\n',
    );
    expect(byPath.get('untracked.bin')).toMatchObject({
      patch: null,
      binary: true,
    });
    expect(JSON.stringify(result)).not.toContain(fixture.dir);
  });

  it('patches a turn between its trees, renames included', async () => {
    const { startTree, endTree } = fixture.turn;
    const result = await query({
      ...rootParams(SINGLE_WS),
      base: startTree,
      head: endTree,
      paths: ['rename-src.txt', 'edit.txt', 'image.bin'],
    });
    const byPath = new Map(result.files.map((file) => [file.path, file]));
    expect(byPath.get('edit.txt')?.patch).toBe(
      `${git(singleTree(), ['diff', `${startTree}..${endTree}`, '--no-color', '--', 'edit.txt'])}\n`,
    );
    expect(byPath.get('renamed.txt')).toMatchObject({
      previousPath: 'rename-src.txt',
      status: 'renamed',
    });
    expect(byPath.get('renamed.txt')?.patch).toContain('+rename edited\n');
    expect(byPath.get('image.bin')).toMatchObject({
      patch: null,
      binary: true,
    });
  });

  posixIt('confines untracked reads to the checkout', async () => {
    const repo = singleTree();
    const outside = join(fixture.dir, 'outside-secret.txt');
    write(outside, 'secret\n');
    symlinkSync(fixture.dir, join(repo, 'escape-dir'));
    symlinkSync(outside, join(repo, 'escape-link'));
    try {
      const reads = gitPatchReads(repo);
      expect(
        await reads.readUntracked('../outside-secret.txt', 100),
      ).toBeNull();
      expect(
        await reads.readUntracked('escape-dir/outside-secret.txt', 100),
      ).toBeNull();
      expect(await reads.readUntracked('dir', 100)).toBeNull();
      expect(await reads.readUntracked('dir/', 100)).toBeNull();
      // A final symlink is reported, never followed.
      expect(await reads.readUntracked('escape-link', 100)).toEqual({
        kind: 'symlink',
        target: outside,
      });
      const result = await query({
        ...rootParams(SINGLE_WS),
        paths: ['escape-link'],
      });
      // Git's form for a link: its target, never the file it names.
      const patch = result.files[0]?.patch ?? '';
      expect(patch).toContain('new file mode 120000\n');
      expect(patch).not.toContain('+secret');
    } finally {
      rmSync(join(repo, 'escape-dir'));
      rmSync(join(repo, 'escape-link'));
    }
  });

  posixIt('records the execute bit of an untracked file', async () => {
    const repo = singleTree();
    const script = join(repo, 'untracked-tool.sh');
    const plain = join(repo, 'untracked-plain.sh');
    write(script, 'echo tool\n');
    write(plain, 'echo plain\n');
    chmodSync(script, 0o755);
    chmodSync(plain, 0o644);
    try {
      const reads = gitPatchReads(repo);
      expect(await reads.readUntracked('untracked-tool.sh', 100)).toMatchObject(
        { kind: 'file', executable: true },
      );
      expect(
        await reads.readUntracked('untracked-plain.sh', 100),
      ).toMatchObject({ kind: 'file', executable: false });
      const result = await query({
        ...rootParams(SINGLE_WS),
        paths: ['untracked-tool.sh', 'untracked-plain.sh'],
      });
      const byPath = new Map(result.files.map((file) => [file.path, file]));
      expect(byPath.get('untracked-tool.sh')?.patch).toContain(
        'new file mode 100755\n',
      );
      expect(byPath.get('untracked-plain.sh')?.patch).toContain(
        'new file mode 100644\n',
      );
    } finally {
      rmSync(script);
      rmSync(plain);
    }
  });
});

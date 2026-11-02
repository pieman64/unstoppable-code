// Shared fixtures for the CAN-4103 diff goldens: real workspace records, bare
// origins, worktree checkouts and Git states under one temporary data root.
// Only IPC registration is mocked by the golden files that use them.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { WorkspaceType } from '@canopy/desktop-shared/types';
import { registerWorkspaceTypes } from '../../lib/workspace-registry';

export const POSIX = process.platform !== 'win32';

export const SINGLE_WS = 'single-ws';
export const POSIX_WS = 'posix-ws';
export const MANY_WS = 'many-ws';
export const UNBORN_WS = 'unborn-ws';
export const CONFLICT_WS = 'conflict-ws';
export const NO_ORIGIN_WS = 'no-origin-ws';
export const MULTI_WS = 'multi-ws';
export const PENDING_WS = 'pending-ws';
export const WORKTREE = 'feature-01';
/** In no-origin-ws: tracks a base branch that does not exist. */
export const GONE_BASE_WORKTREE = 'feature-02';
/** In pending-ws: a deferred reservation whose directory does not exist. */
export const PENDING_WORKTREE = 'pending-01';

export interface DiffGoldenFixture {
  readonly dir: string;
  readonly dataDir: string;
  readonly repos: Readonly<Record<string, string>>;
  readonly origins: Readonly<Record<string, string>>;
  /** Tree and commit ids captured around the single-ws turn. */
  readonly turn: {
    readonly startTree: string;
    readonly endTree: string;
    readonly startCommit: string;
  };
  /** origin/main's tip after the post-clone upstream commit. */
  readonly upstreamTip: string;
  worktreePath(this: void, workspaceId: string, worktreeId?: string): string;
  scrub(this: void, value: string): string;
  cleanup(this: void): void;
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

function gitMayFail(cwd: string, args: string[]): void {
  try {
    execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  } catch {
    // Expected: a conflicting merge exits non-zero and leaves unmerged paths.
  }
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

function lines(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`)
    .map((line) => `${line}\n`)
    .join('');
}

/** NUL within the first 8000 bytes: Git and the estimator call it binary. */
function binary(seed: string, size = 64): Buffer {
  const buffer = Buffer.alloc(size, seed);
  buffer[3] = 0;
  return buffer;
}

function configure(path: string): void {
  git(path, ['config', 'user.email', 'golden@example.com']);
  git(path, ['config', 'user.name', 'Golden']);
  git(path, ['config', 'commit.gpgsign', 'false']);
  git(path, ['config', 'core.autocrlf', 'false']);
  git(path, ['config', 'merge.conflictStyle', 'merge']);
}

function initRepo(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q', '-b', 'main']);
  configure(path);
}

function commitAll(path: string, message: string): void {
  git(path, ['add', '-A']);
  git(path, ['commit', '-q', '--allow-empty', '-m', message]);
}

function workspaceEntry(id: string, type: string, order: number): object {
  return { id, name: id, type, color: '#38BDF8', collapsed: false, order };
}

export function createDiffGoldenFixture(prefix: string): DiffGoldenFixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const dataDir = join(dir, 'data');
  const repos: Record<string, string> = {};
  const origins: Record<string, string> = {};
  const workspaceDir = (id: string): string => join(dataDir, 'workspaces', id);
  const worktreePath = (workspaceId: string, worktreeId = WORKTREE): string =>
    join(workspaceDir(workspaceId), 'worktrees', worktreeId);

  /** Seed -> bare origin -> clone, with the seed kept for upstream pushes. */
  const originFrom = (name: string, seed: string): string => {
    const origin = join(dir, 'origins', `${name}.git`);
    mkdirSync(dirname(origin), { recursive: true });
    execFileSync('git', ['clone', '-q', '--bare', seed, origin], {
      stdio: 'pipe',
    });
    const clone = join(dir, 'clones', name);
    mkdirSync(dirname(clone), { recursive: true });
    execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'pipe' });
    configure(clone);
    origins[name] = origin;
    repos[name] = clone;
    return clone;
  };

  const addWorktree = (
    repo: string,
    workspaceId: string,
    worktreeId = WORKTREE,
  ): string => {
    const path = worktreePath(workspaceId, worktreeId);
    git(repo, ['worktree', 'add', '-q', '-b', worktreeId, path]);
    configure(path);
    return path;
  };

  // single-ws: committed and uncommitted changes of every portable kind.
  const singleSeed = join(dir, 'seeds', SINGLE_WS);
  initRepo(singleSeed);
  write(join(singleSeed, 'keep.txt'), 'keep\n');
  write(join(singleSeed, 'edit.txt'), lines('edit', 10));
  write(join(singleSeed, 'rename-src.txt'), lines('rename', 20));
  write(join(singleSeed, 'copy-src.txt'), lines('copy', 20));
  write(join(singleSeed, 'delete-me.txt'), lines('delete', 4));
  write(join(singleSeed, 'image.bin'), binary('i'));
  write(join(singleSeed, 'bin-rename.bin'), binary('b', 200));
  write(join(singleSeed, 'uncommitted-edit.txt'), lines('uncommitted', 5));
  write(join(singleSeed, 'staged-rename.txt'), lines('staged', 10));
  write(join(singleSeed, 'café.md'), 'café\n');
  commitAll(singleSeed, 'base');
  const single = originFrom(SINGLE_WS, singleSeed);
  const singleTree = addWorktree(single, SINGLE_WS);
  const startTree = git(singleTree, ['rev-parse', 'HEAD^{tree}']);
  const startCommit = git(singleTree, ['rev-parse', 'HEAD']);
  write(
    join(singleTree, 'edit.txt'),
    lines('edit', 8) + 'changed 9\nchanged 10\n',
  );
  git(singleTree, ['mv', 'rename-src.txt', 'renamed.txt']);
  write(
    join(singleTree, 'renamed.txt'),
    lines('rename', 19) + 'rename edited\n',
  );
  write(join(singleTree, 'copied.txt'), lines('copy', 20) + 'copy extra\n');
  write(join(singleTree, 'copy-src.txt'), lines('copy', 20) + 'copy tail\n');
  git(singleTree, ['rm', '-q', 'delete-me.txt']);
  git(singleTree, ['mv', 'bin-rename.bin', 'bin-renamed.bin']);
  write(join(singleTree, 'image.bin'), binary('j'));
  write(join(singleTree, 'new-file.txt'), lines('new', 3));
  commitAll(singleTree, 'feature work');
  const endTree = git(singleTree, ['rev-parse', 'HEAD^{tree}']);
  // Upstream moves after the clone; the next fetch picks it up, and the
  // merge base keeps it out of the committed set.
  write(join(singleSeed, 'upstream-only.txt'), 'upstream\n');
  commitAll(singleSeed, 'upstream');
  git(singleSeed, ['push', '-q', origins[SINGLE_WS], 'main']);
  const upstreamTip = git(singleSeed, ['rev-parse', 'HEAD']);
  // Uncommitted: unstaged edit and deletion, staged add and rename,
  // non-ASCII edit, and untracked text, binary, empty, nested and oversized.
  write(join(singleTree, 'uncommitted-edit.txt'), lines('uncommitted', 3));
  git(singleTree, ['rm', '-q', '--cached', 'keep.txt']);
  rmSync(join(singleTree, 'keep.txt'));
  write(join(singleTree, 'staged-new.txt'), lines('staged new', 2));
  git(singleTree, ['add', 'staged-new.txt']);
  git(singleTree, ['mv', 'staged-rename.txt', 'staged-renamed.txt']);
  write(join(singleTree, 'café.md'), 'café\ncrème\n');
  write(join(singleTree, 'untracked.txt'), lines('untracked', 3));
  write(join(singleTree, 'untracked.bin'), binary('u'));
  write(join(singleTree, 'empty-untracked.txt'), '');
  write(join(singleTree, 'dir', 'nested-untracked.txt'), 'nested\n');
  write(join(singleTree, 'big-untracked.txt'), 'x'.repeat(600_000));

  // posix-ws: names Git C-quotes, edge whitespace runGit trims, a type change
  // and a mode-only change.
  const posixSeed = join(dir, 'seeds', POSIX_WS);
  initRepo(posixSeed);
  write(join(posixSeed, 'a-mode.sh'), 'echo mode\n');
  write(join(posixSeed, 'type-change.txt'), 'type\n');
  write(join(posixSeed, 'link-target.txt'), 'target\n');
  if (POSIX) {
    write(join(posixSeed, 'q"t.txt'), lines('quote', 2));
    write(join(posixSeed, 'rename"src.txt'), lines('qrename', 6));
  }
  commitAll(posixSeed, 'base');
  const posix = originFrom(POSIX_WS, posixSeed);
  const posixTree = addWorktree(posix, POSIX_WS);
  if (POSIX) {
    git(posixTree, ['mv', 'rename"src.txt', 'renamed"dst.txt']);
    write(join(posixTree, 'b\\slash.txt'), lines('backslash', 2));
    commitAll(posixTree, 'quoted names');
    write(join(posixTree, 'q"t.txt'), lines('quote', 3));
    write(join(posixTree, ' lead.txt'), lines('lead', 2));
    write(join(posixTree, 'tab\tname.txt'), lines('tab', 2));
    write(join(posixTree, 'zz-trail.txt '), lines('trail', 2));
    write(join(posixTree, 'ctl\u0001.txt'), lines('ctl', 2));
    rmSync(join(posixTree, 'type-change.txt'));
    symlinkSync('link-target.txt', join(posixTree, 'type-change.txt'));
    chmodSync(join(posixTree, 'a-mode.sh'), 0o755);
  }

  // many-ws: more untracked files than the listing keeps, and more lines than
  // the estimate's ceiling.
  const manySeed = join(dir, 'seeds', MANY_WS);
  initRepo(manySeed);
  write(join(manySeed, 'README.md'), 'many\n');
  commitAll(manySeed, 'base');
  const many = originFrom(MANY_WS, manySeed);
  const manyTree = addWorktree(many, MANY_WS);
  for (let index = 0; index < 205; index += 1)
    write(
      join(manyTree, `u-${String(index).padStart(3, '0')}.txt`),
      lines('u', 600),
    );

  // unborn-ws: a checkout with no commit yet, a staged and a loose file.
  const unbornTree = worktreePath(UNBORN_WS);
  initRepo(unbornTree);
  write(join(unbornTree, 'staged.txt'), lines('staged', 2));
  git(unbornTree, ['add', 'staged.txt']);
  write(join(unbornTree, 'loose.txt'), lines('loose', 3));
  repos[UNBORN_WS] = unbornTree;

  // conflict-ws: a merge stopped on a conflict, beside a clean merged edit.
  const conflictSeed = join(dir, 'seeds', CONFLICT_WS);
  initRepo(conflictSeed);
  write(join(conflictSeed, 'conflict.txt'), 'base\n');
  write(join(conflictSeed, 'clean.txt'), lines('clean', 3));
  commitAll(conflictSeed, 'base');
  const conflict = originFrom(CONFLICT_WS, conflictSeed);
  const conflictTree = addWorktree(conflict, CONFLICT_WS);
  write(join(conflictTree, 'conflict.txt'), 'feature\n');
  commitAll(conflictTree, 'feature side');
  git(conflict, ['checkout', '-q', '-b', 'other']);
  write(join(conflict, 'conflict.txt'), 'other\n');
  write(join(conflict, 'clean.txt'), lines('clean', 4));
  commitAll(conflict, 'other side');
  git(conflict, ['checkout', '-q', 'main']);
  gitMayFail(conflictTree, ['merge', '-q', '--no-edit', 'other']);

  // no-origin-ws: no remote at all; a local main and a missing tracked base.
  const noOrigin = join(dir, 'clones', NO_ORIGIN_WS);
  initRepo(noOrigin);
  write(join(noOrigin, 'README.md'), 'local\n');
  commitAll(noOrigin, 'base');
  repos[NO_ORIGIN_WS] = noOrigin;
  for (const worktreeId of [WORKTREE, GONE_BASE_WORKTREE]) {
    const path = addWorktree(noOrigin, NO_ORIGIN_WS, worktreeId);
    write(join(path, `${worktreeId}.txt`), lines(worktreeId, 2));
    commitAll(path, worktreeId);
    write(join(path, 'README.md'), 'local\nedited\n');
  }

  // multi-ws: a source-backed root checkout and two member checkouts.
  const rootSeed = join(dir, 'seeds', MULTI_WS);
  initRepo(rootSeed);
  write(join(rootSeed, '.gitignore'), '/repos/\n');
  write(join(rootSeed, 'root.txt'), lines('root', 3));
  commitAll(rootSeed, 'base');
  const root = originFrom(MULTI_WS, rootSeed);
  const rootTree = addWorktree(root, MULTI_WS);
  write(join(rootTree, 'root-committed.txt'), lines('root committed', 2));
  commitAll(rootTree, 'root work');
  write(join(rootTree, 'root.txt'), lines('root', 4));
  for (const member of ['alpha', 'beta']) {
    const seed = join(dir, 'seeds', member);
    initRepo(seed);
    write(join(seed, 'shared.txt'), lines(member, 3));
    commitAll(seed, 'base');
    const clone = originFrom(member, seed);
    const path = join(rootTree, 'repos', member);
    git(clone, ['worktree', 'add', '-q', '-b', WORKTREE, path]);
    configure(path);
    write(join(path, `${member}-committed.txt`), lines(member, 2));
    commitAll(path, `${member} work`);
    write(join(path, 'shared.txt'), lines(member, 5));
    write(join(path, `${member}-untracked.txt`), lines(member, 1));
  }
  // A directory under repos/ that is not a checkout: Git there reads the root.
  write(join(rootTree, 'repos', 'notes', 'note.txt'), 'note\n');

  writeJson(join(dataDir, 'workspaces', 'index.json'), {
    version: 1,
    workspaces: [
      ...[
        SINGLE_WS,
        POSIX_WS,
        MANY_WS,
        UNBORN_WS,
        CONFLICT_WS,
        NO_ORIGIN_WS,
        PENDING_WS,
      ].map((id, order) => workspaceEntry(id, 'single-repo', order)),
      workspaceEntry(MULTI_WS, 'multi-repo', 20),
    ],
  });
  const worktreeRecord = (
    id: string,
    extra: Record<string, unknown> = {},
  ): object => ({
    id,
    branchName: id,
    createdAt: '2026-10-31T00:00:00.000Z',
    ...extra,
  });
  for (const [id, repoPath] of [
    [SINGLE_WS, single],
    [POSIX_WS, posix],
    [MANY_WS, many],
    [UNBORN_WS, unbornTree],
    [CONFLICT_WS, conflict],
    [NO_ORIGIN_WS, noOrigin],
    [PENDING_WS, single],
  ] as const) {
    writeJson(join(workspaceDir(id), 'workspace.json'), {
      version: 1,
      type: 'single-repo',
      repoPath,
      repos: [],
    });
  }
  for (const id of [SINGLE_WS, POSIX_WS, MANY_WS, UNBORN_WS, CONFLICT_WS])
    writeJson(join(workspaceDir(id), 'worktrees.json'), {
      version: 1,
      worktrees: [worktreeRecord(WORKTREE)],
    });
  writeJson(join(workspaceDir(NO_ORIGIN_WS), 'worktrees.json'), {
    version: 1,
    worktrees: [
      worktreeRecord(WORKTREE),
      worktreeRecord(GONE_BASE_WORKTREE, { trackedBaseBranch: 'gone' }),
    ],
  });
  writeJson(join(workspaceDir(PENDING_WS), 'worktrees.json'), {
    version: 1,
    worktrees: [
      worktreeRecord(PENDING_WORKTREE, { setupPhase: 'git-pending' }),
    ],
  });
  writeJson(join(workspaceDir(MULTI_WS), 'workspace.json'), {
    version: 1,
    type: 'multi-repo',
    sourceRepoPath: root,
    repos: [
      { id: 'alpha', name: 'Alpha', repoPath: repos.alpha },
      { id: 'beta', name: 'Beta', repoPath: repos.beta },
    ],
  });
  writeJson(join(workspaceDir(MULTI_WS), 'worktrees.json'), {
    version: 1,
    worktrees: [worktreeRecord(WORKTREE)],
  });
  // The sidebar read registers workspace types in the running app.
  registerWorkspaceTypes(
    new Map([
      ...[
        SINGLE_WS,
        POSIX_WS,
        MANY_WS,
        UNBORN_WS,
        CONFLICT_WS,
        NO_ORIGIN_WS,
        PENDING_WS,
      ].map((id): [string, WorkspaceType] => [id, 'single-repo']),
      [MULTI_WS, 'multi-repo'],
    ]),
  );

  return {
    dir,
    dataDir,
    repos,
    origins,
    turn: { startTree, endTree, startCommit },
    upstreamTip,
    worktreePath,
    scrub: (value) => value.split(dir).join('<root>'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Child-process errors come from another Jest realm: read their fields. */
export function describeError(
  error: unknown,
  scrub: (value: string) => string,
): Record<string, unknown> {
  if (typeof error !== 'object' || error === null)
    return { thrown: String(error) };
  return {
    name: String(Reflect.get(error, 'name')),
    message: scrub(String(Reflect.get(error, 'message')))
      .replace(/^Command failed: \S+/, 'Command failed: <git>')
      .replace(/[0-9a-f]{40}/g, '<sha>'),
  };
}

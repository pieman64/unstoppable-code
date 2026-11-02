import { execFile, execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  GIT_CHANGE_SET_MAX_UNTRACKED_FILES,
  gitChangeSetReadArgs,
  gitChangeSetStatus,
  parseGitNameStatusZ,
  parseGitNumstatZ,
  parseGitUnmergedZ,
  sampleGitChangeSet,
  toWorkerGitChangedFiles,
  type GitChangeSetRange,
  type GitChangeSetRead,
  type GitChangeSetReader,
} from '../change-set';

jest.setTimeout(60_000);

const POSIX = process.platform !== 'win32';
const posixIt = POSIX ? it : it.skip;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'change-set-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function write(repo: string, path: string, content: string | Buffer): void {
  mkdirSync(join(repo, path, '..'), { recursive: true });
  writeFileSync(join(repo, path), content);
}

const lines = (prefix: string, count: number): string =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join('');

function binary(seed: string): Buffer {
  const buffer = Buffer.alloc(64, seed);
  buffer[3] = 0;
  return buffer;
}

let repoCount = 0;
function repository(): string {
  repoCount += 1;
  const repo = join(root, `repo-${repoCount}`);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'golden@example.com');
  git(repo, 'config', 'user.name', 'Golden');
  git(repo, 'config', 'commit.gpgsign', 'false');
  return repo;
}

function commitAll(repo: string): string {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'commit');
  return git(repo, 'rev-parse', 'HEAD').trim();
}

/** Real Git reads, with a count of the estimates the engine asked for. */
function reader(repo: string): GitChangeSetReader & {
  reads: GitChangeSetRead[];
} {
  const reads: GitChangeSetRead[] = [];
  return {
    reads,
    read: (read) => {
      reads.push(read);
      return new Promise((resolve, reject) => {
        execFile(
          'git',
          gitChangeSetReadArgs(read),
          { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
          (error: Error | null, stdout: string) =>
            error ? reject(error) : resolve(stdout),
        );
      });
    },
    estimateUntracked: (paths) =>
      Promise.resolve(paths.map(() => ({ insertions: 1, binary: false }))),
  };
}

async function changedFiles(
  repo: string,
  range: GitChangeSetRange,
): ReturnType<typeof toWorkerGitChangedFiles> {
  const host = reader(repo);
  return toWorkerGitChangedFiles(host, await sampleGitChangeSet(host, range));
}

const WORKTREE: GitChangeSetRange = { kind: 'worktree', base: 'HEAD' };

describe('change-set parsing', () => {
  it('reads -z name-status records with rename and copy pairs', () => {
    expect(
      parseGitNameStatusZ('M\0a\tb.txt\0R087\0old\0new\0C100\0x\0y\0D\0z\0'),
    ).toEqual([
      { code: 'M', path: 'a\tb.txt' },
      { code: 'R087', path: 'new', previousPath: 'old' },
      { code: 'C100', path: 'y', previousPath: 'x' },
      { code: 'D', path: 'z' },
    ]);
    expect(parseGitNameStatusZ('')).toEqual([]);
  });

  it('reads -z numstat records, binary counts and rename pairs', () => {
    expect(
      parseGitNumstatZ('1\t2\ta\tb.txt\0-\t-\tbin\0' + '3\t0\t\0old\0new\0'),
    ).toEqual([
      { added: '1', deleted: '2', path: 'a\tb.txt' },
      { added: '-', deleted: '-', path: 'bin' },
      { added: '3', deleted: '0', path: 'new', previousPath: 'old' },
    ]);
  });

  it('reads unmerged entries', () => {
    expect(
      parseGitUnmergedZ('100644 abc 1\tx y\x00100644 def 2\tx y\x00'),
    ).toEqual([
      { entry: '100644 abc 1', path: 'x y' },
      { entry: '100644 def 2', path: 'x y' },
    ]);
  });

  it("maps Git's status letters onto the spec's vocabulary (5)", () => {
    expect(
      ['A', 'M', 'D', 'R100', 'C075', 'T', 'U', 'X', 'B', ''].map(
        gitChangeSetStatus,
      ),
    ).toEqual([
      'added',
      'modified',
      'deleted',
      'renamed',
      'copied',
      'type_changed',
      'unmerged',
      'unknown',
      'unknown',
      'unknown',
    ]);
  });
});

describe('toWorkerGitChangedFiles', () => {
  it('counts renamed and copied lines and flags renamed binaries (1)', async () => {
    const repo = repository();
    write(repo, 'src/a.txt', lines('a', 20));
    write(repo, 'copy-src.txt', lines('c', 20));
    write(repo, 'img.bin', binary('i'));
    const base = commitAll(repo);
    git(repo, 'mv', 'src/a.txt', 'src/b.txt');
    write(repo, 'src/b.txt', lines('a', 19) + 'edited\n');
    write(repo, 'copied.txt', lines('c', 20) + 'more\n');
    write(repo, 'copy-src.txt', lines('c', 20) + 'tail\n');
    git(repo, 'mv', 'img.bin', 'img-renamed.bin');
    commitAll(repo);
    const result = await changedFiles(repo, {
      kind: 'objects',
      base,
      head: 'HEAD',
    });
    expect(result).toEqual({
      truncated: false,
      files: [
        {
          path: 'copied.txt',
          previousPath: 'copy-src.txt',
          status: 'copied',
          additions: 1,
          deletions: 0,
          patch: null,
        },
        {
          path: 'copy-src.txt',
          previousPath: null,
          status: 'modified',
          additions: 1,
          deletions: 0,
          patch: null,
        },
        {
          path: 'img-renamed.bin',
          previousPath: 'img.bin',
          status: 'renamed',
          additions: 0,
          deletions: 0,
          patch: null,
          binary: true,
        },
        {
          path: 'src/b.txt',
          previousPath: 'src/a.txt',
          status: 'renamed',
          additions: 1,
          deletions: 1,
          patch: null,
        },
      ],
    });
  });

  it('lists 200 untracked files and flags the rest as truncated (2)', async () => {
    const repo = repository();
    write(repo, 'README.md', 'x\n');
    commitAll(repo);
    const total = GIT_CHANGE_SET_MAX_UNTRACKED_FILES + 5;
    for (let index = 0; index < total; index += 1)
      write(repo, `u-${String(index).padStart(3, '0')}.txt`, 'u\n');
    const host = reader(repo);
    const estimated: string[][] = [];
    const result = await toWorkerGitChangedFiles(
      host,
      await sampleGitChangeSet(
        {
          ...host,
          estimateUntracked: (paths) => {
            estimated.push([...paths]);
            return host.estimateUntracked(paths);
          },
        },
        WORKTREE,
      ),
    );
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(GIT_CHANGE_SET_MAX_UNTRACKED_FILES);
    expect(result.files.at(-1)?.path).toBe('u-199.txt');
    expect(estimated).toEqual([result.files.map((file) => file.path)]);
  });

  it('keeps exactly 200 untracked files untruncated', async () => {
    const repo = repository();
    write(repo, 'README.md', 'x\n');
    commitAll(repo);
    for (let index = 0; index < GIT_CHANGE_SET_MAX_UNTRACKED_FILES; index += 1)
      write(repo, `u-${String(index).padStart(3, '0')}.txt`, 'u\n');
    const result = await changedFiles(repo, WORKTREE);
    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(GIT_CHANGE_SET_MAX_UNTRACKED_FILES);
  });

  posixIt(
    'reports raw paths, type changes and the uncommitted kinds (4, 5)',
    async () => {
      const repo = repository();
      write(repo, 'q"t.txt', lines('q', 2));
      write(repo, 'type.txt', 'type\n');
      write(repo, 'target.txt', 'target\n');
      write(repo, 'gone.txt', 'gone\n');
      commitAll(repo);
      write(repo, 'q"t.txt', lines('q', 3));
      rmSync(join(repo, 'type.txt'));
      symlinkSync('target.txt', join(repo, 'type.txt'));
      rmSync(join(repo, 'gone.txt'));
      write(repo, 'staged.txt', 'staged\n');
      git(repo, 'add', 'staged.txt');
      write(repo, ' lead.txt', 'lead\n');
      write(repo, 'tab\tname.txt', 'tab\n');
      write(repo, 'trail.txt ', 'trail\n');
      write(repo, 'café.md', 'café\n');
      const result = await changedFiles(repo, WORKTREE);
      expect(
        result.files.map(({ path, status, additions, deletions }) => [
          path,
          status,
          additions,
          deletions,
        ]),
      ).toEqual([
        [' lead.txt', 'untracked', 1, 0],
        ['café.md', 'untracked', 1, 0],
        ['gone.txt', 'deleted', 0, 1],
        ['q"t.txt', 'modified', 1, 0],
        ['staged.txt', 'added', 1, 0],
        ['tab\tname.txt', 'untracked', 1, 0],
        ['trail.txt ', 'untracked', 1, 0],
        ['type.txt', 'type_changed', 1, 1],
      ]);
    },
  );

  it('marks unmerged paths and keeps their counts', async () => {
    const repo = repository();
    write(repo, 'conflict.txt', 'base\n');
    commitAll(repo);
    git(repo, 'checkout', '-q', '-b', 'other');
    write(repo, 'conflict.txt', 'other\n');
    commitAll(repo);
    git(repo, 'checkout', '-q', 'main');
    write(repo, 'conflict.txt', 'main\n');
    commitAll(repo);
    try {
      git(repo, 'merge', '-q', 'other');
    } catch {
      // The conflict is the point.
    }
    const result = await changedFiles(repo, WORKTREE);
    expect(result.files).toEqual([
      expect.objectContaining({ path: 'conflict.txt', status: 'unmerged' }),
    ]);
    expect(result.files[0]?.additions).toBeGreaterThan(0);
  });

  it('skips an untracked path the diff already lists', async () => {
    const repo = repository();
    write(repo, 'README.md', 'x\n');
    commitAll(repo);
    write(repo, 'new.txt', 'new\n');
    const host = reader(repo);
    const sample = await sampleGitChangeSet(host, WORKTREE);
    const result = await toWorkerGitChangedFiles(host, {
      ...sample,
      nameStatus: { ok: true, stdout: 'A\0new.txt\0' },
      numstat: { ok: true, stdout: '4\t0\tnew.txt\0' },
    });
    expect(result.files).toEqual([
      {
        path: 'new.txt',
        previousPath: null,
        status: 'added',
        additions: 4,
        deletions: 0,
        patch: null,
      },
    ]);
  });

  it('compares committed states without untracked or unmerged reads', async () => {
    const repo = repository();
    write(repo, 'a.txt', 'a\n');
    const base = commitAll(repo);
    write(repo, 'a.txt', 'a\nb\n');
    const head = commitAll(repo);
    write(repo, 'loose.txt', 'loose\n');
    const host = reader(repo);
    const result = await toWorkerGitChangedFiles(
      host,
      await sampleGitChangeSet(host, { kind: 'objects', base, head }),
    );
    expect(result.files.map((file) => file.path)).toEqual(['a.txt']);
    expect(host.reads.map((read) => read.kind)).toEqual([
      'diff-name-status',
      'diff-numstat',
    ]);
    const trees = await changedFiles(repo, {
      kind: 'objects',
      base: git(repo, 'rev-parse', `${base}^{tree}`).trim(),
      head: git(repo, 'rev-parse', `${head}^{tree}`).trim(),
    });
    expect(trees.files).toEqual(result.files);
  });

  it('refuses an unborn HEAD as invalid state', async () => {
    const repo = repository();
    write(repo, 'staged.txt', 'staged\n');
    git(repo, 'add', 'staged.txt');
    await expect(changedFiles(repo, WORKTREE)).rejects.toMatchObject({
      payload: {
        kind: 'failed_precondition',
        code: 'worker.git.diff.invalidState',
      },
    });
  });

  it('refuses an absent object id as not found', async () => {
    const repo = repository();
    write(repo, 'a.txt', 'a\n');
    commitAll(repo);
    for (const range of [
      { kind: 'objects', base: 'f'.repeat(40), head: 'HEAD' },
      { kind: 'worktree', base: 'e'.repeat(40) },
    ] satisfies GitChangeSetRange[])
      await expect(changedFiles(repo, range)).rejects.toMatchObject({
        payload: { kind: 'not_found', code: 'worker.git.diff.notFound' },
      });
  });

  it('fails a directory that is no repository as internal', async () => {
    const directory = join(root, 'plain');
    mkdirSync(directory, { recursive: true });
    const error: unknown = await changedFiles(directory, WORKTREE).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CanopyOperationError);
    expect(error).toMatchObject({ payload: { kind: 'internal' } });
  });
});

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  WORKER_GIT_DIFF_MAX_PATCH_LENGTH,
  type WorkerGitDiffFile,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import {
  gitChangeSetReadArgs,
  sampleGitChangeSet,
  toWorkerGitChangedFiles,
  type GitChangeSetRange,
  type GitChangeSetReader,
} from '../change-set';
import {
  GIT_CHANGE_SET_MAX_PATCHES,
  gitPatchReadArgs,
  gitQuotedPatchName,
  selectFilePatch,
  untrackedFilePatch,
  withGitPatches,
  type GitPatchRead,
  type GitPatchReader,
  type GitUntrackedContent,
} from '../change-set-patch';

jest.setTimeout(60_000);

const POSIX = process.platform !== 'win32';
const posixIt = POSIX ? it : it.skip;

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'change-set-patch-'));
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

function changeSetReader(repo: string): GitChangeSetReader {
  return {
    read: (read) =>
      new Promise((resolve, reject) => {
        execFile(
          'git',
          gitChangeSetReadArgs(read),
          { cwd: repo, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
          (error: Error | null, stdout: string) =>
            error ? reject(error) : resolve(stdout),
        );
      }),
    estimateUntracked: (paths) =>
      Promise.resolve(paths.map(() => ({ insertions: 1, binary: false }))),
  };
}

/** Real Git patch reads and plain untracked reads, recording each. */
function patchReader(repo: string): GitPatchReader & {
  patchReads: GitPatchRead[];
  untrackedReads: string[];
} {
  const patchReads: GitPatchRead[] = [];
  const untrackedReads: string[] = [];
  return {
    patchReads,
    untrackedReads,
    readPatch: (read, maxBytes) => {
      patchReads.push(read);
      return new Promise((resolve, reject) => {
        execFile(
          'git',
          gitPatchReadArgs(read),
          { cwd: repo, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 },
          (error: Error | null, stdout: Buffer) =>
            error
              ? reject(error)
              : resolve({
                  data: stdout.subarray(0, maxBytes),
                  truncated: stdout.byteLength > maxBytes,
                }),
        );
      });
    },
    readUntracked: (path, maxBytes) => {
      untrackedReads.push(path);
      const full = join(repo, path);
      const entry = lstatSync(full);
      if (entry.isSymbolicLink())
        return Promise.resolve({ kind: 'symlink', target: readlinkSync(full) });
      const data = readFileSync(full);
      return Promise.resolve({
        kind: 'file',
        // eslint-disable-next-line no-bitwise
        executable: POSIX && (entry.mode & 0o100) !== 0,
        data: data.subarray(0, maxBytes),
        size: data.byteLength,
      });
    },
  };
}

const WORKTREE: GitChangeSetRange = { kind: 'worktree', base: 'HEAD' };

async function patched(
  repo: string,
  range: GitChangeSetRange,
  paths: readonly string[],
  reader: GitPatchReader = patchReader(repo),
  budget = 8 * 1024 * 1024,
): ReturnType<typeof withGitPatches> {
  const host = changeSetReader(repo);
  const listed = await toWorkerGitChangedFiles(
    host,
    await sampleGitChangeSet(host, range),
  );
  return withGitPatches(reader, range, listed, paths, budget);
}

/** What Git prints for an untracked path, without its `index` line. */
function gitNoIndexPatch(repo: string, path: string): string {
  const result = spawnSync(
    'git',
    [
      'diff',
      '--no-index',
      '--no-color',
      '--no-ext-diff',
      '--',
      '/dev/null',
      path,
    ],
    { cwd: repo, encoding: 'utf8' },
  );
  expect(result.status).toBe(1);
  return result.stdout.replace(/^index [0-9a-f]+\.\.[0-9a-f]+\n/m, '');
}

describe('patch reads', () => {
  it('limit a read to its paths, literally, with no external diff', () => {
    const pinned = [
      '--patch',
      '--no-color',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--find-renames',
      '--find-copies',
      '--',
    ];
    expect(
      gitPatchReadArgs({ range: WORKTREE, paths: ['a', 'b *.ts'] }),
    ).toEqual([
      '-c',
      'core.quotePath=true',
      '--no-optional-locks',
      '--literal-pathspecs',
      'diff',
      'HEAD',
      ...pinned,
      'a',
      'b *.ts',
    ]);
    expect(
      gitPatchReadArgs({
        range: { kind: 'objects', base: 'a'.repeat(40), head: 'HEAD' },
        paths: ['-x'],
      }),
    ).toEqual([
      '-c',
      'core.quotePath=true',
      '--literal-pathspecs',
      'diff',
      `${'a'.repeat(40)}..HEAD`,
      ...pinned,
      '-x',
    ]);
  });

  it('quote header names as Git does by default', () => {
    expect(gitQuotedPatchName('a/plain name.txt')).toBe('a/plain name.txt');
    expect(gitQuotedPatchName('a/tab\there')).toBe('"a/tab\\there"');
    expect(gitQuotedPatchName('a/q"\\')).toBe('"a/q\\"\\\\"');
    expect(gitQuotedPatchName('a/café')).toBe('"a/caf\\303\\251"');
    expect(gitQuotedPatchName('a/\x01\x7f')).toBe('"a/\\001\\177"');
  });

  it('keep the paired section of a copy whose source also changed', () => {
    const copy =
      'diff --git a/f.txt b/copy.txt\nsimilarity index 50%\ncopy from f.txt\ncopy to copy.txt\n--- a/f.txt\n+++ b/copy.txt\n@@ -1 +1 @@\n-b\n+c\n';
    const source =
      'diff --git a/f.txt b/f.txt\n--- a/f.txt\n+++ b/f.txt\n@@ -1 +1 @@\n-b\n+c\n';
    expect(selectFilePatch(copy + source, 'copy.txt', 'f.txt')).toBe(copy);
    expect(selectFilePatch(source + copy, 'copy.txt', 'f.txt')).toBe(copy);
    // A type change prints two sections for one path; both are kept.
    expect(selectFilePatch(source + source, 'f.txt', null)).toBe(
      source + source,
    );
    // A body line that merely reads like a header is content.
    const tricky = `${source.slice(0, -1)}\n+copy from f.txt\n`;
    expect(selectFilePatch(tricky + copy, 'copy.txt', 'f.txt')).toBe(copy);
  });

  it('keep only the section pairing the source with this destination', () => {
    // Another destination of the same source is paired too; it is dropped.
    const sibling =
      'diff --git a/src.txt b/moved.txt\nsimilarity index 100%\nrename from src.txt\nrename to moved.txt\n';
    const copy =
      'diff --git a/src.txt b/copy.txt\nsimilarity index 100%\ncopy from src.txt\ncopy to copy.txt\n';
    expect(selectFilePatch(copy + sibling, 'copy.txt', 'src.txt')).toBe(copy);
    expect(selectFilePatch(copy + sibling, 'moved.txt', 'src.txt')).toBe(
      sibling,
    );
    // Quoted names are matched as Git prints them.
    const quoted =
      'diff --git "a/caf\\303\\251" "b/caf\\303\\251 2"\nrename from "caf\\303\\251"\nrename to "caf\\303\\251 2"\n';
    expect(selectFilePatch(quoted, 'café 2', 'café')).toBe(quoted);
    // Unpaired, the destination's own new-file section is kept.
    const added = 'diff --git a/copy.txt b/copy.txt\nnew file mode 100644\n';
    const deleted =
      'diff --git a/src.txt b/src.txt\ndeleted file mode 100644\n';
    expect(selectFilePatch(deleted + added, 'copy.txt', 'src.txt')).toBe(added);
  });
});

describe('untracked patches', () => {
  const file = (
    text: string | Buffer,
    executable = false,
  ): GitUntrackedContent => {
    const data = typeof text === 'string' ? Buffer.from(text) : text;
    return { kind: 'file', executable, data, size: data.byteLength };
  };

  it('build Git’s new-file patch', () => {
    expect(untrackedFilePatch('n.txt', file('one\ntwo\n'), 100)).toEqual({
      patch:
        'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n',
      truncated: false,
    });
    expect(untrackedFilePatch('n.txt', file('one'), 100)).toEqual({
      patch:
        'diff --git a/n.txt b/n.txt\nnew file mode 100644\n--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1 @@\n+one\n\\ No newline at end of file\n',
      truncated: false,
    });
    expect(untrackedFilePatch('e', file(''), 100)).toEqual({
      patch: 'diff --git a/e b/e\nnew file mode 100644\n',
      truncated: false,
    });
    expect(
      untrackedFilePatch('l', { kind: 'symlink', target: 'n.txt' }, 100),
    ).toEqual({
      patch:
        'diff --git a/l b/l\nnew file mode 120000\n--- /dev/null\n+++ b/l\n@@ -0,0 +1 @@\n+n.txt\n\\ No newline at end of file\n',
      truncated: false,
    });
    const executable = untrackedFilePatch('x', file('#!\n', true), 100);
    expect(executable === 'binary' ? executable : executable.patch).toContain(
      'new file mode 100755\n',
    );
  });

  it('refuse binary content and mark a cut file', () => {
    expect(untrackedFilePatch('b', file(Buffer.from('a\0b')), 100)).toBe(
      'binary',
    );
    const cut: GitUntrackedContent = {
      kind: 'file',
      executable: false,
      data: Buffer.from('é'),
      size: 10,
    };
    // The cut leaves half a character; it is dropped, not mangled.
    expect(untrackedFilePatch('c', cut, 1)).toEqual({
      patch: 'diff --git a/c b/c\nnew file mode 100644\n',
      truncated: true,
    });
  });

  posixIt('match git diff --no-index byte for byte', () => {
    const repo = repository();
    write(repo, 'tracked.txt', 'x\n');
    commitAll(repo);
    const cases: Array<[string, string | Buffer]> = [
      ['lines.txt', 'one\ntwo\n'],
      ['no-newline.txt', 'one\ntwo'],
      ['empty.txt', ''],
      ['crlf.txt', 'a\r\nb\r\n'],
      ['blank-lines.txt', '\n\n\n'],
      ['café space.md', 'é\n'],
      ['tab\tname.txt', 'tab\n'],
      ['quote"name.txt', 'q\n'],
    ];
    for (const [path, content] of cases) write(repo, path, content);
    write(repo, 'run.sh', '#!/bin/sh\n');
    chmodSync(join(repo, 'run.sh'), 0o755);
    symlinkSync('tracked.txt', join(repo, 'link'));
    for (const path of [...cases.map(([path]) => path), 'run.sh', 'link']) {
      const full = join(repo, path);
      const entry = lstatSync(full);
      const content: GitUntrackedContent = entry.isSymbolicLink()
        ? { kind: 'symlink', target: readlinkSync(full) }
        : file(
            readFileSync(full),
            // eslint-disable-next-line no-bitwise
            (entry.mode & 0o100) !== 0,
          );
      const built = untrackedFilePatch(path, content, 1_000);
      expect(built).not.toBe('binary');
      if (built === 'binary') continue;
      expect([path, built.patch]).toEqual([path, gitNoIndexPatch(repo, path)]);
    }
  });
});

describe('withGitPatches', () => {
  it('patches the files named by path or previous path', async () => {
    const repo = repository();
    write(repo, 'old.txt', 'a\nb\nc\nd\ne\n');
    write(repo, 'edit.txt', 'one\n');
    write(repo, 'keep.txt', 'k\n');
    commitAll(repo);
    git(repo, 'mv', 'old.txt', 'new.txt');
    write(repo, 'edit.txt', 'two\n');
    write(repo, 'untracked.txt', 'u\n');
    const reader = patchReader(repo);
    const result = await patched(
      repo,
      WORKTREE,
      ['old.txt', 'edit.txt', 'untracked.txt', 'keep.txt', 'absent.txt'],
      reader,
    );
    expect(result.truncated).toBe(false);
    expect(result.files.map((entry) => [entry.path, entry.status])).toEqual([
      ['edit.txt', 'modified'],
      ['new.txt', 'renamed'],
      ['untracked.txt', 'untracked'],
    ]);
    const [edit, renamed, untracked] = result.files;
    expect(edit?.patch).toBe(
      git(repo, 'diff', 'HEAD', '--no-color', '--', 'edit.txt'),
    );
    expect(renamed?.patch).toContain(
      'rename from old.txt\nrename to new.txt\n',
    );
    expect(untracked?.patch).toContain(
      '+++ b/untracked.txt\n@@ -0,0 +1 @@\n+u\n',
    );
    expect(reader.untrackedReads).toEqual(['untracked.txt']);
    expect(reader.patchReads).toEqual([
      { range: WORKTREE, paths: ['edit.txt'] },
      { range: WORKTREE, paths: ['old.txt', 'new.txt'] },
    ]);
  });

  // CAN-4103 improver: a copy read with only its source let Git pair them as
  // a rename, so the copy's patch said `rename from`.
  it('pairs a copy and a rename of one source as the listing does', async () => {
    const repo = repository();
    write(repo, 'src.txt', lines('line', 40));
    commitAll(repo);
    git(repo, 'mv', 'src.txt', 'moved.txt');
    write(repo, 'copy.txt', lines('line', 40));
    git(repo, 'add', '-A');
    const reader = patchReader(repo);
    const result = await patched(
      repo,
      WORKTREE,
      ['copy.txt', 'moved.txt'],
      reader,
    );
    const byPath = new Map(result.files.map((entry) => [entry.path, entry]));
    expect(byPath.get('copy.txt')).toMatchObject({
      previousPath: 'src.txt',
      status: 'copied',
      patch:
        'diff --git a/src.txt b/copy.txt\nsimilarity index 100%\ncopy from src.txt\ncopy to copy.txt\n',
    });
    expect(byPath.get('moved.txt')).toMatchObject({
      previousPath: 'src.txt',
      status: 'renamed',
      patch:
        'diff --git a/src.txt b/moved.txt\nsimilarity index 100%\nrename from src.txt\nrename to moved.txt\n',
    });
    expect(reader.patchReads.map((read) => read.paths)).toEqual([
      ['src.txt', 'copy.txt', 'moved.txt'],
      ['src.txt', 'copy.txt', 'moved.txt'],
    ]);
  });

  it('finds a section whatever the user sets for prefixes and quoting', async () => {
    const repo = repository();
    write(repo, 'café.txt', lines('c', 20));
    commitAll(repo);
    git(repo, 'mv', 'café.txt', 'café 2.txt');
    write(repo, 'café 2.txt', `${lines('c', 20)}tail\n`);
    write(repo, 'new é.txt', 'n\n');
    git(repo, 'config', 'diff.noprefix', 'true');
    git(repo, 'config', 'diff.mnemonicPrefix', 'true');
    git(repo, 'config', 'core.quotePath', 'false');
    const result = await patched(repo, WORKTREE, ['café.txt', 'new é.txt']);
    const [renamed, untracked] = result.files;
    expect(renamed).toMatchObject({ path: 'café 2.txt', status: 'renamed' });
    expect(renamed?.patch).toMatch(
      /^diff --git "a\/caf\\303\\251\.txt" "b\/caf\\303\\251 2\.txt"\n/,
    );
    expect(renamed?.patch).toContain('+tail\n');
    // The untracked file's built header uses the same pinned form.
    expect(untracked?.patch).toMatch(
      /^diff --git "a\/new \\303\\251\.txt" "b\/new \\303\\251\.txt"\n/,
    );
  });

  /** `glob` names a changed file and, read as a glob, matches f.txt too. */
  async function expectCommittedCopyAndLiteral(glob: string): Promise<void> {
    const repo = repository();
    write(repo, 'f.txt', lines('f', 20));
    write(repo, glob, 'glob\n');
    const base = commitAll(repo);
    write(repo, 'f.txt', `${lines('f', 20)}tail\n`);
    write(repo, 'copy.txt', `${lines('f', 20)}tail\n`);
    write(repo, glob, 'glob 2\n');
    commitAll(repo);
    const range: GitChangeSetRange = { kind: 'objects', base, head: 'HEAD' };
    const result = await patched(repo, range, ['copy.txt', glob]);
    const byPath = new Map(result.files.map((entry) => [entry.path, entry]));
    expect(byPath.get('copy.txt')?.status).toBe('copied');
    const copyPatch = byPath.get('copy.txt')?.patch ?? '';
    expect(copyPatch.match(/^diff --git /gm)).toHaveLength(1);
    expect(copyPatch).toContain('copy from f.txt\ncopy to copy.txt\n');
    // Read as a glob, the pathspec would add f.txt's section.
    const globPatch = byPath.get(glob)?.patch ?? '';
    expect(globPatch.match(/^diff --git .*$/gm)).toEqual([
      `diff --git a/${glob} b/${glob}`,
    ]);
    expect(globPatch).toContain('+glob 2\n');
    // f.txt is named only as a copy source; its own change is not listed.
    expect(byPath.has('f.txt')).toBe(false);
  }

  it('reads a committed copy as its own section and a pathspec literally', () =>
    expectCommittedCopyAndLiteral('[f].txt'));

  // Windows cannot name a file `*`.
  posixIt('reads a pathspec holding `*` literally', () =>
    expectCommittedCopyAndLiteral('*.txt'),
  );

  it('keeps binary files unpatched and marks binary patch output', async () => {
    const repo = repository();
    write(repo, 'bin.dat', Buffer.from([1, 0, 2]));
    commitAll(repo);
    write(repo, 'bin.dat', Buffer.from([3, 0, 4]));
    // Past the listing's 512,000-byte estimate, so only the patch read sees
    // the NUL Git's own 8,000-byte test finds.
    const big = Buffer.alloc(600_000, 97);
    big[10] = 0;
    write(repo, 'big.bin', big);
    const reader = patchReader(repo);
    const result = await patched(
      repo,
      WORKTREE,
      ['bin.dat', 'big.bin'],
      reader,
    );
    expect(result.files).toEqual([
      expect.objectContaining({ path: 'big.bin', patch: null, binary: true }),
      expect.objectContaining({ path: 'bin.dat', patch: null, binary: true }),
    ]);
    expect(reader.patchReads).toEqual([]);
  });

  it('patches at most 20 files and marks the rest truncated', async () => {
    const repo = repository();
    for (let index = 0; index < 22; index += 1)
      write(repo, `f${String(index).padStart(2, '0')}.txt`, 'a\n');
    commitAll(repo);
    const paths: string[] = [];
    for (let index = 0; index < 22; index += 1) {
      const path = `f${String(index).padStart(2, '0')}.txt`;
      write(repo, path, 'b\n');
      paths.push(path);
    }
    const result = await patched(repo, WORKTREE, paths);
    expect(result.truncated).toBe(true);
    expect(result.files).toHaveLength(22);
    expect(result.files.filter((entry) => entry.patch !== null)).toHaveLength(
      GIT_CHANGE_SET_MAX_PATCHES,
    );
    expect(result.files.slice(20).map((entry) => entry.patch)).toEqual([
      null,
      null,
    ]);
  });

  it('cuts a long patch, then refuses patches past the budget', async () => {
    const file: WorkerGitDiffFile = {
      path: 'a.txt',
      previousPath: null,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: null,
    };
    const huge = Buffer.alloc(WORKER_GIT_DIFF_MAX_PATCH_LENGTH + 10, 97);
    const reader: GitPatchReader = {
      readPatch: (_read, maxBytes) =>
        Promise.resolve({
          data: huge.subarray(0, maxBytes),
          truncated: huge.byteLength > maxBytes,
        }),
      readUntracked: () => Promise.resolve(null),
    };
    const one = await withGitPatches(
      reader,
      WORKTREE,
      { files: [file], truncated: false },
      ['a.txt'],
      Number.MAX_SAFE_INTEGER,
    );
    expect(one.truncated).toBe(true);
    expect(one.files[0]?.patch).toHaveLength(WORKER_GIT_DIFF_MAX_PATCH_LENGTH);
    let refused: unknown;
    try {
      await withGitPatches(
        reader,
        WORKTREE,
        { files: [file, { ...file, path: 'b.txt' }], truncated: false },
        ['a.txt', 'b.txt'],
        // One patch's JSON string fits; the second passes the budget.
        WORKER_GIT_DIFF_MAX_PATCH_LENGTH + 2,
      );
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(CanopyOperationError);
    expect(
      refused instanceof CanopyOperationError ? refused.payload.kind : null,
    ).toBe('resource_exhausted');
  });

  // CAN-4103 improver: the budget counted characters, so multi-byte patches
  // passed the frame without stopping the reads.
  it('counts the budget in bytes of JSON text, not characters', async () => {
    const wide = Buffer.from('é'.repeat(3_000_000));
    const reads: string[] = [];
    const reader: GitPatchReader = {
      readPatch: (read) => {
        reads.push(read.paths.join());
        return Promise.resolve({ data: wide, truncated: false });
      },
      readUntracked: () => Promise.resolve(null),
    };
    const file = (path: string): WorkerGitDiffFile => ({
      path,
      previousPath: null,
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: null,
    });
    let refused: unknown;
    try {
      await withGitPatches(
        reader,
        WORKTREE,
        { files: [file('a'), file('b'), file('c')], truncated: false },
        ['a', 'b', 'c'],
        8 * 1024 * 1024,
      );
    } catch (error) {
      refused = error;
    }
    expect(
      refused instanceof CanopyOperationError ? refused.payload.kind : null,
    ).toBe('resource_exhausted');
    // 6,000,002 bytes each: the second passes the budget, so c is never read.
    expect(reads).toEqual(['a', 'b']);
  });

  it('fails a patch read Git rejects as internal', async () => {
    const failure = new Error('fatal');
    const reader: GitPatchReader = {
      readPatch: () => Promise.reject(failure),
      readUntracked: () => Promise.resolve(null),
    };
    let refused: unknown;
    try {
      await withGitPatches(
        reader,
        WORKTREE,
        {
          files: [
            {
              path: 'a',
              previousPath: null,
              status: 'modified',
              additions: 0,
              deletions: 0,
              patch: null,
            },
          ],
          truncated: false,
        },
        ['a'],
        100,
      );
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(CanopyOperationError);
    if (refused instanceof CanopyOperationError) {
      expect(refused.payload.kind).toBe('internal');
      expect(refused.runtimeCause).toBe(failure);
    }
  });

  it('keeps an untracked path the reader cannot read unpatched', async () => {
    const result = await withGitPatches(
      {
        readPatch: () => Promise.reject(new Error('unused')),
        readUntracked: () => Promise.resolve(null),
      },
      WORKTREE,
      {
        files: [
          {
            path: 'nested/',
            previousPath: null,
            status: 'untracked',
            additions: 0,
            deletions: 0,
            patch: null,
          },
        ],
        truncated: false,
      },
      ['nested/'],
      100,
    );
    expect(result).toEqual({
      truncated: false,
      files: [expect.objectContaining({ path: 'nested/', patch: null })],
    });
  });
});

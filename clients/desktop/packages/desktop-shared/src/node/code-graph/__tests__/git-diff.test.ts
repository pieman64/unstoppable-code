import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  getDiffRanges,
  getMergeBase,
  isSafeGitRef,
  readFileAtRef,
} from '../git/diff';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
  }).trim();
}

function commitAll(root: string, message: string): string {
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '--quiet',
    '-m',
    message,
  ]);
  return git(root, ['rev-parse', 'HEAD']);
}

describe('code-graph git diff module', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'code-graph-git-diff-'));
    git(root, ['init', '--quiet']);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe('isSafeGitRef', () => {
    it('accepts plain branch and sha-like refs', () => {
      expect(isSafeGitRef('main')).toBe(true);
      expect(isSafeGitRef('origin/main')).toBe(true);
      expect(isSafeGitRef('HEAD~1')).toBe(true);
      expect(isSafeGitRef('abc123')).toBe(true);
      expect(isSafeGitRef('v1.2.3')).toBe(true);
      expect(isSafeGitRef('feature/foo-bar_baz')).toBe(true);
      expect(isSafeGitRef('HEAD^')).toBe(true);
    });

    it('rejects option-injection-shaped refs', () => {
      expect(isSafeGitRef('--upload-pack=x')).toBe(false);
    });

    it('rejects refs containing shell metacharacters', () => {
      expect(isSafeGitRef('$(cmd)')).toBe(false);
      expect(isSafeGitRef('`cmd`')).toBe(false);
      expect(isSafeGitRef('main; rm -rf /')).toBe(false);
    });

    it('rejects refs longer than 128 characters', () => {
      expect(isSafeGitRef('a'.repeat(200))).toBe(false);
    });

    it('rejects the empty string', () => {
      expect(isSafeGitRef('')).toBe(false);
    });
  });

  describe('getDiffRanges', () => {
    it('returns [] for an empty diff', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      const baseRef = commitAll(root, 'base');
      const ranges = await getDiffRanges(root, baseRef);
      expect(ranges).toEqual([]);
    });

    it('reports modified, added, and deleted files with after-side ranges', async () => {
      writeFileSync(
        path.join(root, 'modified.ts'),
        'line1\nline2\nline3\nline4\nline5\n',
      );
      writeFileSync(path.join(root, 'deleted.ts'), 'gone1\ngone2\n');
      const baseRef = commitAll(root, 'base');

      writeFileSync(
        path.join(root, 'modified.ts'),
        'line1\nCHANGED\nline3\nline4\nline5\n',
      );
      writeFileSync(path.join(root, 'added.ts'), 'new content\n');
      // `git diff <ref>` (no `--cached`) diffs the given tree against the
      // working tree, but only for paths git already knows about — a wholly
      // untracked new file is invisible to it until staged (`git add`),
      // committed, or added with `--intent-to-add`.
      git(root, ['add', 'added.ts']);
      rmSync(path.join(root, 'deleted.ts'));

      const result = await getDiffRanges(root, baseRef);
      const byPath = new Map(
        result.map((entry) => [entry.relativePath, entry]),
      );

      const modified = byPath.get('modified.ts');
      expect(modified).toBeDefined();
      expect(modified?.status).toBe('modified');
      expect(modified?.ranges).toEqual([{ start: 2, end: 2 }]);

      const added = byPath.get('added.ts');
      expect(added).toBeDefined();
      expect(added?.status).toBe('added');
      expect(added?.ranges).toEqual([{ start: 1, end: 1 }]);

      const deleted = byPath.get('deleted.ts');
      expect(deleted).toBeDefined();
      expect(deleted?.status).toBe('deleted');
    });

    it('maps a pure-deletion hunk to the single after-side insertion point', async () => {
      writeFileSync(
        path.join(root, 'shrink.ts'),
        'keep1\nremoveA\nremoveB\nkeep2\n',
      );
      const baseRef = commitAll(root, 'base');

      writeFileSync(path.join(root, 'shrink.ts'), 'keep1\nkeep2\n');

      const result = await getDiffRanges(root, baseRef);
      const shrink = result.find((entry) => entry.relativePath === 'shrink.ts');
      expect(shrink).toBeDefined();
      // Deleting lines 2-3 with nothing added collapses to the after-side
      // insertion point (line 1, right after "keep1").
      expect(shrink?.ranges).toEqual([{ start: 1, end: 1 }]);
    });

    it('reports renamed files with previousPath', async () => {
      writeFileSync(path.join(root, 'old-name.ts'), 'export const x = 1;\n');
      const baseRef = commitAll(root, 'base');

      git(root, ['mv', 'old-name.ts', 'new-name.ts']);

      const result = await getDiffRanges(root, baseRef);
      const renamed = result.find(
        (entry) => entry.relativePath === 'new-name.ts',
      );
      expect(renamed).toBeDefined();
      expect(renamed?.status).toBe('renamed');
      expect(renamed?.previousPath).toBe('old-name.ts');
    });

    it('rejects an unsafe base ref', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      commitAll(root, 'base');
      await expect(getDiffRanges(root, '--upload-pack=x')).rejects.toThrow();
      await expect(getDiffRanges(root, '$(cmd)')).rejects.toThrow();
      await expect(getDiffRanges(root, 'a'.repeat(200))).rejects.toThrow();
    });

    it('keeps a modified status entry with empty ranges for a binary file', async () => {
      writeFileSync(path.join(root, '.gitattributes'), '*.bin binary\n');
      writeFileSync(
        path.join(root, 'image.bin'),
        Buffer.from([0, 1, 2, 3, 0, 255]),
      );
      const baseRef = commitAll(root, 'base');

      writeFileSync(
        path.join(root, 'image.bin'),
        Buffer.from([4, 5, 6, 7, 0, 255]),
      );

      const result = await getDiffRanges(root, baseRef);
      const binary = result.find((entry) => entry.relativePath === 'image.bin');
      expect(binary).toBeDefined();
      expect(binary?.status).toBe('modified');
      expect(binary?.ranges).toEqual([]);
    });

    it('reports a purely untracked (never-added) file as added with empty ranges', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      const baseRef = commitAll(root, 'base');

      // Never staged/committed — invisible to `git diff <ref>`, but the normal
      // agent-mid-task state that must still surface as a change.
      writeFileSync(path.join(root, 'brand-new.ts'), 'export const b = 2;\n');

      const result = await getDiffRanges(root, baseRef);
      const untracked = result.find(
        (entry) => entry.relativePath === 'brand-new.ts',
      );
      expect(untracked).toBeDefined();
      expect(untracked?.status).toBe('added');
      expect(untracked?.ranges).toEqual([]);
    });

    it('does not double-report an untracked path already covered by the tracked diff', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      const baseRef = commitAll(root, 'base');

      // Staged (now tracked) new file: reported once via --name-status, and
      // NOT a second time via ls-files --others.
      writeFileSync(path.join(root, 'staged.ts'), 'export const s = 3;\n');
      git(root, ['add', 'staged.ts']);

      const result = await getDiffRanges(root, baseRef);
      const matches = result.filter(
        (entry) => entry.relativePath === 'staged.ts',
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]?.status).toBe('added');
    });

    it('captures hunk ranges for a non-ASCII filename', async () => {
      const name = 'café.ts';
      writeFileSync(path.join(root, name), 'line1\nline2\nline3\n');
      const baseRef = commitAll(root, 'base');
      writeFileSync(path.join(root, name), 'line1\nCHANGED\nline3\n');

      const result = await getDiffRanges(root, baseRef);
      // Exactly one changed file, so index 0 is robust against NFC/NFD path
      // normalization differences on the lookup.
      expect(result).toHaveLength(1);
      // Without `-c core.quotePath=false` the quoted `diff --git "a/…"` header
      // would not match, silently dropping the ranges ([]).
      expect(result[0]?.ranges).toEqual([{ start: 2, end: 2 }]);
    });
  });

  describe('getMergeBase', () => {
    it('returns the merge base sha for a real ref', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      const baseRef = commitAll(root, 'base');
      writeFileSync(path.join(root, 'b.ts'), 'export const b = 2;\n');
      commitAll(root, 'second');

      const mergeBase = await getMergeBase(root, baseRef);
      expect(mergeBase).toBe(baseRef);
    });

    it('returns null for a nonexistent ref', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      commitAll(root, 'base');
      const mergeBase = await getMergeBase(root, 'not-a-real-ref-xyz');
      expect(mergeBase).toBeNull();
    });

    it('returns null for an unsafe ref instead of throwing', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      commitAll(root, 'base');
      const mergeBase = await getMergeBase(root, '--upload-pack=x');
      expect(mergeBase).toBeNull();
    });
  });

  describe('readFileAtRef', () => {
    it('returns file content at a given ref', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      const baseRef = commitAll(root, 'base');
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 2;\n');
      commitAll(root, 'second');

      const content = await readFileAtRef(root, baseRef, 'a.ts');
      expect(content).toBe('export const a = 1;\n');
    });

    it('returns null for a path absent at the given ref', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      const baseRef = commitAll(root, 'base');

      const content = await readFileAtRef(root, baseRef, 'does-not-exist.ts');
      expect(content).toBeNull();
    });

    it('throws for an unsafe ref', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      commitAll(root, 'base');
      await expect(
        readFileAtRef(root, '--upload-pack=x', 'a.ts'),
      ).rejects.toThrow();
    });

    it('throws for a path argument shaped like an option', async () => {
      writeFileSync(path.join(root, 'a.ts'), 'export const a = 1;\n');
      const baseRef = commitAll(root, 'base');
      await expect(
        readFileAtRef(root, baseRef, '--upload-pack=x'),
      ).rejects.toThrow();
    });
  });
});

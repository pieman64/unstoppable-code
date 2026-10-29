import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReviewDiffBundle,
  computeReviewFingerprint,
  truncateUnifiedDiff,
} from '../lib/code-review-diff';
import {
  getCombinedDiffText,
  getHeadCommitSha,
  getMergeBaseForBranch,
  listUntrackedFiles,
} from '../lib/git';

jest.mock('../lib/git', () => ({
  getCombinedDiffText: jest.fn(),
  getHeadCommitSha: jest.fn(),
  getMergeBaseForBranch: jest.fn(),
  listUntrackedFiles: jest.fn(),
}));

const mockedGetCombinedDiffText = jest.mocked(getCombinedDiffText);
const mockedGetHeadCommitSha = jest.mocked(getHeadCommitSha);
const mockedGetMergeBaseForBranch = jest.mocked(getMergeBaseForBranch);
const mockedListUntrackedFiles = jest.mocked(listUntrackedFiles);

function fileDiff(path: string, lines: number): string {
  const header = [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,1 @@',
  ];
  const body = Array.from({ length: lines }, (_, i) => `+line ${i}`);
  return [...header, ...body].join('\n');
}

describe('truncateUnifiedDiff', () => {
  it('passes small diffs through untouched', () => {
    const text = fileDiff('a.ts', 5);
    expect(truncateUnifiedDiff(text, 400, 8000)).toEqual({
      text,
      truncated: false,
    });
  });

  it('truncates a single oversized file diff and marks truncation', () => {
    const result = truncateUnifiedDiff(fileDiff('a.ts', 500), 100, 8000);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('diff --git a/a.ts b/a.ts');
    expect(result.text).toContain('[diff truncated]');
    expect(result.text.split('\n').length).toBeLessThan(120);
  });

  it('enforces the total cap across files', () => {
    const text = [fileDiff('a.ts', 90), fileDiff('b.ts', 90)].join('\n');
    const result = truncateUnifiedDiff(text, 100, 120);
    expect(result.truncated).toBe(true);
    expect(result.text).toContain('a.ts');
    expect(result.text).toContain('[remaining file diffs omitted]');
  });
});

describe('computeReviewFingerprint', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('reuses the resolved merge-base for the diff text', async () => {
    mockedGetHeadCommitSha.mockResolvedValue('head-sha');
    mockedGetMergeBaseForBranch.mockResolvedValue('merge-base-sha');
    mockedGetCombinedDiffText.mockResolvedValue('diff text');
    mockedListUntrackedFiles.mockResolvedValue([]);

    await computeReviewFingerprint([{ repoId: 'default', repoPath: '/repo' }]);

    expect(mockedGetMergeBaseForBranch).toHaveBeenCalledWith(
      '/repo',
      undefined,
    );
    expect(mockedGetCombinedDiffText).toHaveBeenCalledWith(
      '/repo',
      undefined,
      'merge-base-sha',
    );
  });

  it('uses the review repo base branch for fingerprint diffs', async () => {
    mockedGetHeadCommitSha.mockResolvedValue('head-sha');
    mockedGetMergeBaseForBranch.mockResolvedValue('merge-base-sha');
    mockedGetCombinedDiffText.mockResolvedValue('diff text');
    mockedListUntrackedFiles.mockResolvedValue([]);

    await computeReviewFingerprint([
      { repoId: 'default', repoPath: '/repo', baseBranch: 'release/2.0' },
    ]);

    expect(mockedGetMergeBaseForBranch).toHaveBeenCalledWith(
      '/repo',
      'release/2.0',
    );
    expect(mockedGetCombinedDiffText).toHaveBeenCalledWith(
      '/repo',
      'release/2.0',
      'merge-base-sha',
    );
  });
});

describe('buildReviewDiffBundle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedListUntrackedFiles.mockResolvedValue([]);
  });

  it('enforces one total diff-line budget across all repos', async () => {
    const repos = Array.from({ length: 24 }, (_, index) => ({
      repoId: `repo-${index.toString().padStart(2, '0')}`,
      repoPath: `/repo-${index}`,
    }));
    mockedGetCombinedDiffText.mockImplementation((repoPath) =>
      Promise.resolve(fileDiff(`${repoPath.slice(1)}.ts`, 380)),
    );

    const result = await buildReviewDiffBundle(repos);

    expect(result.truncated).toBe(true);
    expect(result.text).toContain('[remaining file diffs omitted]');
    expect(result.text).toContain('# Repo: repo-00 (id: repo-00)');
    expect(result.text).not.toContain('# Repo: repo-23 (id: repo-23)');
  });

  it('uses the review repo base branch for bundle diffs', async () => {
    mockedGetCombinedDiffText.mockResolvedValue(fileDiff('feature.ts', 5));

    await buildReviewDiffBundle([
      { repoId: 'default', repoPath: '/repo', baseBranch: 'release/2.0' },
    ]);

    expect(mockedGetCombinedDiffText).toHaveBeenCalledWith(
      '/repo',
      'release/2.0',
    );
  });

  it('omits untracked symlinks instead of reading their targets', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'code-review-diff-'));
    try {
      const repoPath = join(tempDir, 'repo');
      const outside = join(tempDir, 'outside-secret.txt');
      mkdirSync(repoPath);
      writeFileSync(outside, 'do not include me\n');
      symlinkSync(outside, join(repoPath, 'leak.txt'));
      mockedGetCombinedDiffText.mockResolvedValue('');
      mockedListUntrackedFiles.mockResolvedValue(['leak.txt']);

      const result = await buildReviewDiffBundle([
        { repoId: 'default', repoPath },
      ]);

      expect(result.text).not.toContain('do not include me');
      expect(result.text).not.toContain('## New file: leak.txt');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('omits oversized untracked file contents before reading them', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'code-review-diff-'));
    try {
      const repoPath = join(tempDir, 'repo');
      mkdirSync(repoPath);
      writeFileSync(join(repoPath, 'large.txt'), 'x'.repeat(300 * 1024));
      mockedGetCombinedDiffText.mockResolvedValue('');
      mockedListUntrackedFiles.mockResolvedValue(['large.txt']);

      const result = await buildReviewDiffBundle([
        { repoId: 'default', repoPath },
      ]);

      expect(result.truncated).toBe(true);
      expect(result.text).toContain(
        '## New file (too large, contents omitted): large.txt',
      );
      expect(result.text).not.toContain('x'.repeat(1000));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

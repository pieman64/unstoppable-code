import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  GitChangeSetSample,
  GitReadOutcome,
} from '@canopy/core-runtime/node/git';
import { quoteGitPath } from '../legacy-changed-files';
import {
  legacyDiffStats,
  nameStatusNeedsShortstat,
  untrackedListingNeedsQuotePath,
} from '../legacy-diff-stats';

const posixIt = process.platform === 'win32' ? it.skip : it;

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'legacy-diff-stats-'));
  execFileSync('git', ['init', '-q', repo]);
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

const NAMES = [
  'plain.txt',
  'naïve.txt',
  '日本.txt',
  'emoji-😀.txt',
  'q"t.txt',
  'b\\slash.txt',
  'tab\tname.txt',
  'ctl\u0001.txt',
  'del\u007f.txt',
  'nl\nname.txt',
];

/** A rename, which only the shortstat can count as the repository does. */
const RENAMED: Pick<GitChangeSetSample, 'nameStatus' | 'numstat'> = {
  nameStatus: { ok: true, stdout: 'R090\0old.txt\0new.txt\0' },
  numstat: { ok: true, stdout: '1\t0\t\0old.txt\0new.txt\0' },
};

function sample(
  untracked: GitReadOutcome | null,
  tracked: Pick<GitChangeSetSample, 'nameStatus' | 'numstat'> = RENAMED,
): GitChangeSetSample {
  return {
    range: { kind: 'worktree', base: 'HEAD' },
    ...tracked,
    untracked,
    unmerged: { ok: true, stdout: '' },
    untrackedEstimates: [],
  };
}

const read = (outcome: GitReadOutcome) => (): Promise<GitReadOutcome> =>
  Promise.resolve(outcome);

describe('quoteGitPath', () => {
  posixIt('quotes names as git ls-files prints them', () => {
    for (const name of NAMES) writeFileSync(join(repo, name), 'x\n');
    const listed = (quotePath: boolean): string[] =>
      execFileSync(
        'git',
        [
          '-C',
          repo,
          '-c',
          `core.quotePath=${String(quotePath)}`,
          'ls-files',
          '--others',
        ],
        { encoding: 'utf8' },
      )
        .split('\n')
        .filter(Boolean);
    const raw = execFileSync(
      'git',
      ['-C', repo, 'ls-files', '--others', '-z'],
      {
        encoding: 'utf8',
      },
    )
      .split('\0')
      .filter(Boolean);
    expect(raw.map((name) => quoteGitPath(name, true))).toEqual(listed(true));
    expect(raw.map((name) => quoteGitPath(name, false))).toEqual(listed(false));
    expect(raw.map((name) => quoteGitPath(name))).toEqual(listed(false));
  });
});

describe('untrackedListingNeedsQuotePath', () => {
  it('is true only for a listing with non-ASCII text', () => {
    expect(untrackedListingNeedsQuotePath('a.txt\0q"t\u0001.txt\0')).toBe(
      false,
    );
    expect(untrackedListingNeedsQuotePath('a.txt\0naïve.txt\0')).toBe(true);
  });
});

describe('nameStatusNeedsShortstat', () => {
  it('is true for a rename, a copy, or an add beside a delete', () => {
    for (const [stdout, needed] of [
      ['', false],
      ['M\0a\0A\0b\0T\0c\0U\0d\0', false],
      ['M\0a\0D\0b\0', false],
      ['R100\0a\0b\0', true],
      ['C075\0a\0b\0', true],
      ['A\0b\0M\0c\0D\0a\0', true],
    ] as const)
      expect({ stdout, needed: nameStatusNeedsShortstat(stdout) }).toEqual({
        stdout,
        needed,
      });
  });
});

describe('legacyDiffStats', () => {
  it('sums the numstat without reading the shortstat when no pairing can differ', async () => {
    const shortstat = jest.fn(read({ ok: true, stdout: '' }));
    expect(
      await legacyDiffStats(
        repo,
        sample(null, {
          nameStatus: { ok: true, stdout: 'M\0a\0A\0b\0M\0bin\0' },
          numstat: {
            ok: true,
            stdout: '3\t1\ta\0' + '2\t0\tb\0' + '-\t-\tbin\0',
          },
        }),
        { shortstat, quotePath: true },
      ),
    ).toEqual({ insertions: 5, deletions: 1 });
    expect(shortstat).not.toHaveBeenCalled();
  });

  it('reads the shortstat when a tracked read failed or the reads disagree', async () => {
    for (const tracked of [
      {
        nameStatus: { ok: false, error: new Error('name-status') },
        numstat: { ok: true, stdout: '' },
      },
      {
        nameStatus: { ok: true, stdout: '' },
        numstat: { ok: false, error: new Error('numstat') },
      },
      // A rename between the two reads: only numstat shows the pair.
      {
        nameStatus: { ok: true, stdout: 'M\0a\0' },
        numstat: { ok: true, stdout: '1\t0\t\0old\0new\0' },
      },
    ] as const)
      expect(
        await legacyDiffStats(repo, sample(null, tracked), {
          shortstat: read({
            ok: true,
            stdout: '1 file changed, 4 insertions(+), 2 deletions(-)',
          }),
          quotePath: true,
        }),
      ).toEqual({ insertions: 4, deletions: 2 });
  });

  it('rethrows the shortstat failure itself', async () => {
    const failure = new Error('Command failed: git diff HEAD --shortstat');
    await expect(
      legacyDiffStats(repo, sample({ ok: true, stdout: '' }), {
        shortstat: read({ ok: false, error: failure }),
        quotePath: true,
      }),
    ).rejects.toBe(failure);
  });

  it('counts only the shortstat when the listing failed or was refused', async () => {
    const shortstat: GitReadOutcome = {
      ok: true,
      stdout: '2 files changed, 3 insertions(+), 1 deletion(-)',
    };
    const listed: GitReadOutcome = { ok: true, stdout: 'missing.txt\0' };
    for (const [untracked, quotePath] of [
      [{ ok: false, error: new Error('ls-files failed') }, true],
      [listed, null],
      [null, true],
    ] as const)
      expect(
        await legacyDiffStats(repo, sample(untracked), {
          shortstat: read(shortstat),
          quotePath,
        }),
      ).toEqual({ insertions: 3, deletions: 1 });
  });

  it('reads a shortstat with no changes as zero', async () => {
    expect(
      await legacyDiffStats(repo, sample({ ok: true, stdout: '' }), {
        shortstat: read({ ok: true, stdout: '' }),
        quotePath: true,
      }),
    ).toEqual({ insertions: 0, deletions: 0 });
  });
});

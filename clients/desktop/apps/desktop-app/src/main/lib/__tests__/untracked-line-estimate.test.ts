jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return { ...actual, lstat: jest.fn(actual.lstat) };
});

import type * as FsPromises from 'node:fs/promises';
import {
  lstat,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  estimateUntrackedChanges,
  estimateUntrackedInsertions,
  MAX_UNTRACKED_FILE_BYTES,
} from '../untracked-line-estimate';

const mockedLstat = jest.mocked(lstat);
const actualLstat =
  jest.requireActual<typeof FsPromises>('node:fs/promises').lstat;

describe('estimateUntrackedInsertions', () => {
  let worktreePath: string;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockedLstat.mockImplementation(actualLstat);
    worktreePath = await mkdtemp(join(tmpdir(), 'untracked-line-estimate-'));
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it('counts small text files and skips oversized files without inventing lines', async () => {
    await writeFile(join(worktreePath, 'small.txt'), 'a\nb\nc');
    await writeFile(join(worktreePath, 'big.bin'), '');
    await truncate(
      join(worktreePath, 'big.bin'),
      MAX_UNTRACKED_FILE_BYTES + 400,
    );

    const counts = await estimateUntrackedInsertions(worktreePath, [
      'small.txt',
      'big.bin',
    ]);

    expect(counts).toEqual([3, 0]);
  });

  it('does not count binary content as text lines', async () => {
    await writeFile(
      join(worktreePath, 'small.bin'),
      Buffer.from([1, 0, 10, 2]),
    );
    await expect(
      estimateUntrackedInsertions(worktreePath, ['small.bin']),
    ).resolves.toEqual([0]);
  });

  it('does not estimate oversized text files by byte size', async () => {
    await writeFile(
      join(worktreePath, 'large.txt'),
      'x'.repeat(MAX_UNTRACKED_FILE_BYTES + 1),
    );
    await expect(
      estimateUntrackedInsertions(worktreePath, ['large.txt']),
    ).resolves.toEqual([0]);
  });

  it('caps the aggregate contribution in input order', async () => {
    await writeFile(join(worktreePath, 'first.txt'), 'x\n'.repeat(60_000));
    await writeFile(join(worktreePath, 'second.txt'), 'x\n'.repeat(60_000));
    await expect(
      estimateUntrackedInsertions(worktreePath, ['first.txt', 'second.txt']),
    ).resolves.toEqual([60_000, 40_000]);
  });

  it('treats an unreadable file as zero lines', async () => {
    await expect(
      estimateUntrackedInsertions(worktreePath, ['gone.ts']),
    ).resolves.toEqual([0]);
  });

  it('does not count trailing newline segments or an empty file as lines', async () => {
    await writeFile(join(worktreePath, 'newline.txt'), 'one line\n');
    await writeFile(join(worktreePath, 'empty.txt'), '');

    await expect(
      estimateUntrackedInsertions(worktreePath, ['newline.txt', 'empty.txt']),
    ).resolves.toEqual([1, 0]);
  });

  it('bounds concurrent filesystem work across a large untracked set', async () => {
    const files = Array.from({ length: 40 }, (_, index) => `file-${index}.txt`);
    await Promise.all(
      files.map((file) => writeFile(join(worktreePath, file), 'one line')),
    );
    let activeStats = 0;
    let peakStats = 0;
    mockedLstat.mockImplementation(async (path) => {
      activeStats += 1;
      peakStats = Math.max(peakStats, activeStats);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeStats -= 1;
      return actualLstat(path);
    });

    const counts = await estimateUntrackedInsertions(worktreePath, files);

    expect(counts).toHaveLength(40);
    expect(peakStats).toBeLessThanOrEqual(16);
  });

  it('does not follow symlinks or read non-regular files', async () => {
    await writeFile(join(worktreePath, 'target.txt'), 'must not be read');
    await symlink('target.txt', join(worktreePath, 'device-link'));

    await expect(
      estimateUntrackedInsertions(worktreePath, ['device-link']),
    ).resolves.toEqual([0]);
  });
});

describe('estimateUntrackedChanges (REG-3024)', () => {
  let worktreePath: string;

  beforeEach(async () => {
    mockedLstat.mockImplementation(actualLstat);
    worktreePath = await mkdtemp(join(tmpdir(), 'untracked-changes-'));
  });

  afterEach(async () => {
    await rm(worktreePath, { recursive: true, force: true });
  });

  it('reports a file with a NUL byte as binary with no lines, as git does', async () => {
    await writeFile(join(worktreePath, 'notes.txt'), 'a\nb\nc\n');
    await writeFile(
      join(worktreePath, 'logo.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x00, 0x0a]),
    );

    expect(
      await estimateUntrackedChanges(worktreePath, ['notes.txt', 'logo.png']),
    ).toEqual([
      { insertions: 3, binary: false },
      { insertions: 0, binary: true },
    ]);
  });

  it('preserves binary metadata while bounding text and oversized artifacts', async () => {
    await writeFile(join(worktreePath, 'first.txt'), 'x\n'.repeat(60_000));
    await writeFile(join(worktreePath, 'logo.png'), Buffer.from([1, 0, 10]));
    await writeFile(join(worktreePath, 'large.bin'), '');
    await truncate(
      join(worktreePath, 'large.bin'),
      MAX_UNTRACKED_FILE_BYTES + 1,
    );
    await writeFile(join(worktreePath, 'second.txt'), 'x\n'.repeat(60_000));

    await expect(
      estimateUntrackedChanges(worktreePath, [
        'first.txt',
        'logo.png',
        'large.bin',
        'second.txt',
      ]),
    ).resolves.toEqual([
      { insertions: 60_000, binary: false },
      { insertions: 0, binary: true },
      { insertions: 0, binary: false },
      { insertions: 40_000, binary: false },
    ]);
  });
});

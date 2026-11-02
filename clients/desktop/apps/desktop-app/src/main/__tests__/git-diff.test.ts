// Resolve the test Git independently of desktop preferences; this suite tests Git operations.
jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: (): Promise<string> =>
    Promise.resolve(process.env.CANOPY_GIT_EXECUTABLE?.trim() || 'git'),
}));

jest.mock('node:child_process', () => ({
  execFile: jest.fn(),
}));
jest.mock('node:fs/promises');

import { execFile } from 'node:child_process';
import { open, readFile, stat } from 'node:fs/promises';
import {
  getFileDiffBetweenTrees,
  getFileDiffCombined,
  getFileDiffCommitted,
  getFileDiffUncommitted,
} from '../lib/git';

const mockedExecFile = jest.mocked(execFile);
const mockedReadFile = jest.mocked(readFile);
const mockedOpen = jest.mocked(open);
const mockedStat = jest.mocked(stat);

type ExecFileCallback = (
  error: Error | null,
  result: { stdout: Buffer | string; stderr: string },
) => void;

beforeEach((): void => {
  jest.clearAllMocks();
});

/**
 * Helper: build a default mockedOpen that returns a file handle whose
 * read() finds no null bytes (i.e. a text file) and close() succeeds.
 */
function mockOpenAsText(): void {
  mockedOpen.mockResolvedValue({
    read: jest
      .fn()
      .mockImplementation((buf: Buffer): Promise<{ bytesRead: number }> => {
        // Fill buffer with non-zero bytes so isFileBinary returns false
        const count = Math.min(10, buf.length);
        for (let i = 0; i < count; i++) {
          buf[i] = 0x41; // 'A'
        }
        return Promise.resolve({ bytesRead: count });
      }),
    close: jest.fn().mockResolvedValue(undefined),
  } as never);
}

/**
 * Helper: build a mockedOpen that simulates a binary file (null byte in first 8KB).
 * We make Buffer.includes(0) return true by having bytesRead > 0 and
 * injecting a null byte into the buffer via a custom read implementation.
 */
function mockOpenAsBinary(): void {
  mockedOpen.mockResolvedValue({
    read: jest
      .fn()
      .mockImplementation((buf: Buffer): Promise<{ bytesRead: number }> => {
        buf[0] = 0; // null byte → binary
        return Promise.resolve({ bytesRead: 1 });
      }),
    close: jest.fn().mockResolvedValue(undefined),
  } as never);
}

/**
 * Helper: build a mockedOpen that fails (e.g. file doesn't exist on disk).
 */
function mockOpenFail(): void {
  mockedOpen.mockRejectedValue(new Error('ENOENT'));
}

// ---------------------------------------------------------------------------
// getFileDiffUncommitted
// ---------------------------------------------------------------------------
describe('getFileDiffUncommitted', () => {
  it('returns old and new values for a standard text file diff', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      // isFileBinary → diff HEAD --numstat -- file.ts → not binary
      if (key === 'diff HEAD --numstat -- src/file.ts') {
        cb?.(null, { stdout: '5\t2\tsrc/file.ts\n', stderr: '' });
        return;
      }
      // getFileAtRef → show HEAD:src/file.ts
      if (key === 'show HEAD:src/file.ts') {
        cb?.(null, { stdout: 'old file content\n', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockOpenAsText();
    mockedReadFile.mockResolvedValue('new file content\n');

    const result = await getFileDiffUncommitted('/repo', 'src/file.ts');

    expect(result).toEqual({
      oldValue: 'old file content\n',
      newValue: 'new file content\n',
      truncated: false,
      binary: false,
    });
  });

  it('returns empty old value for an added file', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      // isFileBinary → diff HEAD --numstat -- new-file.ts → no output (untracked)
      if (key === 'diff HEAD --numstat -- new-file.ts') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      // getFileAtRef → show HEAD:new-file.ts → fails (file didn't exist)
      if (key === 'show HEAD:new-file.ts') {
        cb?.(new Error('fatal: path does not exist'), {
          stdout: '',
          stderr: '',
        });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockOpenAsText();
    mockedReadFile.mockResolvedValue('brand new content\n');

    const result = await getFileDiffUncommitted('/repo', 'new-file.ts');

    expect(result.oldValue).toBe('');
    expect(result.newValue).toBe('brand new content\n');
    expect(result.binary).toBe(false);
  });

  it('returns empty new value for a deleted file', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      if (key === 'diff HEAD --numstat -- deleted.ts') {
        cb?.(null, { stdout: '0\t10\tdeleted.ts\n', stderr: '' });
        return;
      }
      if (key === 'show HEAD:deleted.ts') {
        cb?.(null, { stdout: 'old content here\n', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    // open fails because the file doesn't exist on disk
    mockOpenFail();
    // readFile also fails for deleted file
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await getFileDiffUncommitted('/repo', 'deleted.ts');

    expect(result.oldValue).toBe('old content here\n');
    expect(result.newValue).toBe('');
    expect(result.binary).toBe(false);
  });

  it('returns binary: true with empty values for binary files', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      // git diff --numstat reports binary as "-\t-\tfilename"
      if (key === 'diff HEAD --numstat -- image.png') {
        cb?.(null, { stdout: '-\t-\timage.png\n', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockOpenAsText();

    const result = await getFileDiffUncommitted('/repo', 'image.png');

    expect(result).toEqual({
      oldValue: '',
      newValue: '',
      truncated: false,
      binary: true,
    });
  });

  it('returns a current image preview for previewable image files', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      if (key === 'cat-file -s HEAD:assets/logo.png') {
        cb?.(new Error('added'), { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockedStat.mockResolvedValue({ size: 3 } as never);
    mockedReadFile.mockResolvedValue(Buffer.from([1, 2, 3]));

    const result = await getFileDiffUncommitted('/repo', 'assets/logo.png');

    expect(result).toEqual({
      oldValue: '',
      newValue: '',
      truncated: false,
      binary: true,
      imagePreview: {
        newDataUrl: 'data:image/png;base64,AQID',
      },
    });
  });

  it('detects binary via null-byte fallback when diff numstat is inconclusive', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      // numstat doesn't indicate binary (e.g. untracked file)
      if (key === 'diff HEAD --numstat -- data.bin') {
        cb?.(new Error('untracked'), { stdout: '', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    // Null-byte check finds binary content
    mockOpenAsBinary();

    const result = await getFileDiffUncommitted('/repo', 'data.bin');

    expect(result).toEqual({
      oldValue: '',
      newValue: '',
      truncated: false,
      binary: true,
    });
  });

  it('returns truncated: true when content exceeds the size limit', async (): Promise<void> => {
    const longContent = 'x'.repeat(500_001);

    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      if (key === 'diff HEAD --numstat -- big.ts') {
        cb?.(null, { stdout: '1\t1\tbig.ts\n', stderr: '' });
        return;
      }
      if (key === 'show HEAD:big.ts') {
        cb?.(null, { stdout: longContent, stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockOpenAsText();
    mockedReadFile.mockResolvedValue('short new\n');

    const result = await getFileDiffUncommitted('/repo', 'big.ts');

    expect(result.truncated).toBe(true);
    expect(result.oldValue.length).toBe(500_000);
    expect(result.newValue).toBe('short new\n');
    expect(result.binary).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getFileDiffCommitted
// ---------------------------------------------------------------------------
describe('getFileDiffCommitted', () => {
  /**
   * Helper: set up execFile mock for committed diff tests.
   * Handles getRemoteDefaultBranch, merge-base, isFileBinary, and show calls.
   */
  function setupCommittedMock(
    overrides: Record<string, { error?: Error; stdout: Buffer | string }> = {},
  ): void {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      // Check overrides first
      if (overrides[key]) {
        const ov = overrides[key];
        if (ov.error) {
          cb?.(ov.error, { stdout: ov.stdout, stderr: '' });
        } else {
          cb?.(null, { stdout: ov.stdout, stderr: '' });
        }
        return;
      }

      // resolveExistingBranchRef → show-ref for remote branch
      if (key === 'show-ref --verify --quiet refs/remotes/origin/main') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      // getRemoteDefaultBranch → ls-remote
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      // merge-base
      if (key === 'merge-base origin/main HEAD') {
        cb?.(null, { stdout: 'abc000\n', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);
  }

  it('returns old and new values for a standard text file diff', async (): Promise<void> => {
    setupCommittedMock({
      'diff abc000 HEAD --numstat -- src/file.ts': {
        stdout: '5\t2\tsrc/file.ts\n',
      },
      'show abc000:src/file.ts': { stdout: 'old base content\n' },
      'show HEAD:src/file.ts': { stdout: 'new head content\n' },
    });
    mockOpenAsText();

    const result = await getFileDiffCommitted('/repo', 'src/file.ts');

    expect(result).toEqual({
      oldValue: 'old base content\n',
      newValue: 'new head content\n',
      truncated: false,
      binary: false,
    });
  });

  it('returns empty old value for an added file', async (): Promise<void> => {
    setupCommittedMock({
      'diff abc000 HEAD --numstat -- added.ts': { stdout: '' },
      'show abc000:added.ts': {
        stdout: '',
        error: new Error('fatal: path does not exist'),
      },
      'show HEAD:added.ts': { stdout: 'added content\n' },
    });
    mockOpenAsText();

    const result = await getFileDiffCommitted('/repo', 'added.ts');

    expect(result.oldValue).toBe('');
    expect(result.newValue).toBe('added content\n');
    expect(result.binary).toBe(false);
  });

  it('returns empty new value for a deleted file', async (): Promise<void> => {
    setupCommittedMock({
      'diff abc000 HEAD --numstat -- removed.ts': {
        stdout: '0\t10\tremoved.ts\n',
      },
      'show abc000:removed.ts': { stdout: 'removed content\n' },
      'show HEAD:removed.ts': {
        stdout: '',
        error: new Error('fatal: path does not exist'),
      },
    });
    mockOpenAsText();

    const result = await getFileDiffCommitted('/repo', 'removed.ts');

    expect(result.oldValue).toBe('removed content\n');
    expect(result.newValue).toBe('');
    expect(result.binary).toBe(false);
  });

  it('returns binary: true for binary files', async (): Promise<void> => {
    setupCommittedMock({
      'diff abc000 HEAD --numstat -- photo.jpg': {
        stdout: '-\t-\tphoto.jpg\n',
      },
    });
    mockOpenAsText();

    const result = await getFileDiffCommitted('/repo', 'photo.jpg');

    expect(result).toEqual({
      oldValue: '',
      newValue: '',
      truncated: false,
      binary: true,
    });
  });

  it('returns old and new image previews for previewable image files', async (): Promise<void> => {
    setupCommittedMock({
      'cat-file -s abc000:assets/logo.png': { stdout: '3\n' },
      'cat-file -s HEAD:assets/logo.png': { stdout: '3\n' },
      'show abc000:assets/logo.png': {
        stdout: Buffer.from([1, 2, 3]),
      },
      'show HEAD:assets/logo.png': {
        stdout: Buffer.from([4, 5, 6]),
      },
    });

    const result = await getFileDiffCommitted('/repo', 'assets/logo.png');

    expect(result).toEqual({
      oldValue: '',
      newValue: '',
      truncated: false,
      binary: true,
      imagePreview: {
        oldDataUrl: 'data:image/png;base64,AQID',
        newDataUrl: 'data:image/png;base64,BAUG',
      },
    });
  });

  it('returns truncated: true when content exceeds the size limit', async (): Promise<void> => {
    const longContent = 'y'.repeat(500_001);

    setupCommittedMock({
      'diff abc000 HEAD --numstat -- huge.ts': { stdout: '1\t1\thuge.ts\n' },
      'show abc000:huge.ts': { stdout: 'short\n' },
      'show HEAD:huge.ts': { stdout: longContent },
    });
    mockOpenAsText();

    const result = await getFileDiffCommitted('/repo', 'huge.ts');

    expect(result.truncated).toBe(true);
    expect(result.newValue.length).toBe(500_000);
    expect(result.oldValue).toBe('short\n');
    expect(result.binary).toBe(false);
  });

  it('returns empty result when no merge base is found', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      // getRemoteDefaultBranch → all lookups fail → returns null
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(new Error('no remote'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'symbolic-ref refs/remotes/origin/HEAD') {
        cb?.(new Error('not set'), { stdout: '', stderr: '' });
        return;
      }
      if (key.startsWith('rev-parse --verify refs/remotes/origin/')) {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (key.startsWith('show-ref --verify --quiet')) {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    const result = await getFileDiffCommitted('/repo', 'any-file.ts');

    expect(result).toEqual({
      oldValue: '',
      newValue: '',
      truncated: false,
      binary: false,
    });
  });
});

// ---------------------------------------------------------------------------
// getFileDiffBetweenTrees
// ---------------------------------------------------------------------------
describe('getFileDiffBetweenTrees', () => {
  it('returns old and new image previews for previewable image files', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      if (key === 'cat-file -s start-tree:assets/screenshot.webp') {
        cb?.(null, { stdout: '3\n', stderr: '' });
        return;
      }
      if (key === 'cat-file -s end-tree:assets/screenshot.webp') {
        cb?.(null, { stdout: '3\n', stderr: '' });
        return;
      }
      if (key === 'show start-tree:assets/screenshot.webp') {
        cb?.(null, { stdout: Buffer.from([7, 8, 9]), stderr: '' });
        return;
      }
      if (key === 'show end-tree:assets/screenshot.webp') {
        cb?.(null, { stdout: Buffer.from([10, 11, 12]), stderr: '' });
        return;
      }

      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    const result = await getFileDiffBetweenTrees(
      '/repo',
      'assets/screenshot.webp',
      'start-tree',
      'end-tree',
    );

    expect(result).toEqual({
      oldValue: '',
      newValue: '',
      truncated: false,
      binary: true,
      imagePreview: {
        oldDataUrl: 'data:image/webp;base64,BwgJ',
        newDataUrl: 'data:image/webp;base64,CgsM',
      },
    });
  });
});

// ---------------------------------------------------------------------------
// getFileDiffCombined
// ---------------------------------------------------------------------------
describe('getFileDiffCombined', () => {
  it('returns old and new values using merge base as ref', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      if (key === 'show-ref --verify --quiet refs/remotes/origin/main') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'merge-base origin/main HEAD') {
        cb?.(null, { stdout: 'def456\n', stderr: '' });
        return;
      }
      // isFileBinary with merge-base ref
      if (key === 'diff def456 --numstat -- src/app.ts') {
        cb?.(null, { stdout: '3\t1\tsrc/app.ts\n', stderr: '' });
        return;
      }
      // getFileAtRef with merge-base
      if (key === 'show def456:src/app.ts') {
        cb?.(null, { stdout: 'base content\n', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockOpenAsText();
    mockedReadFile.mockResolvedValue('working tree content\n');

    const result = await getFileDiffCombined('/repo', 'src/app.ts');

    expect(result).toEqual({
      oldValue: 'base content\n',
      newValue: 'working tree content\n',
      truncated: false,
      binary: false,
    });
  });

  it('falls back to HEAD when no merge base exists', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      // getRemoteDefaultBranch → all fail → null → getMergeBase returns null
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(new Error('no remote'), { stdout: '', stderr: '' });
        return;
      }
      if (key === 'symbolic-ref refs/remotes/origin/HEAD') {
        cb?.(new Error('not set'), { stdout: '', stderr: '' });
        return;
      }
      if (key.startsWith('rev-parse --verify refs/remotes/origin/')) {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      if (key.startsWith('show-ref --verify --quiet')) {
        cb?.(new Error('not found'), { stdout: '', stderr: '' });
        return;
      }
      // Falls back to HEAD for isFileBinary
      if (key === 'diff HEAD --numstat -- fallback.ts') {
        cb?.(null, { stdout: '2\t0\tfallback.ts\n', stderr: '' });
        return;
      }
      // Falls back to HEAD for getFileAtRef
      if (key === 'show HEAD:fallback.ts') {
        cb?.(null, { stdout: 'head content\n', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockOpenAsText();
    mockedReadFile.mockResolvedValue('local content\n');

    const result = await getFileDiffCombined('/repo', 'fallback.ts');

    expect(result).toEqual({
      oldValue: 'head content\n',
      newValue: 'local content\n',
      truncated: false,
      binary: false,
    });
  });

  it('returns empty old value for an added file', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      if (key === 'show-ref --verify --quiet refs/remotes/origin/main') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'merge-base origin/main HEAD') {
        cb?.(null, { stdout: 'aaa111\n', stderr: '' });
        return;
      }
      if (key === 'diff aaa111 --numstat -- new.ts') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'show aaa111:new.ts') {
        cb?.(new Error('fatal: path does not exist'), {
          stdout: '',
          stderr: '',
        });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockOpenAsText();
    mockedReadFile.mockResolvedValue('new file\n');

    const result = await getFileDiffCombined('/repo', 'new.ts');

    expect(result.oldValue).toBe('');
    expect(result.newValue).toBe('new file\n');
    expect(result.binary).toBe(false);
  });

  it('returns empty new value for a deleted file', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      if (key === 'show-ref --verify --quiet refs/remotes/origin/main') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'merge-base origin/main HEAD') {
        cb?.(null, { stdout: 'aaa111\n', stderr: '' });
        return;
      }
      if (key === 'diff aaa111 --numstat -- gone.ts') {
        cb?.(null, { stdout: '0\t5\tgone.ts\n', stderr: '' });
        return;
      }
      if (key === 'show aaa111:gone.ts') {
        cb?.(null, { stdout: 'was here\n', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockOpenFail();
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));

    const result = await getFileDiffCombined('/repo', 'gone.ts');

    expect(result.oldValue).toBe('was here\n');
    expect(result.newValue).toBe('');
    expect(result.binary).toBe(false);
  });

  it('returns binary: true for binary files', async (): Promise<void> => {
    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      if (key === 'show-ref --verify --quiet refs/remotes/origin/main') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'merge-base origin/main HEAD') {
        cb?.(null, { stdout: 'bbb222\n', stderr: '' });
        return;
      }
      if (key === 'diff bbb222 --numstat -- icon.png') {
        cb?.(null, { stdout: '-\t-\ticon.png\n', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockOpenAsText();

    const result = await getFileDiffCombined('/repo', 'icon.png');

    expect(result).toEqual({
      oldValue: '',
      newValue: '',
      truncated: false,
      binary: true,
    });
  });

  it('returns truncated: true when content exceeds the size limit', async (): Promise<void> => {
    const longContent = 'z'.repeat(500_001);

    mockedExecFile.mockImplementation(((
      _cmd: string,
      args: string[],
      _opts: unknown,
      cb?: ExecFileCallback,
    ) => {
      const key = args.join(' ');

      if (key === 'show-ref --verify --quiet refs/remotes/origin/main') {
        cb?.(null, { stdout: '', stderr: '' });
        return;
      }
      if (key === 'ls-remote --symref origin HEAD') {
        cb?.(null, {
          stdout: 'ref: refs/heads/main\tHEAD\nabc123\tHEAD\n',
          stderr: '',
        });
        return;
      }
      if (key === 'merge-base origin/main HEAD') {
        cb?.(null, { stdout: 'ccc333\n', stderr: '' });
        return;
      }
      if (key === 'diff ccc333 --numstat -- massive.ts') {
        cb?.(null, { stdout: '1\t1\tmassive.ts\n', stderr: '' });
        return;
      }
      if (key === 'show ccc333:massive.ts') {
        cb?.(null, { stdout: 'small\n', stderr: '' });
        return;
      }
      cb?.(new Error(`Unexpected: ${key}`), { stdout: '', stderr: '' });
    }) as typeof execFile);

    mockOpenAsText();
    mockedReadFile.mockResolvedValue(longContent);

    const result = await getFileDiffCombined('/repo', 'massive.ts');

    expect(result.truncated).toBe(true);
    expect(result.newValue.length).toBe(500_000);
    expect(result.oldValue).toBe('small\n');
    expect(result.binary).toBe(false);
  });
});

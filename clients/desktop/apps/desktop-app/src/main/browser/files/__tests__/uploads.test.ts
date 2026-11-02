import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as fsModule from 'node:fs';
import {
  closeSync,
  openSync,
  realpathSync,
  utimesSync,
  writeSync,
} from 'node:fs';
import {
  UploadError,
  attachmentUploadSource,
  stageUploadFile,
  stagedFileMatches,
  workspaceUploadSource,
  type UploadSource,
} from '../uploads';

// The real realpath and open, which tests wrap to swap a folder around them.
jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof fsModule>('node:fs');
  return {
    ...actual,
    openSync: jest.fn(actual.openSync),
    realpathSync: jest.fn(actual.realpathSync),
  };
});

let base: string;
let workspace: string;
let outside: string;
let staging: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'uploads-')));
  workspace = join(base, 'workspace');
  outside = join(base, 'outside');
  staging = join(base, 'staging');
  await mkdir(join(workspace, 'exports'), { recursive: true });
  await mkdir(outside);
  await mkdir(staging);
  await writeFile(join(workspace, 'exports', 'report.csv'), 'a,b\n1,2\n');
  await writeFile(join(outside, 'secret.txt'), 'secret');
});
afterEach(async () => {
  await chmod(staging, 0o700).catch(() => undefined);
  await rm(base, { recursive: true, force: true });
});

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
function source(path = 'exports/report.csv'): UploadSource {
  const result = workspaceUploadSource(workspace, path);
  if (!result.ok) throw new Error(result.error.message);
  return result.source;
}
function refusal(path: string): string | undefined {
  const result = workspaceUploadSource(workspace, path);
  return result.ok ? undefined : result.error.code;
}

describe('workspaceUploadSource', () => {
  it('resolves a workspace file to its name, workspace path, and size', () => {
    expect(source()).toMatchObject({
      name: 'report.csv',
      displayPath: 'exports/report.csv',
      path: join(workspace, 'exports', 'report.csv'),
      sizeBytes: 8,
    });
    expect(source('./exports//report.csv').displayPath).toBe(
      'exports/report.csv',
    );
  });

  it('refuses a path that leaves the workspace, by .. or as an absolute path', () => {
    expect(refusal('../outside/secret.txt')).toBe('file_not_eligible');
    expect(refusal('exports/../../outside/secret.txt')).toBe(
      'file_not_eligible',
    );
    expect(refusal(join(outside, 'secret.txt'))).toBe('file_not_eligible');
    // Even an absolute path inside the workspace: paths are workspace-relative.
    expect(refusal(join(workspace, 'exports', 'report.csv'))).toBe(
      'file_not_eligible',
    );
    expect(refusal('C:\\Users\\x\\secret.txt')).toBe('file_not_eligible');
  });

  it('follows a link that stays inside the workspace and refuses one that leaves it', async () => {
    await symlink(
      join(workspace, 'exports', 'report.csv'),
      join(workspace, 'inside-link'),
    );
    await symlink(join(outside, 'secret.txt'), join(workspace, 'outside-link'));
    await symlink(outside, join(workspace, 'outside-folder'));
    // Rules and the card see the file itself; the typed path is kept as an alias.
    expect(source('inside-link')).toMatchObject({
      name: 'inside-link',
      displayPath: 'exports/report.csv',
      requestedPath: 'inside-link',
      path: join(workspace, 'exports', 'report.csv'),
    });
    expect(source()).not.toHaveProperty('requestedPath');
    expect(refusal('outside-link')).toBe('file_not_eligible');
    expect(refusal('outside-folder/secret.txt')).toBe('file_not_eligible');
  });

  it('refuses anything under a .git folder, at any depth and in any case', async () => {
    await mkdir(join(workspace, '.git'));
    await writeFile(join(workspace, '.git', 'config'), '[core]');
    await mkdir(join(workspace, 'repos', 'app', '.GIT'), { recursive: true });
    await writeFile(join(workspace, 'repos', 'app', '.GIT', 'HEAD'), 'ref');
    await symlink(
      join(workspace, '.git', 'config'),
      join(workspace, 'config-link'),
    );
    expect(refusal('.git/config')).toBe('file_not_eligible');
    expect(refusal('repos/app/.GIT/HEAD')).toBe('file_not_eligible');
    expect(refusal('config-link')).toBe('file_not_eligible');
  });

  it('refuses a folder, a missing file, an empty path, and a NUL', () => {
    expect(refusal('exports')).toBe('file_not_eligible');
    expect(refusal('exports/missing.csv')).toBe('file_not_eligible');
    expect(refusal('')).toBe('file_not_eligible');
    expect(refusal('exports/report.csv\0.txt')).toBe('file_not_eligible');
  });

  it('refuses a file whose folder is swapped for a link to outside after its path resolves', async () => {
    const actual = jest.requireActual<typeof fsModule>('node:fs');
    await writeFile(join(outside, 'report.csv'), 'outside bytes');
    jest
      .mocked(realpathSync)
      .mockImplementation((path: fsModule.PathLike): string => {
        const resolved = actual.realpathSync(path);
        if (String(path).endsWith(join('exports', 'report.csv'))) {
          actual.renameSync(
            join(workspace, 'exports'),
            join(workspace, 'moved'),
          );
          actual.symlinkSync(outside, join(workspace, 'exports'));
        }
        return resolved;
      });
    try {
      expect(refusal('exports/report.csv')).toBe('file_not_eligible');
    } finally {
      jest.mocked(realpathSync).mockImplementation(actual.realpathSync);
    }
  });

  it('refuses a file opened while its folder pointed outside, even once the folder is back', async () => {
    const actual = jest.requireActual<typeof fsModule>('node:fs');
    await writeFile(join(outside, 'report.csv'), 'outside bytes');
    const exports = join(workspace, 'exports');
    const moved = join(workspace, 'moved');
    let swapped = false;
    // Outside for the open and the lstat after it, back for the realpath after that.
    jest
      .mocked(openSync)
      .mockImplementation(
        (
          path: fsModule.PathLike,
          flags: fsModule.OpenMode,
          mode?: fsModule.Mode | null,
        ): number => {
          if (String(path).endsWith(join('exports', 'report.csv'))) {
            actual.renameSync(exports, moved);
            actual.symlinkSync(outside, exports);
            swapped = true;
          }
          return actual.openSync(path, flags, mode);
        },
      );
    jest
      .mocked(realpathSync)
      .mockImplementation((path: fsModule.PathLike): string => {
        if (swapped) {
          actual.unlinkSync(exports);
          actual.renameSync(moved, exports);
          swapped = false;
        }
        return actual.realpathSync(path);
      });
    try {
      expect(refusal('exports/report.csv')).toBe('file_not_eligible');
    } finally {
      jest.mocked(openSync).mockImplementation(actual.openSync);
      jest.mocked(realpathSync).mockImplementation(actual.realpathSync);
    }
  });

  it('refuses a named pipe without waiting for a writer', () => {
    execFileSync('mkfifo', [join(workspace, 'pipe')]);
    expect(refusal('pipe')).toBe('file_not_eligible');
  });

  it('refuses workspace files on Windows, where the open file cannot be checked', () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    });
    try {
      expect(workspaceUploadSource(workspace, 'exports/report.csv')).toEqual({
        ok: false,
        error: {
          code: 'file_not_eligible',
          message: "Uploading workspace files isn't available on Windows yet.",
        },
      });
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });

  it('allows an empty file', async () => {
    await writeFile(join(workspace, 'empty.txt'), '');
    expect(source('empty.txt').sizeBytes).toBe(0);
  });
});

describe('attachmentUploadSource', () => {
  let attachments: string;
  beforeEach(async () => {
    attachments = join(base, 'attachments');
    await mkdir(attachments);
    await writeFile(join(attachments, 'photo (1).png'), 'png!');
    await writeFile(join(attachments, 'theirs.txt'), 'other chat');
  });
  const resolveIn = (
    attachmentId: string,
    referenced = [join(attachments, 'photo (1).png')],
  ): ReturnType<typeof attachmentUploadSource> =>
    attachmentUploadSource(attachments, attachmentId, referenced);

  it('resolves a file the chat attached to its name, label, and size', () => {
    const resolved = resolveIn('photo (1).png');
    if (!resolved.ok) throw new Error(resolved.error.message);
    const { identity, ...rest } = resolved.source;
    expect(rest).toEqual({
      kind: 'attachment',
      name: 'photo (1).png',
      displayPath: 'photo (1).png (attached to this chat)',
      path: join(attachments, 'photo (1).png'),
      sizeBytes: 4,
    });
    expect(identity.ino).toBeGreaterThan(0);
  });

  it('refuses a file in the folder that this chat never attached', () => {
    expect(resolveIn('theirs.txt')).toMatchObject({
      ok: false,
      error: { code: 'file_not_eligible' },
    });
  });

  it('refuses an id that is a path, and a missing or non-file attachment', async () => {
    await mkdir(join(attachments, 'folder'));
    for (const id of [
      '../outside/secret.txt',
      'folder/x',
      'a\\b',
      '.',
      '..',
      ' ',
      'nul\0',
      'missing.png',
      'folder',
    ])
      expect(
        resolveIn(id, [
          join(attachments, id),
          join(attachments, 'photo (1).png'),
        ]).ok,
      ).toBe(false);
  });

  it('refuses an attached name that is a link, even to a file inside', async () => {
    await symlink(join(outside, 'secret.txt'), join(attachments, 'out.txt'));
    await symlink(
      join(attachments, 'photo (1).png'),
      join(attachments, 'alias.png'),
    );
    for (const id of ['out.txt', 'alias.png'])
      expect(resolveIn(id, [join(attachments, id)]).ok).toBe(false);
  });
});

describe('stageUploadFile', () => {
  it('copies the bytes, hashes them, reports progress, and leaves the copy read-only', async () => {
    const progress: number[] = [];
    const destination = join(staging, 'report.csv');
    const staged = await stageUploadFile({
      source: source(),
      destination,
      signal: new AbortController().signal,
      onProgress: (bytes) => progress.push(bytes),
    });
    expect(staged).toEqual({ sha256: sha256('a,b\n1,2\n'), sizeBytes: 8 });
    expect(await readFile(destination, 'utf8')).toBe('a,b\n1,2\n');
    expect(progress.at(-1)).toBe(8);
    expect((await stat(destination)).mode & 0o222).toBe(0);
  });

  it('refuses a source replaced after it was checked, and leaves nothing', async () => {
    const checked = source();
    const path = join(workspace, 'exports', 'report.csv');
    // Made while the original exists, so it cannot reuse the original's inode.
    await writeFile(`${path}.new`, 'other');
    await rename(`${path}.new`, path);
    const destination = join(staging, 'report.csv');
    await expect(
      stageUploadFile({
        source: checked,
        destination,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'file_not_eligible' });
    expect(await readdir(staging)).toEqual([]);
  });

  it('refuses a source replaced by a named pipe without waiting for a writer', async () => {
    const checked = source();
    const path = join(workspace, 'exports', 'report.csv');
    await rm(path);
    execFileSync('mkfifo', [path]);
    await expect(
      stageUploadFile({
        source: checked,
        destination: join(staging, 'report.csv'),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: 'file_not_eligible' });
    expect(await readdir(staging)).toEqual([]);
  });

  it('stops when cancelled and removes its partial copy', async () => {
    await writeFile(
      join(workspace, 'large.bin'),
      Buffer.alloc(8 * 1024 * 1024, 1),
    );
    const controller = new AbortController();
    await expect(
      stageUploadFile({
        source: source('large.bin'),
        destination: join(staging, 'large.bin'),
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toThrow();
    expect(await readdir(staging)).toEqual([]);
  });

  it('hashes exactly what it staged when the source is rewritten during the copy, keeping its size and time', async () => {
    const big = join(workspace, 'exports', 'big.bin');
    const size = 3 * 1024 * 1024;
    await writeFile(big, Buffer.alloc(size, 0x61));
    const before = await stat(big);
    const destination = join(staging, 'big.bin');
    let rewritten = false;
    const staged = await stageUploadFile({
      source: source('exports/big.bin'),
      destination,
      signal: new AbortController().signal,
      onProgress: (bytes) => {
        if (rewritten || bytes >= size) return;
        rewritten = true;
        // Same inode, same size, same modification time, other bytes.
        const fd = openSync(big, 'r+');
        try {
          writeSync(
            fd,
            Buffer.alloc(size - bytes, 0x62),
            0,
            size - bytes,
            bytes,
          );
        } finally {
          closeSync(fd);
        }
        utimesSync(big, before.atime, before.mtime);
      },
    });
    expect(rewritten).toBe(true);
    const copy = await readFile(destination);
    expect(staged).toEqual({
      sha256: createHash('sha256').update(copy).digest('hex'),
      sizeBytes: size,
    });
    await expect(stagedFileMatches(destination, staged)).resolves.toBe(true);
  });

  it('keeps the staged bytes when the source changes afterwards', async () => {
    const destination = join(staging, 'report.csv');
    const staged = await stageUploadFile({
      source: source(),
      destination,
      signal: new AbortController().signal,
    });
    await writeFile(join(workspace, 'exports', 'report.csv'), 'changed');
    await expect(stagedFileMatches(destination, staged)).resolves.toBe(true);
    expect(await readFile(destination, 'utf8')).toBe('a,b\n1,2\n');
  });
});

describe('stagedFileMatches', () => {
  it('fails a staged file whose bytes or size changed, or that was replaced', async () => {
    const destination = join(staging, 'report.csv');
    const staged = await stageUploadFile({
      source: source(),
      destination,
      signal: new AbortController().signal,
    });
    await chmod(destination, 0o600);
    // Same size, other bytes.
    await writeFile(destination, 'x,y\n3,4\n');
    await expect(stagedFileMatches(destination, staged)).resolves.toBe(false);
    await writeFile(destination, 'a,b\n1,2\n');
    await expect(stagedFileMatches(destination, staged)).resolves.toBe(true);
    await rm(destination);
    await symlink(join(workspace, 'exports', 'report.csv'), destination);
    await expect(stagedFileMatches(destination, staged)).resolves.toBe(false);
    await expect(
      stagedFileMatches(join(staging, 'missing'), staged),
    ).resolves.toBe(false);
  });

  it('fails a staged copy replaced by a named pipe without waiting for a writer', async () => {
    const destination = join(staging, 'report.csv');
    const staged = await stageUploadFile({
      source: source(),
      destination,
      signal: new AbortController().signal,
    });
    await rm(destination);
    execFileSync('mkfifo', [destination]);
    await expect(stagedFileMatches(destination, staged)).resolves.toBe(false);
  });

  it('is an UploadError with a code', () => {
    expect(new UploadError('file_changed', 'x').code).toBe('file_changed');
  });
});

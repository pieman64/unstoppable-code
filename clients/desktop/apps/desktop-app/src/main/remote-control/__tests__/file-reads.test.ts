import { randomBytes } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as Paths from '../../lib/paths';
import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import { authorizeExternalFileRead } from '../../lib/external-file-open';
import { createHostFileReader } from '../host/file-reads';
import type { FileReadParams } from '../remote-protocol';

/** Small parts, so reads span several without megabytes of work. */
const PART_BYTES = 16 * 1024;

const sharedContainers = { root: '' };

jest.mock('../../lib/paths', () => {
  const actual = jest.requireActual<typeof Paths>('../../lib/paths');
  return {
    ...actual,
    getSharedContainersRootDir: (): string => sharedContainers.root,
  };
});

jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
  getFileBrowserSupplementalWatchPaths: jest.fn(() => []),
}));

const mockedRoots = jest.mocked(getFileBrowserRoots);

let dir: string;
let worktree: string;
let outside: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'host-file-reads-')));
  worktree = join(dir, 'worktree');
  outside = join(dir, 'outside');
  sharedContainers.root = join(dir, 'shared-containers');
  await mkdir(worktree);
  await mkdir(outside);
  await mkdir(sharedContainers.root);
  const root = {
    repoId: 'repo',
    repoName: 'repo',
    absolutePath: worktree,
    rootKind: 'git-repo' as const,
    gitAware: true,
    excludedDescendantRoots: [],
  };
  mockedRoots.mockResolvedValue({
    roots: [root],
    rootMap: new Map([[root.repoId, root]]),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = createHostFileReader({
  authorize: authorizeExternalFileRead,
  maxBytes: 16 * 1024 * 1024,
});

function part(
  absolutePath: string,
  offset = 0,
  extra: Partial<FileReadParams> = {},
): FileReadParams {
  return {
    absolutePath,
    offset,
    length: PART_BYTES,
    ...extra,
  };
}

describe('host file reads', () => {
  it('reads a file in parts, the last one short', async () => {
    const bytes = randomBytes(PART_BYTES + 10);
    const path = join(outside, 'report.pdf');
    await writeFile(path, bytes);

    const first = await read(part(path));
    const last = await read(part(path, PART_BYTES));

    expect(first.fileName).toBe('report.pdf');
    expect(first.sizeBytes).toBe(bytes.byteLength);
    expect(Buffer.from(first.bytes).equals(bytes.subarray(0, PART_BYTES))).toBe(
      true,
    );
    expect(Buffer.from(last.bytes).equals(bytes.subarray(PART_BYTES))).toBe(
      true,
    );
    expect(last.modifiedAtMs).toBe(first.modifiedAtMs);
    expect((await read(part(path, bytes.byteLength))).bytes).toHaveLength(0);
  });

  it('names a linked file after its target', async () => {
    const target = join(outside, 'install.command');
    await writeFile(target, 'echo hi');
    await symlink(target, join(outside, 'photo.png'));
    expect((await read(part(join(outside, 'photo.png')))).fileName).toBe(
      'install.command',
    );
  });

  it('refuses files over its limit', async () => {
    const path = join(outside, 'big.bin');
    await writeFile(path, Buffer.alloc(9));
    const small = createHostFileReader({
      authorize: authorizeExternalFileRead,
      maxBytes: 8,
    });
    await expect(small(part(path))).rejects.toMatchObject({
      code: 'remote_file_too_large',
    });
  });

  it('refuses what this computer would not open itself', async () => {
    const replica = join(sharedContainers.root, 'secret.txt');
    await writeFile(replica, 'sealed');
    await expect(read(part('relative/notes.txt'))).rejects.toThrow(
      'absolute path',
    );
    await expect(read(part(replica))).rejects.toThrow('read-only');
    await expect(read(part('\\\\server\\share\\a.pdf'))).rejects.toThrow();
    await expect(read(part(outside))).rejects.toThrow('regular file');
    await expect(read(part(join(outside, 'missing.pdf')))).rejects.toThrow();
  });

  it('keeps a request that names a worktree inside its roots', async () => {
    const inside = join(worktree, 'notes.txt');
    const secret = join(outside, 'secret.txt');
    await writeFile(inside, 'notes');
    await writeFile(secret, 'secret');
    await symlink(secret, join(worktree, 'escape.txt'));
    const scope = { projectId: 'project-1', worktreeId: 'worktree-1' };

    await expect(read(part(inside, 0, scope))).resolves.toMatchObject({
      fileName: 'notes.txt',
    });
    await expect(read(part(secret, 0, scope))).rejects.toThrow('outside');
    await expect(
      read(part(join(worktree, 'escape.txt'), 0, scope)),
    ).rejects.toThrow('outside');
    await expect(
      read(part(inside, 0, { projectId: 'project-1' })),
    ).rejects.toThrow('provided together');
    await expect(
      read(part(inside, 0, { projectId: 'Project 1', worktreeId: 'w' })),
    ).rejects.toThrow('projectId');
  });
});

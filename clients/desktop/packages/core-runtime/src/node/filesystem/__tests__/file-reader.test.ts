import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as paths from 'node:path';
import { WorkerFilesystemFileReadResultSchema } from '@canopy/protocol/canopy-core';
import { CanopyOperationError } from '../../../runtime/errors';
import { readNativeRootIdentity } from '../catalog-revision';
import {
  readFilesystemFile,
  type FilesystemFileReadIo,
  type FilesystemFileReadInput,
} from '../file-reader';
import { readFilesystemScopeFile } from '../scope-queries';
import type { FilesystemScopeDependencies } from '../scope-reader';
import { inventory } from './no-write-proof';

let tempRoot = '';
let repo = '';
let attachments = '';

beforeEach(async () => {
  tempRoot = await mkdtemp(paths.join(tmpdir(), 'file-reader-'));
  repo = paths.join(tempRoot, 'repo');
  attachments = paths.join(tempRoot, 'attachments');
  await mkdir(repo, { recursive: true });
  await mkdir(attachments, { recursive: true });
});

afterEach(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

function roots(): FilesystemFileReadInput['roots'] {
  return [
    { id: 'repo', absolutePath: repo },
    { id: 'attachments', absolutePath: attachments },
  ];
}

async function put(path: string, content: string | Buffer): Promise<void> {
  await mkdir(paths.dirname(path), { recursive: true });
  await writeFile(path, content);
}

function read(
  relativePath: string,
  overrides: Partial<FilesystemFileReadInput> = {},
): ReturnType<typeof readFilesystemFile> {
  return readFilesystemFile({
    roots: roots(),
    fileRootId: 'repo',
    relativePath,
    maxBytes: 5 * 1024 * 1024,
    ...overrides,
  });
}

async function failure(
  promise: Promise<unknown>,
): Promise<CanopyOperationError['payload']> {
  const error: unknown = await promise.then(
    () => undefined,
    (cause: unknown) => cause,
  );
  if (!(error instanceof CanopyOperationError))
    throw new Error(`Expected a typed failure, got ${String(error)}`);
  return error.payload;
}

it('reads text with its identity, timestamp and version', async () => {
  const file = paths.join(repo, 'src', 'a.ts');
  await put(file, 'const a = 1;\n');
  const stats = await stat(file);
  const { result, modifiedAtMs } = await read('src/a.ts');
  expect(result).toEqual({
    fileRootId: 'repo',
    relativePath: 'src/a.ts',
    name: 'a.ts',
    contentKind: 'text',
    encoding: 'utf8',
    content: 'const a = 1;\n',
    sizeBytes: 13,
    returnedBytes: 13,
    truncated: false,
    modifiedAt: new Date(stats.mtimeMs).toISOString(),
    version: `13:${Math.round(stats.mtimeMs)}`,
  });
  expect(modifiedAtMs).toBe(stats.mtimeMs);
  expect(WorkerFilesystemFileReadResultSchema.safeParse(result).success).toBe(
    true,
  );
});

it('truncates text at maxBytes and reports the full size', async () => {
  await put(paths.join(repo, 'long.txt'), 'abcdefgh');
  const { result } = await read('long.txt', { maxBytes: 3 });
  expect(result).toMatchObject({
    content: 'abc',
    returnedBytes: 3,
    sizeBytes: 8,
    truncated: true,
  });
});

it('returns images as base64 with a media type, and oversized ones as unsupported', async () => {
  await put(paths.join(repo, 'a.svg'), '<svg/>');
  await expect(read('a.svg')).resolves.toMatchObject({
    result: {
      contentKind: 'image',
      encoding: 'base64',
      content: Buffer.from('<svg/>').toString('base64'),
      mediaType: 'image/svg+xml',
      returnedBytes: 6,
    },
  });
  await expect(read('a.svg', { maxBytes: 5 })).resolves.toMatchObject({
    result: {
      contentKind: 'unsupported',
      content: '',
      returnedBytes: 0,
      sizeBytes: 6,
    },
  });
});

it('treats a NUL byte as binary and an empty file as empty text', async () => {
  await put(paths.join(repo, 'bin.txt'), Buffer.from([1, 0, 2]));
  await put(paths.join(repo, 'empty.md'), '');
  await expect(read('bin.txt')).resolves.toMatchObject({
    result: { contentKind: 'unsupported', content: '', returnedBytes: 0 },
  });
  await expect(read('empty.md')).resolves.toMatchObject({
    result: { contentKind: 'markdown', content: '', sizeBytes: 0 },
  });
});

it('reads no bytes of a known binary extension', async () => {
  await put(paths.join(repo, 'a.zip'), 'not really');
  await expect(read('a.zip')).resolves.toMatchObject({
    result: { contentKind: 'unsupported', returnedBytes: 0, sizeBytes: 10 },
  });
});

it.each([
  '',
  '../repo/a.txt',
  '/etc/hosts',
  'a//b.txt',
  './a.txt',
  'a\\b.txt',
  'C:/a.txt',
  'a\0b',
])('refuses the unsafe relative path %j before any access', async (path) => {
  await expect(failure(read(path))).resolves.toMatchObject({
    kind: 'not_found',
    code: 'worker.filesystem.file.outsideRoots',
  });
});

it('answers notFound for an unknown root or a missing file', async () => {
  await expect(
    failure(read('a.txt', { fileRootId: 'other' })),
  ).resolves.toMatchObject({ code: 'worker.filesystem.file.notFound' });
  await expect(failure(read('missing/a.txt'))).resolves.toMatchObject({
    kind: 'not_found',
    code: 'worker.filesystem.file.notFound',
  });
  await put(paths.join(repo, 'plain'), 'x');
  await expect(failure(read('plain/child.txt'))).resolves.toMatchObject({
    code: 'worker.filesystem.file.notFound',
  });
});

it('follows a symlink into any root of the scope and names the target', async () => {
  await put(paths.join(attachments, 'brief.md'), '# Brief');
  await symlink(
    paths.join(attachments, 'brief.md'),
    paths.join(repo, 'link.txt'),
  );
  await expect(read('link.txt')).resolves.toMatchObject({
    result: {
      relativePath: 'link.txt',
      name: 'brief.md',
      contentKind: 'markdown',
      content: '# Brief',
    },
  });
});

it('refuses a symlink that leaves every root', async () => {
  await put(paths.join(tempRoot, 'outside.txt'), 'secret');
  await symlink(
    paths.join(tempRoot, 'outside.txt'),
    paths.join(repo, 'escape.txt'),
  );
  const payload = await failure(read('escape.txt'));
  expect(payload).toMatchObject({
    kind: 'not_found',
    code: 'worker.filesystem.file.outsideRoots',
    message: 'Cannot read file outside the target project roots',
  });
});

it('reads inside .git', async () => {
  await put(paths.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  await expect(read('.git/HEAD')).resolves.toMatchObject({
    result: { content: 'ref: refs/heads/main\n' },
  });
});

it('refuses a directory as not a regular file', async () => {
  await mkdir(paths.join(repo, 'dir'));
  await expect(failure(read('dir'))).resolves.toMatchObject({
    kind: 'failed_precondition',
    code: 'worker.filesystem.file.notRegularFile',
  });
});

(process.platform === 'win32' ? it.skip : it)(
  'refuses a FIFO before opening it',
  async () => {
    execFileSync('mkfifo', [paths.join(repo, 'pipe.txt')]);
    const opens: string[] = [];
    const io: FilesystemFileReadIo = {
      realpath: (path) => realpath(path),
      lstat: (path) => lstat(path),
      open: (path, flags) => {
        opens.push(path);
        return open(path, flags);
      },
    };
    await expect(failure(read('pipe.txt', { io }))).resolves.toMatchObject({
      code: 'worker.filesystem.file.notRegularFile',
    });
    expect(opens).toEqual([]);
  },
);

it('refuses a file replaced after it was opened', async () => {
  const file = paths.join(repo, 'swap.txt');
  await put(file, 'original');
  await put(paths.join(repo, 'next.txt'), 'replacement');
  const io: FilesystemFileReadIo = {
    realpath: (path) => realpath(path),
    lstat: (path) => lstat(path),
    open: async (path, flags) => {
      const handle = await open(path, flags);
      await rename(paths.join(repo, 'next.txt'), file);
      return handle;
    },
  };
  await expect(failure(read('swap.txt', { io }))).resolves.toMatchObject({
    kind: 'failed_precondition',
    code: 'worker.filesystem.file.invalidState',
    message: 'Cannot read a file that changed while being validated',
  });
});

// Only win32 keeps the UNC spelling through `join`; elsewhere this pins that
// a trusted root's spelling alone never refuses the read.
it('reads under a root spelled as a UNC share', async () => {
  await put(paths.join(repo, 'a.txt'), 'shared');
  const share = paths.join(
    paths.sep === '\\' ? '\\\\server\\share\\repo' : '//server/share/repo',
  );
  const io: FilesystemFileReadIo = {
    realpath: (path) =>
      realpath(path.startsWith(share) ? repo + path.slice(share.length) : path),
    lstat: (path) => lstat(path),
    open: (path, flags) => open(path, flags),
  };
  const { result } = await read('a.txt', {
    roots: [{ id: 'repo', absolutePath: share }],
    io,
  });
  expect(result).toMatchObject({ contentKind: 'text', content: 'shared' });
});

it('keeps an unexpected resolution failure as its own error', async () => {
  const cause = Object.assign(new Error('EACCES: permission denied'), {
    code: 'EACCES',
  });
  const io: FilesystemFileReadIo = {
    realpath: () => Promise.reject(cause),
    lstat: (path) => lstat(path),
    open: (path, flags) => open(path, flags),
  };
  await expect(read('a.txt', { io })).rejects.toBe(cause);
});

describe('readFilesystemScopeFile', () => {
  let dataRoot = '';
  let dependencies: FilesystemScopeDependencies;
  const scope = { workspaceId: 'project', worktreeId: 'task' };

  async function json(relative: string, document: unknown): Promise<void> {
    await put(paths.join(dataRoot, relative), JSON.stringify(document));
  }

  beforeEach(async () => {
    dataRoot = paths.join(tempRoot, 'data');
    dependencies = {
      dataRoot,
      authorityId: 'local',
      targetId: 'worker',
      paths,
      coworkManagedDirName: '.canopy',
      rootIdentity: readNativeRootIdentity,
    };
    await json('workspaces/index.json', {
      version: 1,
      workspaces: [
        { id: 'project', name: 'Project', type: 'single-repo', color: '#fff' },
      ],
    });
    await json('workspaces/project/workspace.json', {
      version: 1,
      type: 'single-repo',
      repos: [],
    });
    await json('workspaces/project/worktrees.json', {
      version: 1,
      worktrees: [{ id: 'task', branchName: 'topic', createdAt: 'now' }],
    });
    await put(
      paths.join(dataRoot, 'workspaces/project/worktrees/task/notes.md'),
      '# Notes\n',
    );
  });

  const params = {
    scope,
    fileRootId: 'project',
    relativePath: 'notes.md',
    maxBytes: 1024,
  };

  it('reads through the trusted catalog and returns its revision without writing', async () => {
    const before = await inventory(dataRoot);
    const result = await readFilesystemScopeFile(params, dependencies);
    expect(result).toMatchObject({
      fileRootId: 'project',
      relativePath: 'notes.md',
      contentKind: 'markdown',
      content: '# Notes\n',
    });
    expect(result.catalogRevision).toEqual(expect.any(String));
    await expect(
      readFilesystemScopeFile(
        { ...params, catalogRevision: result.catalogRevision },
        dependencies,
      ),
    ).resolves.toMatchObject({ content: '# Notes\n' });
    expect(await inventory(dataRoot)).toEqual(before);
  });

  it('refuses a stale catalog revision', async () => {
    await expect(
      failure(
        readFilesystemScopeFile(
          { ...params, catalogRevision: 'stale' },
          dependencies,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'conflict',
      code: 'worker.filesystem.file.revisionConflict',
      retry: { kind: 'after_refresh', resource: 'filesystem-roots' },
    });
  });

  it('answers an unknown worktree with the file namespace', async () => {
    await expect(
      failure(
        readFilesystemScopeFile(
          { ...params, scope: { ...scope, worktreeId: 'gone' } },
          dependencies,
        ),
      ),
    ).resolves.toMatchObject({ code: 'worker.filesystem.file.notFound' });
  });

  it('refuses a result over the binding budget as tooLarge', async () => {
    await expect(
      failure(
        readFilesystemScopeFile(params, dependencies, { maxResultBytes: 64 }),
      ),
    ).resolves.toMatchObject({
      kind: 'resource_exhausted',
      code: 'worker.filesystem.file.tooLarge',
    });
  });
});

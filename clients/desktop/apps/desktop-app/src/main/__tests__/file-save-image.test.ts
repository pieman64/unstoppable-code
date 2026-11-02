import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  IPC_CHANNELS,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type SaveFileContentRequest,
  type SaveFileContentResponse,
} from '@canopy/desktop-shared/types';
import { registerIpcHandler } from '../ipc/register';
import { registerFilePreviewHandlers } from '../ipc/file-preview';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { getWorktreeAttachmentsDir } from '../lib/paths';
import { touchWorkspaceTarget } from '../lib/workspace-activity';
import {
  createDirectTextSaveDispatcher,
  trustedSaveCaller,
} from './file-preview-fixtures';

jest.mock('../ipc/register', () => ({ registerIpcHandler: jest.fn() }));
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof fs>('node:fs/promises');
  return { ...actual, open: jest.fn(actual.open) };
});
jest.mock('../lib/validation', () => ({
  validateAbsolutePath: jest.fn(),
  validateId: jest.fn(),
}));
jest.mock('../lib/resolve-worktree', () => ({ resolveWorktreeCwd: jest.fn() }));
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceType: (): null => null,
  isCoworkWorkspace: (): boolean => false,
}));
jest.mock('../lib/paths', () => ({ getWorktreeAttachmentsDir: jest.fn() }));
jest.mock('../lib/workspace-activity', () => ({
  touchWorkspaceTarget: jest.fn().mockResolvedValue(undefined),
}));

// Independently encoded 1x1 PNG, including null bytes in its decoded body.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>図 →</text></svg>';
type SaveHandler = (
  _event: unknown,
  request: SaveFileContentRequest,
) => Promise<SaveFileContentResponse>;
let root: string;
let outside: string;
let save: SaveHandler;

function request(
  name = 'diagram.png',
  content = PNG,
  encoding: 'base64' | 'utf8' = 'base64',
): SaveFileContentRequest {
  const value = {
    projectId: 'project',
    worktreeId: 'worktree',
    absolutePath: join(root, name),
    content,
    encoding,
    createOnly: true,
  };
  return value;
}

beforeEach(async () => {
  jest.clearAllMocks();
  jest
    .mocked(fs.open)
    .mockImplementation(jest.requireActual<typeof fs>('node:fs/promises').open);
  root = await fs.mkdtemp(join(tmpdir(), 'can-5040-'));
  outside = await fs.mkdtemp(join(tmpdir(), 'can-5040-outside-'));
  jest.mocked(resolveWorktreeCwd).mockReturnValue(root);
  jest
    .mocked(getWorktreeAttachmentsDir)
    .mockReturnValue(join(root, 'missing-attachments'));
  registerFilePreviewHandlers(
    createDirectTextSaveDispatcher(),
    trustedSaveCaller,
  );
  const handler = jest
    .mocked(registerIpcHandler)
    .mock.calls.find(([channel]) => channel === IPC_CHANNELS.fileSaveContent);
  if (!handler) throw new Error('Missing save handler');
  save = handler[1] as SaveHandler;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

it('creates a PNG byte-exactly and returns metadata rather than a fake text preview', async () => {
  const result = await save(undefined, request());
  const bytes = await fs.readFile(join(root, 'diagram.png'));
  expect(bytes).toEqual(Buffer.from(PNG, 'base64'));
  expect(result).toEqual({
    filename: 'diagram.png',
    sizeBytes: bytes.length,
    modifiedAtMs: (await fs.stat(join(root, 'diagram.png'))).mtimeMs,
  });
  expect(result).not.toHaveProperty('content');
});

it('creates standalone UTF-8 SVG without requiring the destination to exist', async () => {
  await save(undefined, request('diagram.svg', SVG, 'utf8'));
  expect(await fs.readFile(join(root, 'diagram.svg'), 'utf8')).toBe(SVG);
});

it('lets exactly one concurrent creator win without changing the winner', async () => {
  const results = await Promise.allSettled([
    save(undefined, request()),
    save(undefined, request()),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { name: 'FileNameConflictError' },
  });
  expect(await fs.readFile(join(root, 'diagram.png'))).toEqual(
    Buffer.from(PNG, 'base64'),
  );
});

it('does not overwrite an existing destination or follow a destination symlink', async () => {
  await fs.writeFile(join(outside, 'keep.png'), 'keep');
  await fs.symlink(join(outside, 'keep.png'), join(root, 'diagram.png'));
  await expect(save(undefined, request())).rejects.toMatchObject({
    name: 'FileNameConflictError',
  });
  expect(await fs.readFile(join(outside, 'keep.png'), 'utf8')).toBe('keep');
});

it('rejects traversal and parent symlinks escaping the allowed roots', async () => {
  await fs.symlink(outside, join(root, 'link'));
  for (const name of ['../escape.png', 'link/escape.png']) {
    await expect(save(undefined, request(name))).rejects.toMatchObject({
      name: 'FileSaveValidationError',
    });
  }
  expect(await fs.readdir(outside)).toEqual([]);
});

it.each([
  'a',
  '!!!!',
  'aGVsbG8',
  'aGVsbG8===',
  'aGVs bG8=',
  `${PNG.slice(0, -2)}J=`,
  'data:image/png;base64,AAAA',
  '',
])(
  'rejects malformed or noncanonical base64 %j before writing',
  async (content) => {
    await expect(
      save(undefined, request('diagram.png', content)),
    ).rejects.toMatchObject({ name: 'FileSaveValidationError' });
    expect(await fs.readdir(root)).toEqual([]);
    expect(touchWorkspaceTarget).not.toHaveBeenCalled();
  },
);

it('bounds encoded and decoded payloads before creating files', async () => {
  const oversized = Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64');
  await expect(
    save(undefined, request('diagram.png', oversized)),
  ).rejects.toMatchObject({ name: 'FileSaveValidationError' });
  await expect(
    save(undefined, request('diagram.png', `${oversized}AAAA`)),
  ).rejects.toMatchObject({ name: 'FileSaveValidationError' });
  await expect(
    save(
      undefined,
      request('diagram.svg', 'é'.repeat(3 * 1024 * 1024), 'utf8'),
    ),
  ).rejects.toMatchObject({ name: 'FileSaveValidationError' });
  expect(await fs.readdir(root)).toEqual([]);
});

it('accepts the decoded limit without a regex stack overflow on large valid base64', async () => {
  const bytes = Buffer.alloc(5 * 1024 * 1024);
  Buffer.from(PNG, 'base64').copy(bytes);
  await save(undefined, request('diagram.png', bytes.toString('base64')));
  expect(await fs.readFile(join(root, 'diagram.png'))).toEqual(bytes);
});

it('rejects read-only scopes before creating an image', async () => {
  await expect(
    save(undefined, {
      ...request(),
      projectId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
    }),
  ).rejects.toThrow('read-only');
  expect(await fs.readdir(root)).toEqual([]);
});

it('retains UTF-8 overwrite and timestamp conflict behavior with explicit default options', async () => {
  const path = join(root, 'notes.md');
  await fs.writeFile(path, 'before');
  const { mtimeMs } = await fs.stat(path);
  const value = {
    ...request('notes.md', 'after', 'utf8'),
    createOnly: false,
    expectedModifiedAtMs: mtimeMs,
  };
  await save(undefined, value);
  expect(await fs.readFile(path, 'utf8')).toBe('after');
  await expect(
    save(undefined, { ...value, expectedModifiedAtMs: mtimeMs - 100 }),
  ).rejects.toMatchObject({ name: 'FileSaveConflictError' });
  expect(await fs.readFile(path, 'utf8')).toBe('after');
});

it('keeps operational creation failures distinct from retryable conflicts', async () => {
  const failure = Object.assign(new Error('permission denied'), {
    code: 'EACCES',
  });
  jest.mocked(fs.open).mockRejectedValue(failure);
  await expect(save(undefined, request())).rejects.toMatchObject({
    name: 'FileSaveOperationalError',
  });
  expect(await fs.readdir(root)).toEqual([]);
});

it('rejects binary overwrite and incompatible payload options without touching existing files', async () => {
  await fs.writeFile(join(root, 'diagram.png'), 'keep');
  for (const options of [
    { createOnly: false },
    { encoding: 'hex' },
    { expectedModifiedAtMs: 1 },
    { content: null },
  ]) {
    const value = { ...request(), ...options };
    await expect(
      save(undefined, value as SaveFileContentRequest),
    ).rejects.toMatchObject({ name: 'FileSaveValidationError' });
  }
  expect(await fs.readFile(join(root, 'diagram.png'), 'utf8')).toBe('keep');
});

it('removes only its own newly created file after a write failure', async () => {
  const originalOpen = jest.requireActual<typeof fs>('node:fs/promises').open;
  jest.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    jest.spyOn(handle, 'writeFile').mockRejectedValue(new Error('disk full'));
    return handle;
  });
  await expect(save(undefined, request())).rejects.toMatchObject({
    name: 'FileSaveOperationalError',
  });
  expect(await fs.readdir(root)).toEqual([]);
});

it('preserves a replacement file installed by another writer during failure cleanup', async () => {
  const originalOpen = jest.requireActual<typeof fs>('node:fs/promises').open;
  jest.mocked(fs.open).mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    jest.spyOn(handle, 'writeFile').mockImplementation(async () => {
      await fs.rename(join(root, 'diagram.png'), join(root, 'original.png'));
      await fs.writeFile(join(root, 'diagram.png'), 'other writer');
      throw new Error('disk full');
    });
    return handle;
  });
  await expect(save(undefined, request())).rejects.toMatchObject({
    name: 'FileSaveOperationalError',
  });
  expect(await fs.readFile(join(root, 'diagram.png'), 'utf8')).toBe(
    'other writer',
  );
});

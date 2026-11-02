/**
 * CAN-4099: a scoped `file:read-content` request that names its root
 * identity is read as addressed and answers with the canonical read, which
 * the Files panel consumes instead of reconstructing it.
 */
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type FileContentRequest,
} from '@canopy/desktop-shared/types';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';

type Handler = (event: unknown, request: unknown) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));
jest.mock('electron', () => ({
  nativeImage: { createThumbnailFromPath: jest.fn() },
  shell: { openExternal: jest.fn(), showItemInFolder: jest.fn() },
}));
jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
  getFileBrowserSupplementalWatchPaths: jest.fn(() => []),
}));

import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { registerFilePreviewHandlers } from '../file-preview';

const workspaceTarget = { projectId: 'project-1', worktreeId: 'wt-1' };
let tempRoot = '';
let repo = '';
let runtime: DesktopCanopyDispatcher | undefined;

function readContent(request: FileContentRequest): Promise<unknown> {
  const handler = handlers.get(IPC_CHANNELS.fileReadContent);
  if (!handler) throw new Error('file:read-content is not registered.');
  return Promise.resolve(handler({ sender: { id: 7 } }, request));
}

beforeEach(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), 'file-read-canonical-'));
  repo = join(tempRoot, 'repo');
  await mkdir(join(repo, 'docs'), { recursive: true });
  const roots: FileBrowserRoot[] = [
    {
      repoId: 'project-1',
      repoName: 'project-1',
      absolutePath: repo,
      rootKind: 'git-repo',
      gitAware: true,
      excludedDescendantRoots: [],
    },
  ];
  jest.mocked(getFileBrowserRoots).mockResolvedValue({
    roots,
    rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
  });
  handlers.clear();
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
  registerFilePreviewHandlers(runtime, () => ({
    principalId: 'local',
    clientInstanceId: 'electron-web-contents:7',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['worker.filesystem.read'],
  }));
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  await rm(tempRoot, { recursive: true, force: true });
});

it('answers a request that names its identity with the canonical read', async () => {
  const file = join(repo, 'docs', 'plan.md');
  await writeFile(file, '# Plan\n');
  const { mtimeMs } = await stat(file);
  await expect(
    readContent({
      absolutePath: file,
      workspaceTarget,
      file: { fileRootId: 'project-1', relativePath: 'docs/plan.md' },
    }),
  ).resolves.toEqual({
    kind: 'markdown',
    content: '# Plan\n',
    filename: 'plan.md',
    sizeBytes: 7,
    truncated: false,
    modifiedAtMs: mtimeMs,
    canonical: {
      fileRootId: 'project-1',
      relativePath: 'docs/plan.md',
      name: 'plan.md',
      contentKind: 'markdown',
      sizeBytes: 7,
      returnedBytes: 7,
      truncated: false,
      modifiedAt: new Date(mtimeMs).toISOString(),
      version: `7:${Math.round(mtimeMs)}`,
    },
  });
});

it('keeps the identity it was given for a symlinked path', async () => {
  await writeFile(join(repo, 'docs', 'real.md'), 'real');
  await symlink(join(repo, 'docs', 'real.md'), join(repo, 'alias.txt'));
  await expect(
    readContent({
      absolutePath: join(repo, 'alias.txt'),
      workspaceTarget,
      file: { fileRootId: 'project-1', relativePath: 'alias.txt' },
    }),
  ).resolves.toMatchObject({
    kind: 'markdown',
    filename: 'real.md',
    canonical: { relativePath: 'alias.txt', name: 'real.md' },
  });
});

it('reads the identity, not the path, when both are sent', async () => {
  await writeFile(join(repo, 'a.txt'), 'by identity');
  await writeFile(join(repo, 'b.txt'), 'by path');
  await expect(
    readContent({
      absolutePath: join(repo, 'b.txt'),
      workspaceTarget,
      file: { fileRootId: 'project-1', relativePath: 'a.txt' },
    }),
  ).resolves.toMatchObject({ content: 'by identity' });
});

it('answers without a canonical read when the request names no identity', async () => {
  await writeFile(join(repo, 'a.txt'), 'plain');
  const result = await readContent({
    absolutePath: join(repo, 'a.txt'),
    workspaceTarget,
  });
  expect(result).toMatchObject({ kind: 'text', content: 'plain' });
  expect(result).not.toHaveProperty('canonical');
});

it('refuses an unsafe identity and answers an unknown root as missing', async () => {
  await expect(
    readContent({
      absolutePath: join(repo, 'a.txt'),
      workspaceTarget,
      file: { fileRootId: 'project-1', relativePath: '../outside.txt' },
    }),
  ).rejects.toThrow('Cannot read file outside the target project roots');
  await expect(
    readContent({
      absolutePath: join(repo, 'a.txt'),
      workspaceTarget,
      file: { fileRootId: 'archived-attachments', relativePath: 'a.txt' },
    }),
  ).resolves.toMatchObject({ kind: 'missing', filename: 'a.txt' });
});

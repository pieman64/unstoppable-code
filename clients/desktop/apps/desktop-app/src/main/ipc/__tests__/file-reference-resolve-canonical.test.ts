/**
 * CAN-5038: how `file-reference:resolve` projects onto
 * `worker.filesystem.link.resolve`. The legacy answers are pinned by
 * `file-reference-resolve-golden.test.ts`; this pins the canonical request
 * the projection sends and the `mode: 'transcript'` answer.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  type FileReferenceResolveRequest,
  type FileReferenceResolveResponse,
} from '@canopy/desktop-shared/types';
import { canopyPermissionDeniedError } from '@canopy/core-runtime';
import { WORKER_FILESYSTEM_LINK_HREF_MAX_LENGTH } from '@canopy/protocol/canopy-core';
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

const mockedGetFileBrowserRoots = jest.mocked(getFileBrowserRoots);
const posix = process.platform === 'win32' ? describe.skip : describe;

let runtime: DesktopCanopyDispatcher | undefined;
let tempRoot = '';
let repo = '';

const TRUSTED_SENDER_ID = 44;

function resolveReference(
  request: Omit<FileReferenceResolveRequest, 'projectId' | 'worktreeId'>,
  senderId = TRUSTED_SENDER_ID,
): Promise<FileReferenceResolveResponse> {
  const handler = handlers.get(IPC_CHANNELS.fileReferenceResolve);
  if (!handler) throw new Error('file-reference:resolve is not registered.');
  return Promise.resolve(
    handler(
      { sender: { id: senderId } },
      { projectId: 'project-1', worktreeId: 'wt-1', ...request },
    ),
  ).then((value) => value as FileReferenceResolveResponse);
}

function root(repoId: string, absolutePath: string): FileBrowserRoot {
  return {
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind: 'git-repo',
    gitAware: true,
    excludedDescendantRoots: [],
  };
}

beforeEach(async () => {
  tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'file-reference-canonical-')),
  );
  repo = join(tempRoot, 'repo');
  await mkdir(join(repo, 'docs'), { recursive: true });
  await writeFile(join(repo, 'docs', 'guide.md'), 'guide');
  await writeFile(join(repo, 'README.md'), 'readme');
  const roots = [root('project-1', repo)];
  mockedGetFileBrowserRoots.mockReset().mockResolvedValue({
    roots,
    rootMap: new Map(roots.map((entry) => [entry.repoId, entry])),
  });
  handlers.clear();
  runtime = createDesktopRuntime({ shutdownTimeoutMs: 1_000 });
  registerFilePreviewHandlers(runtime, (event) => {
    // As in desktop-ipc-caller.ts: only the app's own windows resolve.
    if (event.sender.id !== TRUSTED_SENDER_ID)
      throw canopyPermissionDeniedError('Untrusted desktop IPC sender.');
    return {
      principalId: 'local',
      clientInstanceId: `electron-web-contents:${event.sender.id}`,
      authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
      interfaceKind: 'desktop',
      grants: ['worker.filesystem.read'],
    };
  });
});

afterEach(async () => {
  await runtime?.shutdown();
  runtime = undefined;
  await rm(tempRoot, { recursive: true, force: true });
});

function linkQueries(spy: jest.SpyInstance): unknown[] {
  return spy.mock.calls
    .filter(([name]) => name === 'worker.filesystem.link.resolve')
    .map(([, params]: unknown[]) => params);
}

posix('markdown projection', () => {
  it('sends a base inside a root as a root identity', async () => {
    if (!runtime) throw new Error('No runtime.');
    const query = jest.spyOn(runtime, 'query');
    await expect(
      resolveReference({
        baseFilePath: join(repo, 'docs', 'guide.md'),
        href: '../README.md',
      }),
    ).resolves.toEqual({
      absolutePath: join(repo, 'README.md'),
      filename: 'README.md',
      kind: 'file',
    });
    expect(linkQueries(query)).toEqual([
      {
        scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
        mode: 'markdown',
        href: '../README.md',
        base: { fileRootId: 'project-1', relativePath: 'docs/guide.md' },
      },
    ]);
  });

  it('keeps a base no root spells on the host, outside the request', async () => {
    if (!runtime) throw new Error('No runtime.');
    const query = jest.spyOn(runtime, 'query');
    const outsideBase = join(tempRoot, 'outside', 'note.md');
    await expect(
      resolveReference({
        baseFilePath: outsideBase,
        href: '../repo/README.md',
      }),
    ).resolves.toMatchObject({ filename: 'README.md' });
    await expect(
      resolveReference({ baseFilePath: `${repo}/docs/`, href: 'guide.md' }),
    ).resolves.toMatchObject({ filename: 'guide.md' });
    // No host path enters the canonical request.
    expect(JSON.stringify(linkQueries(query))).not.toContain(tempRoot);
    expect(linkQueries(query)).toHaveLength(2);
    for (const params of linkQueries(query))
      expect(params).not.toHaveProperty('base');
  });

  it('resolves long links and bases as the legacy resolver did', async () => {
    // Neither bound refuses a link to a path any platform can open.
    await expect(
      resolveReference({
        baseFilePath: join(repo, 'README.md'),
        href: `${'./'.repeat(10_000)}docs/guide.md`,
      }),
    ).resolves.toMatchObject({ filename: 'guide.md' });
    const deepBase = join(repo, ...Array<string>(20_000).fill('d'), 'note.md');
    await expect(
      resolveReference({
        baseFilePath: deepBase,
        href: `${'../'.repeat(20_000)}README.md`,
      }),
    ).resolves.toMatchObject({ filename: 'README.md' });
  });

  it('answers a link the schema refuses as null and still throws a roots failure', async () => {
    await expect(
      resolveReference({
        baseFilePath: join(repo, 'README.md'),
        href: 'a'.repeat(WORKER_FILESYSTEM_LINK_HREF_MAX_LENGTH + 1),
      }),
    ).resolves.toBeNull();
    mockedGetFileBrowserRoots.mockRejectedValueOnce(
      new Error('Unknown workspace'),
    );
    await expect(
      resolveReference({ baseFilePath: join(repo, 'README.md'), href: 'x.md' }),
    ).rejects.toThrow('Unknown workspace');
  });
});

posix('transcript mode', () => {
  it('answers one file with its canonical identity, or null', async () => {
    const guide = join(repo, 'docs', 'guide.md');
    for (const href of ['docs/guide.md#L4', guide])
      await expect(
        resolveReference({ baseFilePath: '', href, mode: 'transcript' }),
      ).resolves.toEqual({
        absolutePath: guide,
        filename: 'guide.md',
        kind: 'file',
        canonical: {
          fileRootId: 'project-1',
          relativePath: 'docs/guide.md',
          name: 'guide.md',
          kind: 'file',
        },
      });
    for (const href of ['docs', '../README.md', 'missing.md', 'https://x'])
      await expect(
        resolveReference({ baseFilePath: '', href, mode: 'transcript' }),
      ).resolves.toBeNull();
  });
});

// Before CAN-5038 the handler ignored its sender and the runtime state.
posix('caller and runtime admission', () => {
  const requests: ReadonlyArray<
    Omit<FileReferenceResolveRequest, 'projectId' | 'worktreeId'>
  > = [
    { baseFilePath: '/unused/README.md', href: 'docs/guide.md' },
    { baseFilePath: '', href: 'docs/guide.md', mode: 'transcript' },
  ];

  it('requires a trusted caller before reading any root', async () => {
    for (const request of requests) {
      await expect(resolveReference(request, 99)).rejects.toMatchObject({
        payload: {
          kind: 'permission_denied',
          message: 'Untrusted desktop IPC sender.',
        },
      });
    }
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
  });

  it('refuses once the runtime is shutting down', async () => {
    if (!runtime) throw new Error('No runtime.');
    await runtime.shutdown();
    for (const request of requests) {
      await expect(resolveReference(request)).rejects.toMatchObject({
        payload: { kind: 'unavailable' },
      });
    }
    expect(mockedGetFileBrowserRoots).not.toHaveBeenCalled();
  });
});

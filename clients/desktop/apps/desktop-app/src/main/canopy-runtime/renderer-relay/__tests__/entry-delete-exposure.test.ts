import { EventEmitter } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileBrowserRoot } from '../../../lib/file-browser-roots';

jest.mock('../../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
}));
jest.mock('../../../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
  resolveWorktreeTargetIds: jest.fn(
    (projectId: string, worktreeId: string) => ({ projectId, worktreeId }),
  ),
}));

import { getFileBrowserRoots } from '../../../lib/file-browser-roots';
import { RENDERER_RELAY_GRANTS } from '../../../ipc/canopy-core-relay';
import type { CanopyCoreRelayReply } from '../../../../shared/canopy-core-relay';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../desktop-runtime-identity';
import { createInterimInMemoryBindingProvider } from '../interim-in-memory-binding';
import {
  createRendererRelay,
  type RendererRelay,
  type RendererRelayEvent,
} from '../relay';
import type { RendererRelaySurface } from '../surface-allowlist';

/**
 * CAN-4101 Q5: `worker.filesystem.entry.delete`, `.copy` and `.move` join the
 * interface set, so the main window's renderer relay reaches them with the
 * relay's own grants; App Advisor's narrowed surface does not.
 */

const URL = 'file:///app/renderer/index.html';

class FakeSender extends EventEmitter {
  readonly mainFrame = {
    url: URL,
    detached: false,
    isDestroyed: (): boolean => false,
  };
  constructor(readonly id: number) {
    super();
  }
  getURL(): string {
    return URL;
  }
  isDestroyed(): boolean {
    return false;
  }
}

let tempRoot = '';
let repo = '';
let runtime: DesktopCanopyDispatcher;
let relay: RendererRelay;
const trashed: string[] = [];

function eventFor(sender: FakeSender): RendererRelayEvent {
  return { sender, senderFrame: sender.mainFrame };
}

let keySequence = 0;

function request(
  relativePath: string,
  // null sends no `_meta` at all.
  meta: Record<string, unknown> | null = {
    idempotencyKey: `relay-key-${++keySequence}`,
  },
): {
  kind: 'request';
  method: string;
  params: Record<string, unknown>;
} {
  return {
    kind: 'request',
    method: 'worker.filesystem.entry.delete',
    params: {
      scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
      fileRootId: 'project-1',
      relativePath,
      expectedVersion: null,
      recursive: true,
      disposition: 'trash',
      ...(meta && { _meta: meta }),
    },
  };
}

beforeEach(async () => {
  trashed.length = 0;
  tempRoot = await realpath(
    await mkdtemp(join(tmpdir(), 'entry-delete-relay-')),
  );
  repo = join(tempRoot, 'repo');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'index.ts'), 'export {};\n');
  const root: FileBrowserRoot = {
    repoId: 'project-1',
    repoName: 'project-1',
    absolutePath: repo,
    rootKind: 'git-repo',
    gitAware: true,
    excludedDescendantRoots: [],
  };
  jest.mocked(getFileBrowserRoots).mockResolvedValue({
    roots: [root],
    rootMap: new Map([[root.repoId, root]]),
  });
  runtime = createDesktopRuntime({
    shutdownTimeoutMs: 250,
    platform: {
      os: process.platform === 'win32' ? 'win32' : 'darwin',
      trash: {
        trashItem: (path) => {
          trashed.push(path);
          return Promise.resolve();
        },
      },
    },
  });
  const surfaces = new Map<number, RendererRelaySurface>();
  relay = createRendererRelay({
    bindingProvider: createInterimInMemoryBindingProvider(runtime),
    resolveSurface: (event) => {
      const surface = surfaces.get(event.sender.id) ?? 'main';
      return {
        surface,
        caller: {
          principalId: `local-desktop-renderer:${surface}`,
          clientInstanceId: `electron-web-contents:${event.sender.id}`,
          authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
          interfaceKind: 'desktop',
          grants: [...RENDERER_RELAY_GRANTS],
        },
      };
    },
  });
  surfaces.set(2, 'app-advisor');
});

afterEach(async () => {
  relay.dispose();
  await runtime.shutdown();
  await rm(tempRoot, { recursive: true, force: true });
});

it('lets the main surface delete through the relay', async () => {
  expect(RENDERER_RELAY_GRANTS).toContain('worker.filesystem.write');
  await expect(
    relay.invoke(eventFor(new FakeSender(1)), request('src/index.ts')),
  ).resolves.toEqual({
    ok: true,
    value: { deleted: true, deletedEntryCount: 1, disposition: 'trash' },
  });
  expect(trashed).toEqual([join(repo, 'src', 'index.ts')]);
});

it('requires the relay caller to supply its own idempotency key', async () => {
  for (const meta of [null, {}, { idempotencyKey: '' }]) {
    const reply = await relay.invoke(
      eventFor(new FakeSender(1)),
      request('src/index.ts', meta),
    );
    expect(reply).toMatchObject({
      ok: false,
      error: { kind: 'invalid_argument' },
    });
  }
  expect(trashed).toEqual([]);
  expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
});

it('refuses the App Advisor surface before the operation runs', async () => {
  const reply = await relay.invoke(eventFor(new FakeSender(2)), request('src'));
  expect(reply).toMatchObject({
    ok: false,
    // The relay's answer for a method outside the surface's allowlist.
    error: {
      kind: 'capability_unavailable',
      message: 'worker.filesystem.entry.delete is not available here.',
    },
  });
  expect(trashed).toEqual([]);
  expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
});

describe('without a retained outcome (CAN-4733)', () => {
  it('never directs a same-key replay when the relay deadline passes mid-effect', async () => {
    let finishTrash: () => void = () => undefined;
    const hanging = createDesktopRuntime({
      shutdownTimeoutMs: 250,
      platform: {
        os: process.platform === 'win32' ? 'win32' : 'darwin',
        trash: {
          trashItem: () =>
            new Promise<void>((resolve) => {
              finishTrash = resolve;
            }),
        },
      },
    });
    const shortRelay = createRendererRelay({
      bindingProvider: createInterimInMemoryBindingProvider(hanging),
      limits: { deadlineMs: 50 },
      resolveSurface: (event) => ({
        surface: 'main',
        caller: {
          principalId: 'local-desktop-renderer:main',
          clientInstanceId: `electron-web-contents:${event.sender.id}`,
          authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
          interfaceKind: 'desktop',
          grants: [...RENDERER_RELAY_GRANTS],
        },
      }),
    });
    try {
      const reply = await shortRelay.invoke(
        eventFor(new FakeSender(1)),
        request('src/index.ts'),
      );
      expect(reply).toMatchObject({
        ok: false,
        error: { kind: 'deadline_exceeded', retry: { kind: 'never' } },
      });
    } finally {
      finishTrash();
      shortRelay.dispose();
      await hanging.shutdown();
    }
  });

  it('never directs a same-key replay for an elapsed caller deadline', async () => {
    const reply = await relay.invoke(
      eventFor(new FakeSender(1)),
      request('src/index.ts', {
        idempotencyKey: 'relay-key-elapsed',
        deadlineAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    expect(reply).toMatchObject({
      ok: false,
      error: { kind: 'deadline_exceeded', retry: { kind: 'never' } },
    });
    expect(trashed).toEqual([]);
  });

  it('never directs a same-key replay once instructions drain', async () => {
    runtime.drainInstructions();
    const reply = await relay.invoke(
      eventFor(new FakeSender(1)),
      request('src/index.ts'),
    );
    expect(reply).toMatchObject({
      ok: false,
      error: { kind: 'unavailable', retry: { kind: 'never' } },
    });
    expect(trashed).toEqual([]);
  });
});

it('keeps the guards for relay callers', async () => {
  const reply = await relay.invoke(
    eventFor(new FakeSender(3)),
    request('../outside'),
  );
  expect(reply).toMatchObject({
    ok: false,
    error: {
      kind: 'invalid_argument',
      code: 'worker.filesystem.entry.invalidPath',
    },
  });
  expect(trashed).toEqual([]);
});

function transfer(
  operation: 'copy' | 'move',
  destinationRelativePath: string,
  meta: Record<string, unknown> = {
    idempotencyKey: `relay-key-${++keySequence}`,
  },
): { kind: 'request'; method: string; params: Record<string, unknown> } {
  const endpoints = {
    scope: { workspaceId: 'project-1', worktreeId: 'wt-1' },
    sourceFileRootId: 'project-1',
    destinationFileRootId: 'project-1',
    expectedSourceVersion: null,
    conflictPolicy: 'error',
    _meta: meta,
  };
  return {
    kind: 'request',
    method: `worker.filesystem.entry.${operation}`,
    params:
      operation === 'copy'
        ? {
            ...endpoints,
            sourceRelativePath: 'src/index.ts',
            destinationRelativePath,
          }
        : {
            ...endpoints,
            fromRelativePath: 'src/index.ts',
            toRelativePath: destinationRelativePath,
            expectedDestinationAbsent: true,
          },
  };
}

/** A reply's `<size>:<mtimeMs>` result version; throws on anything else. */
function versionOf(reply: CanopyCoreRelayReply): string {
  const value = reply.ok ? reply.value : undefined;
  const version =
    typeof value === 'object' && value !== null && 'version' in value
      ? value.version
      : undefined;
  if (typeof version !== 'string' || !/^\d+:\d+$/.test(version))
    throw new Error(`Expected a size:mtime version, got ${String(version)}`);
  return version;
}

it('lets the main surface copy and move through the relay', async () => {
  const main = eventFor(new FakeSender(1));
  const copied = await relay.invoke(main, transfer('copy', 'src/copy.ts'));
  expect(copied).toEqual({
    ok: true,
    value: {
      sourceFileRootId: 'project-1',
      sourceRelativePath: 'src/index.ts',
      destinationFileRootId: 'project-1',
      requestedDestinationRelativePath: 'src/copy.ts',
      destinationRelativePath: 'src/copy.ts',
      copiedEntryCount: 1,
      version: versionOf(copied),
    },
  });
  const moved = await relay.invoke(main, transfer('move', 'moved.ts'));
  expect(moved).toEqual({
    ok: true,
    value: {
      fromRelativePath: 'src/index.ts',
      toRelativePath: 'moved.ts',
      requestedToRelativePath: 'moved.ts',
      sourceFileRootId: 'project-1',
      destinationFileRootId: 'project-1',
      conflictPolicy: 'error',
      version: versionOf(moved),
    },
  });
  expect((await readdir(repo)).sort()).toEqual(['moved.ts', 'src']);
  expect(await readdir(join(repo, 'src'))).toEqual(['copy.ts']);
});

it('refuses copy and move on the App Advisor surface before they run', async () => {
  for (const operation of ['copy', 'move'] as const) {
    const reply = await relay.invoke(
      eventFor(new FakeSender(2)),
      transfer(operation, 'out.ts'),
    );
    expect(reply).toMatchObject({
      ok: false,
      error: {
        kind: 'capability_unavailable',
        message: `worker.filesystem.entry.${operation} is not available here.`,
      },
    });
  }
  expect(await readdir(repo)).toEqual(['src']);
  expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
});

it('keeps the copy and move guards for relay callers', async () => {
  const exists = {
    copy: 'worker.filesystem.destination.exists',
    move: 'worker.filesystem.entry.exists',
  };
  for (const operation of ['copy', 'move'] as const) {
    await expect(
      relay.invoke(eventFor(new FakeSender(3)), transfer(operation, 'src')),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'already_exists', code: exists[operation] },
    });
    await expect(
      relay.invoke(eventFor(new FakeSender(3)), transfer(operation, '../out')),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'invalid_argument',
        code: 'worker.filesystem.entry.invalidPath',
      },
    });
  }
  expect(await readdir(join(repo, 'src'))).toEqual(['index.ts']);
  expect(await readdir(tempRoot)).toEqual(['repo']);
});

it('never directs a same-key copy or move replay (CAN-4733)', async () => {
  for (const operation of ['copy', 'move'] as const) {
    const reply = await relay.invoke(
      eventFor(new FakeSender(1)),
      transfer(operation, 'out.ts', {
        idempotencyKey: `relay-key-elapsed-${operation}`,
        deadlineAt: new Date(Date.now() - 1_000).toISOString(),
      }),
    );
    expect(reply).toMatchObject({
      ok: false,
      error: { kind: 'deadline_exceeded', retry: { kind: 'never' } },
    });
  }
  expect(await readdir(repo)).toEqual(['src']);
});

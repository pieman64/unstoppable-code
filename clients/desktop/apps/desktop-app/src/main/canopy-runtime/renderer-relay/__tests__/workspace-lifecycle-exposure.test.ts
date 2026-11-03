import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CORE_LIFECYCLE_ARCHIVE_CALLER_REFUSED_MESSAGE,
  CORE_WORKSPACE_LIFECYCLE_CALLER_REFUSED_MESSAGE,
  type CoreWorkspaceLifecycleHost,
} from '@canopy/core-runtime/node/workspace/lifecycle-commands';
import { RENDERER_RELAY_GRANTS } from '../../../ipc/canopy-core-relay';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../desktop-runtime-identity';
import { createInterimInMemoryBindingProvider } from '../interim-in-memory-binding';
import { INTERFACE_RELAY_ALLOWLIST } from '../interface-allowlist.generated';
import {
  createRendererRelay,
  type RendererRelay,
  type RendererRelayEvent,
} from '../relay';

/**
 * W7b-3 (CAN-5551) and W7b-2a (CAN-5550), Q8: the main window's relay holds
 * the lifecycle write grants, because its grants are every relay
 * definition's, but the lifecycle caller allowlist refuses relay principals
 * before the host runs, until W9 projects them.
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

let dataDir = '';
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;
let relay: RendererRelay;
const reached: string[] = [];

beforeEach(async () => {
  reached.length = 0;
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'lifecycle-relay-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  const host: CoreWorkspaceLifecycleHost = {
    createWorkspace: () => {
      reached.push('createWorkspace');
      return Promise.reject(new Error('The relay reached the host.'));
    },
    importWorkspace: () => {
      reached.push('importWorkspace');
      return Promise.reject(new Error('The relay reached the host.'));
    },
    createWorktree: () => {
      reached.push('createWorktree');
      return Promise.reject(new Error('The relay reached the host.'));
    },
    archiveWorktree: () => {
      reached.push('archiveWorktree');
      return Promise.reject(new Error('The relay reached the host.'));
    },
    deleteWorkspace: () => {
      reached.push('deleteWorkspace');
      return Promise.reject(new Error('The relay reached the host.'));
    },
    deleteWorktree: () => {
      reached.push('deleteWorktree');
      return Promise.reject(new Error('The relay reached the host.'));
    },
    restoreArchive: () => {
      reached.push('restoreArchive');
      return Promise.reject(new Error('The relay reached the host.'));
    },
  };
  runtime = createDesktopRuntime({
    shutdownTimeoutMs: 250,
    workspaceLifecycleHost: host,
  });
  relay = createRendererRelay({
    bindingProvider: createInterimInMemoryBindingProvider(runtime),
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
});

afterEach(async () => {
  relay.dispose();
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

const event = (): RendererRelayEvent => {
  const sender = new FakeSender(1);
  return { sender, senderFrame: sender.mainFrame };
};

it.each<[string, Record<string, unknown>]>([
  [
    'core.workspace.create',
    {
      name: 'App',
      temporary: false,
      source: { kind: 'empty', workspaceKind: 'single_repo' },
    },
  ],
  [
    'core.workspace.import',
    {
      source: { kind: 'git_url', value: 'https://github.com/acme/app.git' },
      name: 'app',
    },
  ],
  ['core.worktree.create', { workspaceId: 'project-1' }],
])('refuses the main surface %s despite the grant', async (method, params) => {
  expect(RENDERER_RELAY_GRANTS).toEqual(
    expect.arrayContaining(['core.workspace.write', 'core.worktree.write']),
  );
  await expect(
    relay.invoke(event(), {
      kind: 'request',
      method,
      params: { ...params, _meta: { idempotencyKey: 'k-1' } },
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      kind: 'permission_denied',
      message: CORE_WORKSPACE_LIFECYCLE_CALLER_REFUSED_MESSAGE,
    },
  });
  expect(reached).toEqual([]);
});

it.each<[string, Record<string, unknown>]>([
  [
    'core.worktree.archive',
    { worktreeId: 'wt-1', expectedRevision: 0, archived: true },
  ],
  [
    'core.workspace.delete',
    {
      workspaceId: 'project-1',
      expectedRevision: 0,
      _meta: { idempotencyKey: 'relay-key' },
    },
  ],
  [
    'core.worktree.delete',
    {
      worktreeId: 'wt-1',
      expectedRevision: 0,
      _meta: { idempotencyKey: 'relay-key' },
    },
  ],
  [
    'core.archive.container.restore',
    {
      archiveId: 'archive-1',
      expectedRevision: 0,
      destinationScope: { workspaceId: 'project-1' },
      conflictPolicy: 'fail',
      _meta: { idempotencyKey: 'relay-key' },
    },
  ],
])(
  'refuses the main surface %s despite the grant and the allowlist',
  async (method, params) => {
    expect(INTERFACE_RELAY_ALLOWLIST.authority.instruction).toContain(method);
    expect(RENDERER_RELAY_GRANTS).toEqual(
      expect.arrayContaining([
        'core.worktree.write',
        'core.workspace.write',
        'core.archive.write',
      ]),
    );
    await expect(
      relay.invoke(event(), { kind: 'request', method, params }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        kind: 'permission_denied',
        message: CORE_LIFECYCLE_ARCHIVE_CALLER_REFUSED_MESSAGE,
        retry: { kind: 'never' },
      },
    });
    expect(reached).toEqual([]);
  },
);

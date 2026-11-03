import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CoreWorkspaceGuardedCommandName,
  CoreWorkspaceGuardedHost,
} from '@canopy/core-runtime/node/workspace/guarded-commands';
import { RENDERER_RELAY_GRANTS } from '../../../ipc/canopy-core-relay';
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

/**
 * W7b-1b (CAN-5549, OD-4) and W7b-1c (CAN-5568): the guarded commands keep
 * W7a-2's metadata rule, so grants alone admit a caller. The main window's
 * relay reaches the host for all seven; the App Advisor surface is not
 * allowlisted for any.
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

const PARAMS: Record<
  CoreWorkspaceGuardedCommandName,
  Record<string, unknown>
> = {
  'core.workspace.hooks.update': {
    workspaceId: 'project-1',
    change: { kind: 'replace', hooks: {} },
  },
  'core.workspace.plugins.update': {
    workspaceId: 'project-1',
    change: {
      kind: 'setDefaults',
      defaultPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      },
    },
  },
  'core.workspace.retention.update': {
    workspaceId: 'project-1',
    patch: { archiveRetentionDays: 7 },
  },
  'core.workspace.cowork.update': {
    workspaceId: 'project-1',
    settings: { description: 'Notes' },
  },
  'core.worktree.update': {
    worktreeId: 'wt',
    expectedRevision: 2,
    patch: { pinned: true },
  },
  'core.worktree.reorder': {
    workspaceId: 'project-1',
    activeWorktreeId: 'wt',
    overWorktreeId: 'other',
  },
  'core.worktree.hooks.setPaused': {
    workspaceId: 'project-1',
    worktreeId: 'wt',
    change: { kind: 'pause', hookKeys: ['project:manual'] },
  },
};

const HOST_METHOD: Record<
  CoreWorkspaceGuardedCommandName,
  keyof CoreWorkspaceGuardedHost
> = {
  'core.workspace.hooks.update': 'updateHooks',
  'core.workspace.plugins.update': 'updatePlugins',
  'core.workspace.retention.update': 'updateRetention',
  'core.workspace.cowork.update': 'updateCoworkSettings',
  'core.worktree.update': 'updateWorktree',
  'core.worktree.reorder': 'reorderWorktree',
  'core.worktree.hooks.setPaused': 'setWorktreeHooksPaused',
};

let dataDir = '';
let originalDataDir: string | undefined;
let runtime: DesktopCanopyDispatcher;
const reached: string[] = [];

function relayFor(surface: 'main' | 'app-advisor'): RendererRelay {
  return createRendererRelay({
    bindingProvider: createInterimInMemoryBindingProvider(runtime),
    resolveSurface: (event) => ({
      surface,
      caller: {
        principalId: `local-desktop-renderer:${surface}`,
        clientInstanceId: `electron-web-contents:${event.sender.id}`,
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'desktop',
        grants: [...RENDERER_RELAY_GRANTS],
      },
    }),
  });
}

const relays: RendererRelay[] = [];

beforeEach(async () => {
  reached.length = 0;
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'guarded-relay-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  const refuse = (name: string) => (): Promise<never> => {
    reached.push(name);
    return Promise.reject(new Error('Stub host.'));
  };
  const host: CoreWorkspaceGuardedHost = {
    updateHooks: refuse('updateHooks'),
    updatePlugins: refuse('updatePlugins'),
    updateRetention: refuse('updateRetention'),
    updateCoworkSettings: refuse('updateCoworkSettings'),
    updateWorktree: refuse('updateWorktree'),
    reorderWorktree: refuse('reorderWorktree'),
    setWorktreeHooksPaused: refuse('setWorktreeHooksPaused'),
  };
  runtime = createDesktopRuntime({
    shutdownTimeoutMs: 250,
    workspaceGuardedHost: host,
  });
});

afterEach(async () => {
  for (const relay of relays.splice(0)) relay.dispose();
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

const event = (): RendererRelayEvent => {
  const sender = new FakeSender(1);
  return { sender, senderFrame: sender.mainFrame };
};

const invoke = (
  surface: 'main' | 'app-advisor',
  method: CoreWorkspaceGuardedCommandName,
): Promise<unknown> => {
  const relay = relayFor(surface);
  relays.push(relay);
  return relay.invoke(event(), {
    kind: 'request',
    method,
    params: { ...PARAMS[method], _meta: { idempotencyKey: 'k-1' } },
  });
};

const OPERATIONS = Object.keys(PARAMS) as CoreWorkspaceGuardedCommandName[];

it.each(OPERATIONS)('the main surface reaches the %s host', async (method) => {
  await invoke('main', method);
  expect(reached).toEqual([HOST_METHOD[method]]);
});

it.each(OPERATIONS)(
  'the App Advisor surface cannot call %s',
  async (method) => {
    await expect(invoke('app-advisor', method)).resolves.toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
    expect(reached).toEqual([]);
  },
);

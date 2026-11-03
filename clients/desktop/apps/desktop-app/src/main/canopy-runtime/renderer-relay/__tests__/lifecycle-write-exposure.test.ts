import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CoreSourceCompositionHost } from '@canopy/core-runtime/node/workspace/source-composition-commands';
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
 * W7b-4 (CAN-5552, Q8): the keyed source, composition, rename and fork
 * lifecycles are registered on the desktop dispatcher, and the main window's
 * relay holds their write grants, because its grants are every relay
 * definition's. The lifecycle caller rule refuses relay principals before any
 * read, so the relay never reaches their host.
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
const reached: string[] = [];

function relayWith(grants: typeof RENDERER_RELAY_GRANTS): RendererRelay {
  return createRendererRelay({
    bindingProvider: createInterimInMemoryBindingProvider(runtime),
    resolveSurface: (event) => ({
      surface: 'main',
      caller: {
        principalId: 'local-desktop-renderer:main',
        clientInstanceId: `electron-web-contents:${event.sender.id}`,
        authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
        interfaceKind: 'desktop',
        grants: [...grants],
      },
    }),
  });
}

beforeEach(async () => {
  reached.length = 0;
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'lifecycle-relay-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  const record = (name: string) => (): Promise<never> => {
    reached.push(name);
    return Promise.reject(new Error(`The relay reached ${name}.`));
  };
  const host: CoreSourceCompositionHost = {
    initializeSourceRepo: record('initializeSourceRepo'),
    convertType: record('convertType'),
    applySourceChanges: record('applySourceChanges'),
    promote: record('promote'),
    renameBranch: record('renameBranch'),
    fork: record('fork'),
  };
  runtime = createDesktopRuntime({
    shutdownTimeoutMs: 250,
    sourceCompositionHost: host,
  });
});

afterEach(async () => {
  await runtime.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

const event = (): RendererRelayEvent => {
  const sender = new FakeSender(1);
  return { sender, senderFrame: sender.mainFrame };
};

// The relay's generated allowlist lists every name (runtime-profiles `*`).
const REQUESTS: Array<[string, Record<string, unknown>, string]> = [
  [
    'core.workspace.sourceRepo.initialize',
    { workspaceId: 'a' },
    'permission_denied',
  ],
  [
    'core.workspace.type.convert',
    { workspaceId: 'a', targetKind: 'multi_repo' },
    'permission_denied',
  ],
  [
    'core.workspace.sourceChanges.apply',
    { workspaceId: 'a', target: { mode: 'existing', worktreeId: 'w' } },
    'permission_denied',
  ],
  [
    'core.workspace.composition.combine',
    { optionId: 'o', expectedRevision: 0, moveChats: false },
    'permission_denied',
  ],
  [
    'core.workspace.composition.split',
    {
      previewId: 'p',
      expectedWorkspaceRevision: 0,
      approvedDestructiveItems: [],
    },
    'permission_denied',
  ],
  [
    'core.workspace.composition.promote',
    { workspaceId: 'a', expectedRevision: 0, name: 'Kept' },
    'permission_denied',
  ],
  [
    'core.worktree.branch.rename',
    { workspaceId: 'a', worktreeId: 'w', branchName: 'renamed' },
    'permission_denied',
  ],
  [
    'core.sharedContainer.fork',
    {
      containerId: 'c',
      revisionId: 'r',
      sourceOwnerDisplayName: 'Ada',
      destination: { kind: 'new-workspace', owner: { kind: 'personal' } },
    },
    'permission_denied',
  ],
];

it.each(REQUESTS)(
  '%s from the main surface is refused before the host despite the grant',
  async (method, params, kind) => {
    expect(RENDERER_RELAY_GRANTS).toEqual(
      expect.arrayContaining(['core.workspace.write', 'core.worktree.write']),
    );
    const relay = relayWith(RENDERER_RELAY_GRANTS);
    try {
      await expect(
        relay.invoke(event(), {
          kind: 'request',
          method,
          params: { ...params, _meta: { idempotencyKey: 'relay-key' } },
        }),
      ).resolves.toMatchObject({ ok: false, error: { kind } });
    } finally {
      relay.dispose();
    }
    expect(reached).toEqual([]);
  },
);

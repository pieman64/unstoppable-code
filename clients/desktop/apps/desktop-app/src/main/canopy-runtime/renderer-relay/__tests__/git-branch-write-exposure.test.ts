import { EventEmitter } from 'node:events';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerGitBranchWriteHost } from '@canopy/core-runtime/node/git';
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
 * CAN-4108 Q8: the main window's relay holds `worker.git.write`, because its
 * grants are every relay definition's, but the branch writes' caller
 * allowlist refuses relay principals before a checkout or repository
 * resolves (CAN-5516 adds rename and delete).
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
const resolved: unknown[] = [];

beforeEach(async () => {
  resolved.length = 0;
  dataDir = await realpath(await mkdtemp(join(tmpdir(), 'git-write-relay-')));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = dataDir;
  const host: WorkerGitBranchWriteHost<string> = {
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    resolveCheckout: (scope) => {
      resolved.push(scope);
      return Promise.reject(new Error('The relay reached the checkout.'));
    },
    port: () => {
      throw new Error('The relay reached the Git port.');
    },
    resolveRepository: (scope) => {
      resolved.push(scope);
      return Promise.reject(new Error('The relay reached the repository.'));
    },
    deletePort: () => {
      throw new Error('The relay reached the Git port.');
    },
  };
  runtime = createDesktopRuntime({
    shutdownTimeoutMs: 250,
    workerGitBranchWriteHost: host,
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

const scope = { workspaceId: 'project-1', worktreeId: 'wt-1' };

it('refuses the main surface branch checkout and creation despite the grant', async () => {
  expect(RENDERER_RELAY_GRANTS).toContain('worker.git.write');
  await expect(
    relay.invoke(event(), {
      kind: 'request',
      method: 'worker.git.checkout',
      params: { scope, branch: 'main' },
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      kind: 'permission_denied',
      code: 'worker.git.checkout.callerRefused',
    },
  });
  await expect(
    relay.invoke(event(), {
      kind: 'request',
      method: 'worker.git.branch.create',
      params: {
        scope,
        name: 'feature',
        startPoint: { branch: 'main', remote: false },
      },
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      kind: 'permission_denied',
      code: 'worker.git.branch.callerRefused',
    },
  });
  expect(resolved).toEqual([]);
});

it('refuses the main surface branch rename and delete despite the grant', async () => {
  await expect(
    relay.invoke(event(), {
      kind: 'request',
      method: 'worker.git.branch.rename',
      params: { scope, name: 'renamed' },
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      kind: 'permission_denied',
      code: 'worker.git.branch.callerRefused',
    },
  });
  await expect(
    relay.invoke(event(), {
      kind: 'request',
      method: 'worker.git.branch.delete',
      params: {
        scope: { workspaceId: 'project-1' },
        branch: 'old',
        deletion: { kind: 'force' },
      },
    }),
  ).resolves.toMatchObject({
    ok: false,
    error: {
      kind: 'permission_denied',
      code: 'worker.git.branch.callerRefused',
    },
  });
  expect(resolved).toEqual([]);
});

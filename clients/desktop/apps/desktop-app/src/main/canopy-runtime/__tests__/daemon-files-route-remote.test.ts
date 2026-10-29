import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { RemoteHostSession } from '../../remote-control/host/host-session';
import { RemoteUploadStore } from '../../remote-control/host/uploads';
import {
  REMOTE_METHODS,
  type HelloResult,
} from '../../remote-control/remote-protocol';
import { RpcPeer } from '../../remote-control/transport/rpc-peer';
import {
  FakeBridge,
  FakeMainWindow,
  TEST_VERSION,
} from '../../remote-control/__tests__/host-fakes';
import { InMemoryRelayHub } from '../../remote-control/__tests__/in-memory-relay';
import {
  createTestDevice,
  openControlSession,
} from '../../remote-control/__tests__/session-pair';
import {
  deriveDesktopIpcCaller,
  type DesktopIpcFrame,
  type DesktopIpcSender,
} from '../desktop-ipc-caller';
import {
  AUTHORITY,
  createRouteHarness,
  FakeSender,
  type RouteHarness,
} from './daemon-files-route-harness';

/**
 * Remote-control bridge Files reads stay on the direct reader by Mike's
 * decision, with the flag on. Each surface bridge comes from a real
 * RemoteHostSession, and every caller is derived by the production IPC caller
 * derivation from the bridge registry, as `index.ts` wires it.
 */

const SINGLE = { workspaceId: 'single', worktreeId: 'task' };
const CONTROLLER = 'laptop';
const PAGE = 'app://renderer/index.html';

/** A `WebContents` stand-in with the main frame the caller derivation reads. */
class FramedSender extends FakeSender implements DesktopIpcSender {
  public readonly mainFrame: DesktopIpcFrame = {
    url: PAGE,
    detached: false,
    isDestroyed: () => false,
  };
  public getURL(): string {
    return PAGE;
  }
}

class SenderBridge extends FakeBridge {
  public constructor(
    public readonly sender: FramedSender,
    private readonly registry: Map<number, string>,
  ) {
    super();
    registry.set(sender.id, CONTROLLER);
  }

  public override destroy(): void {
    if (this.destroyed) return;
    this.registry.delete(this.sender.id);
    this.sender.destroy();
    super.destroy();
  }
}

let h: RouteHarness | undefined;
const dirs: string[] = [];
let senderIds = 700;

afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

async function remoteSession(
  registry: Map<number, string>,
): Promise<SenderBridge[]> {
  const hub = new InMemoryRelayHub();
  const laptop = createTestDevice(hub, CONTROLLER);
  const desktop = createTestDevice(hub, 'desktop');
  const { initiator, responder } = await openControlSession(laptop, desktop);
  const uploadsDir = mkdtempSync(join(tmpdir(), 'c4305-uploads-'));
  dirs.push(uploadsDir);
  const bridges: SenderBridge[] = [];
  const host = new RemoteHostSession({
    session: responder,
    createBridge: (): Promise<SenderBridge> => {
      const bridge = new SenderBridge(
        new FramedSender((senderIds += 1)),
        registry,
      );
      bridges.push(bridge);
      return Promise.resolve(bridge);
    },
    mainWindowPushes: new FakeMainWindow(),
    uploads: new RemoteUploadStore(uploadsDir),
    readFile: (): Promise<never> => Promise.reject(new Error('unused')),
    disposition: getRemoteChannelDisposition,
    isAuthorized: (): boolean => true,
    version: TEST_VERSION,
    hello: (): Pick<HelloResult, 'name' | 'platform'> => ({
      name: 'desktop',
      platform: 'linux',
    }),
    onClose: (): void => undefined,
  });
  const controller = new RpcPeer(initiator, {
    onRequest: (): Promise<never> => Promise.reject(new Error('unused')),
    onEvent: (): void => undefined,
  });
  await controller.request(REMOTE_METHODS.hello, { version: TEST_VERSION });
  await host.bridgeFor('main');
  await host.bridgeFor('app-advisor');
  return bridges;
}

function derivedCaller(
  sender: FramedSender,
  registry: Map<number, string>,
  windows: FramedSender[],
): CanopyCallerDescriptor {
  return deriveDesktopIpcCaller(
    { sender, senderFrame: sender.mainFrame },
    {
      getAppWindows: () =>
        windows.map((webContents) => ({
          isDestroyed: () => false,
          webContents,
        })),
      packagedRendererUrls: [PAGE],
      resolveRemoteBridgeSender: (candidate) =>
        registry.get(candidate.id) ?? null,
    },
  );
}

describe('remote-control bridge Files reads (direct by decision)', () => {
  it('keeps both surface bridges direct with the flag on, with zero daemon contact', async () => {
    h = await createRouteHarness();
    const harness = h;
    const registry = new Map<number, string>();
    const bridges = await remoteSession(registry);
    expect(bridges).toHaveLength(2);
    for (const bridge of bridges) {
      const caller = derivedCaller(bridge.sender, registry, []);
      expect(caller.clientInstanceId).toBe(`remote-bridge:${bridge.sender.id}`);
      await harness.roots(SINGLE, bridge.sender, caller);
      await harness.directory(SINGLE, 'single', '', bridge.sender, caller);
      expect(bridge.sender.retiringListeners()).toBe(0);
    }
    expect(harness.connectionsFactory).not.toHaveBeenCalled();
    expect(harness.hostContext).not.toHaveBeenCalled();
    expect(harness.connections.gets).toHaveLength(0);
    expect(harness.daemon.queries).toHaveLength(0);
    expect(harness.direct.roots).toHaveBeenCalledTimes(2);
    expect(harness.direct.directory).toHaveBeenCalledTimes(2);
  });

  it('still routes the local window, under its own caller, beside live bridges', async () => {
    h = await createRouteHarness();
    const harness = h;
    const registry = new Map<number, string>();
    const bridges = await remoteSession(registry);
    const window = new FramedSender((senderIds += 1));
    const local = derivedCaller(window, registry, [window]);
    await harness.roots(SINGLE, window, local);
    for (const bridge of bridges)
      await harness.roots(
        SINGLE,
        bridge.sender,
        derivedCaller(bridge.sender, registry, [window]),
      );
    expect(harness.connections.gets.map((get) => get.caller)).toEqual([
      { ...local, authorityId: AUTHORITY },
    ]);
    expect(harness.daemon.queries).toHaveLength(1);
    expect(harness.direct.roots).toHaveBeenCalledTimes(2);
  });
});

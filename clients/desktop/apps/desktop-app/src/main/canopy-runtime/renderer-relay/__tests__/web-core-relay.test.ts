import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import { CanopyTransportError } from '@canopy/core-transport';
import type { RelayBindingProvider } from '../definitions';
import {
  createRendererRelay,
  type RendererRelayEvent,
  type RendererRelaySurfaceResolution,
} from '../relay';
import { routeRendererRelayRequest } from '../relay-authority';
import type { RendererRelaySurface } from '../surface-allowlist';
import { WEB_CORE_RELAY_OPERATIONS } from '../web-core-relay-definitions';
import { createWebCoreRendererRelay } from '../../../ipc/canopy-core-relay';

const CALLER: CanopyCallerDescriptor = {
  principalId: 'local-desktop',
  clientInstanceId: 'main',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.chat.read', 'core.runtime.read'],
};

function rendererEvent(): RendererRelayEvent {
  const frame = {
    url: 'app://canopy/index.html',
    detached: false,
    isDestroyed: (): boolean => false,
  };
  return {
    sender: {
      id: 1,
      mainFrame: frame,
      getURL: () => frame.url,
      isDestroyed: () => false,
      on: () => undefined,
      removeListener: () => undefined,
    },
    senderFrame: frame,
  };
}

const unreachable = (): Promise<never> =>
  Promise.reject(
    new CanopyTransportError({
      kind: 'unavailable',
      message: 'Not connected in this test.',
      retry: { kind: 'never' },
    }),
  );

function webCoreRelay(
  bindingProvider: RelayBindingProvider,
  surface: RendererRelaySurface = 'main',
): ReturnType<typeof createRendererRelay> {
  return createWebCoreRendererRelay({
    bindingProvider,
    resolveSurface: (): RendererRelaySurfaceResolution => ({
      surface,
      caller: CALLER,
    }),
  });
}

describe('web core authority on the canopy-core:relay channel (CAN-4185 PR-C)', () => {
  it('a web-core request is refused for an operation outside WEB_CORE_RELAY_OPERATIONS', async () => {
    const binding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const relay = webCoreRelay(binding);
    const event = rendererEvent();
    // Registered core operations, but cloud worktree features or admin.
    for (const method of [
      'core.workspace.create',
      'core.git.status.get',
      'core.runtime.initialize',
      'worker.filesystem.file.read',
    ]) {
      expect(WEB_CORE_RELAY_OPERATIONS.has(method)).toBe(false);
      await expect(
        relay.invoke(event, { kind: 'request', method, params: {} }),
      ).resolves.toMatchObject({
        ok: false,
        error: { kind: 'capability_unavailable' },
      });
    }
    await expect(
      relay.invoke(event, {
        kind: 'openStream',
        method: 'core.events.subscribe',
        params: {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
    // App Advisor gets no web core access, even for an allowed operation.
    const advisor = webCoreRelay(binding, 'app-advisor');
    await expect(
      advisor.invoke(rendererEvent(), {
        kind: 'request',
        method: 'core.chat.list',
        params: {},
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
    expect(binding).not.toHaveBeenCalled();

    // An allowed operation does reach the web core binding.
    await relay.invoke(event, {
      kind: 'request',
      method: 'core.chat.list',
      params: {},
    });
    expect(binding).toHaveBeenCalledTimes(1);
    relay.dispose();
    advisor.dispose();
  });

  it('core.chat.live.events reaches the web core only (CAN-5984)', async () => {
    const localBinding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const webCoreBinding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const local = createRendererRelay({
      bindingProvider: localBinding,
      resolveSurface: () => ({ surface: 'main', caller: CALLER }),
    });
    const webCore = webCoreRelay(webCoreBinding);
    const open = {
      kind: 'openStream',
      method: 'core.chat.live.events',
      params: {
        scope: { workspaceId: 'ws-1', worktreeId: 'task-1', chatId: 'chat-1' },
      },
    } as const;
    // The desktop core serves no live replies.
    await expect(
      routeRendererRelayRequest({ local, webCore }, rendererEvent(), open),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: 'capability_unavailable' },
    });
    expect(localBinding).not.toHaveBeenCalled();
    await routeRendererRelayRequest({ local, webCore }, rendererEvent(), {
      ...open,
      authority: 'web-core',
    });
    expect(webCoreBinding).toHaveBeenCalledTimes(1);
    expect(localBinding).not.toHaveBeenCalled();
    local.dispose();
    webCore.dispose();
  });

  it('a local request never reaches the web-core binding', async () => {
    const localBinding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const webCoreBinding = jest.fn<
      ReturnType<RelayBindingProvider>,
      Parameters<RelayBindingProvider>
    >(unreachable);
    const local = createRendererRelay({
      bindingProvider: localBinding,
      resolveSurface: () => ({ surface: 'main', caller: CALLER }),
    });
    const webCore = webCoreRelay(webCoreBinding);
    const relays = { local, webCore };
    const event = rendererEvent();

    // Operations both relays allow, so a misrouted request would reach the web core.
    for (const input of [
      { kind: 'request', method: 'core.chat.list', params: {} },
      { kind: 'request', method: 'core.workspace.list', params: {} },
      { kind: 'openStream', method: 'core.chat.events', params: {} },
      { kind: 'close' },
    ])
      await routeRendererRelayRequest(relays, event, input);

    expect(localBinding).toHaveBeenCalled();
    expect(webCoreBinding).not.toHaveBeenCalled();
    local.dispose();
    webCore.dispose();
  });
});

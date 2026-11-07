import { app, ipcMain, webContents } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import type {
  CanopyCoreRelayRequest,
  CanopyCoreRelayReply,
} from '../../shared/canopy-core-relay';
import { registerIpcHandler } from './register';
import {
  sendInterfaceToolCancellation,
  sendInterfaceToolRequest,
  setInterfaceToolReplyHandler,
} from './app-advisor';
import { createDesktopInterfaceLeases } from '../canopy-runtime/interface-tools/desktop-interface-leases';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import { RELAY_DEFINITIONS } from '../canopy-runtime/renderer-relay/definitions';
import {
  createInterimInMemoryBindingProvider,
  type RelayCapabilities,
} from '../canopy-runtime/renderer-relay/interim-in-memory-binding';
import {
  createRendererRelay,
  type RendererRelayEvent,
  type RendererRelaySurfaceResolution,
} from '../canopy-runtime/renderer-relay/relay';

export const RENDERER_RELAY_GRANTS: readonly CanopyCallerDescriptor['grants'][number][] =
  Array.from(
    new Set(
      [
        ...Object.values(RELAY_DEFINITIONS.queries),
        ...Object.values(RELAY_DEFINITIONS.instructions),
        ...Object.values(RELAY_DEFINITIONS.streams),
      ].flatMap((definition) => definition.requiredGrants),
    ),
  );

export function registerCanopyCoreRelayHandlers(
  dispatcher: DesktopCanopyDispatcher,
  resolveSurface: (event: RendererRelayEvent) => RendererRelaySurfaceResolution,
): () => void {
  // Interim connection-scoped declarations; durable ownership waits for a relay daemon binding (W3 exit, CAN-3166).
  const registrations = new Map<string, RelayCapabilities>();
  const interfaceLeases = createDesktopInterfaceLeases({
    registry: dispatcher.interfaceTools,
    webContentsFromId: (id) => webContents.fromId(id) ?? null,
    send: (target, request) => {
      const contents = webContents.fromId(target.id);
      return contents ? sendInterfaceToolRequest(contents, request) : false;
    },
    sendCancellation: (target, cancellation) => {
      const contents = webContents.fromId(target.id);
      return contents
        ? sendInterfaceToolCancellation(contents, cancellation)
        : false;
    },
  });
  setInterfaceToolReplyHandler((senderId, response) =>
    interfaceLeases.reply(senderId, response) === 'unknown_call'
      ? 'not_claimed'
      : 'claimed',
  );
  const relay = createRendererRelay({
    bindingProvider: createInterimInMemoryBindingProvider(dispatcher, {
      onCapabilities: (caller, capabilities) => {
        if (capabilities.length === 0)
          registrations.delete(caller.clientInstanceId);
        else registrations.set(caller.clientInstanceId, capabilities);
      },
      onTools: {
        register: interfaceLeases.register,
        unregister: interfaceLeases.unregister,
      },
    }),
    resolveSurface,
    clientVersion: app.getVersion(),
  });
  registerIpcHandler<[CanopyCoreRelayRequest], CanopyCoreRelayReply>(
    IPC_CHANNELS.canopyCoreRelay,
    (event, input) => relay.invoke(event, input),
  );
  return () => {
    ipcMain.removeHandler(IPC_CHANNELS.canopyCoreRelay);
    setInterfaceToolReplyHandler(null);
    interfaceLeases.dispose();
    relay.dispose();
    registrations.clear();
  };
}

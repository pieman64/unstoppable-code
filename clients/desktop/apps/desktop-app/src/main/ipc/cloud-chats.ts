import { app } from 'electron';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { SettingsOperationError } from '@canopy/protocol/settings';
import {
  IPC_CHANNELS,
  type CloudChatAttachmentUploadResult,
  type CloudChatsReconnectResult,
} from '@canopy/desktop-shared/types';
import { getFeatureFlagService } from '../feature-flags';
import { readCanopyCloudAccountWithStatus } from '../lib/canopy-cloud-account-store';
import type { SettingsBridgeSession } from '../canopy-cloud/settings-session';
import type { WebCoreBindingOptions } from '../canopy-cloud/web-core-connection';
import { createWebCoreReconnect } from '../canopy-cloud/web-core-reconnect';
import {
  createCloudChatAttachmentUpload,
  createWebCoreAttachmentSender,
} from '../canopy-cloud/cloud-chat-attachments';
import type {
  RendererRelayEvent,
  RendererRelaySurfaceResolution,
} from '../canopy-runtime/renderer-relay/relay';
import { registerIpcHandler } from './register';

function cloudChatsEnabled(): boolean {
  return getFeatureFlagService().isEnabled(
    CLIENT_FEATURE_FLAGS.canopyDesktopCloudChats.key,
  );
}

async function signedInAccountId(): Promise<string | null> {
  const read = await readCanopyCloudAccountWithStatus();
  return (read.status === 'ok' ? read.entry?.account?.id : null) ?? null;
}

// Loaded off the startup path, as the hosted settings handlers do.
async function acquireBridge(
  accountId: string,
): Promise<SettingsBridgeSession> {
  const { acquireSettingsBridgeSession } =
    await import('../canopy-cloud/settings-session');
  return acquireSettingsBridgeSession(accountId);
}

/** Main's web core binding: `canopyDesktopCloudChats` and the signed-in account's bridge. */
export function desktopWebCoreBindingOptions(): WebCoreBindingOptions {
  return {
    isEnabled: cloudChatsEnabled,
    acquireSession: async () => {
      const accountId = await signedInAccountId();
      if (accountId === null)
        throw new SettingsOperationError({ code: 'unauthenticated' });
      return acquireBridge(accountId);
    },
  };
}

/**
 * The cloud chats Reconnect action (CAN-4185); its throttle lives in main.
 * Only the app's own main window may remint, by the same trusted-surface check
 * that keeps the web-core relay main-window only.
 */
export function registerCloudChatsHandlers(
  resolveSurface: (event: RendererRelayEvent) => RendererRelaySurfaceResolution,
): void {
  const reconnect = createWebCoreReconnect({
    isEnabled: cloudChatsEnabled,
    currentAccountId: signedInAccountId,
    acquireSession: acquireBridge,
  });
  const requireMainWindow = (event: RendererRelayEvent): void => {
    let trusted = false;
    try {
      trusted = resolveSurface(event).surface === 'main';
    } catch {
      // An untrusted sender is refused below.
    }
    if (!trusted) throw new Error('Untrusted cloud chats sender.');
  };
  registerIpcHandler<[], CloudChatsReconnectResult>(
    IPC_CHANNELS.cloudChatsReconnect,
    (event) => {
      requireMainWindow(event);
      return reconnect();
    },
  );
  // The renderer sends the bytes of a file the user picked or dropped; main
  // uploads them on its own web core connection (CAN-5972, CAN-5988).
  const binding = desktopWebCoreBindingOptions();
  const upload = createCloudChatAttachmentUpload({
    isEnabled: binding.isEnabled,
    send: createWebCoreAttachmentSender(binding, app.getVersion()),
  });
  registerIpcHandler<[unknown, unknown], CloudChatAttachmentUploadResult>(
    IPC_CHANNELS.cloudChatsUploadAttachment,
    (event, target, file) => {
      requireMainWindow(event);
      return upload(target, file);
    },
  );
}

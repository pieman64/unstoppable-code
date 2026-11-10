import type { BrowserWindow } from 'electron';
import type * as SettingsModule from '../ipc/settings';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getFeatureFlagService } from '../feature-flags';
import { getRemoteControlRuntime } from '../remote-control/electron-remote-control';
import type { AdvisorCredentialActionHost } from './advisor-credential-actions';

/**
 * The owners the window's Settings IPC handlers call (CAN-6008), as App
 * Advisor's main executors. OpenCode and Ollama act for the main window, as
 * the window's own calls do.
 */
export function mainAdvisorCredentialActionHost(options: {
  getMainWindow: () => BrowserWindow | null;
  revealOllamaSettings: () => Promise<void>;
}): AdvisorCredentialActionHost {
  const settings = (): Promise<typeof SettingsModule> =>
    import('../ipc/settings');
  return {
    loadCloudAccount: async () => {
      const { loadCanopyCloudAccountPublicState } =
        await import('../lib/canopy-cloud-account-store');
      return loadCanopyCloudAccountPublicState();
    },
    validateCloudApiKey: async (request) =>
      (await settings()).validateCanopyCloudApiKeyForWindow(request),
    saveCloudApiKey: async (request) =>
      (await settings()).saveCanopyCloudApiKeyForWindow(request),
    clearCloudApiKey: async () =>
      (await settings()).disconnectCanopyCloudAccount(),
    startCloudOAuthLogin: async () =>
      (await settings()).startCanopyCloudOAuthLoginForWindow(),
    cancelCloudOAuthLogin: async () =>
      (await settings()).cancelCanopyCloudOAuthLoginForWindow(),
    disconnectCloudAccount: async () =>
      (await settings()).disconnectCanopyCloudAccount(),
    portalEnabled: () =>
      getFeatureFlagService().isEnabled(
        CLIENT_FEATURE_FLAGS.canopyPortalEnabled.key,
      ),
    startPortal: async () => {
      const { startCanopyPortal } =
        await import('../portal/portal-session-manager');
      return startCanopyPortal();
    },
    stopPortal: async () => {
      const { stopCanopyPortal } =
        await import('../portal/portal-session-manager');
      return stopCanopyPortal();
    },
    remoteControl: () => {
      const service = getRemoteControlRuntime()?.service;
      return service
        ? {
            getState: () => service.getState({ discover: false }),
            setAllowIncoming: (allow) => service.setAllowIncoming(allow),
          }
        : null;
    },
    openCode: async (operation, signal) => {
      const window = options.getMainWindow();
      if (!window || window.isDestroyed())
        throw new Error('OpenCode connection is unavailable on this surface.');
      const { runOpenCodeConnectionForWindow } =
        await import('../ipc/opencode-connection');
      return runOpenCodeConnectionForWindow(window, operation, signal);
    },
    revealOllamaSettings: options.revealOllamaSettings,
    installOllama: async () => {
      const { installOllamaForWindow } = await import('../ipc/ollama');
      return installOllamaForWindow(options.getMainWindow);
    },
  };
}

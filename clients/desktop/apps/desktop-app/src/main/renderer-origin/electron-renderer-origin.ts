import { protocol, session, WebContentsView } from 'electron';
import { RENDERER_SCHEME } from '@canopy/desktop-shared/lib/renderer-scheme';
import {
  createOriginStorageBridge,
  type BridgeContents,
} from './origin-storage-bridge';
import type { OriginStorageBridge } from './renderer-origin-migration';
import { createRendererSchemeHandler } from './renderer-scheme-handler';

/**
 * Electron bindings for the renderer scheme. Kept apart from the policy
 * modules so those stay testable without Electron.
 */

/**
 * Registers the scheme's privileges. Electron only accepts this before the
 * app is ready, and only once, so main calls it at module scope on every
 * launch; it is an in-memory registration with no I/O, and without a
 * handler (registered only when a launch uses the scheme) nothing can load
 * from it.
 *
 * - `standard` + `secure`: a real origin with web storage, treated like
 *   HTTPS (secure context), which `codeCache` requires;
 * - `supportFetchAPI` + `corsEnabled`: Vite's `crossorigin` module scripts
 *   and same-origin `fetch` of bundled assets;
 * - `codeCache`: V8 keeps compiled code for scripts from this scheme.
 *
 * Not granted: `bypassCSP`, `allowServiceWorkers`, `stream`.
 */
export function registerRendererSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        codeCache: true,
      },
    },
  ]);
}

/**
 * Serves the scheme from `rootDir` on the default session only, the one
 * the main and App Advisor windows use. In-app browser sessions never get
 * a handler, so their pages cannot load it.
 */
export function registerElectronRendererSchemeHandler(options: {
  rootDir: string;
  onError: (error: unknown) => void;
}): void {
  const handle = createRendererSchemeHandler(options);
  protocol.handle(RENDERER_SCHEME, (request) => handle(request));
}

/**
 * The storage bridge's pages: unattached web contents on the default
 * session (the app windows' storage), sandboxed, isolated, with no preload
 * and no Node. Being unattached, they never count as a window, so they
 * cannot trigger quit-on-last-window and receive no window broadcasts.
 */
export function createElectronOriginStorageBridge(
  rendererDir: string,
): OriginStorageBridge {
  return createOriginStorageBridge({
    rendererDir,
    createContents: (): BridgeContents => {
      const view = new WebContentsView({
        webPreferences: {
          session: session.defaultSession,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          spellcheck: false,
          backgroundThrottling: false,
        },
      });
      return view.webContents;
    },
    flushStorage: () => {
      session.defaultSession.flushStorageData();
    },
  });
}

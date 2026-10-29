// Runtime snapshot-injection seeder for the in-app browser (Doc 13 §4; Doc 2
// Spec 10 / PR 808). Like `seedResourceSnapshot`, this injects state into an
// ALREADY-RUNNING app by emitting the same IPC event the main process
// broadcasts, so the renderer `browserStore` updates without creating a real
// embedded browser view.
//
// Source of truth for the channel + shape:
//   - Broadcast: `apps/desktop-app/src/main/browser/browser-service.ts` calls
//     `sendToWindow(window, IPC_CHANNELS.browserEvent, event)` and emits
//     `{ type: 'snapshot', browserId, snapshot }` (and `'load-failed'` with the
//     same shape) for browser state changes.
//   - Channel constant: `packages/desktop-shared/src/types.ts`
//     `browserEvent: 'browser:event'`.
//   - Preload: `apps/desktop-app/src/preload/index.ts` `browser.onEvent`
//     subscribes to `IPC_CHANNELS.browserEvent` and forwards the `BrowserEvent`.
//   - Store wiring: `apps/desktop-app/src/renderer/src/stores/
//     browserEventSubscription.ts` routes both `'snapshot'` and `'load-failed'`
//     events to `browserStore.applySnapshot(event.snapshot)`.
//   - Payload type: `BrowserEvent` / `BrowserSessionSnapshot` in
//     `packages/desktop-shared/src/types/browser.ts`.

/**
 * The exact IPC channel the main process broadcasts `BrowserEvent`s on. Mirrors
 * `IPC_CHANNELS.browserEvent` (`'browser:event'`). Kept as a literal here
 * because the Playwright `electronApp.evaluate` callback runs in the packaged
 * main-process context and cannot import the shared TS module.
 */
const BROWSER_EVENT_CHANNEL = 'browser:event';

/**
 * Inject a `BrowserSessionSnapshot` into the running app by emitting a
 * `BrowserEvent` on the same channel `BrowserService` broadcasts on. A failed
 * snapshot (`status: 'failed'` and/or a `lastError`) is sent as a
 * `'load-failed'` event; otherwise it is sent as `'snapshot'`. Both route to
 * `browserStore.applySnapshot`, so either discriminant updates the store.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {import('@canopy/desktop-shared/types').BrowserSessionSnapshot} snapshot
 * @returns {Promise<void>}
 */
export async function injectBrowserSnapshot(electronApp, snapshot) {
  if (!electronApp) {
    throw new Error('injectBrowserSnapshot requires an electronApp');
  }
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('injectBrowserSnapshot requires a snapshot object');
  }

  const eventType =
    snapshot.status === 'failed' || typeof snapshot.lastError === 'string'
      ? 'load-failed'
      : 'snapshot';

  const event = {
    type: eventType,
    browserId: snapshot.id,
    snapshot,
  };

  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, payload }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) {
        throw new Error('No BrowserWindow available to receive the snapshot');
      }
      windows[0].webContents.send(channel, payload);
    },
    { channel: BROWSER_EVENT_CHANNEL, payload: event },
  );
}

/**
 * Build a minimal-but-valid `BrowserSessionSnapshot` for assertions (per Doc 2
 * Spec 10 / PR 808). Defaults describe a ready, non-loading session; pass
 * `loading: true` for the in-flight state, or `failed: true` (and/or an error)
 * for the failed state. Shape follows `BrowserSessionSnapshot` in
 * `packages/desktop-shared/src/types/browser.ts`.
 *
 * @param {object} [options]
 * @param {boolean} [options.loading] navigation in flight (`status: 'loading'`)
 * @param {boolean} [options.failed] navigation failed (`status: 'failed'`)
 * @param {string} [options.url] committed URL; defaults to a sample URL
 * @param {string} [options.id] browser id; defaults to `'browser-1'`
 * @param {string} [options.projectId] owning project id
 * @param {string} [options.worktreeId] owning worktree id
 * @param {string} [options.title] document title
 * @param {string} [options.lastError] error string for the failed state
 * @returns {import('@canopy/desktop-shared/types').BrowserSessionSnapshot}
 */
export function buildBrowserSnapshot(options = {}) {
  const {
    loading = false,
    failed = false,
    url = 'https://example.com/',
    id = 'browser-1',
    projectId = 'seeded-project',
    worktreeId = 'seeded-worktree',
    title = 'Seeded Page',
    lastError,
  } = options;

  const status = failed ? 'failed' : loading ? 'loading' : 'ready';
  const now = Date.now();

  const snapshot = {
    id,
    projectId,
    worktreeId,
    createdAt: now,
    updatedAt: now,
    url,
    title,
    status,
    canGoBack: false,
    canGoForward: false,
    loading,
    themeMode: 'light',
    pickMode: false,
    recording: false,
  };

  if (failed) {
    snapshot.lastError = lastError ?? 'Navigation failed';
  } else if (typeof lastError === 'string') {
    snapshot.lastError = lastError;
  }

  return snapshot;
}

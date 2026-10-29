/**
 * Stands in for `electron` when the live probe bundles the real browser-view
 * preload into a headless-Chromium isolated world, for its document-start
 * tracker and bridges. The probes send it no commands: the snapshot,
 * inspect, wait and action commands they compared were deleted (phase 04b
 * S4), and pick mode and recording are not probed.
 */

/**
 * Electron runs the source in the main world at once. Here the preload is
 * in an isolated world, so the source goes through a DOM event to the
 * harness's main-world relay (registered before the preload); a string
 * event detail crosses worlds. Without the relay nothing runs, as when the
 * request fails.
 */
export const webFrame = {
  executeJavaScript(source: string): Promise<unknown> {
    document.dispatchEvent(
      new CustomEvent('canopy-probe-main-world', { detail: source }),
    );
    return Promise.resolve(undefined);
  },
};

export const ipcRenderer = {
  on(): void {},
  send(): void {},
};

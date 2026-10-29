// Runtime injection seeder for the "graph building" worktree-row indicator.
// Like `injectScriptRunEvent` / `injectResourceSnapshot` / `injectBrowserSnapshot`,
// this injects state into an ALREADY-RUNNING app by emitting the same IPC
// event the main process broadcasts when a code-graph build's status changes,
// so the renderer `codeGraphBuildStore` lights the badge without a real
// off-main build worker running.
//
// Source of truth for the channel + shape:
//   - Broadcast: `apps/desktop-app/src/main/ipc/code-graph-build-status.ts`
//     `registerCodeGraphBuildStatusBroadcast()` wires the build runner's
//     module-level status listener (`apps/desktop-app/src/main/code-graph/
//     build-runner.ts` `setCodeGraphBuildStatusListener`) to send a
//     `CodeGraphBuildStatusChangedEvent` on
//     `IPC_CHANNELS.codeGraphBuildStatusChanged` to every `BrowserWindow`.
//   - Channel constant: `packages/desktop-shared/src/types.ts`
//     `codeGraphBuildStatusChanged: 'code-graph:build-status-changed'`.
//   - Preload: `apps/desktop-app/src/preload/index.ts`
//     `onCodeGraphBuildStatusChanged` forwards the raw event.
//   - Subscription: `apps/desktop-app/src/renderer/src/hooks/
//     useCodeGraphBuildEventSubscriptions.ts` routes it to
//     `codeGraphBuildStore`'s `setBuilding`.
//   - Payload type: `CodeGraphBuildStatusChangedEvent` in
//     `packages/desktop-shared/src/types.ts`.
//
// UNLIKE `injectScriptRunEvent`, there is NO "worktree must be selected
// first" precondition here — `codeGraphBuildStore` intentionally has no
// `loadedWorktreeKeys`-style gate (the sidebar badge must light up for any
// worktree row, not just the currently open one). This spec exercises that
// exact invariant by injecting before ever selecting the worktree.

const CODE_GRAPH_BUILD_STATUS_CHANNEL = 'code-graph:build-status-changed';

/**
 * Inject a `code-graph:build-status-changed` event into an already-running
 * app so the worktree-row hub badge (`worktree-row-graph-badge`) lights up
 * (or clears) without a real off-main code-graph build.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {object} payload
 * @param {string} payload.projectId owning project / workspace id
 * @param {string} payload.worktreeId owning worktree id
 * @param {'building' | 'idle'} payload.status
 * @returns {Promise<void>}
 */
export async function injectCodeGraphBuildStatusEvent(electronApp, payload) {
  if (!electronApp) {
    throw new Error('injectCodeGraphBuildStatusEvent requires an electronApp');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error(
      'injectCodeGraphBuildStatusEvent requires a payload object',
    );
  }
  const { projectId, worktreeId, status } = payload;
  if (typeof projectId !== 'string' || typeof worktreeId !== 'string') {
    throw new Error(
      'injectCodeGraphBuildStatusEvent payload requires string projectId and worktreeId',
    );
  }
  if (status !== 'building' && status !== 'idle') {
    throw new Error(
      'injectCodeGraphBuildStatusEvent payload.status must be "building" or "idle"',
    );
  }

  /** @type {import('@canopy/desktop-shared/types').CodeGraphBuildStatusChangedEvent} */
  const event = { projectId, worktreeId, status };

  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, evt }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) {
        throw new Error(
          'No BrowserWindow available to receive the code-graph build status event',
        );
      }
      windows[0].webContents.send(channel, evt);
    },
    { channel: CODE_GRAPH_BUILD_STATUS_CHANNEL, evt: event },
  );
}

// Runtime injection seeder for the worktree-row terminal activity indicator.
// Like `injectChatEvent` / `injectCodeGraphBuildStatusEvent`, this emits the
// same IPC events the main terminal service broadcasts, so the renderer
// `terminalActivityStore` lights the terminal badge without a real PTY.
//
// Source of truth for channels + shapes:
//   - Channels: `packages/desktop-shared/src/types.ts`
//     `terminalRunningChanged: 'terminal:running-changed'`,
//     `terminalExit: 'terminal:exit'`.
//   - Payloads: `TerminalRunningChangedEvent` / `TerminalExitEvent` in
//     `packages/desktop-shared/src/types/terminal.ts`.
//   - Subscription: `useTerminalActivitySubscription` routes both events into
//     `terminalActivityStore` (`handleRunningChanged` / `handleExit`).
//
// No selection precondition: the activity subscription is global (mounted at
// App startup) and the store is not gated on loaded worktrees. Use a plain
// terminalId (and no `kind`) — script/claude-code terminals are
// lifecycle-managed and deliberately excluded from this surface.
//
// State recipes:
//   running        → one `runningChanged` with `running: true`.
//   unseen (blue)  → `running: true` then `running: false` (completion) for
//                    an UNSELECTED worktree.
//   failed (red)   → `running: true` then an `exit` with a non-zero code.

const TERMINAL_RUNNING_CHANGED_CHANNEL = 'terminal:running-changed';
const TERMINAL_EXIT_CHANNEL = 'terminal:exit';

async function send(electronApp, channel, payload) {
  if (!electronApp) {
    throw new Error('injectTerminalActivityEvent requires an electronApp');
  }
  await electronApp.evaluate(
    ({ BrowserWindow }, { channel: c, payload: p }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) {
        throw new Error('No BrowserWindow available for the terminal event');
      }
      windows[0].webContents.send(c, p);
    },
    { channel, payload },
  );
}

/**
 * Emit a `terminal:running-changed` event.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {import('@canopy/desktop-shared/types').TerminalRunningChangedEvent} event
 */
export async function injectTerminalRunningChanged(electronApp, event) {
  await send(electronApp, TERMINAL_RUNNING_CHANGED_CHANNEL, {
    processName: null,
    ...event,
  });
}

/**
 * Emit a `terminal:exit` event.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {import('@canopy/desktop-shared/types').TerminalExitEvent} event
 */
export async function injectTerminalExit(electronApp, event) {
  await send(electronApp, TERMINAL_EXIT_CHANNEL, {
    exitCode: 0,
    signal: null,
    ...event,
  });
}

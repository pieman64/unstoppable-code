// Runtime injection seeder for live script-run events (Doc 2 Spec 8b; PR 794).
// Like `injectResourceSnapshot` / `injectBrowserSnapshot`, this injects state
// into an ALREADY-RUNNING app by emitting the same IPC events the main process
// broadcasts for live script runs, so the renderer `scriptsStore` registers an
// ACTIVE run without a real OS process.
//
// WHY THIS EXISTS: a seeded-disk script-run snapshot canNOT light the worktree
// rocket badge. `worktree-row-badges.spec.mjs` documents that the main-process
// stale-run reconciliation (`loadWorktreeScriptRuns` →
// `resolveScriptRunLogStatus`) downgrades any persisted `running` snapshot to
// `cancelled` because no tracked shell process exists for a seeded snapshot.
// Emitting the live `script:started` event drives `scriptsStore.startRunFromEvent`,
// which creates a `running` run directly in the store — the same path a real
// launch takes — bypassing disk reconciliation.
//
// Source of truth for the channels + shapes:
//   - Broadcast: the main-process script runner sends `ScriptStartedEvent` /
//     `ScriptOutputEvent` / `ScriptCompleteEvent` on `IPC_CHANNELS.scriptStarted`
//     / `scriptOutput` / `scriptComplete`.
//   - Channel constants: `packages/desktop-shared/src/types.ts`
//     `scriptStarted: 'script:started'`, `scriptOutput: 'script:output'`,
//     `scriptComplete: 'script:complete'`.
//   - Preload: `apps/desktop-app/src/preload/index.ts` `onScriptStarted` /
//     `onScriptOutput` / `onScriptComplete` forward the raw events.
//   - Subscriptions: `apps/desktop-app/src/renderer/src/hooks/
//     useScriptEventSubscriptions.ts` routes them to `scriptsStore`'s
//     `startRunFromEvent` / `appendOutput` / `completeRunFromEvent`.
//   - Store reducer: `apps/desktop-app/src/renderer/src/stores/scriptsStore.ts`.
//   - Payload types: `ScriptStartedEvent` / `ScriptOutputEvent` /
//     `ScriptCompleteEvent` / `ScriptDescriptor` in
//     `packages/desktop-shared/src/types.ts`.
//
// CRITICAL PRECONDITION — `startRunFromEvent` (and `appendOutput`) are GATED on
// `loadedWorktreeKeys.has(`${projectId}/${worktreeId}`)`. That key is added only
// when the worktree's scripts are loaded — i.e. after the worktree is SELECTED
// in the UI (which mounts `ActivityPanel`, calling `loadWorktreeRuns`). An
// injected `script:started` for a worktree that has never been selected is
// silently dropped. A spec MUST select the target worktree before injecting.
// `completeRunFromEvent` is more lenient (it also accepts an existing runs map),
// but the badge-lighting `script:started` event requires the loaded key.

const SCRIPT_STARTED_CHANNEL = 'script:started';
const SCRIPT_OUTPUT_CHANNEL = 'script:output';
const SCRIPT_COMPLETE_CHANNEL = 'script:complete';

/**
 * Send a single script event on the given channel to the main renderer window.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {string} channel
 * @param {unknown} event
 * @returns {Promise<void>}
 */
async function sendScriptEvent(electronApp, channel, event) {
  await electronApp.evaluate(
    ({ BrowserWindow }, { ch, evt }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) {
        throw new Error(
          'No BrowserWindow available to receive the script event',
        );
      }
      windows[0].webContents.send(ch, evt);
    },
    { ch: channel, evt: event },
  );
}

/**
 * Build a `ScriptDescriptor` for an injected run with deterministic defaults.
 * Shape follows `ScriptDescriptor` in `packages/desktop-shared/src/types.ts`.
 *
 * @param {object} [overrides] partial `ScriptDescriptor` overrides
 * @returns {import('@canopy/desktop-shared/types').ScriptDescriptor}
 */
export function buildScriptDescriptor(overrides = {}) {
  return {
    scriptKey: 'launch:project',
    scriptName: 'launch',
    label: 'Dev Server',
    command: 'npm run dev',
    lifecycle: 'launch',
    target: 'project',
    devServerPattern: 'https?://[^\\s]+',
    ...overrides,
  };
}

/**
 * Inject a running-script event so the worktree-row rocket badge
 * (`worktree-row-script-badge`) lights and its "Scripts Running" popover
 * (`worktree-row-script-popover`) becomes available (PR 794).
 *
 * Emits a `ScriptStartedEvent` on `'script:started'`, which drives
 * `scriptsStore.startRunFromEvent` → a `running` run keyed by
 * `${projectId}/${worktreeId}` → `script.scriptKey`. In `WorktreeItem.tsx` that
 * makes `hasRunningScript` true and `sharedScriptStatus = 'running'`, so the
 * shared `WorktreeRow` renders the rocket badge.
 *
 * PRECONDITION: the target worktree must already be selected/loaded (see the
 * file header) or the event is silently dropped by the `loadedWorktreeKeys`
 * gate. Pass `outputLines` to additionally stream a `script:output` event (e.g.
 * a dev-server URL line) after the start event.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {object} payload
 * @param {string} payload.projectId owning project / workspace id
 * @param {string} payload.worktreeId owning worktree id
 * @param {Partial<import('@canopy/desktop-shared/types').ScriptDescriptor>} [payload.script]
 *   descriptor overrides; defaults to a `launch`/`project` dev server.
 * @param {import('@canopy/desktop-shared/types').ScriptStartedEvent['invocation']} [payload.invocation]
 *   defaults to `'manual-lifecycle'`.
 * @param {string[]} [payload.outputLines] optional output lines streamed via a
 *   follow-up `script:output` event after the start event.
 * @returns {Promise<{ script: import('@canopy/desktop-shared/types').ScriptDescriptor }>}
 */
export async function injectScriptRunEvent(electronApp, payload) {
  if (!electronApp) {
    throw new Error('injectScriptRunEvent requires an electronApp');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('injectScriptRunEvent requires a payload object');
  }
  const { projectId, worktreeId, invocation = 'manual-lifecycle' } = payload;
  if (typeof projectId !== 'string' || typeof worktreeId !== 'string') {
    throw new Error(
      'injectScriptRunEvent payload requires string projectId and worktreeId',
    );
  }

  const script = buildScriptDescriptor(payload.script ?? {});

  /** @type {import('@canopy/desktop-shared/types').ScriptStartedEvent} */
  const startedEvent = { projectId, worktreeId, script, invocation };
  await sendScriptEvent(electronApp, SCRIPT_STARTED_CHANNEL, startedEvent);

  if (Array.isArray(payload.outputLines) && payload.outputLines.length > 0) {
    /** @type {import('@canopy/desktop-shared/types').ScriptOutputEvent} */
    const outputEvent = {
      projectId,
      worktreeId,
      script,
      invocation,
      lines: payload.outputLines,
    };
    await sendScriptEvent(electronApp, SCRIPT_OUTPUT_CHANNEL, outputEvent);
  }

  return { script };
}

/**
 * Append output to an already injected script run without restarting it.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {object} payload
 * @param {string} payload.projectId owning project / workspace id
 * @param {string} payload.worktreeId owning worktree id
 * @param {Partial<import('@canopy/desktop-shared/types').ScriptDescriptor>} [payload.script]
 * @param {import('@canopy/desktop-shared/types').ScriptStartedEvent['invocation']} [payload.invocation]
 * @param {string[]} payload.outputLines output lines to append
 * @returns {Promise<void>}
 */
export async function injectScriptOutputEvent(electronApp, payload) {
  if (!electronApp) {
    throw new Error('injectScriptOutputEvent requires an electronApp');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('injectScriptOutputEvent requires a payload object');
  }
  const { projectId, worktreeId, invocation = 'manual-lifecycle' } = payload;
  if (typeof projectId !== 'string' || typeof worktreeId !== 'string') {
    throw new Error(
      'injectScriptOutputEvent payload requires string projectId and worktreeId',
    );
  }
  if (!Array.isArray(payload.outputLines)) {
    throw new Error(
      'injectScriptOutputEvent payload requires an outputLines array',
    );
  }

  const script = buildScriptDescriptor(payload.script ?? {});
  /** @type {import('@canopy/desktop-shared/types').ScriptOutputEvent} */
  const outputEvent = {
    projectId,
    worktreeId,
    script,
    invocation,
    lines: payload.outputLines,
  };
  await sendScriptEvent(electronApp, SCRIPT_OUTPUT_CHANNEL, outputEvent);
}

/**
 * Inject a script-completion event so an active injected run transitions to
 * `success`/`failed`. Drives `scriptsStore.completeRunFromEvent`. Useful to
 * assert the badge clears after a run ends.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {object} payload
 * @param {string} payload.projectId owning project / workspace id
 * @param {string} payload.worktreeId owning worktree id
 * @param {Partial<import('@canopy/desktop-shared/types').ScriptDescriptor>} [payload.script]
 *   must match the started run's descriptor (same `scriptKey`).
 * @param {import('@canopy/desktop-shared/types').ScriptStartedEvent['invocation']} [payload.invocation]
 * @param {boolean} [payload.success] defaults to `true`.
 * @param {number | null} [payload.exitCode] defaults based on `success`.
 * @param {boolean} [payload.timedOut] defaults to `false`.
 * @param {number} [payload.durationMs] defaults to `0`.
 * @returns {Promise<void>}
 */
export async function injectScriptCompleteEvent(electronApp, payload) {
  if (!electronApp) {
    throw new Error('injectScriptCompleteEvent requires an electronApp');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('injectScriptCompleteEvent requires a payload object');
  }
  const {
    projectId,
    worktreeId,
    invocation = 'manual-lifecycle',
    success = true,
    exitCode,
    timedOut = false,
    durationMs = 0,
  } = payload;
  if (typeof projectId !== 'string' || typeof worktreeId !== 'string') {
    throw new Error(
      'injectScriptCompleteEvent payload requires string projectId and worktreeId',
    );
  }

  const script = buildScriptDescriptor(payload.script ?? {});

  /** @type {import('@canopy/desktop-shared/types').ScriptCompleteEvent} */
  const completeEvent = {
    projectId,
    worktreeId,
    script,
    invocation,
    result: {
      success,
      exitCode: exitCode !== undefined ? exitCode : success ? 0 : 1,
      output: '',
      timedOut,
      durationMs,
    },
  };
  await sendScriptEvent(electronApp, SCRIPT_COMPLETE_CHANNEL, completeEvent);
}

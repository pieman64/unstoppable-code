// Pipeline IPC probe (Phase 01 — pipeline workspace panels test harness /
// baseline-recheck "Harness gaps to build first").
//
// Counts, and can optionally hold, calls to the pipeline execution-detail
// read channels, so a spec can assert what the renderer/main round-trip
// actually did (e.g. "the step log was re-read exactly once after the live
// event arrived") instead of inferring it from the DOM alone.
//
// Modeled on the ad hoc `ipcMain._invokeHandlers.get(channel)` / `removeHandler`
// / `handle(wrapper)` rewiring already used in two specs:
//   - `activity-sidebar-polish.spec.mjs` (~821): holds `local-memory:list` on a
//     manual gate, released later in the test.
//   - `pipeline-chat-drawer.spec.mjs` (~38): holds `chat:get-state` behind a
//     `globalThis`-published promise.
// This module packages that pattern as a reusable, multi-channel counter +
// hold/release control, in the style of `seeders/exactFileIoCounter.mjs`
// (install/read/stop trio, state kept under one namespaced `globalThis` key in
// the Electron MAIN process, since only main has `ipcMain`).
//
// Channel sources (`packages/desktop-shared/src/constants/ipc-channels.ts`
// `PIPELINE_CHANNELS`):
//   - readStepLog:    'pipelines:read-step-log'   (READ_STEP_LOG)
//   - getExecution:   'pipelines:get-execution'   (GET_EXECUTION)
//   - readReportFile: 'pipelines:read-report-file' (READ_REPORT_FILE)
// Handler registrations: `apps/desktop-app/src/main/pipelines/pipeline-handlers.ts`
// (each wrapped by `registerIpcHandler`, which itself does
// `ipcMain.removeHandler` + `ipcMain.handle` around slow-action tracking — the
// function captured off `ipcMain._invokeHandlers.get(channel)` before this
// probe installs IS that already-production-wrapped handler, so delegating to
// it preserves normal behavior).
//
// Every exported function is a thin `electronApp.evaluate` wrapper: the actual
// counters, call-arg summaries, and hold gates live in the Electron main
// process under `globalThis.__CANOPY_PIPELINE_IPC_PROBE__`, not in the
// Playwright/Node test process.

const PROBE_GLOBAL_KEY = '__CANOPY_PIPELINE_IPC_PROBE__';

/** Friendly channel keys this probe understands, mapped to their real wire channel. */
export const PIPELINE_IPC_PROBE_CHANNELS = {
  readStepLog: 'pipelines:read-step-log',
  getExecution: 'pipelines:get-execution',
  readReportFile: 'pipelines:read-report-file',
};

function resolveChannel(channelKeyOrChannel) {
  if (typeof channelKeyOrChannel !== 'string' || channelKeyOrChannel === '') {
    throw new Error('Expected a non-empty pipeline IPC channel key or name');
  }
  return (
    PIPELINE_IPC_PROBE_CHANNELS[channelKeyOrChannel] ?? channelKeyOrChannel
  );
}

/**
 * Install the probe around one or more pipeline IPC invoke channels.
 *
 * For each channel this captures the CURRENTLY registered handler (the real,
 * already-production-wrapped handler), replaces it with a counting wrapper,
 * and leaves the original recoverable by {@link uninstallPipelineIpcProbe}.
 * Each wrapper call: increments the channel's count, records an args summary
 * (`executionId` / `jobId` / `stepId` / `logFilePath` when present in the
 * first argument), and — if the channel is currently held — awaits the
 * pending release before delegating to the original handler. The hold check
 * happens at call time, so `hold()` only gates calls that start after it
 * runs; a call already in flight when `hold()` is invoked is unaffected.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {{ channels?: Array<keyof typeof PIPELINE_IPC_PROBE_CHANNELS> }} [options]
 *   channel KEYS to install on; defaults to all three
 *   (`readStepLog`, `getExecution`, `readReportFile`).
 * @returns {Promise<void>}
 */
export async function installPipelineIpcProbe(electronApp, options = {}) {
  const channelKeys =
    options.channels ?? Object.keys(PIPELINE_IPC_PROBE_CHANNELS);
  const channelsByKey = {};
  for (const channelKey of channelKeys) {
    const channel = PIPELINE_IPC_PROBE_CHANNELS[channelKey];
    if (!channel) {
      throw new Error(`Unknown pipeline IPC probe channel key "${channelKey}"`);
    }
    channelsByKey[channelKey] = channel;
  }

  await electronApp.evaluate(
    ({ ipcMain }, { key, channelsByKey: channels }) => {
      if (globalThis[key]) {
        throw new Error('Pipeline IPC probe is already installed');
      }

      function summarizeArgs(args) {
        const [first] = args;
        if (typeof first === 'string') {
          return { executionId: first };
        }
        if (first && typeof first === 'object') {
          const summary = {};
          if (typeof first.executionId === 'string') {
            summary.executionId = first.executionId;
          }
          if (typeof first.jobId === 'string') {
            summary.jobId = first.jobId;
          }
          if (typeof first.stepId === 'string') {
            summary.stepId = first.stepId;
          }
          if (typeof first.logFilePath === 'string') {
            summary.logFilePath = first.logFilePath;
          }
          return summary;
        }
        return {};
      }

      const byKey = {};
      for (const [channelKey, channel] of Object.entries(channels)) {
        const original = ipcMain._invokeHandlers.get(channel);
        if (typeof original !== 'function') {
          throw new Error(
            `No IPC handler is registered for "${channel}" (${channelKey})`,
          );
        }
        const entry = {
          channel,
          original,
          count: 0,
          calls: [],
          holdGate: null,
          releaseHold: null,
        };
        byKey[channelKey] = entry;

        ipcMain.removeHandler(channel);
        ipcMain.handle(channel, async (event, ...args) => {
          entry.count += 1;
          entry.calls.push(summarizeArgs(args));
          if (entry.holdGate) {
            await entry.holdGate;
          }
          return entry.original(event, ...args);
        });
      }

      globalThis[key] = { byKey };
    },
    { key: PROBE_GLOBAL_KEY, channelsByKey },
  );
}

/**
 * Read the current call counts (and args summaries) per installed channel
 * key.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @returns {Promise<Record<string, { channel: string, count: number, calls: Array<{ executionId?: string, jobId?: string, stepId?: string, logFilePath?: string }> }>>}
 */
export async function readCounts(electronApp) {
  return electronApp.evaluate((_electron, key) => {
    const state = globalThis[key];
    if (!state) {
      throw new Error('Pipeline IPC probe is not installed');
    }
    const result = {};
    for (const [channelKey, entry] of Object.entries(state.byKey)) {
      result[channelKey] = {
        channel: entry.channel,
        count: entry.count,
        calls: entry.calls.map((call) => ({ ...call })),
      };
    }
    return result;
  }, PROBE_GLOBAL_KEY);
}

/**
 * Reset every installed channel's count and recorded call summaries to zero,
 * without touching an active hold.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @returns {Promise<void>}
 */
export async function resetCounts(electronApp) {
  await electronApp.evaluate((_electron, key) => {
    const state = globalThis[key];
    if (!state) {
      throw new Error('Pipeline IPC probe is not installed');
    }
    for (const entry of Object.values(state.byKey)) {
      entry.count = 0;
      entry.calls = [];
    }
  }, PROBE_GLOBAL_KEY);
}

/**
 * Hold future calls on one channel: any invocation that starts after this
 * resolves awaits {@link release} before delegating to the original handler.
 * A call already in flight is unaffected. Calling `hold` again on an
 * already-held channel is a no-op (it does not replace the existing gate).
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {keyof typeof PIPELINE_IPC_PROBE_CHANNELS | string} channel channel
 *   key (`'readStepLog'`, `'getExecution'`, `'readReportFile'`) or the raw
 *   wire channel name.
 * @returns {Promise<void>}
 */
export async function hold(electronApp, channel) {
  const resolvedChannel = resolveChannel(channel);
  await electronApp.evaluate(
    (_electron, { key, resolvedChannel: targetChannel }) => {
      const state = globalThis[key];
      if (!state) {
        throw new Error('Pipeline IPC probe is not installed');
      }
      const entry = Object.values(state.byKey).find(
        (candidate) => candidate.channel === targetChannel,
      );
      if (!entry) {
        throw new Error(
          `Pipeline IPC probe is not installed on "${targetChannel}"`,
        );
      }
      if (entry.holdGate) {
        return;
      }
      entry.holdGate = new Promise((resolve) => {
        entry.releaseHold = resolve;
      });
    },
    { key: PROBE_GLOBAL_KEY, resolvedChannel },
  );
}

/**
 * Release a channel held by {@link hold}, letting every call currently
 * awaiting the gate (and any future call, until `hold` is invoked again)
 * proceed to the original handler. A no-op if the channel is not currently
 * held.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {keyof typeof PIPELINE_IPC_PROBE_CHANNELS | string} channel channel
 *   key or raw wire channel name (see {@link hold}).
 * @returns {Promise<void>}
 */
export async function release(electronApp, channel) {
  const resolvedChannel = resolveChannel(channel);
  await electronApp.evaluate(
    (_electron, { key, resolvedChannel: targetChannel }) => {
      const state = globalThis[key];
      if (!state) {
        throw new Error('Pipeline IPC probe is not installed');
      }
      const entry = Object.values(state.byKey).find(
        (candidate) => candidate.channel === targetChannel,
      );
      if (!entry) {
        throw new Error(
          `Pipeline IPC probe is not installed on "${targetChannel}"`,
        );
      }
      if (entry.releaseHold) {
        entry.releaseHold();
      }
      entry.holdGate = null;
      entry.releaseHold = null;
    },
    { key: PROBE_GLOBAL_KEY, resolvedChannel },
  );
}

/**
 * Restore every installed channel's original (real, production-wrapped)
 * handler and drop the probe's `globalThis` state. Releases any still-held
 * channel first so no call is left permanently pending.
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @returns {Promise<void>}
 */
export async function uninstallPipelineIpcProbe(electronApp) {
  await electronApp.evaluate(({ ipcMain }, key) => {
    const state = globalThis[key];
    if (!state) {
      throw new Error('Pipeline IPC probe is not installed');
    }
    for (const entry of Object.values(state.byKey)) {
      if (entry.releaseHold) {
        entry.releaseHold();
      }
      ipcMain.removeHandler(entry.channel);
      ipcMain.handle(entry.channel, entry.original);
    }
    delete globalThis[key];
  }, PROBE_GLOBAL_KEY);
}

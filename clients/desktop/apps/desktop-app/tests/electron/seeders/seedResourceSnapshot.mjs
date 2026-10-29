// Runtime snapshot-injection seeder for the resource monitor (Doc 13 §4; Doc 2
// §0 H7). Unlike the file-writing seeders in this directory, this one injects
// state into an ALREADY-RUNNING app by emitting the same IPC event the main
// process broadcasts after each sample, so the renderer `resourceMonitorStore`
// updates without spawning real processes.
//
// Source of truth for the channel + shape:
//   - Broadcast: `apps/desktop-app/src/main/resource-monitor/service.ts` calls
//     `window.webContents.send(IPC_CHANNELS.resourceMonitorSnapshot, snapshot)`.
//   - Channel constant: `packages/desktop-shared/src/types.ts`
//     `resourceMonitorSnapshot: 'resource-monitor:snapshot'`.
//   - Preload: `apps/desktop-app/src/preload/index.ts` `onResourceMonitorSnapshot`
//     subscribes to that channel.
//   - Store: `apps/desktop-app/src/renderer/src/stores/resourceMonitorStore.ts`
//     consumes it via `window.api.onResourceMonitorSnapshot(...)`.
//   - Payload type: `ResourceMonitorSnapshot` in
//     `packages/desktop-shared/src/types.ts`.

/**
 * The exact IPC channel the main process broadcasts resource samples on. Mirrors
 * `IPC_CHANNELS.resourceMonitorSnapshot` (`'resource-monitor:snapshot'`). Kept
 * as a literal here because the Playwright `electronApp.evaluate` callback runs
 * in the packaged main-process context and cannot import the shared TS module.
 */
const RESOURCE_MONITOR_SNAPSHOT_CHANNEL = 'resource-monitor:snapshot';

/**
 * Inject a `ResourceMonitorSnapshot` into the running app by sending it on the
 * same channel the resource monitor service broadcasts on. The first window is
 * the main renderer window (the resource monitor only ever broadcasts to it).
 *
 * @param {import('@playwright/test').ElectronApplication} electronApp
 * @param {import('@canopy/desktop-shared/types').ResourceMonitorSnapshot} snapshot
 * @returns {Promise<void>}
 */
export async function injectResourceSnapshot(electronApp, snapshot) {
  if (!electronApp) {
    throw new Error('injectResourceSnapshot requires an electronApp');
  }
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('injectResourceSnapshot requires a snapshot object');
  }

  await electronApp.evaluate(
    ({ BrowserWindow }, { channel, snap }) => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) {
        throw new Error('No BrowserWindow available to receive the snapshot');
      }
      windows[0].webContents.send(channel, snap);
    },
    { channel: RESOURCE_MONITOR_SNAPSHOT_CHANNEL, snap: snapshot },
  );
}

/**
 * Build a minimal-but-valid `ResourceMonitorSnapshot` for assertions. The
 * default fixture includes a `browser` group with two processes so attribution
 * rows can be asserted (per Doc 2 Spec 9 / PR 811):
 *   - an `in-app-browser` process attributed to a worktree via
 *     `metadata: { type: 'browser', browser: {...} }`;
 *   - a `script` process attributed to a worktree via
 *     `metadata: { type: 'script', script: {...} }`.
 *
 * Group/process/metadata shapes follow `ResourceGroupSnapshot`,
 * `ResourceProcessSnapshot`, `BrowserResourceMetadata`, and
 * `ScriptResourceMetadata` in `packages/desktop-shared/src/types.ts`. Callers
 * may pass their own fully-formed `groups` to override the default fixture.
 *
 * @param {object} [options]
 * @param {import('@canopy/desktop-shared/types').ResourceGroupSnapshot[]} [options.groups]
 * @returns {import('@canopy/desktop-shared/types').ResourceMonitorSnapshot}
 */
export function buildResourceSnapshot(options = {}) {
  const sampledAt = new Date().toISOString();
  const groups = options.groups ?? defaultGroups();

  const cpuPercent = sum(groups, (group) => group.cpuPercent);
  const memoryRssBytes = sum(groups, (group) => group.memoryRssBytes);
  const processCount = sum(groups, (group) => group.processCount);

  return {
    version: 1,
    sampledAt,
    appPid: 1000,
    cpuPercent,
    memoryRssBytes,
    processCount,
    pressure: {
      level: 'ok',
      reasons: [],
      warningMemoryBytes: 8 * 1024 * 1024 * 1024,
      criticalMemoryBytes: 12 * 1024 * 1024 * 1024,
    },
    groups,
    guards: {
      chatTurns: {
        activeTurns: 0,
        pendingMessages: 0,
        maxConcurrentTurns: null,
        blocked: false,
      },
      pipelines: {
        activeExecutions: 0,
        maxConcurrentExecutions: null,
        blocked: false,
      },
      codexPools: {
        activeConnections: 0,
        liveProcesses: 0,
        activeTurns: 0,
      },
    },
  };
}

/**
 * Default `browser` group containing an in-app-browser process and a script
 * process, each attributed to a worktree so attribution rows render.
 *
 * @returns {import('@canopy/desktop-shared/types').ResourceGroupSnapshot[]}
 */
function defaultGroups() {
  const browserProcess = {
    id: 'browser:browser-1',
    kind: 'in-app-browser',
    groupId: 'browser',
    label: 'In-app browser',
    pid: 2001,
    cpuPercent: 3.5,
    memoryRssBytes: 180 * 1024 * 1024,
    processCount: 1,
    status: 'running',
    metadata: {
      type: 'browser',
      browser: {
        projectId: 'seeded-project',
        worktreeId: 'seeded-worktree',
        browserId: 'browser-1',
        title: 'Seeded Page',
        displayUrl: 'example.com',
        visible: true,
        status: 'ready',
      },
    },
  };

  const scriptProcess = {
    id: 'script:script-1',
    kind: 'script',
    // The renderer derives a group's display label from its group `id`
    // ('scripts' -> "Script", 'browser' -> "Browser"), so the script process
    // must live in a group whose id is 'scripts', not 'browser'.
    groupId: 'scripts',
    label: 'dev server',
    pid: 2002,
    cpuPercent: 6.0,
    memoryRssBytes: 120 * 1024 * 1024,
    processCount: 1,
    status: 'running',
    metadata: {
      type: 'script',
      script: {
        projectId: 'seeded-project',
        worktreeId: 'seeded-worktree',
        scriptKey: 'launch',
        scriptName: 'launch',
        scriptLabel: 'Launch',
        // Must be one of the preload validator's allowed values
        // ('project' | 'workspace-repo' | 'workspace-root'); 'worktree' is
        // rejected and the whole snapshot is silently dropped.
        target: 'workspace-root',
      },
    },
  };

  return [
    {
      id: 'browser',
      label: 'Browser',
      cpuPercent: browserProcess.cpuPercent,
      memoryRssBytes: browserProcess.memoryRssBytes,
      processCount: browserProcess.processCount,
      items: [browserProcess],
    },
    {
      id: 'scripts',
      label: 'Script',
      cpuPercent: scriptProcess.cpuPercent,
      memoryRssBytes: scriptProcess.memoryRssBytes,
      processCount: scriptProcess.processCount,
      items: [scriptProcess],
    },
  ];
}

/**
 * @template T
 * @param {T[]} list
 * @param {(item: T) => number} select
 * @returns {number}
 */
function sum(list, select) {
  return list.reduce((total, item) => total + select(item), 0);
}

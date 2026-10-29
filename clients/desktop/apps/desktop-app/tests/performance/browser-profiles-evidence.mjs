/** Fixed fresh browser-profile study evidence. No launch, retry, or product APIs. */
import assert from 'node:assert/strict';
import headlessBootstrap from './browser-profiles-production-headless-bootstrap.cjs';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

export const STUDY_VIEWPORT = Object.freeze({ width: 1000, height: 640 });
export const STUDY_VIEWPORT_PRESET = 'headed-native-1000x640';
export const HEADLESS_STUDY_MODE = 'hidden-native-1400x900-v1';
export const HEADLESS_STUDY_VIEWPORT = Object.freeze({
  width: 1400,
  height: 900,
});
const IDENTITY_FIELDS = [
  'id',
  'webContentsId',
  'rendererPid',
  'url',
  'nativeUrl',
];
function hiddenOwnerReady(state) {
  return Boolean(
    state &&
    state.ownerMatches === true &&
    ['id', 'webContentsId', 'rendererPid'].every(
      (key) => Number.isInteger(state[key]) && state[key] > 0,
    ) &&
    typeof state.url === 'string' &&
    state.url.length > 0 &&
    state.nativeUrl === state.url &&
    state.destroyed === false &&
    state.minimized === false &&
    state.visible === false &&
    state.focused === false,
  );
}
function headlessGeometry(value) {
  return value?.width === 1400 && value?.height === 900;
}
function assertSameWindow(before, after) {
  for (const key of IDENTITY_FIELDS)
    assert.equal(
      after?.[key],
      before?.[key],
      `Hidden window identity changed: ${key}`,
    );
}
export function headlessStudyWindowReady(state) {
  return (
    hiddenOwnerReady(state) &&
    state.documentVisible === true &&
    typeof state.documentFocused === 'boolean' &&
    headlessGeometry(state.viewport) &&
    headlessGeometry(state.contentBounds)
  );
}
export function assertHeadlessStudyMetadata(metadata) {
  assert.equal(
    metadata?.studyWindowMode,
    HEADLESS_STUDY_MODE,
    'Missing/unknown headless study mode',
  );
  assert.equal(
    metadata.studyViewportPreset,
    HEADLESS_STUDY_MODE,
    'Mixed study viewport preset',
  );
  assert.equal(
    metadata.windowVisible,
    false,
    'Headless study must remain hidden',
  );
  assert(
    headlessGeometry(metadata.viewport),
    'Headless study viewport must be 1400x900',
  );
}
export function assertHeadlessWindowEvidence(evidence) {
  assert.equal(
    evidence?.mode,
    HEADLESS_STUDY_MODE,
    'Missing/unknown hidden window evidence mode',
  );
  assert.equal(evidence.windowVisible, false);
  assert(
    headlessGeometry(evidence.viewport),
    'Invalid hidden evidence viewport',
  );
  assert.equal(
    evidence.setup?.status,
    'ready',
    'Hidden setup missing or failed',
  );
  assert(hiddenOwnerReady(evidence.setup.before), 'Hidden setup owner invalid');
  for (const state of [
    evidence.setup.after,
    evidence.atStart,
    evidence.atEnd,
  ]) {
    assert(
      headlessStudyWindowReady(state),
      'Hidden native window boundary invalid',
    );
    assertSameWindow(evidence.setup.before, state);
  }
}
/** One bounded setup, before monitoring. Never activates or hides a window. */
export async function setupHeadlessStudyWindow(
  electronApp,
  page,
  evidence = {},
  { signal, timeoutMs = 10_000 } = {},
) {
  assert(
    timeoutMs > 0 && timeoutMs <= 10_000,
    'Hidden setup limit must not exceed 10000ms',
  );
  evidence.mode = HEADLESS_STUDY_MODE;
  evidence.startedAtMs = performance.now();
  evidence.status = 'running';
  const deadline = Date.now() + timeoutMs;
  let interruption;
  const interrupt = () => {
    interruption = new Error('Hidden setup interrupted');
  };
  const check = () => {
    if (signal?.aborted)
      throw signal.reason ?? new Error('Hidden setup aborted');
    if (interruption) throw interruption;
    assert(
      evidence.status === 'running' && Date.now() < deadline,
      'Hidden setup deadline exhausted',
    );
  };
  const step = async (operation) => {
    check();
    const result = await bounded(
      operation,
      deadline - Date.now(),
      'Hidden setup deadline exhausted',
    );
    check();
    return result;
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  let handle;
  try {
    evidence.before = await step(() =>
      measuredWindowState(electronApp, page, check),
    );
    assert(
      hiddenOwnerReady(evidence.before),
      'Hidden setup requires an already hidden, unfocused owning window',
    );
    handle = await step(async () => {
      const acquired = await electronApp.browserWindow(page);
      try {
        check();
      } catch (error) {
        void acquired.dispose().catch(() => undefined);
        throw error;
      }
      return acquired;
    });
    await step(() =>
      handle.evaluate(
        (window, { expected, deadline }) => {
          if (
            Date.now() >= deadline ||
            !window ||
            window.isDestroyed() ||
            window.isMinimized() ||
            window.isVisible() ||
            window.isFocused() ||
            window.id !== expected.id ||
            window.webContents.id !== expected.webContentsId ||
            window.webContents.getOSProcessId() !== expected.rendererPid ||
            window.webContents.getURL() !== expected.nativeUrl
          )
            throw new Error('Hidden setup owner changed or deadline exhausted');
          window.setContentSize(1400, 900);
        },
        { expected: evidence.before, deadline },
      ),
    );
    await step(() => page.setViewportSize(HEADLESS_STUDY_VIEWPORT));
    evidence.after = await step(() =>
      measuredWindowState(electronApp, page, check),
    );
    assert(
      headlessStudyWindowReady(evidence.after),
      'Hidden setup geometry/visibility unavailable',
    );
    assertSameWindow(evidence.before, evidence.after);
    check();
    evidence.status = 'ready';
    return evidence.after;
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = String(error);
    throw error;
  } finally {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    evidence.completedAtMs = performance.now();
    evidence.durationMs = evidence.completedAtMs - evidence.startedAtMs;
    // Disposal is cleanup only; no observation or mutation is scheduled after expiry.
    if (handle) void handle.dispose().catch(() => undefined);
  }
}
async function bounded(operation, remainingMs, message) {
  assert(remainingMs > 0, message);
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), remainingMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

export function nativeStudyWindowReady(state) {
  const { bounds: b, contentBounds: c, display, viewport: v } = state;
  const a = display?.workArea;
  return Boolean(
    state.ownerMatches &&
    !state.destroyed &&
    !state.minimized &&
    state.visible &&
    state.focused &&
    state.documentVisible &&
    state.id > 0 &&
    state.webContentsId > 0 &&
    state.rendererPid > 0 &&
    v?.width === 1000 &&
    v?.height === 640 &&
    c?.width === 1000 &&
    c?.height === 640 &&
    a &&
    b &&
    b.x >= a.x &&
    b.y >= a.y &&
    b.x + b.width <= a.x + a.width &&
    b.y + b.height <= a.y + a.height,
  );
}
export function foregroundReady(state) {
  return nativeStudyWindowReady(state) && state.documentFocused;
}
export async function measuredWindowState(electronApp, page, check = () => {}) {
  check();
  const handle = await electronApp.browserWindow(page);
  try {
    check();
    const native = await handle.evaluate((window) => {
      if (!window || window.isDestroyed()) return { destroyed: true };
      return {
        id: window.id,
        webContentsId: window.webContents.id,
        rendererPid: window.webContents.getOSProcessId(),
        url: window.webContents.getURL(),
        destroyed: false,
        minimized: window.isMinimized(),
        visible: window.isVisible(),
        focused: window.isFocused(),
        contentBounds: window.getContentBounds(),
        bounds: window.getBounds(),
      };
    });
    check();
    const renderer = await page.evaluate(() => ({
      url: location.href,
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      documentVisible: document.visibilityState === 'visible',
      documentFocused: document.hasFocus(),
      rendererAtMs: performance.now(),
      rendererTimeOrigin: performance.timeOrigin,
    }));
    check();
    const display = native.bounds
      ? await electronApp.evaluate(({ screen }, bounds) => {
          const display = screen.getDisplayMatching(bounds);
          return {
            id: display.id,
            scaleFactor: display.scaleFactor,
            bounds: display.bounds,
            workArea: display.workArea,
          };
        }, native.bounds)
      : null;
    check();
    return {
      ...native,
      ...renderer,
      focusScope:
        'native owning window at boundary; renderer document focus may transfer to an owned BrowserView/dialog',
      nativeUrl: native.url,
      ownerMatches: !native.destroyed && native.url === renderer.url,
      display,
      nodeAtMs: performance.now(),
    };
  } finally {
    await handle.dispose();
  }
}
export async function admitStudyWindow(electronApp, page, evidence = {}) {
  evidence.preset = STUDY_VIEWPORT_PRESET;
  evidence.startedAtMs = performance.now();
  evidence.observations = [];
  evidence.status = 'running';
  try {
    return await bounded(
      async () => {
        const handle = await electronApp.browserWindow(page);
        try {
          evidence.before = await measuredWindowState(electronApp, page);
          const area = evidence.before.display?.workArea;
          assert(area, 'Measured window display work area unavailable');
          await handle.evaluate(
            (window, { viewport, area }) => {
              assertWindow(window);
              function assertWindow(value) {
                if (!value || value.isDestroyed())
                  throw new Error('Measured window destroyed');
              }
              window.setContentSize(viewport.width, viewport.height);
              window.setPosition(area.x, area.y);
              if (window.isMinimized()) window.restore();
              window.show();
              window.focus();
            },
            { viewport: STUDY_VIEWPORT, area },
          );
        } finally {
          await handle.dispose();
        }
        await page.setViewportSize(STUDY_VIEWPORT);
        await page.bringToFront();
        while (performance.now() - evidence.startedAtMs < 10_000) {
          const state = await measuredWindowState(electronApp, page);
          evidence.observations.push(state);
          if (
            performance.now() - evidence.startedAtMs < 10_000 &&
            evidence.status === 'running' &&
            foregroundReady(state)
          ) {
            evidence.status = 'admitted';
            return state;
          }
          await delay(50);
        }
        throw new Error(
          'Measured window foreground/content/work-area admission failed within 10000ms',
        );
      },
      10_000,
      'Measured window foreground/content/work-area admission failed within 10000ms',
    );
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = String(error);
    throw error;
  } finally {
    evidence.completedAtMs = performance.now();
    evidence.durationMs = evidence.completedAtMs - evidence.startedAtMs;
  }
}
export async function waitForInventoryAdmission({
  observe,
  now = () => performance.now(),
  pause = delay,
}) {
  const start = now();
  while (now() - start < 10_000) {
    const job = await bounded(
      () => observe('admission'),
      10_000 - (now() - start),
      'Inventory queued-to-running admission failed within 10000ms',
    );
    if (job.status === 'running') return job;
    assert.equal(
      job.status,
      'queued',
      'Inventory ended before required navigation/typing overlap',
    );
    await pause(50);
  }
  throw new Error(
    'Inventory queued-to-running admission failed within 10000ms',
  );
}

/** Release-only adapter evidence; E2E does not activate the production adapter. */
export function assertProductionHeadlessAdapter(snapshot, expected) {
  assert.equal(
    snapshot?.schemaVersion,
    1,
    'Missing production adapter snapshot',
  );
  assert.equal(snapshot.adapterVersion, 'production-hidden-native-v1');
  assert.match(snapshot.adapterSha256 ?? '', /^[a-f0-9]{64}$/);
  assert.match(snapshot.productMainSha256 ?? '', /^[a-f0-9]{64}$/);
  if (expected) {
    for (const key of ['adapterVersion', 'adapterSha256', 'productMainSha256'])
      assert.equal(
        snapshot[key],
        expected[key],
        `Headless adapter identity mismatch: ${key}`,
      );
  }
  assert.equal(
    snapshot.lifetimeObservationIntact,
    true,
    'Native window lifetime observation lost or unverified',
  );
  assert.equal(snapshot.installed, true);
  assert.equal(
    snapshot.valid,
    true,
    'Production headless capability unavailable',
  );
  assert.equal(snapshot.overflow, false, 'Adapter evidence overflow');
  assert.equal(
    snapshot.allWindowsObserved,
    true,
    'Incomplete native window inventory',
  );
  assert.deepEqual(snapshot.events, [], 'Native activation occurred');
  assert.deepEqual(snapshot.violations, []);
  assert.equal(
    snapshot.productImported,
    true,
    'Real production import incomplete',
  );
  assert(
    Number.isInteger(snapshot.pid) && snapshot.pid > 0,
    'Adapter native process identity missing',
  );
  assert(
    typeof snapshot.productMainEntryPath === 'string' &&
      snapshot.productMainEntryPath.endsWith('/out/main/index.js'),
    'Product path missing',
  );
  assert.equal(
    snapshot.launchEntryPath,
    snapshot.productMainEntryPath.replace(
      /index\.js$/,
      'browser-profiles-production-headless-bootstrap.cjs',
    ),
  );
  assert(
    Array.isArray(snapshot.expectedArgv) && snapshot.expectedArgv.length > 1,
    'Independent complete argv expectation missing',
  );
  assert.match(snapshot.launchId ?? '', /^[a-f0-9-]{36}$/);
  assert.match(snapshot.launchContractSha256 ?? '', /^[a-f0-9]{64}$/);
  for (const [key, value] of Object.entries(headlessBootstrap.LAUNCHER_POLICY))
    assert.equal(
      snapshot.launcherIdentity?.[key],
      value,
      'Unknown launcher argv policy',
    );
  if (expected) {
    if (expected.expectedArgv)
      assert.deepEqual(
        snapshot.expectedArgv,
        expected.expectedArgv,
        'Launcher argv expectation mismatch',
      );
    if (expected.launcherIdentity)
      assert.deepEqual(
        snapshot.launcherIdentity,
        expected.launcherIdentity,
        'Launcher source identity mismatch',
      );
  }
  for (const identity of [snapshot.beforeImport, snapshot.currentIdentity]) {
    assert.deepEqual(
      identity?.argv,
      snapshot.expectedArgv,
      'Native argv differs from complete independent direct-entry expectation',
    );
    assert(
      identity &&
        ['appPath', 'cwd', 'resourcesPath'].every(
          (key) =>
            typeof identity[key] === 'string' && identity[key].length > 0,
        ),
      'Product path identity missing',
    );
    assert(
      Array.isArray(identity.argv) &&
        identity.argv.filter((arg) => arg === snapshot.productMainEntryPath)
          .length === 1,
      'Product argv identity missing',
    );
    assert(
      !identity.argv.some(
        (arg) =>
          typeof arg !== 'string' ||
          arg.startsWith('--headless-') ||
          arg === snapshot.launchEntryPath,
      ),
    );
  }
  assert(
    Array.isArray(snapshot.calls) &&
      snapshot.calls.length <= 2048 &&
      snapshot.calls.every(
        (call) =>
          call.suppressed === true &&
          ['show', 'showInactive', 'focus', 'moveTop'].includes(call.method) &&
          (call.target === 'app'
            ? call.method === 'focus' && call.id === null
            : call.target === 'window' &&
              Number.isInteger(call.id) &&
              call.id > 0),
      ),
  );
  assert(
    Array.isArray(snapshot.windows) &&
      snapshot.windows.length > 0 &&
      snapshot.windows.length <= 2048,
  );
  assert(Array.isArray(snapshot.liveWindowIds));
  assert.deepEqual(
    [...snapshot.liveWindowIds].sort((a, b) => a - b),
    snapshot.windows
      .filter(({ current }) => !current.destroyed)
      .map(({ current }) => current.id)
      .sort((a, b) => a - b),
    'Incomplete native window inventory',
  );
  assert.equal(
    new Set(snapshot.windows.map((record) => record.initial.id)).size,
    snapshot.windows.length,
  );
  for (const { initial, current } of snapshot.windows) {
    for (const state of [initial, current]) {
      assert(Number.isInteger(state?.id) && state.id > 0);
      assert.equal(state.visible, false, 'Native window became visible');
      assert.equal(state.focused, false, 'Native window became focused');
    }
    assert.equal(initial.id, current.id);
  }
  for (const key of ['appPath', 'cwd', 'argv', 'resourcesPath'])
    assert.deepEqual(
      snapshot.currentIdentity?.[key],
      snapshot.beforeImport?.[key],
      `Product initialization identity changed: ${key}`,
    );
}
export async function readProductionHeadlessAdapter(
  electronApp,
  evidence,
  key,
) {
  const snapshot = await electronApp.evaluate(() => {
    const read = globalThis.__BROWSER_PROFILES_HEADLESS_SNAPSHOT__;
    if (typeof read !== 'function') throw new Error('Headless adapter missing');
    return read();
  });
  if (evidence) evidence[key] = snapshot;
  assertProductionHeadlessAdapter(snapshot);
  return snapshot;
}
export async function beginProductionHeadlessEvidence(
  electronApp,
  page,
  evidence = {},
) {
  Object.assign(evidence, {
    mode: HEADLESS_STUDY_MODE,
    viewport: HEADLESS_STUDY_VIEWPORT,
    windowVisible: false,
    setup: {},
  });
  evidence.adapterAtSetup = await readProductionHeadlessAdapter(
    electronApp,
    evidence,
    'adapterAtSetup',
  );
  await setupHeadlessStudyWindow(electronApp, page, evidence.setup);
  evidence.atStart = await measuredWindowState(electronApp, page);
  evidence.adapterAtStart = await readProductionHeadlessAdapter(
    electronApp,
    evidence,
    'adapterAtStart',
  );
  return evidence;
}
export async function endProductionHeadlessEvidence(
  electronApp,
  page,
  evidence,
) {
  evidence.atEnd = await measuredWindowState(electronApp, page);
  evidence.adapterAtEnd = await readProductionHeadlessAdapter(
    electronApp,
    evidence,
    'adapterAtEnd',
  );
  assertProductionHeadlessEvidence(evidence);
  return evidence;
}
export function assertProductionHeadlessEvidence(evidence, expected) {
  assertHeadlessWindowEvidence(evidence);
  const first = evidence.adapterAtSetup;
  for (const snapshot of [
    first,
    evidence.adapterAtStart,
    evidence.adapterAtEnd,
  ]) {
    assertProductionHeadlessAdapter(snapshot, expected ?? first);
    for (const key of [
      'launchEntryPath',
      'productMainEntryPath',
      'pid',
      'launchId',
      'launchContractSha256',
    ])
      assert.equal(snapshot[key], first[key]);
  }
  for (const [state, snapshot] of [
    [evidence.atStart, evidence.adapterAtStart],
    [evidence.atEnd, evidence.adapterAtEnd],
  ]) {
    const owner = snapshot.windows.find(
      ({ current }) => current.id === state.id,
    )?.current;
    assert(
      owner && !owner.destroyed,
      'Measured owner absent from adapter inventory',
    );
    assert.equal(owner.webContentsId, state.webContentsId);
    assert.equal(owner.rendererPid, state.rendererPid);
    assert.equal(owner.url, state.nativeUrl);
    const rendererPage = (page) =>
      new URL(
        `../renderer/${page}`,
        pathToFileURL(snapshot.productMainEntryPath),
      ).href;
    const observedUrl = new URL(state.nativeUrl);
    observedUrl.hash = '';
    // The main window loads index.html; App Advisor loads its own page.
    assert(
      [
        rendererPage('index.html'),
        `${rendererPage('app-advisor.html')}?surface=app-advisor`,
      ].includes(observedUrl.href),
      'Unexpected production renderer URL',
    );
  }
}

/** A process-disappearance observation alone cannot replace terminal event history. */
export function assertProductionHeadlessTerminal(
  terminal,
  launch,
  measurements = [],
) {
  assert.equal(
    terminal?.schemaVersion,
    1,
    'Missing terminal lifecycle evidence',
  );
  assert.equal(
    terminal.processGroupGone,
    true,
    'Terminal evidence precedes process disappearance',
  );
  assert.equal(terminal.pid, launch.pid);
  assert.equal(terminal.terminalPath, launch.terminalPath);
  assert.equal(terminal.terminalPath, `${launch.archivePath}.lifecycle.jsonl`);
  assert.match(terminal.fileSha256 ?? '', /^[a-f0-9]{64}$/);
  assert(
    Number.isInteger(terminal.size) &&
      terminal.size > 0 &&
      terminal.size <= 16 * 1024 * 1024,
  );
  assert(
    Array.isArray(terminal.records) && terminal.records.length === 2,
    'Missing, incomplete or post-terminal lifecycle records',
  );
  const [installed, ended] = terminal.records;
  for (const record of terminal.records) {
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.launchId, launch.launchId);
    assert.equal(record.launchContractSha256, launch.launchContractSha256);
    assert.equal(record.pid, launch.pid);
  }
  assert.equal(installed.phase, 'installed');
  assert.equal(ended.phase, 'process-exit');
  assert.equal(
    ended.dispatchCompleted,
    true,
    'Native exit dispatch incomplete',
  );
  assert.equal(
    ended.quitDispatchCompleted,
    true,
    'Native quit dispatch incomplete',
  );
  assert.equal(ended.quitObserved, true, 'Native app quit unobserved');
  assert.equal(ended.observerInstalled, true, 'Native terminal observer lost');
  assert.equal(ended.exitCode, 0, 'Native process exited unsuccessfully');
  assert.equal(ended.snapshotError, undefined, 'Terminal snapshot unavailable');
  assertProductionHeadlessAdapter(ended.snapshot, launch);
  assert.deepEqual(
    ended.snapshot.liveWindowIds,
    [],
    'Terminal lifecycle still has live native windows',
  );
  assert(
    ended.snapshot.windows.every(({ current }) => current.destroyed === true),
    'Terminal native window destruction incomplete',
  );
  assert.equal(ended.snapshot.pid, launch.pid);
  assert.equal(ended.snapshot.launchId, launch.launchId);
  assert.equal(
    ended.snapshot.launchContractSha256,
    launch.launchContractSha256,
  );
  assert.equal(ended.snapshot.launchEntryPath, launch.launchEntryPath);
  assert.equal(
    ended.snapshot.productMainEntryPath,
    launch.productMainEntryPath,
  );
  for (const measured of measurements) {
    assert.equal(measured.launchId, launch.launchId);
    assertProductionHeadlessAdapter(measured, launch);
    assert.deepEqual(
      ended.snapshot.beforeImport,
      measured.beforeImport,
      'Terminal product initialization identity changed',
    );
    assert.deepEqual(
      ended.snapshot.currentIdentity,
      measured.currentIdentity,
      'Terminal product runtime identity changed',
    );
    for (const record of measured.windows) {
      const terminalWindow = ended.snapshot.windows.find(
        (entry) => entry.initial.id === record.initial.id,
      );
      assert.deepEqual(
        terminalWindow?.initial,
        record.initial,
        'Terminal history lost a measured native window',
      );
    }
    assert.deepEqual(
      ended.snapshot.calls.slice(0, measured.calls.length),
      measured.calls,
      'Terminal history lost activation attempts',
    );
  }
}

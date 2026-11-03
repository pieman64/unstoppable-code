import { expect, test } from '@playwright/test';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  collectLeaves,
  DEFAULT_GROUP_IDS,
  DEFAULT_PANEL_IDS,
  getLayout,
  seedPanelWorktree,
  seedVisibleBrowserPanel,
} from './panelHarness.mjs';
import { closeCanopy, getMainWindow, launchCanopy } from './launchCanopy.mjs';
import { CanopyAppDriver, closePanelTab } from './canopyApp.mjs';
import {
  captureFixtureCatalog,
  closeServerWithBoundary,
  createLocalHttpBoundaryObserver,
  createObservedCleanupRecorder,
  createSelectedLaunchBoundary,
  observeBoundary,
  createBoundaryRecorder,
  reportOwnedSetupFailure,
  createLargeInventoryFixture,
  createTerminalCleanupFixture,
  retainSelectionFailureOwner,
  runObservedCleanupSteps,
} from './browser-profile-test-lifecycle.mjs';
import { getScenarioActivity } from './seeders/registerScenario.mjs';

const terminalCleanupTest = test.extend({
  runTerminalCleanup: createTerminalCleanupFixture(),
});

const largeInventoryTest = test.extend({
  largeInventory: createLargeInventoryFixture(),
});

const WINDOWS_PROFILE_DIAGNOSTICS_DIR =
  process.env.CANOPY_WINDOWS_PROFILE_DIAGNOSTICS_DIR?.trim() || null;

function diagnosticErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function boundedCleanupErrorMessage(error) {
  try {
    if (error instanceof Error) {
      try {
        return String(error.message).slice(0, 4_096);
      } catch {
        return 'Cleanup failed with an unreadable Error message';
      }
    }
    return String(error).slice(0, 4_096);
  } catch {
    return 'Cleanup failed with an unreadable error value';
  }
}

async function closeProfileSetupFailure({
  selectionOwner,
  server,
  releaseHeldResponses,
  attachmentName,
}) {
  const failures = [];
  const record = (resource, operation, error) => {
    failures.push({
      resource,
      operation,
      message: boundedCleanupErrorMessage(error),
    });
  };

  try {
    releaseHeldResponses?.();
  } catch {
    // The current release action is only a local boolean assignment. Keep a
    // future reporting failure from replacing the fixture's setup error.
  }
  if (server) {
    try {
      server.closeAllConnections();
    } catch (error) {
      record('http-server', 'close-all-connections', error);
    }
    await new Promise((resolve) => {
      try {
        server.close((error) => {
          let alreadyReleased = false;
          try {
            alreadyReleased = error?.code === 'ERR_SERVER_NOT_RUNNING';
          } catch {
            // A hostile error shape is still a reportable close failure.
          }
          if (error && !alreadyReleased) record('http-server', 'close', error);
          resolve();
        });
      } catch (error) {
        record('http-server', 'close', error);
        resolve();
      }
    });
  }
  if (selectionOwner.electronApp) {
    try {
      await closeCanopy(selectionOwner.electronApp, selectionOwner.userDataDir);
    } catch (error) {
      record('electron-app', 'close', error);
    }
  }
  if (!failures.length) return;

  const cleanupRecord = {
    phase: 'fixture-setup-failure-cleanup',
    failures: failures.slice(0, 3),
  };
  let body;
  try {
    body = Buffer.from(JSON.stringify(cleanupRecord));
  } catch {
    body = Buffer.from(
      '{"phase":"fixture-setup-failure-cleanup","failures":[]}',
    );
  }
  try {
    await test.info().attach(attachmentName, {
      body,
      contentType: 'application/json',
    });
  } catch (attachmentError) {
    try {
      console.error(
        'Failed to attach profile fixture setup cleanup error:',
        JSON.stringify(cleanupRecord),
        boundedCleanupErrorMessage(attachmentError),
      );
    } catch {
      // Reporting is bounded best effort; cleanup and the primary error have
      // already been preserved.
    }
  }
}

async function sendCancelableDebuggerCommand(
  debuggerClient,
  method,
  params,
  timeoutMs,
  label,
) {
  if (debuggerClient.isAttached()) {
    throw new Error(`${label} debugger is already attached`);
  }
  let attached = false;
  let timeoutId;
  try {
    debuggerClient.attach();
    attached = true;
    const command = debuggerClient.sendCommand(method, params);
    return await new Promise((resolve, reject) => {
      timeoutId = setTimeout(() => {
        // Electron's synchronous detach clears and rejects every pending
        // debugger request, so the timed-out protocol operation cannot keep
        // running behind later diagnostic work.
        if (attached && debuggerClient.isAttached()) debuggerClient.detach();
        reject(new Error(`${label} exceeded ${timeoutMs}ms`));
      }, timeoutMs);
      command.then(resolve, reject);
    });
  } finally {
    clearTimeout(timeoutId);
    if (attached && debuggerClient.isAttached()) debuggerClient.detach();
  }
}

function collectWorktreeSelectionSnapshot(requestedIdentity) {
  const isVisible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      rect.width > 0 &&
      rect.height > 0
    );
  };
  const nodes = document.querySelectorAll('[data-testid="worktree-row"]');
  const navigationNodes = document.querySelectorAll(
    '[data-testid^="sidebar-"][aria-current]',
  );
  const rows = Array.from(nodes)
    .slice(0, 128)
    .map((row) => ({
      worktreeId: row.getAttribute('data-worktree-id')?.slice(0, 128),
      branch: row.getAttribute('data-branch')?.slice(0, 128),
      visibleLabel: row.innerText.trim().slice(0, 512),
      visible: isVisible(row),
    }));
  const mainPage = document.querySelector('[data-testid="page-main"]');
  return {
    rows,
    truncated: nodes.length > 128 || navigationNodes.length > 32,
    rowCount: nodes.length,
    countsStatus: nodes.length > 128 ? 'bounded-projection' : 'complete',
    exactCounts: {
      worktreeId: rows.filter((row) => row.worktreeId === requestedIdentity)
        .length,
      branch: rows.filter((row) => row.branch === requestedIdentity).length,
      visibleLabel: rows.filter(
        (row) => row.visible && row.visibleLabel.trim() === requestedIdentity,
      ).length,
    },
    mainPage: {
      present: Boolean(mainPage),
      visible: mainPage ? isVisible(mainPage) : false,
    },
    navigation: Array.from(navigationNodes)
      .slice(0, 32)
      .map((element) => ({
        testId: element.getAttribute('data-testid')?.slice(0, 128),
        ariaCurrent: element.getAttribute('aria-current')?.slice(0, 32),
        visible: isVisible(element),
      })),
    documentState: {
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    },
  };
}

async function captureWorktreeSelectionSnapshot(
  electronApp,
  window,
  requestedIdentity,
  collect = collectWorktreeSelectionSnapshot,
) {
  const browserWindow = await electronApp.browserWindow(window);
  try {
    return await browserWindow.evaluate(
      async (targetWindow, input) => {
        const sendCommand = (0, eval)(`(${input.commandSource})`);
        const response = await sendCommand(
          targetWindow.webContents.debugger,
          'Runtime.evaluate',
          {
            expression: input.expression,
            returnByValue: true,
            awaitPromise: false,
            timeout: input.timeoutMs,
          },
          input.timeoutMs,
          'DOM snapshot',
        );
        if (response.exceptionDetails) {
          throw new Error(
            response.exceptionDetails.exception?.description ??
              response.exceptionDetails.text ??
              'DOM snapshot evaluation failed',
          );
        }
        if (!Object.hasOwn(response.result, 'value')) {
          throw new Error('DOM snapshot did not return a serializable value');
        }
        return response.result.value;
      },
      {
        commandSource: sendCancelableDebuggerCommand.toString(),
        expression: `(${collect.toString()})(${JSON.stringify(requestedIdentity)})`,
        timeoutMs: 2_000,
      },
    );
  } finally {
    await browserWindow.dispose();
  }
}

function createWindowsDiagnosticBasePath(
  slug,
  directory = WINDOWS_PROFILE_DIAGNOSTICS_DIR,
) {
  if (!directory) return null;
  try {
    mkdirSync(directory, { recursive: true });
    return path.join(directory, `${slug}-${process.pid}-${randomUUID()}`);
  } catch (error) {
    console.error(
      `Failed to prepare Windows profile diagnostics in ${directory}:`,
      error,
    );
    return null;
  }
}

function createWorktreeSelectionFailureDiagnostic(slug, directory) {
  const basePath = createWindowsDiagnosticBasePath(slug, directory);
  if (!basePath) return undefined;
  const reportPath = `${basePath}.json`;
  const screenshotPath = `${basePath}.png`;
  const startedAt = process.hrtime.bigint();
  return async ({
    electronApp,
    window,
    branch,
    userDataDir,
    error,
    seedIdentity,
    mainIdentityPath,
  }) => {
    const report = {
      requestedIdentity: branch,
      seedIdentity,
      // Disk projection precedes DOM capture; no loadProjects reconciliation is called.
      failureCatalog: seedIdentity
        ? captureFixtureCatalog(userDataDir, ['demo-ts-pnpm-vite'])
        : undefined,
      actualAppIdentity: mainIdentityPath
        ? (() => {
            try {
              return readFileSync(mainIdentityPath, 'utf8').slice(0, 16 * 1024);
            } catch {
              return 'unobserved';
            }
          })()
        : undefined,
      catalogReadback:
        'not-requested; no reconciliation-triggering loadProjects call',
      userDataDir,
      selectionError: boundedCleanupErrorMessage(error),
      elapsedMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
      rows: null,
      mainPage: null,
      navigation: null,
      documentState: null,
      screenshotPath,
      screenshotSkipped: false,
      captureErrors: [],
    };
    let snapshotCompleted = false;
    try {
      const snapshot = await captureWorktreeSelectionSnapshot(
        electronApp,
        window,
        branch,
      );
      report.rows = snapshot.rows;
      report.truncated = snapshot.truncated;
      report.rowCount = snapshot.rowCount;
      report.countsStatus = snapshot.countsStatus;
      report.exactCounts = snapshot.exactCounts;
      report.mainPage = snapshot.mainPage;
      report.navigation = snapshot.navigation;
      report.documentState = snapshot.documentState;
      snapshotCompleted = true;
    } catch (error) {
      report.captureErrors.push({
        phase: 'snapshot',
        message: boundedCleanupErrorMessage(error),
      });
    }
    if (snapshotCompleted) {
      try {
        await window.screenshot({ path: screenshotPath, timeout: 5_000 });
      } catch (error) {
        report.captureErrors.push({
          phase: 'screenshot',
          message: boundedCleanupErrorMessage(error),
        });
      }
    } else {
      report.screenshotSkipped = true;
    }
    try {
      writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    } catch (error) {
      console.error(
        `Failed to write worktree selection diagnostics to ${reportPath}:`,
        error,
      );
    }
  };
}

function selectedWindowsBoundary(slug) {
  const directory = process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR?.trim();
  if (!directory) return undefined;
  const base = createWindowsDiagnosticBasePath(slug, directory);
  if (!base) return undefined;
  return {
    directory,
    base,
    record: createBoundaryRecorder(`${base}-fixture.jsonl`),
  };
}

function boundedWorkerBoundaryIndex(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;
}

function createSelectedWorkerBoundary(
  boundary,
  slug,
  processTarget = process,
  getTestInfo = () => test.info(),
) {
  if (!boundary?.record) return undefined;
  const info = getTestInfo();
  const identity = {
    slug,
    pid: Number.isSafeInteger(processTarget.pid) ? processTarget.pid : null,
    ppid: Number.isSafeInteger(processTarget.ppid) ? processTarget.ppid : null,
    workerIndex: boundedWorkerBoundaryIndex(info?.workerIndex),
    parallelIndex: boundedWorkerBoundaryIndex(info?.parallelIndex),
  };
  boundary.record('worker-case-entered', identity);
  const onExit = (exitCode) =>
    boundary.record('worker-process-exit', {
      ...identity,
      exitCode: Number.isSafeInteger(exitCode) ? exitCode : null,
    });
  processTarget.once('exit', onExit);
  let released = false;
  return {
    observe: (stage, operation) =>
      observeBoundary(stage, operation, boundary.record),
    release() {
      if (released) return;
      released = true;
      processTarget.removeListener('exit', onExit);
      boundary.record('worker-case-released', identity);
    },
  };
}

function observeSelectedWorkerBoundary(workerBoundary, stage, operation) {
  return workerBoundary
    ? workerBoundary.observe(stage, operation)
    : operation();
}

function selectedSetupDiagnostics(slug, selectionOwner, launchBoundary) {
  const boundary = launchBoundary?.base
    ? { ...launchBoundary, directory: path.dirname(launchBoundary.base) }
    : selectedWindowsBoundary(slug);
  if (!boundary) return undefined;
  const mainIdentityPath = path.resolve(`${boundary.base}-main.jsonl`);
  const capture = createWorktreeSelectionFailureDiagnostic(
    slug,
    boundary.directory,
  );
  let seedIdentity;
  return {
    env: {
      CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
        file: mainIdentityPath,
        mode: launchBoundary ? 'close' : 'setup',
        ...(launchBoundary?.options.env
          ? JSON.parse(
              launchBoundary.options.env
                .CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS,
            )
          : {}),
      }),
    },
    onBeforeLaunch: ({ userDataDir, workspaceIds }) => {
      seedIdentity = captureFixtureCatalog(userDataDir, workspaceIds);
      boundary.record?.('seed-identity', { seedIdentity });
    },
    onSetupFailure: (context) => {
      if (selectionOwner) {
        selectionOwner.electronApp = context.electronApp;
        selectionOwner.userDataDir = context.userDataDir;
      }
      return reportOwnedSetupFailure(context, context.error, {
        capture: (value) =>
          capture?.({ ...value, seedIdentity, mainIdentityPath }),
        close: selectionOwner
          ? undefined
          : launchBoundary
            ? () => launchBoundary.close(context)
            : closeCanopy,
        record: boundary.record,
      });
    },
  };
}

function installInitialNavigationObserver(
  { app, ipcMain, webContents },
  { observerKey, targetUrl },
) {
  const original = ipcMain._invokeHandlers.get('browser:navigate');
  if (typeof original !== 'function')
    throw new Error('Missing browser navigate IPC');
  if (globalThis[observerKey])
    throw new Error('Initial navigation observer already installed');
  let sequence = 0;
  const dispatch = [];
  const native = [];
  const listeners = new Map();
  const targetNativeIds = new Set();
  const retain = (collection, value, limit = 128) => {
    collection.push(value);
    if (collection.length > limit) collection.shift();
  };
  const state = (contents) => ({
    nativeId: contents.id,
    type: String(contents.getType?.() ?? '').slice(0, 64),
    url: String(contents.getURL?.() ?? '').slice(0, 512),
    destroyed: Boolean(contents.isDestroyed?.()),
    loading: !contents.isDestroyed?.() && Boolean(contents.isLoading?.()),
  });
  const retainNative = (contents, phase, details = {}) => {
    retain(
      native,
      {
        sequence: ++sequence,
        phase,
        nativeId: contents.id,
        ...details,
      },
      64,
    );
  };
  const attach = (contents) => {
    if (!contents || listeners.has(contents)) return;
    const started = (_event, url, _inPlace, mainFrame) => {
      if (!mainFrame || url !== targetUrl) return;
      targetNativeIds.add(contents.id);
      retainNative(contents, 'did-start-navigation', { url });
    };
    const failed = (
      _event,
      errorCode,
      errorDescription,
      validatedURL,
      mainFrame,
    ) => {
      if (
        !mainFrame ||
        (validatedURL !== targetUrl && !targetNativeIds.has(contents.id))
      )
        return;
      targetNativeIds.add(contents.id);
      retainNative(contents, 'did-fail-load', {
        url: String(validatedURL ?? '').slice(0, 512),
        errorCode,
        errorDescription: String(errorDescription ?? '').slice(0, 256),
      });
    };
    const navigated = (_event, url, httpResponseCode, httpStatusText) => {
      if (url !== targetUrl && !targetNativeIds.has(contents.id)) return;
      targetNativeIds.add(contents.id);
      retainNative(contents, 'did-navigate', {
        url: String(url ?? '').slice(0, 512),
        httpResponseCode,
        httpStatusText: String(httpStatusText ?? '').slice(0, 128),
      });
    };
    const finished = () => {
      const url = contents.getURL?.() ?? '';
      if (url !== targetUrl && !targetNativeIds.has(contents.id)) return;
      retainNative(contents, 'did-finish-load', {
        url: String(url).slice(0, 512),
      });
    };
    const destroyed = () => {
      if (!targetNativeIds.has(contents.id)) return;
      retainNative(contents, 'destroyed');
    };
    const values = { started, failed, navigated, finished, destroyed };
    listeners.set(contents, values);
    contents.on('did-start-navigation', started);
    contents.on('did-fail-load', failed);
    contents.on('did-navigate', navigated);
    contents.on('did-finish-load', finished);
    contents.on('destroyed', destroyed);
  };
  const created = (_event, contents) => attach(contents);
  const currentContents = webContents.getAllWebContents();
  const initialNative = currentContents.slice(0, 16).map(state);
  for (const contents of currentContents) attach(contents);
  const wrapper = async function (event, request, ...rest) {
    if (request?.url !== targetUrl)
      return original.call(this, event, request, ...rest);
    const record = {
      enteredSequence: ++sequence,
      browserId:
        typeof request.browserId === 'string'
          ? request.browserId.slice(0, 128)
          : null,
      url: targetUrl,
      outcome: 'pending',
    };
    retain(dispatch, record, 32);
    try {
      const result = await original.call(this, event, request, ...rest);
      record.outcome = 'resolved';
      record.settledSequence = ++sequence;
      return result;
    } catch (error) {
      record.outcome = 'rejected';
      record.settledSequence = ++sequence;
      record.error = String(error?.message ?? error).slice(0, 2048);
      throw error;
    }
  };
  globalThis[observerKey] = {
    snapshot: () => ({
      dispatch: dispatch.map((entry) => ({ ...entry })),
      initialNative,
      native: native.map((entry) => {
        const contents = webContents.fromId(entry.nativeId);
        return {
          ...entry,
          destroyed: !contents || contents.isDestroyed(),
          loading:
            contents && !contents.isDestroyed() ? contents.isLoading() : false,
        };
      }),
    }),
    cleanup: () => {
      app.removeListener('web-contents-created', created);
      for (const [contents, values] of listeners) {
        contents.removeListener('did-start-navigation', values.started);
        contents.removeListener('did-fail-load', values.failed);
        contents.removeListener('did-navigate', values.navigated);
        contents.removeListener('did-finish-load', values.finished);
        contents.removeListener('destroyed', values.destroyed);
      }
      delete globalThis[observerKey];
      if (ipcMain._invokeHandlers.get('browser:navigate') !== wrapper)
        throw new Error('Initial navigation observer restoration conflict');
      ipcMain._invokeHandlers.set('browser:navigate', original);
    },
  };
  ipcMain._invokeHandlers.set('browser:navigate', wrapper);
  app.on('web-contents-created', created);
}

async function captureInitialNavigationEvidence({
  electronApp,
  window,
  url,
  activityKey,
  observerKey,
  record,
  testInfo,
  error,
}) {
  const safely = async (unavailable, operation, timeoutMs = 750) => {
    let timer;
    try {
      return await Promise.race([
        Promise.resolve()
          .then(operation)
          .catch((failure) => ({
            unavailable,
            error: boundedCleanupErrorMessage(failure).slice(0, 2048),
          })),
        new Promise((resolve) => {
          timer = setTimeout(
            () => resolve({ unavailable, error: 'diagnostic timed out' }),
            timeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const [snapshot, mock, renderer, screenshot] = await Promise.all([
    safely('main observer snapshot unavailable', () =>
      electronApp.evaluate(
        (_electron, key) => globalThis[key]?.snapshot(),
        observerKey,
      ),
    ),
    safely('mock activity unavailable', () =>
      getScenarioActivity(new URL(url).origin, activityKey),
    ),
    error
      ? safely('renderer state unavailable', () =>
          window.evaluate((intendedUrl) => {
            const input = document.querySelector(
              '[data-testid="browser-url-input"]',
            );
            const panel = document.querySelector(
              '[data-testid="browser-panel-surface"][data-browser-id]',
            );
            const visible = (node) => {
              if (!node) return false;
              const style = window.getComputedStyle(node);
              const rect = node.getBoundingClientRect();
              return (
                style.display !== 'none' &&
                style.visibility !== 'hidden' &&
                rect.width > 0 &&
                rect.height > 0
              );
            };
            const errors = Array.from(
              document.querySelectorAll(
                '[role="alert"], [data-testid*="browser"][data-testid*="error"]',
              ),
            )
              .filter(visible)
              .slice(0, 16)
              .map((node) => ({
                testId: node.getAttribute('data-testid'),
                text: node.textContent?.trim().slice(0, 512) ?? '',
              }));
            return {
              intendedUrl,
              inputCount: document.querySelectorAll(
                '[data-testid="browser-url-input"]',
              ).length,
              inputValue: input?.value?.slice(0, 2048) ?? null,
              inputFocused: document.activeElement === input,
              ariaInvalid: input?.getAttribute('aria-invalid'),
              ariaDescribedBy: input?.getAttribute('aria-describedby'),
              browserId: panel?.getAttribute('data-browser-id') ?? null,
              panelId:
                panel
                  ?.closest('[data-panel-id]')
                  ?.getAttribute('data-panel-id') ?? null,
              errors,
            };
          }, url),
        )
      : { intendedUrl: url },
    error
      ? safely('screenshot unavailable', () =>
          window.locator('body').screenshot({
            animations: 'disabled',
            timeout: 650,
          }),
        )
      : null,
  ]);
  let screenshotEvidence = screenshot;
  if (Buffer.isBuffer(screenshot)) {
    const attachment = await safely('screenshot attachment unavailable', () =>
      testInfo.attach('close-intent-initial-navigation-failure.png', {
        body: screenshot,
        contentType: 'image/png',
      }),
    );
    screenshotEvidence = attachment?.unavailable
      ? attachment
      : { status: 'attached' };
  }
  const details = {
    renderer,
    dispatch: snapshot?.dispatch ?? snapshot,
    native: snapshot
      ? { initial: snapshot.initialNative, events: snapshot.native }
      : snapshot,
    mock,
    cookiePoll: error
      ? { error: boundedCleanupErrorMessage(error).slice(0, 2048) }
      : { status: 'complete' },
    screenshot: screenshotEvidence,
  };
  const checkpoint = error
    ? 'initial-navigation-failure'
    : 'initial-navigation-complete';
  try {
    record?.(checkpoint, details);
  } catch {
    /* Observation only. */
  }
  let serialized = JSON.stringify(details, null, 2);
  if (Buffer.byteLength(serialized) > 64 * 1024)
    serialized = JSON.stringify(
      {
        truncated: true,
        renderer: details.renderer,
        dispatch: details.dispatch,
        mock: details.mock,
        cookiePoll: details.cookiePoll,
        screenshot: details.screenshot,
        native: {
          initialCount: details.native?.initial?.length ?? null,
          eventCount: details.native?.events?.length ?? null,
        },
      },
      null,
      2,
    );
  await safely('metadata attachment unavailable', () =>
    testInfo.attach(`close-intent-${checkpoint}.json`, {
      body: serialized,
      contentType: 'application/json',
    }),
  );
}

function createWindowsCheckpointRecorder(
  slug,
  directory = WINDOWS_PROFILE_DIAGNOSTICS_DIR,
) {
  const basePath = createWindowsDiagnosticBasePath(slug, directory);
  if (!basePath) return null;
  const checkpointPath = `${basePath}.jsonl`;
  const startedAt = process.hrtime.bigint();
  return (checkpoint, details = {}) => {
    try {
      appendFileSync(
        checkpointPath,
        `${JSON.stringify({
          checkpoint,
          elapsedMs: Number((process.hrtime.bigint() - startedAt) / 1_000_000n),
          ...details,
        })}\n`,
        'utf8',
      );
    } catch (error) {
      console.error(
        `Failed to write Windows profile checkpoint to ${checkpointPath}:`,
        error,
      );
    }
  };
}

// Synchronous, allowlisted DOM projection. Intersection is DOM-derived, not
// the private React nativeViewBlocked state, and snapshots are not history.
function collectBrowserBoundaryDom(scope) {
  const id = (value) =>
    typeof value === 'string' ? value.slice(0, 128) : null;
  const element = (node) => {
    if (!node) return { present: false };
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      present: true,
      connected: node.isConnected,
      hidden: node.hidden,
      ariaHidden: node.getAttribute('aria-hidden') === 'true',
      visible:
        node.isConnected &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0,
      testId: id(node.getAttribute('data-testid')),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  };
  const pane = scope.browserId
    ? document.querySelector(
        `[data-testid="browser-pane-${CSS.escape(scope.browserId)}"]`,
      )
    : null;
  const overlay = document.querySelector(
    '[data-testid="browser-javascript-dialog-backdrop"]',
  );
  const paneState = element(pane),
    overlayState = element(overlay);
  const a = paneState.bounds,
    b = overlayState.bounds;
  const menu = document.querySelector('[data-testid="panel-add-menu"]');
  const item = document.querySelector(
    '[data-testid="panel-add-menu-item-browser"]',
  );
  const panels = [];
  let visited = 0,
    truncated = false;
  const walk = (node) => {
    if (!node) return;
    if (++visited > 64) {
      truncated = true;
      return;
    }
    if (node.type === 'leaf') {
      for (const panel of node.panels ?? []) {
        if (++visited > 64) {
          truncated = true;
          break;
        }
        if (panel.kind !== 'browser') continue;
        if (panels.length >= 8) {
          truncated = true;
          break;
        }
        panels.push({
          panelId: id(panel.panelId),
          groupId: id(node.groupId),
          browserId: id(panel.instance?.browserId),
        });
      }
    } else for (const child of node.children ?? []) walk(child);
  };
  const layout = window.__canopyPanelTestApi?.getSerializedLayout();
  walk(layout?.root);
  const pickerNodes = document.querySelectorAll(
    '[data-testid="browser-profile-picker"]',
  );
  const pickers = Array.from(pickerNodes)
    .slice(0, 8)
    .map((node) => ({
      ...element(node),
      paneTestId: id(
        node
          .closest('[data-testid^="browser-pane-"]')
          ?.getAttribute('data-testid'),
      ),
      browserId: id(
        node.closest('[data-browser-id]')?.getAttribute('data-browser-id'),
      ),
    }));
  return {
    modal: element(
      document.querySelector('[data-testid="browser-javascript-dialog"]'),
    ),
    overlay: overlayState,
    pane: paneState,
    domDerivedIntersection:
      a && b
        ? Math.min(a.x + a.width, b.x + b.width) > Math.max(a.x, b.x) &&
          Math.min(a.y + a.height, b.y + b.height) > Math.max(a.y, b.y)
        : null,
    freezeImagePresent: Boolean(pane?.querySelector('img[aria-hidden="true"]')),
    menu: element(menu),
    browserItem: {
      ...element(item),
      disabled: Boolean(
        item?.disabled ||
        item?.getAttribute('aria-disabled') === 'true' ||
        item?.hasAttribute('data-disabled'),
      ),
      busy: item?.getAttribute('aria-busy') === 'true',
    },
    panels,
    layoutStatus: layout ? 'available' : 'unavailable',
    pickers,
    truncated: truncated || pickerNodes.length > 8,
  };
}

function createBrowserBoundaryDiagnostic(electronApp, window, slug) {
  const directory =
    process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR?.trim() ||
    process.env.CANOPY_WINDOWS_BROWSER_BOUNDARY_DIAGNOSTICS_DIR?.trim();
  if (!directory) return null;
  let record;
  try {
    record = createWindowsCheckpointRecorder(slug, directory);
  } catch {
    return null;
  }
  if (!record) return null;
  let count = 0,
    retainedBytes = 0,
    stopped = false;
  let scope;
  const observerToken = randomUUID();
  let armed = false;
  const save = (checkpoint, details) => {
    if (stopped) return;
    try {
      const size =
        Buffer.byteLength(
          JSON.stringify({
            checkpoint,
            elapsedMs: Number.MAX_SAFE_INTEGER,
            ...details,
          }),
        ) + 1;
      if (
        ++count > 255 ||
        size > 16 * 1024 ||
        retainedBytes + size > 103 * 1024
      ) {
        stopped = true;
        record('truncated', {
          reason: '256-record/16KiB-record/104KiB-data-bound',
        });
        return;
      }
      retainedBytes += size;
      record(checkpoint, details);
    } catch {
      /* Observation must preserve the original test failure. */
    }
  };
  const error = (value) => ({
    status: 'unavailable',
    message: boundedCleanupErrorMessage(value).slice(0, 2048),
  });
  // Bound the caller as well as the existing in-main execution deadline.
  // A transport timeout cannot cancel evaluate: consume and label late results.
  const observe = (phase, operation) =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        resolve({
          status: 'unavailable',
          reason: 'diagnostic-transport-timeout',
          phase,
          lateResult: 'may-arrive',
        });
      }, 2000);
      timer.unref();
      Promise.resolve()
        .then(operation)
        .then(
          (value) => {
            clearTimeout(timer);
            if (settled) {
              save('late-observation', { phase, status: 'late-fulfilled' });
              return;
            }
            settled = true;
            resolve(value);
          },
          (value) => {
            clearTimeout(timer);
            if (settled) {
              save('late-observation', {
                phase,
                ...error(value),
                status: 'late-rejected',
              });
              return;
            }
            settled = true;
            resolve(error(value));
          },
        );
    });
  const control = (kind) => {
    const input = { kind, scope, observerToken, deadline: Date.now() + 2000 };
    return observe(kind, () =>
      electronApp.evaluate((_electron, input) => {
        const fixture = globalThis.__CANOPY_E2E_PROFILE_OPERATION_DIAGNOSTICS__;
        if (typeof fixture !== 'function')
          return { status: 'unavailable', reason: 'missing-e2e-boundary-seam' };
        return fixture(input);
      }, input),
    );
  };
  return {
    async arm(identity) {
      scope = identity;
      try {
        armed = true;
        save('armed', await control('arm-create'));
      } catch (value) {
        save('arm-unavailable', error(value));
      }
    },
    async checkpoint(checkpoint, identity, operations = {}, options = {}) {
      scope = identity;
      const details = {
        identity: {
          projectId: identity.projectId,
          worktreeId: identity.worktreeId,
          browserId: identity.browserId,
          profileId: identity.profileId,
          runtimeGeneration: identity.runtimeGeneration,
          storageGeneration: identity.storageGeneration,
          dialogId: identity.dialogId,
        },
        operations,
      };
      try {
        details.main = await control('browser-snapshot');
      } catch (value) {
        details.main = error(value);
      }
      try {
        details.dom = await observe('dom-snapshot', () =>
          captureWorktreeSelectionSnapshot(
            electronApp,
            window,
            identity,
            collectBrowserBoundaryDom,
          ),
        );
      } catch (value) {
        details.dom = error(value);
      }
      if (options.includeRendererLifecycle === true) {
        try {
          details.rendererLifecycle = await observe('renderer-lifecycle', () =>
            window.evaluate((browserId) => {
              const api = window.__canopyPanelTestApi;
              if (typeof api?.getBrowserLifecycle !== 'function') {
                return {
                  status: 'unavailable',
                  reason: 'missing-e2e-panel-seam',
                };
              }
              return api.getBrowserLifecycle(browserId);
            }, identity.browserId),
          );
        } catch (value) {
          details.rendererLifecycle = error(value);
        }
      }
      save(checkpoint, details);
    },
    // The caller's original native poll computes its boolean before diagnostics.
    poll(input) {
      save('original-native-visibility-poll', input);
    },
    failure(value) {
      save('original-step-failed', error(value));
    },
    async close() {
      if (!armed) return;
      try {
        save('observer-release', await control('release-create'));
      } catch (value) {
        save('release-unavailable', error(value));
      }
    },
  };
}

// The graduated address bar exposes profiles through More, not a toolbar chip.
async function expectBrowserProfile(window, name, pane = window) {
  await pane.getByTestId('browser-more').click();
  await expect(window.getByTestId('browser-more-profile')).toContainText(name);
  await window.keyboard.press('Escape');
  await expect(window.getByTestId('browser-more-menu')).toBeHidden();
}

async function chooseBrowserProfile(window, profileId) {
  await window.getByTestId('browser-more').click();
  await window.getByTestId('browser-more-profile').hover();
  await window.getByTestId(`browser-profile-option-${profileId}`).click();
  await expect(window.getByTestId('browser-more-menu')).toBeHidden();
}

// Explicit opt-in works locally on macOS and in the selected Windows CI run.
// Collection is cached metadata plus a bounded synchronous DOM evaluation only.
function createOperationDiagnostic(electronApp, window, slug) {
  const base = createWindowsDiagnosticBasePath(slug);
  let captured;
  let primary;
  const save = (suffix, value) => {
    if (!base) return;
    try {
      writeFileSync(`${base}-${suffix}.json`, JSON.stringify(value, null, 2));
    } catch (error) {
      console.error(
        'Operation evidence write failed:',
        diagnosticErrorMessage(error),
      );
    }
  };
  const errorRecord = (error) => ({
    name: error?.name,
    code: error?.code,
    message: diagnosticErrorMessage(error).slice(0, 2048),
    stack: error?.stack?.slice(0, 8192),
  });
  const control = (kind) =>
    electronApp.evaluate(
      (_electron, input) => {
        const fixture = globalThis.__CANOPY_E2E_PROFILE_OPERATION_DIAGNOSTICS__;
        if (typeof fixture !== 'function')
          throw new Error('Missing operation diagnostics; rebuild E2E.');
        return fixture(input);
      },
      { kind, ...captured },
    );
  return {
    async arm(profile, clear) {
      if (!base) return;
      captured = {
        profileId: profile.profileId,
        storageGeneration: profile.storageGeneration,
        clear,
      };
      const identity = {
        baseline: '31bd6b7e943bc7797e034f6cfcf613ca8b71e256',
        correctionBase: '97cc24c2c3cb0b4ec178bd338249103666aff86c',
        label:
          'diagnostic selection; no Windows acceptance or performance claim',
        interveningChanges: [
          'proactive asynchronous profileData.ensureReady at handler registration',
          'unresolved legacy ownership and retirement handling',
          'selection-bound delete previews',
          'cross-generation reset retry visibility',
          'main-window helper uses configured renderer entry and live top-level native BrowserWindow',
        ],
        runner: process.versions,
        bundles: {},
      };
      try {
        identity.source = execFileSync('git', ['rev-parse', 'HEAD'], {
          encoding: 'utf8',
          timeout: 2000,
        }).trim();
        identity.diff = execFileSync('git', ['status', '--short'], {
          encoding: 'utf8',
          timeout: 2000,
          maxBuffer: 65536,
        });
        identity.diffSha256 = createHash('sha256')
          .update(
            execFileSync('git', ['diff', 'HEAD'], {
              timeout: 2000,
              maxBuffer: 2 * 1024 * 1024,
            }),
          )
          .digest('hex');
      } catch (error) {
        identity.captureError = errorRecord(error);
      }
      // Capture every known executed-main candidate independently. index.js can
      // be only a stable loader; its payload, fallback and loader bytes matter.
      let mainEntry, rendererHtml;
      const captureFile = (file) => {
        try {
          const contents = readFileSync(file);
          identity.bundles[file] = {
            status: 'present',
            sha256: createHash('sha256').update(contents).digest('hex'),
            sizeBytes: contents.byteLength,
          };
          if (file === 'out-e2e/main/index.js')
            mainEntry = contents.toString('utf8');
          if (file === 'out-e2e/renderer/index.html')
            rendererHtml = contents.toString('utf8');
        } catch (error) {
          identity.bundles[file] = {
            status: error?.code === 'ENOENT' ? 'absent' : 'error',
            error: errorRecord(error),
          };
        }
      };
      for (const file of [
        'out-e2e/main/index.js',
        'out-e2e/main/index.jsc',
        'out-e2e/main/_index.js',
        'out-e2e/main/bytecode-loader.cjs',
        'out-e2e/preload/index.js',
        'out-e2e/renderer/index.html',
        'package.json',
        'pnpm-lock.yaml',
        'apps/desktop-app/src/main/lib/e2e-profile-operation-diagnostics.ts',
        'apps/desktop-app/tests/electron/browser-profiles.spec.mjs',
      ])
        captureFile(file);
      identity.mainLayout =
        mainEntry === undefined
          ? 'unavailable'
          : mainEntry.includes('bytecode-loader.cjs') &&
              mainEntry.includes('index.jsc')
            ? 'bytecode'
            : 'javascript';
      identity.mainExecution =
        'Layout and candidate bytes captured; actual bytecode/fallback selection is not inferred from file presence.';
      for (const match of (rendererHtml ?? '').matchAll(
        /(?:src|href)="(?:\.\/)?(assets\/[^"?]+\.(?:js|css))"/g,
      ))
        captureFile(`out-e2e/renderer/${match[1]}`);
      save('identity', identity);
      await control('arm');
    },
    failure(error) {
      primary = error;
      save('primary-failure', errorRecord(error));
    },
    async capture() {
      if (!base || !captured) return;
      try {
        save('service', await control('snapshot'));
      } catch (error) {
        save('service-capture-error', errorRecord(error));
      }
      try {
        save(
          'renderer',
          await captureWorktreeSelectionSnapshot(
            electronApp,
            window,
            captured.profileId,
            (profileId) => {
              const details = document.querySelector(
                '[data-testid="browser-profile-details"]',
              );
              const row = document.querySelector(
                `[data-testid="browser-profile-row-${profileId}"]`,
              );
              return {
                requestedProfileId: profileId,
                row: row
                  ? {
                      label: row.textContent.slice(0, 1024),
                      ariaSelected: row.getAttribute('aria-selected'),
                      dataState: row.getAttribute('data-state'),
                    }
                  : null,
                details: details?.textContent.slice(0, 8192),
                selectedName: details
                  ?.querySelector('input')
                  ?.value?.slice(0, 256),
                alerts: Array.from(
                  details?.querySelectorAll('[role="alert"]') ?? [],
                )
                  .slice(0, 8)
                  .map((element) => element.textContent.slice(0, 2048)),
              };
            },
          ),
        );
      } catch (error) {
        save('renderer-capture-error', errorRecord(error));
      }
      try {
        save('released', await control('release'));
      } catch (error) {
        save('release-error', errorRecord(error));
      }
    },
    teardownFailure(error) {
      save('fixture-teardown-failure', errorRecord(error));
      if (!primary) throw error;
    },
    async close(userDataDir) {
      try {
        await closeCanopy(electronApp, userDataDir);
      } catch (error) {
        save('teardown-failure', errorRecord(error));
        if (!primary) throw error;
      }
    },
  };
}

// Real user configuration, separate from the deterministic capture spec.
test('named profile permissions are independent and Task enable stays fixed on', async () => {
  // Windows completed the user assertions at 48s, then needed native shutdown.
  test.setTimeout(process.platform === 'win32' ? 90_000 : 60_000);
  const boundary = createSelectedLaunchBoundary(
    'named-profile-permissions',
    'initial',
    {
      close: closeCanopy,
      owners: [{ projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }],
    },
  );
  const owner = await seedPanelWorktree(
    selectedSetupDiagnostics(
      'named-profile-permissions-setup',
      undefined,
      boundary,
    ) ?? boundary.options,
  );
  const { electronApp, window, app } = owner;
  try {
    await window.getByTestId('panel-add-tab-group-terminal').click();
    await window.getByTestId('panel-add-menu-item-browser').click();
    await expect(window.getByTestId('browser-bar')).toBeVisible();
    await app.openSettings();
    await app.openSettingsSection('browser');
    const settings = window.getByTestId('settings-tab-browser');
    await settings.getByTestId('browser-profile-new-name').fill('Work');
    await settings.getByTestId('browser-profile-create').click();
    const detail = settings.getByTestId('browser-profile-details');
    await expect(detail).toBeVisible();
    const selectedProfile = settings.locator(
      '[data-testid^="browser-profile-row-"][aria-pressed="true"]',
    );
    // The chosen profile carries the checkmark at the row's end, with no
    // accent fill or ring.
    await expect(selectedProfile).not.toHaveClass(/accent/);
    await expect(selectedProfile.locator('svg')).toHaveCount(1);
    await expect
      .poll(() =>
        selectedProfile.evaluate(
          (element) => getComputedStyle(element).boxShadow,
        ),
      )
      .toBe('none');
    const enable = detail.getByRole('switch', {
      name: 'Allow agent to enable this profile',
      exact: true,
    });
    const clear = detail.getByRole('switch', {
      name: 'Allow agents to clear this profile',
      exact: true,
    });
    await expect(enable).toHaveAttribute('aria-checked', 'false');
    await expect(clear).toHaveAttribute('aria-checked', 'false');
    await enable.click();
    await expect(enable).toHaveAttribute('aria-checked', 'true');
    await expect(clear).toHaveAttribute('aria-checked', 'false');
    await clear.click();
    await expect(clear).toHaveAttribute('aria-checked', 'true');
    await enable.click();
    await expect(enable).toHaveAttribute('aria-checked', 'false');
    await expect(clear).toHaveAttribute('aria-checked', 'true');
    const taskId = await window.evaluate(
      async () =>
        (await window.api.browser.profiles.list()).profiles.find(
          (profile) => profile.kind === 'task',
        )?.profileId,
    );
    expect(taskId).toBeTruthy();
    await settings.getByTestId(`browser-profile-row-${taskId}`).click();
    await expect(enable).toHaveAttribute('aria-checked', 'true');
    await expect(enable).toBeDisabled();
    await expect(clear).toHaveAttribute('aria-checked', 'false');
    await clear.click();
    await expect(clear).toHaveAttribute('aria-checked', 'true');
  } finally {
    await boundary.close(owner);
  }
});

async function dispatchProfileAction(
  electronApp,
  action,
  path = 'scoped',
  destination = {
    projectId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    chatId: 'seed-chat',
  },
) {
  return electronApp.evaluate(
    async (_electron, input) => {
      if (
        typeof globalThis.__CANOPY_E2E_DISPATCH_BROWSER_ACTION__ !== 'function'
      )
        throw new Error('Missing main browser dispatch fixture');
      return globalThis.__CANOPY_E2E_DISPATCH_BROWSER_ACTION__(input);
    },
    { action, path, destination },
  );
}

async function fixtureCookies(electronApp, url, setName) {
  return electronApp.evaluate(
    async ({ webContents }, { url, setName }) => {
      const matches = webContents
        .getAllWebContents()
        .filter((contents) => contents.getURL() === url);
      if (matches.length !== 1)
        throw new Error(
          `Expected one profile fixture view; found ${matches.length}. Native views: ${JSON.stringify(webContents.getAllWebContents().map((contents) => ({ id: contents.id, type: contents.getType(), url: contents.getURL() })))}`,
        );
      if (
        !(await matches[0].executeJavaScript(
          "document.querySelector('[data-browser-fixture] input') !== null",
        ))
      )
        throw new Error('Profile fixture has not rendered its input yet');
      const session = matches[0].session;
      if (setName)
        await session.cookies.set({
          url,
          name: setName,
          value: 'synthetic',
          expirationDate: Math.floor(Date.now() / 1000) + 3600,
        });
      return (await session.cookies.get({ url })).map((cookie) => cookie.name);
    },
    { url, setName },
  );
}

async function dispatchProfileMcpAction(route, action) {
  const response = await fetch(route.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${route.authToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: randomUUID(),
      method: 'tools/call',
      params: { name: 'DispatchAction', arguments: { action } },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(envelope.error).toBeUndefined();
  const text = envelope.result?.content?.find(
    (item) => item.type === 'text',
  )?.text;
  if (typeof text !== 'string' || !text.trim().startsWith('{'))
    throw new Error(
      `MCP tool rejected the browser request: ${text ?? 'no response'}`,
    );
  return JSON.parse(text);
}

test('cold saved tabs reject a different explicit profile before opening and retain existing account access', async () => {
  test.setTimeout(120_000);
  let { electronApp, userDataDir, window, app } = await seedPanelWorktree();
  try {
    await app.openSettings();
    await app.openSettingsSection('browser');
    const settings = window.getByTestId('settings-tab-browser');
    await settings
      .getByTestId('browser-profile-new-name')
      .fill('Saved account');
    await settings.getByTestId('browser-profile-create').click();
    await expect(settings.getByTestId('browser-profile-details')).toBeVisible();
    const named = await window.evaluate(async () =>
      (await window.api.browser.profiles.list()).profiles.find(
        (profile) => profile.displayName === 'Saved account',
      ),
    );
    expect(named.agentPermissions.allowEnable).toBe(false);
    const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?profiles=cold-selection`;
    // Persist a real user-created tab without a mounted Browser panel, so the
    // next process exercises cold rehydration rather than a live-view shortcut.
    const saved = await window.evaluate(
      ({ named, url }) =>
        window.api.browser.create({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          browserId: 'cold-saved-tab',
          url,
          selection: { kind: 'named', profileId: named.profileId },
        }),
      { named, url },
    );
    await expect
      .poll(() =>
        fixtureCookies(electronApp, url, 'saved-account').catch(() => []),
      )
      .toContain('saved-account');
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await getMainWindow(electronApp);
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    const countViews = () =>
      electronApp.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .filter((contents) => contents.getURL() === url).length,
        url,
      );
    expect(await countViews()).toBe(0);
    const denied = await dispatchProfileAction(electronApp, {
      type: 'browser.open',
      browserId: saved.id,
      expectedRuntimeGeneration: saved.profile.runtimeGeneration,
      selection: { kind: 'task' },
    });
    expect(denied).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    expect(await countViews()).toBe(0);
    const reopened = await dispatchProfileAction(electronApp, {
      type: 'browser.open',
      browserId: saved.id,
      expectedRuntimeGeneration: saved.profile.runtimeGeneration,
      selection: { kind: 'named', profileId: named.profileId },
    });
    expect(reopened.ok).toBe(true);
    await expect
      .poll(() => fixtureCookies(electronApp, url).catch(() => []))
      .toContain('saved-account');
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await window.getByTestId(`panel-tab-panel-browser-${saved.id}`).click();
    await expectBrowserProfile(window, 'Saved account');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('switches real account stores, fences stale commands, and enforces both main dispatch paths', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    const profiles = await window.evaluate(async () => {
      const api = window.api.browser.profiles;
      return Promise.all(
        ['Work', 'Personal'].map((displayName) =>
          api.create({
            operationId: crypto.randomUUID(),
            input: { displayName },
          }),
        ),
      );
    });
    const [work, personal] = profiles;
    await window.getByTestId('panel-add-tab-group-terminal').click();
    await window.getByTestId('panel-add-menu-item-browser').click();
    const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?profiles=account-switch`;
    const input = window.getByTestId('browser-url-input');
    await input.fill(url);
    await input.press('Enter');
    await expect
      .poll(() => fixtureCookies(electronApp, url, 'task-only').catch(() => []))
      .toContain('task-only');
    const readTab = async () =>
      (await dispatchProfileAction(electronApp, { type: 'browser.list' }))
        .result.browsers[0];
    const original = await readTab();
    const oldInputs = await dispatchProfileAction(electronApp, {
      type: 'browser.input_snapshot',
      browserId: original.id,
      expectedRuntimeGeneration: original.profile.runtimeGeneration,
    });
    const oldRef = oldInputs.result.inputSnapshot.inputs[0].ref;
    const choose = async (profile) => {
      await chooseBrowserProfile(window, profile.profileId);
      await expectBrowserProfile(window, profile.displayName);
      await expect
        .poll(async () => (await readTab()).profile.resolvedProfileId)
        .toBe(profile.profileId);
      await expect
        .poll(async () => {
          try {
            await fixtureCookies(electronApp, url);
            return true;
          } catch {
            return false;
          }
        })
        .toBe(true);
    };
    await choose(work);
    expect(await fixtureCookies(electronApp, url)).not.toContain('task-only');
    await fixtureCookies(electronApp, url, 'work-only');
    await choose(personal);
    expect(await fixtureCookies(electronApp, url)).not.toContain('work-only');
    await choose(work);
    expect(await fixtureCookies(electronApp, url)).toContain('work-only');
    const current = await readTab();
    expect(current.id).toBe(original.id);
    expect(current.profile.runtimeGeneration).toBeGreaterThan(
      original.profile.runtimeGeneration,
    );
    const currentInputs = await dispatchProfileAction(electronApp, {
      type: 'browser.input_snapshot',
      browserId: current.id,
      expectedRuntimeGeneration: current.profile.runtimeGeneration,
    });
    expect(currentInputs.result.inputSnapshot.runtimeGeneration).toBe(
      current.profile.runtimeGeneration,
    );
    expect(currentInputs.result.inputSnapshot.inputs[0].ref).not.toBe(oldRef);
    const staleRef = await dispatchProfileAction(electronApp, {
      type: 'browser.fill',
      browserId: current.id,
      expectedRuntimeGeneration: current.profile.runtimeGeneration,
      ref: oldRef,
      text: 'wrong account',
    });
    expect(staleRef.ok).toBe(false);
    const stale = await dispatchProfileAction(electronApp, {
      type: 'browser.navigate',
      browserId: current.id,
      expectedRuntimeGeneration: original.profile.runtimeGeneration,
      url: `${url}&stale=1`,
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'stale_runtime' },
    });
    for (const path of ['scoped', 'app-advisor']) {
      const denied = await dispatchProfileAction(
        electronApp,
        {
          type: 'browser.open',
          url,
          selection: { kind: 'named', profileId: work.profileId },
        },
        path,
      );
      expect(denied).toMatchObject({
        ok: false,
        error: { code: 'agent_enable_denied' },
      });
      const existing = await dispatchProfileAction(
        electronApp,
        {
          type: 'browser.reload',
          browserId: current.id,
          expectedRuntimeGeneration: current.profile.runtimeGeneration,
        },
        path,
      );
      expect(existing.ok).toBe(true);
      expect(existing.result.browser.profile.resolvedProfileId).toBe(
        work.profileId,
      );
    }
    const enabled = await window.evaluate(
      async (profile) =>
        window.api.browser.profiles.update({
          operationId: crypto.randomUUID(),
          profileId: profile.profileId,
          expectedMetadataRevision: profile.metadataRevision,
          patch: { allowEnable: true },
        }),
      work,
    );
    const opened = await dispatchProfileAction(electronApp, {
      type: 'browser.open',
      url: `${url}&second=1`,
      selection: { kind: 'named', profileId: work.profileId },
    });
    expect(opened.ok).toBe(true);
    expect(opened.result.browser.id).not.toBe(current.id);
    await window.evaluate(
      async (profile) =>
        window.api.browser.profiles.update({
          operationId: crypto.randomUUID(),
          profileId: profile.profileId,
          expectedMetadataRevision: profile.metadataRevision,
          patch: { allowEnable: false, allowClear: true },
        }),
      enabled,
    );
    const offAgain = await dispatchProfileAction(electronApp, {
      type: 'browser.open',
      selection: { kind: 'named', profileId: work.profileId },
    });
    expect(offAgain, JSON.stringify(offAgain)).toMatchObject({
      ok: false,
      error: { code: 'agent_enable_denied' },
    });
    const list = await dispatchProfileAction(electronApp, {
      type: 'browser.profile.list',
    });
    expect(
      list.result.profiles.find(
        (profile) => profile.profileId === work.profileId,
      ).agentPermissions,
    ).toEqual({ allowEnable: false, allowClear: true });
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

test('inspector browser dispatch isolates ambient context while native IPC and HTTP enforce profile permissions', async () => {
  test.setTimeout(120_000);
  const selectionOwner = {};
  let seeded;
  try {
    seeded = await seedPanelWorktree({
      onSelectWorktreeFailure: retainSelectionFailureOwner(
        selectionOwner,
        createWorktreeSelectionFailureDiagnostic(
          'inspector-browser-dispatch-selection',
        ),
      ),
    });
  } catch (selectionError) {
    if (selectionOwner.electronApp) {
      try {
        await closeCanopy(
          selectionOwner.electronApp,
          selectionOwner.userDataDir,
        );
      } catch (cleanupError) {
        try {
          await test.info().attach('inspector-selection-cleanup-failure.json', {
            body: Buffer.from(
              JSON.stringify({
                phase: 'selection-failure-close',
                message: diagnosticErrorMessage(cleanupError).slice(0, 4_096),
              }),
            ),
            contentType: 'application/json',
          });
        } catch (attachmentError) {
          console.error(
            'Failed to attach inspector selection cleanup error:',
            cleanupError,
            attachmentError,
          );
        }
      }
    }
    throw selectionError;
  }
  const { electronApp, userDataDir, window } = seeded;
  const destination = {
    projectId: 'demo-ts-pnpm-vite',
    worktreeId: 'demo-main',
    chatId: 'seed-chat',
  };
  let pending;
  let mcpRoute;
  try {
    const work = await window.evaluate(() =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName: 'Context control Work' },
      }),
    );
    expect(work.agentPermissions).toEqual({
      allowEnable: false,
      allowClear: false,
    });
    await window.getByTestId('panel-add-tab-group-terminal').click();
    await window.getByTestId('panel-add-menu-item-browser').click();
    const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?profiles=async-context`;
    await window.getByTestId('browser-url-input').fill(url);
    await window.getByTestId('browser-url-input').press('Enter');
    await expect
      .poll(() =>
        fixtureCookies(electronApp, url, 'context-owner-task').catch(() => []),
      )
      .toContain('context-owner-task');
    const original = (
      await dispatchProfileAction(electronApp, { type: 'browser.list' })
    ).result.browsers[0];

    // Capture this service's real ALS instance once, then promptly restore the
    // prototype. Holding the command alone does not force context inheritance.
    await electronApp.evaluate(async (_electron, original) => {
      const { AsyncLocalStorage, executionAsyncId, triggerAsyncId } =
        process.getBuiltinModule('async_hooks');
      const rawRun = AsyncLocalStorage.prototype.run;
      const fixture = {
        entered: false,
        phase: 'capture',
        observations: [],
        rawRun,
      };
      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let armed = true;
      let restoreGetStore = () => {};
      const interceptedRun = function (store, callback, ...args) {
        if (
          armed &&
          store?.browserId === original.id &&
          store.generation === original.profile.runtimeGeneration &&
          store.dialog === false
        ) {
          armed = false;
          AsyncLocalStorage.prototype.run = rawRun;
          fixture.als = this;
          fixture.store = store;
          const descriptor = Object.getOwnPropertyDescriptor(this, 'getStore');
          const rawGetStore = this.getStore;
          this.getStore = function () {
            const current = rawGetStore.call(this);
            const stack = new Error().stack ?? '';
            if (fixture.observations.length < 200) {
              fixture.observations.push({
                phase: fixture.phase,
                browserId: current?.browserId ?? null,
                generation: current?.generation ?? null,
                executionAsyncId: executionAsyncId(),
                triggerAsyncId: triggerAsyncId(),
                atCreate: stack.includes('createSerialized'),
                atTargetAssertion: stack.includes('assertCommandTarget'),
              });
            }
            return current;
          };
          restoreGetStore = () => {
            if (descriptor)
              Object.defineProperty(fixture.als, 'getStore', descriptor);
            else delete fixture.als.getStore;
          };
          return rawRun.call(this, store, async () => {
            fixture.entered = true;
            await gate;
            return callback(...args);
          });
        }
        return rawRun.call(this, store, callback, ...args);
      };
      fixture.restore = () => {
        if (AsyncLocalStorage.prototype.run === interceptedRun)
          AsyncLocalStorage.prototype.run = rawRun;
        restoreGetStore();
        release();
      };
      AsyncLocalStorage.prototype.run = interceptedRun;
      globalThis.__PROFILE_ASYNC_DISPATCH_FIXTURE__ = fixture;
    }, original);
    pending = dispatchProfileAction(electronApp, {
      type: 'browser.input_snapshot',
      browserId: original.id,
      expectedRuntimeGeneration: original.profile.runtimeGeneration,
    }).catch((error) => ({ testError: String(error) }));
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.__PROFILE_ASYNC_DISPATCH_FIXTURE__.entered,
        ),
      )
      .toBe(true);

    const dispatchInContext = (
      phase,
      action,
      forced = false,
      path = 'scoped',
    ) =>
      electronApp.evaluate(
        async (_electron, { phase, input, forced }) => {
          const fixture = globalThis.__PROFILE_ASYNC_DISPATCH_FIXTURE__;
          fixture.phase = phase;
          const dispatch = () =>
            globalThis.__CANOPY_E2E_DISPATCH_BROWSER_ACTION__(input);
          try {
            return await (forced
              ? fixture.rawRun.call(fixture.als, fixture.store, dispatch)
              : fixture.als.exit(dispatch));
          } finally {
            fixture.phase = 'idle';
          }
        },
        { phase, forced, input: { action, path, destination } },
      );
    const summarizeBrowsers = (response) =>
      response.result.browsers.map((browser) => ({
        id: browser.id,
        profileId: browser.profile.resolvedProfileId,
        runtimeGeneration: browser.profile.runtimeGeneration,
      }));
    const before = summarizeBrowsers(
      await dispatchInContext('before', { type: 'browser.list' }),
    );
    const open = {
      type: 'browser.open',
      selection: { kind: 'named', profileId: work.profileId },
    };
    const clean = await dispatchInContext('clean-agent-open', open);
    const forced = await dispatchInContext('forced-agent-open', open, true);
    const forcedAdvisor = await dispatchInContext(
      'forced-advisor-open',
      open,
      true,
      'app-advisor',
    );
    const afterAgentOpens = summarizeBrowsers(
      await dispatchInContext('after-agent-opens', { type: 'browser.list' }),
    );
    const stale = await dispatchInContext(
      'stale-target',
      {
        type: 'browser.input_snapshot',
        browserId: original.id,
        expectedRuntimeGeneration: original.profile.runtimeGeneration + 1,
      },
      true,
    );

    // A real renderer IPC arrives independently of the inspector callback.
    // Its actor is user, so opening enable-disabled Work is allowed here.
    let nativeIpc;
    await electronApp.evaluate(() => {
      globalThis.__PROFILE_ASYNC_DISPATCH_FIXTURE__.phase = 'native-ipc';
    });
    try {
      const controlUrl = `${url}&native-ipc-control=1`;
      const control = await window.evaluate(
        (request) => window.api.browser.create(request),
        {
          projectId: destination.projectId,
          worktreeId: destination.worktreeId,
          selection: { kind: 'named', profileId: work.profileId },
          url: controlUrl,
        },
      );
      nativeIpc = {
        ok: true,
        browserId: control.id,
        profileId: control.profile.resolvedProfileId,
        runtimeGeneration: control.profile.runtimeGeneration,
        isolatedFromTask: false,
      };
      await expect
        .poll(() =>
          fixtureCookies(electronApp, controlUrl)
            .then((names) => !names.includes('context-owner-task'))
            .catch(() => false),
        )
        .toBe(true);
      nativeIpc.isolatedFromTask = true;
    } catch (error) {
      nativeIpc = {
        ...nativeIpc,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    // Start/register the actual app MCP service outside the captured context,
    // then send a real authenticated request from this separate test process.
    // No fixture dispatcher or mocked permission response handles this request.
    let httpMcp;
    let beforeHttp;
    let afterHttp;
    try {
      mcpRoute = await electronApp.evaluate(async () => {
        const fixture = globalThis.__PROFILE_ASYNC_DISPATCH_FIXTURE__;
        const setup = globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__;
        if (typeof setup !== 'function')
          throw new Error('Missing E2E browser MCP route setup. Rebuild E2E.');
        fixture.phase = 'http-setup';
        return fixture.als.exit(() => setup({ kind: 'create' }));
      });
      beforeHttp = summarizeBrowsers(
        await dispatchInContext('before-http', { type: 'browser.list' }),
      );
      await electronApp.evaluate(() => {
        globalThis.__PROFILE_ASYNC_DISPATCH_FIXTURE__.phase = 'http-mcp';
      });
      const response = await fetch(mcpRoute.url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${mcpRoute.authToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'profile-context-control',
          method: 'tools/call',
          params: { name: 'DispatchAction', arguments: { action: open } },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      httpMcp = { transportOk: false, status: response.status };
      if (response.status !== 200)
        throw new Error(`MCP HTTP control returned status ${response.status}.`);
      const envelope = await response.json();
      if (envelope.error)
        throw new Error(
          `MCP HTTP control returned JSON-RPC error ${envelope.error.code}: ${envelope.error.message}`,
        );
      const content = envelope.result?.content?.find(
        (item) => item.type === 'text' && typeof item.text === 'string',
      );
      if (!content) throw new Error('MCP HTTP control returned no tool text.');
      if (!content.text.trim().startsWith('{'))
        throw new Error(`MCP HTTP tool rejected the request: ${content.text}`);
      const result = JSON.parse(content.text);
      httpMcp = {
        transportOk: true,
        status: response.status,
        toolIsError: envelope.result.isError === true,
        result: {
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
        },
      };
      afterHttp = summarizeBrowsers(
        await dispatchInContext('after-http', { type: 'browser.list' }),
      );
    } catch (error) {
      httpMcp = {
        ...httpMcp,
        transportOk: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    const observations = await electronApp.evaluate(() => {
      const fixture = globalThis.__PROFILE_ASYNC_DISPATCH_FIXTURE__;
      fixture.phase = 'idle';
      return fixture.observations;
    });
    const permissions = await window.evaluate(
      async (profileId) =>
        (await window.api.browser.profiles.get({ profileId })).agentPermissions,
      work.profileId,
    );
    const summarizeResponse = (response) => ({
      ok: response.ok,
      ...(response.error ? { error: response.error } : {}),
    });
    const diagnostics = {
      context:
        'Forced calls test the E2E inspector fixture boundary; native IPC and external HTTP independently exercise production ingress.',
      originalBrowserId: original.id,
      disabledProfileId: work.profileId,
      permissions,
      before,
      afterAgentOpens,
      clean: summarizeResponse(clean),
      forced: summarizeResponse(forced),
      forcedAdvisor: summarizeResponse(forcedAdvisor),
      stale: summarizeResponse(stale),
      nativeIpc,
      httpMcp,
      beforeHttp,
      afterHttp,
      observations,
    };
    await test.info().attach('browser-async-context.json', {
      body: Buffer.from(JSON.stringify(diagnostics, null, 2)),
      contentType: 'application/json',
    });

    expect(httpMcp, JSON.stringify(diagnostics)).toMatchObject({
      transportOk: true,
      status: 200,
      toolIsError: true,
      result: { ok: false, error: { code: 'agent_enable_denied' } },
    });

    // The fixture captures clean startup context. These calls deliberately enter
    // it from foreign ALS; they do not claim production accepts foreign context.
    // The independent native IPC and HTTP observations cover actual ingress.
    expect(forced, JSON.stringify(diagnostics)).toMatchObject({
      ok: false,
      error: { code: 'agent_enable_denied' },
    });
    expect(clean).toMatchObject({
      ok: false,
      error: { code: 'agent_enable_denied' },
    });
    expect(forcedAdvisor).toMatchObject({
      ok: false,
      error: { code: 'agent_enable_denied' },
    });
    expect(stale).toMatchObject({
      ok: false,
      error: { code: 'stale_runtime' },
    });
    expect(afterAgentOpens).toEqual(before);
    expect(permissions).toEqual({ allowEnable: false, allowClear: false });
    expect(nativeIpc).toMatchObject({
      ok: true,
      profileId: work.profileId,
      isolatedFromTask: true,
    });
    const nativeCreateObservations = observations.filter(
      (observation) =>
        observation.phase === 'native-ipc' && observation.atCreate,
    );
    expect(nativeCreateObservations.length).toBeGreaterThan(0);
    expect(
      nativeCreateObservations.every(
        (observation) => observation.browserId === null,
      ),
    ).toBe(true);
    expect(httpMcp).toMatchObject({
      transportOk: true,
      status: 200,
      toolIsError: true,
      result: { ok: false, error: { code: 'agent_enable_denied' } },
    });
    expect(afterHttp).toEqual(beforeHttp);
    const httpCreateObservations = observations.filter(
      (observation) => observation.phase === 'http-mcp' && observation.atCreate,
    );
    expect(httpCreateObservations.length).toBeGreaterThan(0);
    expect(
      httpCreateObservations.every(
        (observation) => observation.browserId === null,
      ),
    ).toBe(true);
  } finally {
    await electronApp
      .evaluate(async (_electron, sessionKey) => {
        globalThis.__PROFILE_ASYNC_DISPATCH_FIXTURE__?.restore();
        delete globalThis.__PROFILE_ASYNC_DISPATCH_FIXTURE__;
        if (sessionKey)
          await globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
            kind: 'delete',
            sessionKey,
          });
      }, mcpRoute?.sessionKey)
      .catch(() => {});
    await pending;
    await closeCanopy(electronApp, userDataDir);
  }
});

test('a queued agent fill cannot edit the replacement profile after a user switch', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window } = await seedPanelWorktree();
  let pending;
  let contender;
  const phases = [];
  try {
    const named = await window.evaluate(() =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName: 'Replacement' },
      }),
    );
    await window.getByTestId('panel-add-tab-group-terminal').click();
    await window.getByTestId('panel-add-menu-item-browser').click();
    const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?profiles=queued-fill`;
    await window.getByTestId('browser-url-input').fill(url);
    await window.getByTestId('browser-url-input').press('Enter');
    await expect
      .poll(() =>
        fixtureCookies(electronApp, url)
          .then(() => true)
          .catch(() => false),
      )
      .toBe(true);
    const original = (
      await dispatchProfileAction(electronApp, { type: 'browser.list' })
    ).result.browsers[0];
    // A presentation command must not consume the gate for this exact fill.
    // The action getter tags its real dispatch after the startup-bound E2E
    // entry point has cleared inspector context; no production class is replaced.
    await electronApp.evaluate(async (_electron, original) => {
      const { AsyncLocalStorage } = process.getBuiltinModule('async_hooks');
      const run = AsyncLocalStorage.prototype.run;
      const commandContext = new AsyncLocalStorage();
      const fillIdentity = {};
      const fixture = {
        entered: false,
        released: false,
        resumed: false,
        fillSettled: false,
        captured: null,
        presentationObserved: false,
        commandContext,
        fillIdentity,
      };
      let release;
      let armed = true;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      const interceptedRun = function (store, callback, ...args) {
        const exactFill = commandContext.getStore() === fillIdentity;
        if (
          store?.browserId === original.id &&
          store.generation === original.profile.runtimeGeneration &&
          store.dialog === true &&
          store.rehydrate === false
        )
          fixture.presentationObserved = true;
        if (
          armed &&
          store?.browserId === original.id &&
          store.generation === original.profile.runtimeGeneration &&
          store.dialog === false &&
          store.rehydrate === true &&
          exactFill
        ) {
          armed = false;
          AsyncLocalStorage.prototype.run = run;
          fixture.captured = {
            browserId: store.browserId,
            generation: store.generation,
            dialog: store.dialog,
            rehydrate: store.rehydrate,
            exactFill,
          };
          return run.call(this, store, async () => {
            fixture.entered = true;
            await gate;
            fixture.resumed = true;
            return callback(...args);
          });
        }
        return run.call(this, store, callback, ...args);
      };
      fixture.snapshot = () => ({
        entered: fixture.entered,
        released: fixture.released,
        resumed: fixture.resumed,
        fillSettled: fixture.fillSettled,
        settledBeforeRelease: fixture.settledBeforeRelease ?? null,
        captured: fixture.captured,
        presentationObserved: fixture.presentationObserved,
        prototypeRestored: AsyncLocalStorage.prototype.run === run,
      });
      fixture.restore = () => {
        if (AsyncLocalStorage.prototype.run === interceptedRun)
          AsyncLocalStorage.prototype.run = run;
        fixture.released = true;
        release();
      };
      fixture.cleanup = () => commandContext.disable();
      AsyncLocalStorage.prototype.run = interceptedRun;
      globalThis.__PROFILE_QUEUED_FILL_FIXTURE__ = fixture;
    }, original);
    // Deliberately race a real native presentation scope ahead of fill. Do not
    // await it here: the broken broad hook holds this contender until cleanup.
    contender = window
      .evaluate(async (original) => {
        try {
          await window.api.browser.setBounds({
            browserId: original.id,
            expectedRuntimeGeneration: original.profile.runtimeGeneration,
            bounds: { x: 20, y: 180, width: 640, height: 400 },
            visible: true,
          });
          return { status: 'fulfilled' };
        } catch (error) {
          // Electron's renderer IPC envelope does not preserve the error code.
          // Qualify only this channel's exact presentation-supersession message.
          const message = error?.message;
          return {
            status:
              message ===
              "Error invoking remote method 'browser:set-bounds': BrowserProfileError: A newer presentation request replaced this command."
                ? 'superseded'
                : 'rejected',
            message: typeof message === 'string' ? message : String(error),
          };
        }
      }, original)
      .catch((error) => ({
        status: 'transport-error',
        message: String(error),
      }));
    await expect
      .poll(() =>
        electronApp.evaluate(
          () => globalThis.__PROFILE_QUEUED_FILL_FIXTURE__.presentationObserved,
        ),
      )
      .toBe(true);
    pending = electronApp
      .evaluate(
        async (_electron, action) => {
          const fixture = globalThis.__PROFILE_QUEUED_FILL_FIXTURE__;
          try {
            return await globalThis.__CANOPY_E2E_DISPATCH_BROWSER_ACTION__({
              get action() {
                fixture.commandContext.enterWith(fixture.fillIdentity);
                return action;
              },
              path: 'scoped',
              destination: {
                projectId: 'demo-ts-pnpm-vite',
                worktreeId: 'demo-main',
                chatId: 'seed-chat',
              },
            });
          } finally {
            fixture.fillSettled = true;
            fixture.settledBeforeRelease = !fixture.released;
          }
        },
        {
          type: 'browser.fill',
          browserId: original.id,
          expectedRuntimeGeneration: original.profile.runtimeGeneration,
          locator: '[data-browser-fixture] input',
          text: 'stale account write',
        },
      )
      .catch((error) => ({ testError: String(error) }));
    await expect
      .poll(() =>
        electronApp.evaluate(() => {
          const fixture = globalThis.__PROFILE_QUEUED_FILL_FIXTURE__;
          return fixture.captured?.exactFill || fixture.fillSettled;
        }),
      )
      .toBe(true);
    const assertHeld = async (phase) => {
      const state = await electronApp.evaluate(() =>
        globalThis.__PROFILE_QUEUED_FILL_FIXTURE__.snapshot(),
      );
      phases.push({ phase, ...state });
      expect(state, `queued-fill hold precondition (${phase})`).toMatchObject({
        entered: true,
        released: false,
        resumed: false,
        fillSettled: false,
        prototypeRestored: true,
        captured: {
          browserId: original.id,
          generation: original.profile.runtimeGeneration,
          dialog: false,
          rehydrate: true,
          exactFill: true,
        },
      });
    };
    await assertHeld('before-switch');
    await chooseBrowserProfile(window, named.profileId);
    await expectBrowserProfile(window, 'Replacement');
    await expect
      .poll(() =>
        fixtureCookies(electronApp, url)
          .then(() => true)
          .catch(() => false),
      )
      .toBe(true);
    const replacement = (
      await dispatchProfileAction(electronApp, { type: 'browser.list' })
    ).result.browsers.find((browser) => browser.id === original.id);
    expect(replacement.profile.resolvedProfileId).toBe(named.profileId);
    expect(replacement.profile.runtimeGeneration).toBeGreaterThan(
      original.profile.runtimeGeneration,
    );
    await assertHeld('after-switch');
    await electronApp.evaluate(() =>
      globalThis.__PROFILE_QUEUED_FILL_FIXTURE__.restore(),
    );
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: 'stale_runtime' },
    });
    const settled = await electronApp.evaluate(() =>
      globalThis.__PROFILE_QUEUED_FILL_FIXTURE__.snapshot(),
    );
    phases.push({ phase: 'settled', ...settled });
    expect(settled).toMatchObject({
      released: true,
      resumed: true,
      fillSettled: true,
      settledBeforeRelease: false,
      prototypeRestored: true,
    });
    const contenderOutcome = await contender;
    phases.push({ phase: 'contender', outcome: contenderOutcome });
    expect(['fulfilled', 'superseded'].includes(contenderOutcome.status)).toBe(
      true,
    );
    const value = await electronApp.evaluate(
      async ({ webContents }, fixtureUrl) => {
        const view = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === fixtureUrl);
        return view.executeJavaScript(
          "document.querySelector('[data-browser-fixture] input').value",
        );
      },
      url,
    );
    expect(value).toBe('');
  } finally {
    try {
      await electronApp
        .evaluate(() => globalThis.__PROFILE_QUEUED_FILL_FIXTURE__?.restore())
        .catch(() => {});
      await Promise.all([pending, contender]);
      const cleanup = await electronApp
        .evaluate(() => {
          const fixture = globalThis.__PROFILE_QUEUED_FILL_FIXTURE__;
          const state = fixture?.snapshot();
          fixture?.cleanup();
          delete globalThis.__PROFILE_QUEUED_FILL_FIXTURE__;
          return state;
        })
        .catch((error) => ({ testError: String(error) }));
      phases.push({ phase: 'cleanup', ...cleanup });
      await test.info().attach('queued-fill-scheduler.json', {
        body: Buffer.from(JSON.stringify(phases, null, 2)),
        contentType: 'application/json',
      });
    } finally {
      await closeCanopy(electronApp, userDataDir);
    }
  }
});

// Compatibility-only harness retained for the source-driven Node scenarios in
// browser-profile-operation-diagnostics.test.mjs. Registered Electron cases
// below use runGraduatedPendingSourceDialogCase; they do not execute this gate.
function assertPendingPresentationOrdering(verdict) {
  expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
  return verdict;
}

async function runPendingSourceDialogCase({
  controlledLaterHide = false,
} = {}) {
  test.setTimeout(90_000);
  const {
    installPresentationObserver,
    verifyPresentationOrdering,
    installPresentationRendererRouteRecorder,
    waitForInitialNativeReadiness,
  } = await import('./browser-profile-presentation-observer.mjs');
  let presentationObserverHandle;
  let rendererRouteHandle;
  let composerRootElement;
  const presentationInjectionId = randomUUID();
  const selectionOwner = {};
  const launchBoundary = createSelectedLaunchBoundary(
    'presentation-ordering',
    'pending-dialog',
    {
      close: closeCanopy,
      owners: [{ projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }],
      firstProjectsLoad: !controlledLaterHide,
    },
  );
  let seeded;
  let electronApp;
  let userDataDir;
  let window;
  let advisorRoute;
  let boundaryDiagnostic;
  let earlierPresentation;
  let newerPresentation;
  let presentationGateObservation;
  let presentationGateRace;
  let newerGateObservation;
  let ownerRendererWebContentsId;
  const controlledEvidence = controlledLaterHide
    ? { stage: 'conditional-presentation-ordering', rendererCheckpoints: [] }
    : undefined;
  let orderingVerdict;
  const arbitraryBError =
    !controlledLaterHide &&
    process.env.CANOPY_E2E_PRESENTATION_ARBITRARY_B_ERROR ===
      'after-original-fulfillment';
  let primaryError;
  const cleanupErrors = [];
  try {
    seeded = await seedPanelWorktree({
      ...launchBoundary.options,
      onSetupFailure: retainSelectionFailureOwner(
        selectionOwner,
        launchBoundary.options.onSetupFailure,
      ),
    });
    ({ electronApp, userDataDir, window } = seeded);
    if (controlledLaterHide) {
      // #4318 animates one-line expansion. Exercise the real resize with
      // reduced motion so per-frame hide requests do not overflow the finite
      // ordering recorder before the held presentation commands are released.
      await window.emulateMedia({ reducedMotion: 'reduce' });
    }
    if (!controlledLaterHide && launchBoundary.firstProjectsLoadFile) {
      await expect
        .poll(
          () => {
            try {
              return readFileSync(launchBoundary.firstProjectsLoadFile, 'utf8')
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line).stage);
            } catch {
              return [];
            }
          },
          { timeout: 5_000 },
        )
        .toEqual(
          expect.arrayContaining([
            'projects-load-main-entered',
            'projects-load-main-resolved',
            'projects-load-renderer-entered',
            'projects-load-renderer-ipc-resolved',
            'projects-load-renderer-applied',
            'projects-load-renderer-completed',
          ]),
        );
    }
    // The app owns beforeunload. Prevent Playwright's automatic native-dialog dismissal.
    electronApp.context().on('dialog', () => {});
    boundaryDiagnostic = createBrowserBoundaryDiagnostic(
      electronApp,
      window,
      'pending-dialog-boundary',
    );
    advisorRoute = await electronApp.evaluate(() =>
      globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
        kind: 'create',
        mode: 'app-advisor',
      }),
    );
    const named = await window.evaluate(() =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName: 'Dialog Work', allowEnable: true },
      }),
    );
    await window.getByTestId('panel-add-tab-group-terminal').click();
    await window.getByTestId('panel-add-menu-item-browser').click();
    const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?profiles=beforeunload`;
    await window.getByTestId('browser-url-input').fill(url);
    await window.getByTestId('browser-url-input').press('Enter');
    await expect
      .poll(() =>
        fixtureCookies(electronApp, url, 'source-only').catch(() => []),
      )
      .toContain('source-only');
    await electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((value) => value.getURL() === url);
      await contents.executeJavaScript(
        "window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; }; document.querySelector('input').value = 'unsaved source text';",
        true,
      );
      contents.sendInputEvent({
        type: 'mouseDown',
        x: 30,
        y: 30,
        button: 'left',
        clickCount: 1,
      });
      contents.sendInputEvent({
        type: 'mouseUp',
        x: 30,
        y: 30,
        button: 'left',
        clickCount: 1,
      });
    }, url);
    const original = (
      await dispatchProfileAction(electronApp, { type: 'browser.list' })
    ).result.browsers[0];
    const request = {
      type: 'browser.profile.switch',
      operationId: randomUUID(),
      browserId: original.id,
      expectedRuntimeGeneration: original.profile.runtimeGeneration,
      selection: { kind: 'named', profileId: named.profileId },
      mode: 'replace',
    };
    const first = await dispatchProfileAction(electronApp, request);
    expect(first).toMatchObject({
      ok: true,
      result: { status: 'pending', dialog: { type: 'beforeunload' } },
    });
    const modal = window.getByTestId('browser-javascript-dialog');
    await expect(modal).toBeVisible();
    const boundaryIdentity = {
      projectId: original.projectId,
      worktreeId: original.worktreeId,
      browserId: original.id,
      profileId: original.profile.resolvedProfileId,
      runtimeGeneration: original.profile.runtimeGeneration,
      storageGeneration: original.profile.storageGeneration,
      dialogId: first.result.dialog.id,
      url,
    };
    if (boundaryDiagnostic)
      await boundaryDiagnostic.checkpoint(
        'pending-response-visible-modal',
        boundaryIdentity,
        { switchOperationId: request.operationId },
      );

    const initialNative = await electronApp.evaluate(
      ({ BrowserWindow }, fixtureUrl) => {
        const observedAtMs = Number(process.hrtime.bigint()) / 1_000_000;
        const matches = BrowserWindow.getAllWindows().flatMap((win) =>
          // A Browser page sits two views down in its frame (a window child),
          // which carries its window bounds.
          win.contentView.children
            .map((frame) => ({
              frame,
              view: frame.webContents
                ? frame
                : (frame.children?.[0]?.children?.[0] ?? frame),
            }))
            .filter(({ view }) => view.webContents?.getURL() === fixtureUrl)
            .map(({ frame, view }) => ({
              observedAtMs,
              webContentsId: view.webContents.id,
              hostWindowId: win.id,
              destroyed: view.webContents.isDestroyed(),
              windowDestroyed: win.isDestroyed(),
              visible: frame.getVisible() && view.getVisible(),
              bounds: frame.getBounds(),
            })),
        );
        return matches;
      },
      url,
    );
    if (controlledEvidence) controlledEvidence.initialNative = initialNative;
    expect(initialNative).toHaveLength(1);
    expect(initialNative[0]).toMatchObject({
      destroyed: false,
      windowDestroyed: false,
    });
    const ownerWindow = await electronApp.browserWindow(window);
    try {
      ownerRendererWebContentsId = await ownerWindow.evaluate(
        (owner) => owner.webContents.id,
      );
    } finally {
      await ownerWindow.dispose();
    }
    const initialNativeReadiness = await electronApp.evaluate(
      waitForInitialNativeReadiness,
      {
        ...boundaryIdentity,
        ownerRendererWebContentsId,
        initialNative: initialNative[0],
      },
    );
    if (controlledEvidence) {
      controlledEvidence.initialNativeReadiness = initialNativeReadiness;
    }
    expect(initialNativeReadiness).toMatchObject({
      status: 'ready',
      reason: null,
      identity: {
        webContentsId: initialNative[0].webContentsId,
        hostWindowId: initialNative[0].hostWindowId,
        ownerRendererWebContentsId,
      },
      ready: {
        ready: true,
        classification: 'ready',
        session: {
          browserId: original.id,
          profileId: original.profile.resolvedProfileId,
          runtimeGeneration: original.profile.runtimeGeneration,
          storageGeneration: original.profile.storageGeneration,
          dialogId: first.result.dialog.id,
          ownerRendererWebContentsId,
          cachedVisible: false,
        },
        native: {
          webContentsId: initialNative[0].webContentsId,
          hostWindowId: initialNative[0].hostWindowId,
          destroyed: false,
          windowDestroyed: false,
          visible: false,
          diagnosticVisible: false,
        },
      },
    });
    const readyNative = initialNativeReadiness.ready;
    expect(readyNative.native.bounds.width).toBeGreaterThan(0);
    expect(readyNative.native.bounds.height).toBeGreaterThan(0);
    await expect(modal).toBeVisible();
    const inspectDialogControl = async (name) => {
      const control = modal.getByRole('button', { name, exact: true });
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
      const usability = await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const point = element.ownerDocument.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          pointerTarget: point === element || element.contains(point),
        };
      });
      expect(usability.bounds.width).toBeGreaterThan(0);
      expect(usability.bounds.height).toBeGreaterThan(0);
      expect(usability.pointerTarget).toBe(true);
      return {
        visible: true,
        enabled: true,
        ...usability,
      };
    };
    const stayControl = await inspectDialogControl('Stay');
    const leaveControl = await inspectDialogControl('Leave');
    const readyBrowserBounds = await window
      .getByTestId(`browser-pane-${original.id}`)
      .boundingBox();
    expect(readyBrowserBounds?.width).toBeGreaterThan(0);
    expect(readyBrowserBounds?.height).toBeGreaterThan(0);
    if (controlledEvidence) {
      controlledEvidence.readyNative = readyNative;
      controlledEvidence.rendererCheckpoints.push({
        phase: 'initial-native-ready-before-installation',
        time: await window.evaluate(() => performance.now()),
        modalVisible: true,
        stayEnabled: true,
        leaveEnabled: true,
        stayVisible: true,
        leaveVisible: true,
        controls: { stay: stayControl, leave: leaveControl },
        browserBounds: readyBrowserBounds,
      });
    }

    // Delay the older presentation at the real owner-registry read. Exact
    // request tags and AsyncLocalStorage keep unrelated readers out of the gate.
    const presentationInjection = await electronApp.evaluate(
      ({ app, ipcMain }, target) => {
        const fs = process.getBuiltinModule('node:fs/promises');
        const pathApi = process.getBuiltinModule('node:path');
        const { AsyncLocalStorage } =
          process.getBuiltinModule('node:async_hooks');
        const { syncBuiltinESMExports } =
          process.getBuiltinModule('node:module');
        const channels = {
          bounds: 'browser:set-bounds',
          visible: 'browser:set-visible',
        };
        const original = {
          readFile: fs.readFile,
          bounds: ipcMain._invokeHandlers.get(channels.bounds),
          visible: ipcMain._invokeHandlers.get(channels.visible),
        };
        if (
          typeof original.bounds !== 'function' ||
          typeof original.visible !== 'function'
        )
          throw new Error('Expected browser presentation handlers');
        if (globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__)
          throw new Error('Presentation ordering fixture already installed');
        if (
          pathApi.resolve(app.getPath('userData')) !==
          pathApi.resolve(target.userDataDir)
        )
          throw new Error('Presentation fixture userData identity mismatch');

        const registry = {
          index: pathApi.join(target.userDataDir, 'workspaces', 'index.json'),
          owner: pathApi.join(
            target.userDataDir,
            'workspaces',
            target.projectId,
            'worktrees.json',
          ),
        };
        const context = new AsyncLocalStorage();
        let releaseRead;
        let observeGate;
        const readGate = new Promise((resolve) => {
          releaseRead = resolve;
        });
        const gateObserved = new Promise((resolve) => {
          observeGate = resolve;
        });
        let releaseNewerRead;
        let observeNewerGate;
        const newerReadGate = new Promise((resolve) => {
          releaseNewerRead = resolve;
        });
        const newerGateObserved = new Promise((resolve) => {
          observeNewerGate = resolve;
        });
        const state = {
          target,
          registry,
          reads: {
            earlierIndex: 0,
            earlierOwner: 0,
            newerIndex: 0,
            newerOwner: 0,
            unrelatedOwner: 0,
          },
          earlierEntered: false,
          earlierSettled: false,
          earlierSettledBeforeRelease: null,
          earlierErrorCode: null,
          newerEntered: false,
          newerSettled: false,
          newerGatedEntered: false,
          newerGatedReleased: false,
          newerGatedHits: 0,
          newerReleased: false,
          newerCompleted: false,
          newerCompletedBeforeRelease: null,
          newerErrorCode: null,
          arbitraryBError: {
            enabled: target.arbitraryBError === true,
            originalDelegateInvocations: 0,
            originalDelegateFulfilled: false,
            applied: false,
            notAppliedReason:
              target.arbitraryBError === true
                ? 'delegate-not-fulfilled'
                : 'disabled',
          },
          gatedEntered: false,
          gatedReleased: false,
          gatedHits: 0,
          released: false,
          gatedStack: null,
          notificationGaps: 0,
        };
        let observerBinding;
        const noteObservationGap = () => {
          state.notificationGaps = Math.min(
            1_000_000_000,
            state.notificationGaps + 1,
          );
          try {
            observerBinding?.methods.noteGap();
          } catch {
            // Even gap reporting must not interrupt the original fixture.
          }
        };
        const attachPresentationObserver = (observer, injectionId) => {
          if (observerBinding || injectionId !== target.injectionId)
            throw new Error(
              'Presentation observer attachment identity mismatch',
            );
          const methods = {};
          for (const name of [
            'noteOwnerRead',
            'noteGate',
            'noteTerminal',
            'noteGap',
            'detach',
          ]) {
            const descriptor = Object.getOwnPropertyDescriptor(observer, name);
            if (
              !descriptor ||
              !Object.hasOwn(descriptor, 'value') ||
              typeof descriptor.value !== 'function'
            )
              throw new Error(
                'Presentation observer attachment requires data methods',
              );
            methods[name] = descriptor.value;
          }
          observerBinding = { observer, methods };
        };
        const notifyPresentationObserver = (name, ...args) => {
          if (!observerBinding) return;
          try {
            const binding = Object.getOwnPropertyDescriptor(
              globalThis,
              '__PROFILE_PRESENTATION_ALL_WRITERS__',
            );
            if (
              !binding ||
              !Object.hasOwn(binding, 'value') ||
              binding.value !== observerBinding.observer
            ) {
              noteObservationGap();
              return;
            }
            const method = Object.getOwnPropertyDescriptor(
              observerBinding.observer,
              name,
            );
            if (
              !method ||
              !Object.hasOwn(method, 'value') ||
              method.value !== observerBinding.methods[name]
            ) {
              noteObservationGap();
              return;
            }
            observerBinding.methods[name](...args);
          } catch {
            noteObservationGap();
          }
        };
        const releaseNewer = () => {
          if (state.newerReleased) return;
          state.newerReleased = true;
          if (target.controlledLaterHide)
            notifyPresentationObserver(
              'noteGate',
              'newer-gate-release-requested',
            );
          observeNewerGate();
          releaseNewerRead();
        };
        const release = () => {
          // Release every owned gate before any dependent request is drained.
          releaseNewer();
          if (state.released) return;
          state.released = true;
          notifyPresentationObserver('noteGate', 'gate-release-requested');
          observeGate();
          releaseRead();
        };
        const matches = (request) =>
          request?.e2ePresentationInjectionId === target.injectionId &&
          request?.browserId === target.browserId &&
          request?.expectedRuntimeGeneration === target.runtimeGeneration;
        const interceptedReadFile = async function (file, ...args) {
          const resolved =
            typeof file === 'string' ? pathApi.resolve(file) : undefined;
          const operation = context.getStore();
          if (resolved === pathApi.resolve(registry.index)) {
            notifyPresentationObserver('noteOwnerRead', 'index');
            if (operation === 'earlier') state.reads.earlierIndex += 1;
            if (operation === 'newer') state.reads.newerIndex += 1;
          }
          if (resolved === pathApi.resolve(registry.owner)) {
            notifyPresentationObserver('noteOwnerRead', 'owner');
            const key =
              operation === 'earlier'
                ? 'earlierOwner'
                : operation === 'newer'
                  ? 'newerOwner'
                  : 'unrelatedOwner';
            state.reads[key] += 1;
            if (operation === 'earlier' && !state.gatedEntered) {
              state.gatedEntered = true;
              notifyPresentationObserver('noteGate', 'gate-enter');
              state.gatedHits += 1;
              state.gatedStack = String(new Error().stack).slice(0, 8192);
              observeGate();
              await readGate;
              state.gatedReleased = true;
              notifyPresentationObserver('noteGate', 'gate-resumed');
            }
            if (
              target.controlledLaterHide &&
              operation === 'newer' &&
              !state.newerGatedEntered
            ) {
              state.newerGatedEntered = true;
              state.newerGatedHits += 1;
              notifyPresentationObserver('noteGate', 'newer-gate-enter');
              observeNewerGate();
              await newerReadGate;
              state.newerGatedReleased = true;
              notifyPresentationObserver('noteGate', 'newer-gate-resumed');
            }
          }
          return original.readFile.call(this, file, ...args);
        };
        const wrap = (handler, operation, qualifies) =>
          async function (event, request) {
            if (!qualifies(request)) return handler(event, request);
            state[`${operation}Entered`] = true;
            try {
              if (operation === 'newer')
                state.arbitraryBError.originalDelegateInvocations += 1;
              const result = await context.run(operation, () =>
                handler(event, request),
              );
              if (operation === 'newer') {
                state.arbitraryBError.originalDelegateFulfilled = true;
                if (target.arbitraryBError === true) {
                  state.arbitraryBError.applied = true;
                  state.arbitraryBError.notAppliedReason = null;
                  throw Object.assign(
                    new Error(
                      'E2E arbitrary B error after original delegate fulfillment.',
                    ),
                    { code: 'e2e_arbitrary_B_error' },
                  );
                }
                state.newerCompleted = true;
                state.newerCompletedBeforeRelease = !state.released;
                notifyPresentationObserver('noteTerminal', 'fulfilled');
              }
              return result;
            } catch (error) {
              state[`${operation}ErrorCode`] = error?.code ?? null;
              if (operation === 'newer')
                notifyPresentationObserver('noteTerminal', 'rejected', error);
              throw error;
            } finally {
              state[`${operation}Settled`] = true;
              if (operation === 'earlier')
                state.earlierSettledBeforeRelease = !state.released;
            }
          };
        const handlers = {
          bounds: wrap(
            original.bounds,
            'earlier',
            (request) =>
              matches(request) &&
              request.visible === true &&
              ['x', 'y', 'width', 'height'].every(
                (key) => request.bounds?.[key] === target.bounds[key],
              ),
          ),
          visible: wrap(
            original.visible,
            'newer',
            (request) => matches(request) && request.visible === false,
          ),
        };
        const bindings = () => ({
          readFile: fs.readFile === interceptedReadFile,
          bounds:
            ipcMain._invokeHandlers.get(channels.bounds) === handlers.bounds,
          visible:
            ipcMain._invokeHandlers.get(channels.visible) === handlers.visible,
        });
        const snapshot = () => ({ ...state, bindings: bindings() });
        const restore = () => {
          const before = snapshot();
          const errors = [];
          const attempt = (phase, operation) => {
            try {
              operation();
            } catch (error) {
              errors.push({
                phase,
                message: String(error?.message ?? error).slice(0, 2048),
              });
            }
          };
          attempt('release-gate', release);
          attempt('detach-presentation-observer', () => {
            // Cleanup owns the captured observer even if its public global changed.
            const detached = observerBinding?.methods.detach();
            if (
              detached &&
              Object.values(detached.restored).some((value) => !value)
            )
              throw new Error(
                'Presentation observer binding restoration failed',
              );
          });
          attempt('restore-read-binding', () => {
            if (
              fs.readFile !== interceptedReadFile &&
              fs.readFile !== original.readFile
            )
              throw new Error('Read binding restoration conflict');
            fs.readFile = original.readFile;
          });
          attempt('sync-esm-read-binding', syncBuiltinESMExports);
          for (const name of ['bounds', 'visible']) {
            attempt(`restore-${name}-handler`, () => {
              const current = ipcMain._invokeHandlers.get(channels[name]);
              if (current === original[name]) return;
              if (current !== handlers[name])
                throw new Error('Presentation handler restoration conflict');
              ipcMain.removeHandler(channels[name]);
              if (ipcMain._invokeHandlers.has(channels[name]))
                throw new Error(
                  'Presentation handler replacement during restoration',
                );
              ipcMain.handle(channels[name], original[name]);
            });
          }
          attempt('disable-command-context', () => context.disable());
          const after = snapshot();
          return {
            before,
            after,
            restored: {
              readFile: fs.readFile === original.readFile,
              bounds:
                ipcMain._invokeHandlers.get(channels.bounds) ===
                original.bounds,
              visible:
                ipcMain._invokeHandlers.get(channels.visible) ===
                original.visible,
            },
            errors,
          };
        };
        globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__ = {
          attachPresentationObserver,
          release,
          releaseNewer,
          restore,
          snapshot,
          waitForGate: () => gateObserved.then(snapshot),
          waitForNewerGate: () => newerGateObserved.then(snapshot),
        };
        fs.readFile = interceptedReadFile;
        syncBuiltinESMExports();
        for (const name of ['bounds', 'visible']) {
          ipcMain.removeHandler(channels[name]);
          ipcMain.handle(channels[name], handlers[name]);
        }
        return snapshot();
      },
      {
        injectionId: presentationInjectionId,
        controlledLaterHide,
        arbitraryBError,
        userDataDir,
        ...boundaryIdentity,
        bounds: { x: 20, y: 180, width: 640, height: 400 },
      },
    );
    expect(presentationInjection).toMatchObject({
      target: {
        injectionId: presentationInjectionId,
        projectId: original.projectId,
        worktreeId: original.worktreeId,
        browserId: original.id,
        profileId: original.profile.resolvedProfileId,
        runtimeGeneration: original.profile.runtimeGeneration,
        storageGeneration: original.profile.storageGeneration,
        dialogId: first.result.dialog.id,
      },
      registry: {
        index: path.join(userDataDir, 'workspaces', 'index.json'),
        owner: path.join(
          userDataDir,
          'workspaces',
          original.projectId,
          'worktrees.json',
        ),
      },
      bindings: { readFile: true, bounds: true, visible: true },
      gatedHits: 0,
    });

    // This same serializable helper is covered by the existing Node suite.
    // It adds finite diagnostic overhead; entry order is not a revision value.
    presentationObserverHandle = await electronApp.evaluateHandle(
      installPresentationObserver,
      {
        injectionId: presentationInjectionId,
        controlledLaterHide,
        userDataDir,
        projectId: boundaryIdentity.projectId,
        worktreeId: boundaryIdentity.worktreeId,
        browserId: boundaryIdentity.browserId,
        profileId: boundaryIdentity.profileId,
        runtimeGeneration: boundaryIdentity.runtimeGeneration,
        storageGeneration: boundaryIdentity.storageGeneration,
        dialogId: boundaryIdentity.dialogId,
        bounds: presentationInjection.target.bounds,
        ownerRendererWebContentsId,
      },
    );

    presentationGateObservation = electronApp
      .evaluate(() =>
        globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__.waitForGate(),
      )
      .then(
        (value) => ({ ok: true, value }),
        (error) => ({ ok: false, message: String(error) }),
      );
    earlierPresentation = window
      .evaluate(
        (target) =>
          window.api.browser.setBounds({
            e2ePresentationInjectionId: target.injectionId,
            browserId: target.browserId,
            expectedRuntimeGeneration: target.runtimeGeneration,
            bounds: target.bounds,
            visible: true,
          }),
        presentationInjection.target,
      )
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, message: String(error) }),
      );
    presentationGateRace = await Promise.race([
      presentationGateObservation.then((observation) => ({
        kind: 'gate-observed',
        observation,
      })),
      earlierPresentation.then((settlement) => ({
        kind: 'earlier-settled',
        settlement,
      })),
    ]);
    if (presentationGateRace.kind === 'earlier-settled') {
      const gateState = await electronApp.evaluate(() =>
        globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__.snapshot(),
      );
      throw new Error(
        `Presentation owner read was not observed before the older request settled: ${JSON.stringify({ race: presentationGateRace, gateState })}`,
      );
    }
    expect(presentationGateRace.observation).toMatchObject({
      ok: true,
      value: {
        earlierEntered: true,
        earlierSettled: false,
        reads: { earlierIndex: 1, earlierOwner: 1 },
        gatedEntered: true,
        gatedReleased: false,
        gatedHits: 1,
      },
    });

    newerPresentation = window
      .evaluate(
        (target) =>
          window.api.browser.setVisible({
            e2ePresentationInjectionId: target.injectionId,
            browserId: target.browserId,
            expectedRuntimeGeneration: target.runtimeGeneration,
            visible: false,
          }),
        presentationInjection.target,
      )
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, message: String(error) }),
      );
    if (controlledLaterHide) {
      newerGateObservation = electronApp
        .evaluate(() =>
          globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__.waitForNewerGate(),
        )
        .then(
          (value) => ({ kind: 'newer-gate-observed', value }),
          (error) => ({ kind: 'newer-gate-failed', message: String(error) }),
        );
      controlledEvidence.newerGateRace = await Promise.race([
        newerGateObservation,
        newerPresentation.then((settlement) => ({
          kind: 'newer-settled-before-gate',
          settlement,
        })),
      ]);
      expect(controlledEvidence.newerGateRace).toMatchObject({
        kind: 'newer-gate-observed',
        value: {
          earlierSettled: false,
          gatedReleased: false,
          newerEntered: true,
          newerSettled: false,
          newerGatedEntered: true,
          newerGatedReleased: false,
          newerGatedHits: 1,
          reads: { newerIndex: 1, newerOwner: 1 },
        },
      });
      const rendererCheckpoint = async (phase) => {
        await expect(modal).toBeVisible();
        await expect(
          modal.getByRole('button', { name: 'Stay', exact: true }),
        ).toBeEnabled();
        await expect(
          modal.getByRole('button', { name: 'Leave', exact: true }),
        ).toBeEnabled();
        const browserBounds = await window
          .getByTestId(`browser-pane-${original.id}`)
          .boundingBox();
        expect(browserBounds?.width).toBeGreaterThan(0);
        expect(browserBounds?.height).toBeGreaterThan(0);
        controlledEvidence.rendererCheckpoints.push({
          phase,
          time: await window.evaluate(() => performance.now()),
          modalVisible: true,
          stayEnabled: true,
          leaveEnabled: true,
          browserBounds,
        });
      };
      const assertSafeCheckpoint = (checkpoint) => {
        expect(checkpoint?.state?.native?.bounds?.width).toBeGreaterThan(0);
        expect(checkpoint?.state?.native?.bounds?.height).toBeGreaterThan(0);
        expect(checkpoint).toMatchObject({
          admissionOpen: true,
          state: {
            status: 'available',
            runtimeMatch: true,
            storageMatch: true,
            truncated: false,
            nativeErrors: false,
            session: {
              browserId: original.id,
              profileMatch: true,
              runtimeGeneration: original.profile.runtimeGeneration,
              storageGeneration: original.profile.storageGeneration,
              webContentsId: controlledEvidence.initialNative[0].webContentsId,
              hostWindowId: controlledEvidence.initialNative[0].hostWindowId,
              cachedVisible: false,
              dialogId: first.result.dialog.id,
              dialogMatchesInitial: true,
            },
            native: {
              webContentsId: controlledEvidence.initialNative[0].webContentsId,
              hostWindowId: controlledEvidence.initialNative[0].hostWindowId,
              matchesBrowser: true,
              destroyed: false,
              windowDestroyed: false,
              visible: false,
            },
          },
        });
      };
      const composer = window
        .locator(
          '[data-testid="panel-content-chat"][data-panel-id="panel-chat-seed-chat"]',
        )
        .getByRole('textbox')
        .first();
      await expect(composer).toBeVisible();
      await expect(composer).toBeEditable();
      try {
        composerRootElement = await composer.evaluateHandle((textbox) =>
          textbox.closest('[data-chat-composer-root]'),
        );
      } catch (error) {
        controlledEvidence.composerRootFailure = {
          phase: 'root-installation',
          message: boundedCleanupErrorMessage(error),
        };
      }
      let composerElement;
      try {
        composerElement = await composer.elementHandle();
        if (!composerElement)
          controlledEvidence.rendererRoute = {
            version: 1,
            status: 'unavailable',
            reason: 'textbox-element-unavailable',
            incomplete: true,
            records: [],
          };
        else {
          try {
            rendererRouteHandle = await window.evaluateHandle(
              installPresentationRendererRouteRecorder,
              composerElement,
            );
          } catch (error) {
            controlledEvidence.rendererRoute = {
              version: 1,
              status: 'unavailable',
              reason: 'installation-failed',
              incomplete: true,
              records: [],
              failure: boundedCleanupErrorMessage(error),
            };
          }
        }
      } catch (error) {
        controlledEvidence.rendererRoute = {
          version: 1,
          status: 'unavailable',
          reason: 'installation-failed',
          incomplete: true,
          records: [],
          failure: boundedCleanupErrorMessage(error),
        };
      } finally {
        await composerElement?.dispose().catch(() => {});
      }
      const readComposerRootState = async () => {
        if (!composerRootElement)
          return {
            status: 'unavailable',
            reason: 'composer-root-handle-unavailable',
          };
        try {
          return await composerRootElement.evaluate((root) => {
            if (!root || typeof root.getBoundingClientRect !== 'function')
              return {
                status: 'unavailable',
                reason: 'composer-root-missing',
              };
            try {
              const rect = root.getBoundingClientRect();
              const textboxes = root.querySelectorAll('[data-chat-textarea]');
              const textbox = textboxes.length === 1 ? textboxes[0] : null;
              const slateScroller = textbox?.parentElement ?? null;
              const scrollerRect = slateScroller?.getBoundingClientRect();
              const computed = slateScroller
                ? getComputedStyle(slateScroller)
                : null;
              const maxHeightPx = Number.parseFloat(computed?.maxHeight ?? '');
              const rootSame =
                textbox?.closest('[data-chat-composer-root]') === root;
              const positiveRoot =
                Number.isFinite(rect.width) &&
                Number.isFinite(rect.height) &&
                rect.width > 0 &&
                rect.height > 0;
              const positiveScroller =
                Number.isFinite(scrollerRect?.width) &&
                Number.isFinite(scrollerRect?.height) &&
                scrollerRect.width > 0 &&
                scrollerRect.height > 0;
              const connected = root.isConnected === true;
              const slateScrollerConnected =
                slateScroller?.isConnected === true;
              const slateScrollerWithinRoot =
                slateScroller !== null && root.contains(slateScroller);
              const available =
                connected &&
                rootSame &&
                positiveRoot &&
                textboxes.length === 1 &&
                slateScrollerConnected &&
                slateScrollerWithinRoot &&
                positiveScroller &&
                Number.isFinite(slateScroller.clientHeight) &&
                Number.isFinite(slateScroller.scrollHeight) &&
                typeof computed?.overflowY === 'string' &&
                typeof computed?.maxHeight === 'string';
              return {
                status: available ? 'available' : 'unavailable',
                reason: available
                  ? null
                  : !connected
                    ? 'composer-root-disconnected'
                    : !rootSame
                      ? 'composer-root-identity-changed'
                      : !positiveRoot
                        ? 'composer-root-nonpositive'
                        : textboxes.length !== 1
                          ? 'slate-textbox-identity-unavailable'
                          : !slateScrollerConnected
                            ? 'slate-scroller-disconnected'
                            : !slateScrollerWithinRoot
                              ? 'slate-scroller-outside-root'
                              : !positiveScroller
                                ? 'slate-scroller-nonpositive'
                                : 'slate-scroller-metadata-unavailable',
                rootSame,
                rootConnected: connected,
                rootRect: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                },
                composerDensity: root.getAttribute('data-composer-density'),
                slateScroller: {
                  same: rootSame && textboxes.length === 1,
                  connected: slateScrollerConnected,
                  withinRoot: slateScrollerWithinRoot,
                  rect: scrollerRect
                    ? {
                        x: scrollerRect.x,
                        y: scrollerRect.y,
                        width: scrollerRect.width,
                        height: scrollerRect.height,
                      }
                    : null,
                  clientHeight: slateScroller?.clientHeight ?? null,
                  scrollHeight: slateScroller?.scrollHeight ?? null,
                  overflowY: computed?.overflowY ?? null,
                  maxHeight: computed?.maxHeight ?? null,
                  maxHeightPx: Number.isFinite(maxHeightPx)
                    ? maxHeightPx
                    : null,
                },
              };
            } catch (error) {
              return {
                status: 'unavailable',
                reason: 'composer-root-geometry-read-failed',
                message: String(error?.message ?? error).slice(0, 2048),
              };
            }
          });
        } catch (error) {
          return {
            status: 'unavailable',
            reason: 'composer-root-evaluation-failed',
            message: boundedCleanupErrorMessage(error),
          };
        }
      };
      await rendererCheckpoint('both-gated-before-composer-fill');
      controlledEvidence.composerBefore = await composer.boundingBox();
      controlledEvidence.composerRootBefore = await readComposerRootState();
      expect(controlledEvidence.composerRootBefore.status).toBe('available');
      expect(controlledEvidence.composerRootBefore.rootSame).toBe(true);
      expect(controlledEvidence.composerRootBefore.rootConnected).toBe(true);
      expect(
        controlledEvidence.composerRootBefore.rootRect.width,
      ).toBeGreaterThan(0);
      expect(
        controlledEvidence.composerRootBefore.rootRect.height,
      ).toBeGreaterThan(0);
      expect(controlledEvidence.composerRootBefore.composerDensity).toBe(
        'comfortable',
      );
      expect(controlledEvidence.composerRootBefore.slateScroller.same).toBe(
        true,
      );
      expect(
        controlledEvidence.composerRootBefore.slateScroller.connected,
      ).toBe(true);
      expect(
        controlledEvidence.composerRootBefore.slateScroller.withinRoot,
      ).toBe(true);
      // The empty composer clips one line; filling the multiline draft
      // below expands it and drives the same browser presentation boundary.
      expect(
        controlledEvidence.composerRootBefore.slateScroller.overflowY,
      ).toBe('hidden');
      expect(
        controlledEvidence.composerRootBefore.slateScroller.maxHeightPx,
      ).toBe(controlledEvidence.composerRootBefore.slateScroller.clientHeight);
      controlledEvidence.triggerTime = await window.evaluate(() =>
        performance.now(),
      );
      controlledEvidence.triggerObservation =
        await presentationObserverHandle.evaluate((observer) =>
          observer.noteControlledTrigger(),
        );
      expect(controlledEvidence.triggerObservation?.phase).toBe(
        'controlled-composer-trigger-armed',
      );
      if (rendererRouteHandle)
        try {
          await rendererRouteHandle.evaluate((recorder) =>
            recorder.noteTrigger(),
          );
        } catch (error) {
          controlledEvidence.rendererRouteFailures ??= [];
          controlledEvidence.rendererRouteFailures.push({
            phase: 'trigger-boundary',
            message: boundedCleanupErrorMessage(error),
          });
        }
      // This ordinary unsent draft is the intended ChatInput resize route. The
      // passive record below determines which renderer boundaries were observed.
      await composer.fill(
        'Presentation ordering draft line one.\nPresentation ordering draft line two.\nPresentation ordering draft line three.\nPresentation ordering draft line four.\nPresentation ordering draft line five.\nPresentation ordering draft line six.',
      );
      try {
        await expect
          .poll(
            async () => {
              controlledEvidence.composerRootAfter =
                await readComposerRootState();
              return (
                controlledEvidence.composerRootAfter.status === 'available' &&
                controlledEvidence.composerRootAfter.rootSame === true &&
                controlledEvidence.composerRootAfter.rootConnected === true &&
                controlledEvidence.composerRootAfter.rootRect.width > 0 &&
                controlledEvidence.composerRootAfter.rootRect.height >
                  controlledEvidence.composerRootBefore.rootRect.height
              );
            },
            { timeout: 5000 },
          )
          .toBe(true);
      } finally {
        try {
          controlledEvidence.composerAfter = await composer.boundingBox();
        } catch (error) {
          controlledEvidence.composerGeometryFailures ??= [];
          controlledEvidence.composerGeometryFailures.push({
            phase: 'after-fill-textbox-geometry',
            message: boundedCleanupErrorMessage(error),
          });
        }
        controlledEvidence.composerRootAfter = await readComposerRootState();
        if (rendererRouteHandle)
          try {
            await rendererRouteHandle.evaluate((recorder) =>
              recorder.noteAfterFill(),
            );
            controlledEvidence.rendererRoute =
              await rendererRouteHandle.evaluate((recorder) =>
                recorder.report(),
              );
          } catch (error) {
            controlledEvidence.rendererRouteFailures ??= [];
            controlledEvidence.rendererRouteFailures.push({
              phase: 'after-fill-retrieval',
              message: boundedCleanupErrorMessage(error),
            });
          }
      }
      await expect
        .poll(
          async () => {
            const report = await presentationObserverHandle.evaluate(
              (observer) => observer.report(),
            );
            return report.snapshots.some(
              (row) => row.phase === 'later-hide-fulfilled-while-gated',
            );
          },
          { timeout: 5000 },
        )
        .toBe(true);
      controlledEvidence.beforeBRelease =
        await presentationObserverHandle.evaluate((observer) =>
          observer.report(),
        );
      const witness = controlledEvidence.beforeBRelease.snapshots.find(
        (row) => row.phase === 'later-hide-fulfilled-while-gated',
      );
      assertSafeCheckpoint(witness);
      expect(controlledEvidence.beforeBRelease).toMatchObject({
        incomplete: false,
        truncationReason: null,
        notificationGaps: 0,
        droppedCalls: 0,
        droppedEvents: 0,
        unknownAdmissions: 0,
        observationGap: false,
      });
      expect(
        controlledEvidence.beforeBRelease.calls.find(
          (row) => row.id === witness.witnessCallId,
        ),
      ).toMatchObject({
        class: 'untagged',
        generationStatus: 'match',
        ownerSender: true,
        visible: false,
        state: 'fulfilled',
      });
      await rendererCheckpoint('later-hide-fulfilled-before-B-release');
      controlledEvidence.heldBeforeBRelease = await electronApp.evaluate(() =>
        globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__.snapshot(),
      );
      expect(controlledEvidence.heldBeforeBRelease).toMatchObject({
        earlierSettled: false,
        gatedReleased: false,
        newerSettled: false,
        newerGatedReleased: false,
      });
      await electronApp.evaluate(() =>
        globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__.releaseNewer(),
      );
      controlledEvidence.newerSettlement = await newerPresentation;
      controlledEvidence.atBTerminal =
        await presentationObserverHandle.evaluate((observer) =>
          observer.report(),
        );
      const terminal = controlledEvidence.atBTerminal.snapshots.find(
        (row) => row.phase === 'B-rejection-observed',
      );
      // Controlled scheduling requires the exact real supersession treatment.
      assertSafeCheckpoint(terminal);
      expect(
        controlledEvidence.atBTerminal.calls.find((row) => row.class === 'B'),
      ).toMatchObject({
        state: 'rejected',
        error: { code: 'operation_conflict', supersession: true },
      });
      await rendererCheckpoint('B-rejected-before-A-release');
    }
    const newerSettlement = await newerPresentation;
    const beforeRelease = await electronApp.evaluate(() =>
      globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__.snapshot(),
    );
    const orderingRendererCheckpoints = [];
    const recordOrderingRendererCheckpoint = async (phase) => {
      await expect(modal).toBeVisible();
      await expect(
        modal.getByRole('button', { name: 'Stay', exact: true }),
      ).toBeEnabled();
      await expect(
        modal.getByRole('button', { name: 'Leave', exact: true }),
      ).toBeEnabled();
      const browserBounds = await window
        .getByTestId(`browser-pane-${original.id}`)
        .boundingBox();
      expect(browserBounds?.width).toBeGreaterThan(0);
      expect(browserBounds?.height).toBeGreaterThan(0);
      orderingRendererCheckpoints.push({
        phase,
        time: await window.evaluate(() => performance.now()),
        modalVisible: true,
        stayEnabled: true,
        leaveEnabled: true,
        browserBounds,
      });
    };
    const nativeVisibility = () =>
      electronApp.evaluate(({ BrowserWindow }, url) => {
        const matches = BrowserWindow.getAllWindows()
          // A Browser page sits two views down in its frame (a window child).
          .flatMap((win) =>
            win.contentView.children.map((frame) =>
              frame.webContents
                ? frame
                : (frame.children?.[0]?.children?.[0] ?? frame),
            ),
          )
          .filter((view) => view.webContents?.getURL() === url);
        return { matches: matches.length, visible: matches[0]?.getVisible() };
      }, url);
    await recordOrderingRendererCheckpoint('B-terminal-before-A-release');
    expect(await nativeVisibility()).toEqual({ matches: 1, visible: false });
    if (newerSettlement.ok) {
      // Keep the original latest-B contract at its actual pre-release boundary.
      expect(newerSettlement).toEqual({ ok: true });
      expect(beforeRelease).toMatchObject({
        earlierSettled: false,
        newerEntered: true,
        newerCompleted: true,
        newerCompletedBeforeRelease: true,
        newerErrorCode: null,
        reads: { newerIndex: 1, newerOwner: 1 },
        gatedReleased: false,
        gatedHits: 1,
      });
    }
    // Release A before draining the finite cohort captured at B's terminal.
    await electronApp.evaluate(() =>
      globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__.release(),
    );
    const earlierSettlement = await earlierPresentation;
    await expect
      .poll(
        async () =>
          presentationObserverHandle.evaluate(
            (observer) => observer.report().cohortCaptured,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
    const afterRelease = await electronApp.evaluate(() =>
      globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__.snapshot(),
    );
    await recordOrderingRendererCheckpoint(
      'A-rejected-same-dialog-still-usable',
    );
    expect(await nativeVisibility()).toEqual({ matches: 1, visible: false });
    expect(afterRelease).toMatchObject({
      gatedHits: 1,
      gatedReleased: true,
      earlierSettled: true,
      earlierSettledBeforeRelease: false,
      earlierErrorCode: 'operation_conflict',
    });
    expect(earlierSettlement).toMatchObject({ ok: false });
    // Freeze the complete critical evidence before veto/recheck/runtime changes.
    orderingVerdict = verifyPresentationOrdering({
      observation: await presentationObserverHandle.evaluate((observer) =>
        observer.freezeOrdering(),
      ),
      beforeRelease,
      afterRelease,
      newerSettlement,
      earlierSettlement,
      rendererCheckpoints: orderingRendererCheckpoints,
      controlledLaterHide,
    });
    assertPendingPresentationOrdering(orderingVerdict);

    const clearWhileSwitching = async (profile) => {
      const preview = await window.evaluate(
        (profile) =>
          window.api.browser.profiles.previewClear({
            profileId: profile.profileId,
            storageGeneration: profile.storageGeneration,
            metadataRevision: profile.metadataRevision,
            operation: { kind: 'cache' },
          }),
        profile,
      );
      const operationId = randomUUID();
      const receipt = await window.evaluate(
        (request) => window.api.browser.profiles.clear(request),
        {
          operationId,
          token: preview.token,
        },
      );
      return { operationId, receipt };
    };
    const sourceProfile = await window.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      original.profile.resolvedProfileId,
    );
    const conflictedClear = await clearWhileSwitching(sourceProfile);
    await expect
      .poll(
        () =>
          window.evaluate(
            (jobId) => window.api.browser.profiles.jobGet({ jobId }),
            conflictedClear.operationId,
          ),
        { timeout: 5000 },
      )
      .toMatchObject({ status: 'failed', retryable: false });
    await expect(modal).toBeVisible();
    if (boundaryDiagnostic)
      await boundaryDiagnostic.checkpoint(
        'source-clear-failed-visible-modal',
        boundaryIdentity,
        {
          switchOperationId: request.operationId,
          sourceClearOperationId: conflictedClear.operationId,
        },
      );
    const unrelated = await window.evaluate(() =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName: 'Unrelated clear' },
      }),
    );
    const unrelatedClear = await clearWhileSwitching(unrelated);
    let lastUnrelatedJob = null;
    try {
      await expect
        .poll(
          async () => {
            lastUnrelatedJob = await window.evaluate(
              (jobId) => window.api.browser.profiles.jobGet({ jobId }),
              unrelatedClear.operationId,
            );
            return lastUnrelatedJob;
          },
          { timeout: 15000 },
        )
        .toMatchObject({ status: 'complete' });
    } catch (error) {
      try {
        const evidence = Buffer.from(
          JSON.stringify(
            {
              createdUnrelatedProfile: unrelated,
              operationId: unrelatedClear.operationId,
              clearReceipt: unrelatedClear.receipt ?? null,
              lastJobGet: lastUnrelatedJob,
              cause:
                lastUnrelatedJob?.message ===
                'Browser data maintenance failed. Try again before using this profile.'
                  ? 'unresolved: the job contains only the generic maintenance failure message'
                  : lastUnrelatedJob?.message === undefined
                    ? 'unresolved: the last job has no diagnostic message'
                    : null,
            },
            null,
            2,
          ),
        );
        if (evidence.byteLength <= 32 * 1024) {
          let attachmentTimeout;
          try {
            await Promise.race([
              test.info().attach('unrelated-cache-clear-failure.json', {
                body: evidence,
                contentType: 'application/json',
              }),
              new Promise((resolve) => {
                attachmentTimeout = setTimeout(resolve, 1000);
              }),
            ]);
          } finally {
            clearTimeout(attachmentTimeout);
          }
        }
      } catch {
        // Failure evidence must never replace the original poll error.
      }
      throw error;
    }
    await expect(modal).toBeVisible();
    if (boundaryDiagnostic)
      await boundaryDiagnostic.checkpoint(
        'unrelated-clear-complete-visible-modal',
        boundaryIdentity,
        {
          switchOperationId: request.operationId,
          sourceClearOperationId: conflictedClear.operationId,
          unrelatedClearOperationId: unrelatedClear.operationId,
        },
      );
    await expect
      .poll(async () => {
        const observed = await electronApp.evaluate(
          ({ BrowserWindow }, input) => {
            const url = typeof input === 'string' ? input : input.url;
            // A Browser page sits two views down in its frame.
            const views = BrowserWindow.getAllWindows().flatMap((win) =>
              win.contentView.children.map((frame) =>
                frame.webContents
                  ? frame
                  : (frame.children?.[0]?.children?.[0] ?? frame),
              ),
            );
            const visible = views
              .find((view) => view.webContents?.getURL() === url)
              ?.getVisible();
            if (typeof input === 'string') return visible;
            let evidence;
            try {
              const fixture =
                globalThis.__CANOPY_E2E_PROFILE_OPERATION_DIAGNOSTICS__;
              evidence =
                typeof fixture === 'function'
                  ? fixture({
                      kind: 'browser-snapshot',
                      scope: input,
                      deadline: Date.now() + 2000,
                    })
                  : { status: 'unavailable' };
            } catch {
              evidence = {
                status: 'unavailable',
                reason: 'native-snapshot-failed',
              };
            }
            return { visible, evidence };
          },
          boundaryDiagnostic ? boundaryIdentity : url,
        );
        if (!boundaryDiagnostic) return observed;
        boundaryDiagnostic.poll({
          identity: {
            browserId: original.id,
            profileId: original.profile.resolvedProfileId,
            runtimeGeneration: original.profile.runtimeGeneration,
            storageGeneration: original.profile.storageGeneration,
            dialogId: first.result.dialog.id,
            switchOperationId: request.operationId,
            sourceClearOperationId: conflictedClear.operationId,
            unrelatedClearOperationId: unrelatedClear.operationId,
          },
          firstUrlMatchVisible: observed.visible,
          evidence: observed.evidence,
        });
        return observed.visible;
      })
      .toBe(false);
    await modal.getByRole('button', { name: 'Stay', exact: true }).click();
    await expect(modal).toHaveCount(0);
    const cancelled = await dispatchProfileAction(electronApp, request);
    expect(cancelled).toMatchObject({
      ok: true,
      result: { status: 'cancelled' },
    });
    expect(await fixtureCookies(electronApp, url)).toContain('source-only');
    expect(
      await electronApp.evaluate(
        async ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .find((value) => value.getURL() === url)
            .executeJavaScript("document.querySelector('input').value"),
        url,
      ),
    ).toBe('unsaved source text');
    const secondRequest = { ...request, operationId: randomUUID() };
    const second = await dispatchProfileMcpAction(advisorRoute, secondRequest);
    expect(second).toMatchObject({ ok: true, result: { status: 'pending' } });
    expect(
      await dispatchProfileMcpAction(advisorRoute, {
        type: 'browser.get_dialog',
        browserId: original.id,
        expectedRuntimeGeneration: original.profile.runtimeGeneration,
      }),
    ).toMatchObject({
      ok: true,
      result: { dialog: { id: second.result.dialog.id } },
    });
    await window.evaluate(
      (profile) =>
        window.api.browser.profiles.update({
          operationId: crypto.randomUUID(),
          profileId: profile.profileId,
          expectedMetadataRevision: profile.metadataRevision,
          patch: { allowEnable: false },
        }),
      named,
    );
    const handled = await dispatchProfileMcpAction(advisorRoute, {
      type: 'browser.handle_dialog',
      browserId: original.id,
      expectedRuntimeGeneration: original.profile.runtimeGeneration,
      dialogId: second.result.dialog.id,
      accept: true,
    });
    expect(handled.ok).toBe(true);
    await expect(modal).toHaveCount(0);
    const failed = await dispatchProfileAction(electronApp, secondRequest);
    expect(failed.ok ? failed.result.status : failed.error.code).toMatch(
      /cancelled|agent_enable_denied/,
    );
    expect(await fixtureCookies(electronApp, url)).toContain('source-only');
    expect(
      (await dispatchProfileAction(electronApp, { type: 'browser.list' }))
        .result.browsers[0].profile.resolvedProfileId,
    ).toBe(original.profile.resolvedProfileId);
    expect(
      await electronApp.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .filter((value) => value.getURL() === url).length,
        url,
      ),
    ).toBe(1);
    const currentProfile = await window.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      named.profileId,
    );
    await window.evaluate(
      (profile) =>
        window.api.browser.profiles.update({
          operationId: crypto.randomUUID(),
          profileId: profile.profileId,
          expectedMetadataRevision: profile.metadataRevision,
          patch: { allowEnable: true },
        }),
      currentProfile,
    );
    const acceptedRequest = { ...request, operationId: randomUUID() };
    const acceptedPending = await dispatchProfileAction(
      electronApp,
      acceptedRequest,
    );
    expect(acceptedPending).toMatchObject({
      ok: true,
      result: { status: 'pending' },
    });
    const accepted = await dispatchProfileAction(electronApp, {
      type: 'browser.handle_dialog',
      browserId: original.id,
      expectedRuntimeGeneration: original.profile.runtimeGeneration,
      dialogId: acceptedPending.result.dialog.id,
      accept: true,
    });
    expect(accepted.ok).toBe(true);
    await expect(modal).toHaveCount(0);
    const completed = await dispatchProfileAction(electronApp, acceptedRequest);
    expect(completed).toMatchObject({
      ok: true,
      result: {
        status: 'complete',
        browser: { profile: { resolvedProfileId: named.profileId } },
      },
    });
    await expect
      .poll(() => fixtureCookies(electronApp, url).catch(() => ['loading']))
      .toEqual([]);
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ BrowserWindow }, url) =>
            BrowserWindow.getAllWindows()
              // A Browser page sits two views down in its frame.
              .flatMap((win) =>
                win.contentView.children.map((frame) =>
                  frame.webContents
                    ? frame
                    : (frame.children?.[0]?.children?.[0] ?? frame),
                ),
              )
              .find((view) => view.webContents?.getURL() === url)
              ?.getVisible(),
          url,
        ),
      )
      .toBe(true);
  } catch (error) {
    primaryError = error;
  } finally {
    let presentationRestoration = { installed: false };
    let presentationReleased = !earlierPresentation;
    let ownerCloseAttempted = false;
    let ownerClosed = false;
    const closeOwner = async (phase) => {
      const owner = seeded ?? selectionOwner;
      if (!owner.electronApp || !owner.userDataDir) return;
      ownerCloseAttempted = true;
      try {
        await launchBoundary.close(owner);
        ownerClosed = true;
      } catch (error) {
        cleanupErrors.push({
          phase,
          message: boundedCleanupErrorMessage(error),
        });
      }
    };
    if (electronApp) {
      try {
        const releaseObserved = await electronApp.evaluate(() => {
          const fixture = globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__;
          if (!fixture) return false;
          fixture.release();
          return fixture.snapshot().released === true;
        });
        presentationReleased = !earlierPresentation || releaseObserved;
        if (!presentationReleased && earlierPresentation)
          cleanupErrors.push({
            phase: 'release-presentation-gate',
            message: 'Presentation fixture was unavailable during release',
          });
      } catch (error) {
        cleanupErrors.push({
          phase: 'release-presentation-gate',
          message: boundedCleanupErrorMessage(error),
        });
      }
    }
    if (electronApp) {
      try {
        presentationRestoration = await electronApp.evaluate(() => {
          const fixture = globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__;
          if (!fixture) return { installed: false };
          try {
            return { installed: true, ...fixture.restore() };
          } finally {
            delete globalThis.__PROFILE_PRESENTATION_ORDERING_FIXTURE__;
          }
        });
        if (presentationRestoration.after?.released)
          presentationReleased = true;
        for (const error of presentationRestoration.errors ?? [])
          cleanupErrors.push({
            phase: `presentation-${error.phase}`,
            message: error.message,
          });
        for (const [resource, restored] of Object.entries(
          presentationRestoration.restored ?? {},
        ))
          if (!restored)
            cleanupErrors.push({
              phase: `presentation-${resource}-identity`,
              message: 'Original resource identity was not restored',
            });
      } catch (error) {
        cleanupErrors.push({
          phase: 'restore-presentation-fixture',
          message: boundedCleanupErrorMessage(error),
        });
      }
    }
    if (!presentationReleased) await closeOwner('terminal-owner-close');
    const presentationPromises = [
      presentationGateObservation,
      newerGateObservation,
      earlierPresentation,
      newerPresentation,
    ].filter(Boolean);
    const presentationSettlements =
      presentationReleased || ownerClosed
        ? await Promise.allSettled(presentationPromises)
        : presentationPromises.map(() => ({
            status: 'unresolved',
            reason: 'Gate release and exact-owner close both failed',
          }));
    if (presentationObserverHandle) {
      try {
        const observation = ownerClosed
          ? {
              version: 1,
              incomplete: true,
              reason: 'owner-closed-before-finalization',
            }
          : await presentationObserverHandle.evaluate((observer) =>
              observer.finalize(),
            );
        if (!observation)
          cleanupErrors.push({
            phase: 'finalize-all-writer-presentation-evidence',
            message: 'Presentation observer unavailable at finalization',
          });
        await test.info().attach('presentation-ordering-all-writers.json', {
          body: Buffer.from(
            JSON.stringify(
              observation ?? {
                version: 1,
                incomplete: true,
                reason: 'observer-unavailable-at-finalization',
              },
            ),
          ),
          contentType: 'application/json',
        });
      } catch (error) {
        cleanupErrors.push({
          phase: 'attach-all-writer-presentation-evidence',
          message: boundedCleanupErrorMessage(error),
        });
      } finally {
        try {
          await presentationObserverHandle.dispose();
        } catch (error) {
          cleanupErrors.push({
            phase: 'dispose-all-writer-presentation-handle',
            message: boundedCleanupErrorMessage(error),
          });
        }
      }
    }
    if (controlledEvidence) {
      if (rendererRouteHandle) {
        try {
          controlledEvidence.rendererRoute = await rendererRouteHandle.evaluate(
            (recorder) => recorder.finalize(),
          );
        } catch (error) {
          controlledEvidence.rendererRouteFailures ??= [];
          controlledEvidence.rendererRouteFailures.push({
            phase: 'final-retrieval',
            message: boundedCleanupErrorMessage(error),
          });
          controlledEvidence.rendererRoute = {
            ...(controlledEvidence.rendererRoute ?? {
              version: 1,
              records: [],
            }),
            status: 'unavailable',
            reason:
              controlledEvidence.rendererRoute?.reason ??
              'final-retrieval-failed',
            incomplete: true,
          };
        } finally {
          try {
            await rendererRouteHandle.dispose();
          } catch (error) {
            controlledEvidence.rendererRouteFailures ??= [];
            controlledEvidence.rendererRouteFailures.push({
              phase: 'dispose-renderer-route-handle',
              message: boundedCleanupErrorMessage(error),
            });
          }
        }
      } else
        controlledEvidence.rendererRoute ??= {
          version: 1,
          status: 'unavailable',
          reason: 'missing-installation',
          incomplete: true,
          records: [],
        };
      if (composerRootElement) {
        try {
          await composerRootElement.dispose();
        } catch (error) {
          controlledEvidence.rendererRouteFailures ??= [];
          controlledEvidence.rendererRouteFailures.push({
            phase: 'dispose-composer-root-handle',
            message: boundedCleanupErrorMessage(error),
          });
        } finally {
          composerRootElement = undefined;
        }
      }
      try {
        await test.info().attach('presentation-controlled-later-hide.json', {
          body: Buffer.from(JSON.stringify(controlledEvidence, null, 2)),
          contentType: 'application/json',
        });
      } catch (error) {
        cleanupErrors.push({
          phase: 'attach-controlled-later-hide',
          message: boundedCleanupErrorMessage(error),
        });
      }
    }
    try {
      await test.info().attach('presentation-ordering-verdict.json', {
        body: Buffer.from(
          JSON.stringify(
            orderingVerdict ?? {
              version: 1,
              ok: false,
              branch: 'unverified',
              reasons: ['ordering-not-reached'],
            },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });
    } catch (error) {
      cleanupErrors.push({
        phase: 'attach-presentation-verdict',
        message: boundedCleanupErrorMessage(error),
      });
    }
    try {
      await test.info().attach('presentation-ordering-native-race.json', {
        body: Buffer.from(
          JSON.stringify(
            {
              injectionId: presentationInjectionId,
              primaryError: primaryError
                ? boundedCleanupErrorMessage(primaryError)
                : null,
              gateRace: presentationGateRace ?? null,
              settlements: presentationSettlements.map((settlement) =>
                settlement.status === 'fulfilled'
                  ? { status: settlement.status, value: settlement.value }
                  : {
                      status: settlement.status,
                      reason: boundedCleanupErrorMessage(settlement.reason),
                    },
              ),
              restoration: presentationRestoration,
              cleanupErrors,
            },
            null,
            2,
          ),
        ),
        contentType: 'application/json',
      });
    } catch (error) {
      cleanupErrors.push({
        phase: 'attach-presentation-evidence',
        message: boundedCleanupErrorMessage(error),
      });
    }
    if (boundaryDiagnostic) {
      try {
        await boundaryDiagnostic.close();
      } catch (error) {
        cleanupErrors.push({
          phase: 'close-boundary-diagnostic',
          message: boundedCleanupErrorMessage(error),
        });
      }
    }
    if (advisorRoute && electronApp && !ownerClosed) {
      try {
        await electronApp.evaluate(
          (_electron, sessionKey) =>
            globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
              kind: 'delete',
              sessionKey,
            }),
          advisorRoute.sessionKey,
        );
      } catch (error) {
        cleanupErrors.push({
          phase: 'delete-advisor-route',
          message: boundedCleanupErrorMessage(error),
        });
      }
    }
    if (!ownerCloseAttempted) await closeOwner('close-canopy');
    if (cleanupErrors.length) {
      await test
        .info()
        .attach('presentation-ordering-cleanup-errors.json', {
          body: Buffer.from(JSON.stringify(cleanupErrors)),
          contentType: 'application/json',
        })
        .catch(() => {});
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new Error(JSON.stringify(cleanupErrors));
}

export { runPendingSourceDialogCase };

// Graduation removed the asynchronous owner-read boundary from presentation.
// The injected compatibility-path races remain in browser-service.test.ts;
// these flows exercise the shipped IPC path and actual native/dialog state.
async function runGraduatedPendingSourceDialogCase({
  controlledLaterHide = false,
} = {}) {
  test.setTimeout(90_000);
  const {
    installPresentationRendererRouteRecorder,
    waitForInitialNativeReadiness,
  } = await import('./browser-profile-presentation-observer.mjs');
  const selectionOwner = {};
  const launchBoundary = createSelectedLaunchBoundary(
    'presentation-ordering',
    'pending-dialog',
    {
      close: closeCanopy,
      owners: [{ projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }],
      firstProjectsLoad: !controlledLaterHide,
    },
  );
  let seeded;
  let electronApp;
  let userDataDir;
  let window;
  let advisorRoute;
  let boundaryDiagnostic;
  let ownerRendererWebContentsId;
  let presentationRecorder;
  let rendererRouteHandle;
  const controlledEvidence = controlledLaterHide
    ? { stage: 'graduated-presentation-resize', rendererCheckpoints: [] }
    : undefined;
  let primaryError;
  const cleanupErrors = [];
  try {
    seeded = await seedPanelWorktree({
      ...launchBoundary.options,
      onSetupFailure: retainSelectionFailureOwner(
        selectionOwner,
        launchBoundary.options.onSetupFailure,
      ),
    });
    ({ electronApp, userDataDir, window } = seeded);
    if (controlledLaterHide) {
      // #4318 animates one-line expansion. Reduced motion keeps observation
      // focused on the real resize without recording every animation frame.
      await window.emulateMedia({ reducedMotion: 'reduce' });
    }
    if (!controlledLaterHide && launchBoundary.firstProjectsLoadFile) {
      await expect
        .poll(
          () => {
            try {
              return readFileSync(launchBoundary.firstProjectsLoadFile, 'utf8')
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line).stage);
            } catch {
              return [];
            }
          },
          { timeout: 5_000 },
        )
        .toEqual(
          expect.arrayContaining([
            'projects-load-main-entered',
            'projects-load-main-resolved',
            'projects-load-renderer-entered',
            'projects-load-renderer-ipc-resolved',
            'projects-load-renderer-applied',
            'projects-load-renderer-completed',
          ]),
        );
    }
    // The app owns beforeunload. Prevent Playwright's automatic native-dialog dismissal.
    electronApp.context().on('dialog', () => {});
    boundaryDiagnostic = createBrowserBoundaryDiagnostic(
      electronApp,
      window,
      'pending-dialog-boundary',
    );
    advisorRoute = await electronApp.evaluate(() =>
      globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
        kind: 'create',
        mode: 'app-advisor',
      }),
    );
    const named = await window.evaluate(() =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName: 'Dialog Work', allowEnable: true },
      }),
    );
    await window.getByTestId('panel-add-tab-group-terminal').click();
    await window.getByTestId('panel-add-menu-item-browser').click();
    const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?profiles=beforeunload`;
    await window.getByTestId('browser-url-input').fill(url);
    await window.getByTestId('browser-url-input').press('Enter');
    await expect
      .poll(() =>
        fixtureCookies(electronApp, url, 'source-only').catch(() => []),
      )
      .toContain('source-only');
    await electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((value) => value.getURL() === url);
      await contents.executeJavaScript(
        "window.onbeforeunload = event => { event.preventDefault(); event.returnValue = ''; }; document.querySelector('input').value = 'unsaved source text';",
        true,
      );
      contents.sendInputEvent({
        type: 'mouseDown',
        x: 30,
        y: 30,
        button: 'left',
        clickCount: 1,
      });
      contents.sendInputEvent({
        type: 'mouseUp',
        x: 30,
        y: 30,
        button: 'left',
        clickCount: 1,
      });
    }, url);
    const original = (
      await dispatchProfileAction(electronApp, { type: 'browser.list' })
    ).result.browsers[0];
    const request = {
      type: 'browser.profile.switch',
      operationId: randomUUID(),
      browserId: original.id,
      expectedRuntimeGeneration: original.profile.runtimeGeneration,
      selection: { kind: 'named', profileId: named.profileId },
      mode: 'replace',
    };
    const first = await dispatchProfileAction(electronApp, request);
    expect(first).toMatchObject({
      ok: true,
      result: { status: 'pending', dialog: { type: 'beforeunload' } },
    });
    const modal = window.getByTestId('browser-javascript-dialog');
    await expect(modal).toBeVisible();
    const boundaryIdentity = {
      projectId: original.projectId,
      worktreeId: original.worktreeId,
      browserId: original.id,
      profileId: original.profile.resolvedProfileId,
      runtimeGeneration: original.profile.runtimeGeneration,
      storageGeneration: original.profile.storageGeneration,
      dialogId: first.result.dialog.id,
      url,
    };
    if (boundaryDiagnostic)
      await boundaryDiagnostic.checkpoint(
        'pending-response-visible-modal',
        boundaryIdentity,
        { switchOperationId: request.operationId },
      );

    const initialNative = await electronApp.evaluate(
      ({ BrowserWindow }, fixtureUrl) => {
        const observedAtMs = Number(process.hrtime.bigint()) / 1_000_000;
        const matches = BrowserWindow.getAllWindows().flatMap((win) =>
          // A Browser page sits two views down in its frame (a window child),
          // which carries its window bounds.
          win.contentView.children
            .map((frame) => ({
              frame,
              view: frame.webContents
                ? frame
                : (frame.children?.[0]?.children?.[0] ?? frame),
            }))
            .filter(({ view }) => view.webContents?.getURL() === fixtureUrl)
            .map(({ frame, view }) => ({
              observedAtMs,
              webContentsId: view.webContents.id,
              hostWindowId: win.id,
              destroyed: view.webContents.isDestroyed(),
              windowDestroyed: win.isDestroyed(),
              visible: frame.getVisible() && view.getVisible(),
              bounds: frame.getBounds(),
            })),
        );
        return matches;
      },
      url,
    );
    if (controlledEvidence) controlledEvidence.initialNative = initialNative;
    expect(initialNative).toHaveLength(1);
    expect(initialNative[0]).toMatchObject({
      destroyed: false,
      windowDestroyed: false,
    });
    const ownerWindow = await electronApp.browserWindow(window);
    try {
      ownerRendererWebContentsId = await ownerWindow.evaluate(
        (owner) => owner.webContents.id,
      );
    } finally {
      await ownerWindow.dispose();
    }
    const initialNativeReadiness = await electronApp.evaluate(
      waitForInitialNativeReadiness,
      {
        ...boundaryIdentity,
        ownerRendererWebContentsId,
        initialNative: initialNative[0],
      },
    );
    if (controlledEvidence) {
      controlledEvidence.initialNativeReadiness = initialNativeReadiness;
    }
    expect(initialNativeReadiness).toMatchObject({
      status: 'ready',
      reason: null,
      identity: {
        webContentsId: initialNative[0].webContentsId,
        hostWindowId: initialNative[0].hostWindowId,
        ownerRendererWebContentsId,
      },
      ready: {
        ready: true,
        classification: 'ready',
        session: {
          browserId: original.id,
          profileId: original.profile.resolvedProfileId,
          runtimeGeneration: original.profile.runtimeGeneration,
          storageGeneration: original.profile.storageGeneration,
          dialogId: first.result.dialog.id,
          ownerRendererWebContentsId,
          cachedVisible: false,
        },
        native: {
          webContentsId: initialNative[0].webContentsId,
          hostWindowId: initialNative[0].hostWindowId,
          destroyed: false,
          windowDestroyed: false,
          visible: false,
          diagnosticVisible: false,
        },
      },
    });
    const readyNative = initialNativeReadiness.ready;
    expect(readyNative.native.bounds.width).toBeGreaterThan(0);
    expect(readyNative.native.bounds.height).toBeGreaterThan(0);
    await expect(modal).toBeVisible();
    const inspectDialogControl = async (name) => {
      const control = modal.getByRole('button', { name, exact: true });
      await expect(control).toBeVisible();
      await expect(control).toBeEnabled();
      const usability = await control.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const point = element.ownerDocument.elementFromPoint(
          rect.left + rect.width / 2,
          rect.top + rect.height / 2,
        );
        return {
          bounds: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          pointerTarget: point === element || element.contains(point),
        };
      });
      expect(usability.bounds.width).toBeGreaterThan(0);
      expect(usability.bounds.height).toBeGreaterThan(0);
      expect(usability.pointerTarget).toBe(true);
      return {
        visible: true,
        enabled: true,
        ...usability,
      };
    };
    const stayControl = await inspectDialogControl('Stay');
    const leaveControl = await inspectDialogControl('Leave');
    const readyBrowserBounds = await window
      .getByTestId(`browser-pane-${original.id}`)
      .boundingBox();
    expect(readyBrowserBounds?.width).toBeGreaterThan(0);
    expect(readyBrowserBounds?.height).toBeGreaterThan(0);
    if (controlledEvidence) {
      controlledEvidence.readyNative = readyNative;
      controlledEvidence.rendererCheckpoints.push({
        phase: 'initial-native-ready-before-installation',
        time: await window.evaluate(() => performance.now()),
        modalVisible: true,
        stayEnabled: true,
        leaveEnabled: true,
        stayVisible: true,
        leaveVisible: true,
        controls: { stay: stayControl, leave: leaveControl },
        browserBounds: readyBrowserBounds,
      });
    }

    const assertPendingDialog = async () => {
      const state = await electronApp.evaluate(waitForInitialNativeReadiness, {
        ...boundaryIdentity,
        ownerRendererWebContentsId,
        initialNative: initialNative[0],
      });
      expect(state.status).toBe('ready');
      expect(state.ready).toMatchObject({
        session: {
          browserId: original.id,
          profileId: original.profile.resolvedProfileId,
          runtimeGeneration: original.profile.runtimeGeneration,
          storageGeneration: original.profile.storageGeneration,
          dialogId: first.result.dialog.id,
          cachedVisible: false,
        },
        native: {
          webContentsId: initialNative[0].webContentsId,
          hostWindowId: initialNative[0].hostWindowId,
          destroyed: false,
          windowDestroyed: false,
          visible: false,
        },
      });
      expect(state.ready.native.bounds.width).toBeGreaterThan(0);
      expect(state.ready.native.bounds.height).toBeGreaterThan(0);
      expect(
        await dispatchProfileAction(electronApp, {
          type: 'browser.get_dialog',
          browserId: original.id,
          expectedRuntimeGeneration: original.profile.runtimeGeneration,
        }),
      ).toMatchObject({
        ok: true,
        result: { dialog: { id: first.result.dialog.id } },
      });
      await inspectDialogControl('Stay');
      await inspectDialogControl('Leave');
    };
    await window.evaluate(
      async (target) => {
        await window.api.browser.setBounds({
          ...target,
          bounds: { x: 20, y: 180, width: 640, height: 400 },
          visible: true,
        });
        await window.api.browser.setVisible({ ...target, visible: false });
      },
      {
        browserId: original.id,
        expectedRuntimeGeneration: original.profile.runtimeGeneration,
      },
    );
    await assertPendingDialog();

    if (controlledLaterHide) {
      // Observe real renderer IPC without delaying or replacing its semantics.
      presentationRecorder = await electronApp.evaluateHandle(
        ({ ipcMain }, target) => {
          const channel = 'browser:set-visible';
          const originalHandler = ipcMain._invokeHandlers.get(channel);
          if (typeof originalHandler !== 'function')
            throw new Error('Missing visibility handler');
          const records = [];
          let overflow = false;
          const wrapped = async (event, request) => {
            if (
              event.sender.id !== target.rendererId ||
              request.browserId !== target.browserId ||
              request.expectedRuntimeGeneration !== target.runtimeGeneration
            ) {
              return originalHandler(event, request);
            }
            const row = { visible: request.visible, status: 'pending' };
            if (records.length < 64) records.push(row);
            else overflow = true;
            try {
              const result = await originalHandler(event, request);
              row.status = 'fulfilled';
              return result;
            } catch (error) {
              row.status = 'rejected';
              throw error;
            }
          };
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, wrapped);
          return {
            report: () => ({ records, overflow }),
            restore: () => {
              if (ipcMain._invokeHandlers.get(channel) !== wrapped)
                throw new Error(
                  'Visibility handler changed during observation',
                );
              ipcMain.removeHandler(channel);
              ipcMain.handle(channel, originalHandler);
              return ipcMain._invokeHandlers.get(channel) === originalHandler;
            },
          };
        },
        {
          rendererId: ownerRendererWebContentsId,
          browserId: original.id,
          runtimeGeneration: original.profile.runtimeGeneration,
        },
      );
      const composer = window
        .locator(
          '[data-testid="panel-content-chat"][data-panel-id="panel-chat-seed-chat"]',
        )
        .getByRole('textbox')
        .first();
      await expect(composer).toBeEditable();
      const composerElement = await composer.elementHandle();
      try {
        rendererRouteHandle = await window.evaluateHandle(
          installPresentationRendererRouteRecorder,
          composerElement,
        );
      } finally {
        await composerElement?.dispose();
      }
      await expect
        .poll(() =>
          rendererRouteHandle.evaluate(
            (recorder) =>
              recorder.report().counters.initialResizeObserverNotifications,
          ),
        )
        .toBe(1);
      const rootHeight = () =>
        composer.evaluate(
          (element) =>
            element.closest('[data-chat-composer-root]').getBoundingClientRect()
              .height,
        );
      const beforeHeight = await rootHeight();
      expect(beforeHeight).toBeGreaterThan(0);
      const beforeCalls = await presentationRecorder.evaluate(
        (recorder) => recorder.report().records.length,
      );
      const invalidationsBefore = await rendererRouteHandle.evaluate(
        (recorder) => recorder.report().counters.boundsInvalidationEvents,
      );
      await rendererRouteHandle.evaluate((recorder) => recorder.noteTrigger());
      await composer.fill(
        'Presentation draft line one.\nPresentation draft line two.\nPresentation draft line three.\nPresentation draft line four.\nPresentation draft line five.\nPresentation draft line six.',
      );
      await expect.poll(rootHeight).toBeGreaterThan(beforeHeight);
      await expect
        .poll(() =>
          rendererRouteHandle.evaluate(
            (recorder) => recorder.report().counters.postTriggerSizeChanges,
          ),
        )
        .toBeGreaterThan(0);
      await expect
        .poll(() =>
          rendererRouteHandle.evaluate(
            (recorder) => recorder.report().counters.boundsInvalidationEvents,
          ),
        )
        .toBeGreaterThan(invalidationsBefore);
      await expect
        .poll(() =>
          presentationRecorder.evaluate(
            (recorder, cursor) =>
              recorder
                .report()
                .records.slice(cursor)
                .some(
                  (row) => row.visible === false && row.status === 'fulfilled',
                ),
            beforeCalls,
          ),
        )
        .toBe(true);
      controlledEvidence.rendererRoute = await rendererRouteHandle.evaluate(
        (recorder) => recorder.report(),
      );
      controlledEvidence.presentation = await presentationRecorder.evaluate(
        (recorder) => recorder.report(),
      );
      expect(controlledEvidence.rendererRoute.incomplete).toBe(false);
      expect(controlledEvidence.presentation.overflow).toBe(false);
      await assertPendingDialog();
    }

    const clearWhileSwitching = async (profile) => {
      const preview = await window.evaluate(
        (profile) =>
          window.api.browser.profiles.previewClear({
            profileId: profile.profileId,
            storageGeneration: profile.storageGeneration,
            metadataRevision: profile.metadataRevision,
            operation: { kind: 'cache' },
          }),
        profile,
      );
      const operationId = randomUUID();
      const receipt = await window.evaluate(
        (request) => window.api.browser.profiles.clear(request),
        {
          operationId,
          token: preview.token,
        },
      );
      return { operationId, receipt };
    };
    const sourceProfile = await window.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      original.profile.resolvedProfileId,
    );
    const conflictedClear = await clearWhileSwitching(sourceProfile);
    await expect
      .poll(
        () =>
          window.evaluate(
            (jobId) => window.api.browser.profiles.jobGet({ jobId }),
            conflictedClear.operationId,
          ),
        { timeout: 5000 },
      )
      .toMatchObject({ status: 'failed', retryable: false });
    await expect(modal).toBeVisible();
    if (boundaryDiagnostic)
      await boundaryDiagnostic.checkpoint(
        'source-clear-failed-visible-modal',
        boundaryIdentity,
        {
          switchOperationId: request.operationId,
          sourceClearOperationId: conflictedClear.operationId,
        },
      );
    const unrelated = await window.evaluate(() =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName: 'Unrelated clear' },
      }),
    );
    const unrelatedClear = await clearWhileSwitching(unrelated);
    let lastUnrelatedJob = null;
    try {
      await expect
        .poll(
          async () => {
            lastUnrelatedJob = await window.evaluate(
              (jobId) => window.api.browser.profiles.jobGet({ jobId }),
              unrelatedClear.operationId,
            );
            return lastUnrelatedJob;
          },
          { timeout: 15000 },
        )
        .toMatchObject({ status: 'complete' });
    } catch (error) {
      try {
        const evidence = Buffer.from(
          JSON.stringify(
            {
              createdUnrelatedProfile: unrelated,
              operationId: unrelatedClear.operationId,
              clearReceipt: unrelatedClear.receipt ?? null,
              lastJobGet: lastUnrelatedJob,
              cause:
                lastUnrelatedJob?.message ===
                'Browser data maintenance failed. Try again before using this profile.'
                  ? 'unresolved: the job contains only the generic maintenance failure message'
                  : lastUnrelatedJob?.message === undefined
                    ? 'unresolved: the last job has no diagnostic message'
                    : null,
            },
            null,
            2,
          ),
        );
        if (evidence.byteLength <= 32 * 1024) {
          let attachmentTimeout;
          try {
            await Promise.race([
              test.info().attach('unrelated-cache-clear-failure.json', {
                body: evidence,
                contentType: 'application/json',
              }),
              new Promise((resolve) => {
                attachmentTimeout = setTimeout(resolve, 1000);
              }),
            ]);
          } finally {
            clearTimeout(attachmentTimeout);
          }
        }
      } catch {
        // Failure evidence must never replace the original poll error.
      }
      throw error;
    }
    await expect(modal).toBeVisible();
    if (boundaryDiagnostic)
      await boundaryDiagnostic.checkpoint(
        'unrelated-clear-complete-visible-modal',
        boundaryIdentity,
        {
          switchOperationId: request.operationId,
          sourceClearOperationId: conflictedClear.operationId,
          unrelatedClearOperationId: unrelatedClear.operationId,
        },
      );
    await expect
      .poll(async () => {
        const observed = await electronApp.evaluate(
          ({ BrowserWindow }, input) => {
            const url = typeof input === 'string' ? input : input.url;
            // A Browser page sits two views down in its frame.
            const views = BrowserWindow.getAllWindows().flatMap((win) =>
              win.contentView.children.map((frame) =>
                frame.webContents
                  ? frame
                  : (frame.children?.[0]?.children?.[0] ?? frame),
              ),
            );
            const visible = views
              .find((view) => view.webContents?.getURL() === url)
              ?.getVisible();
            if (typeof input === 'string') return visible;
            let evidence;
            try {
              const fixture =
                globalThis.__CANOPY_E2E_PROFILE_OPERATION_DIAGNOSTICS__;
              evidence =
                typeof fixture === 'function'
                  ? fixture({
                      kind: 'browser-snapshot',
                      scope: input,
                      deadline: Date.now() + 2000,
                    })
                  : { status: 'unavailable' };
            } catch {
              evidence = {
                status: 'unavailable',
                reason: 'native-snapshot-failed',
              };
            }
            return { visible, evidence };
          },
          boundaryDiagnostic ? boundaryIdentity : url,
        );
        if (!boundaryDiagnostic) return observed;
        boundaryDiagnostic.poll({
          identity: {
            browserId: original.id,
            profileId: original.profile.resolvedProfileId,
            runtimeGeneration: original.profile.runtimeGeneration,
            storageGeneration: original.profile.storageGeneration,
            dialogId: first.result.dialog.id,
            switchOperationId: request.operationId,
            sourceClearOperationId: conflictedClear.operationId,
            unrelatedClearOperationId: unrelatedClear.operationId,
          },
          firstUrlMatchVisible: observed.visible,
          evidence: observed.evidence,
        });
        return observed.visible;
      })
      .toBe(false);
    await modal.getByRole('button', { name: 'Stay', exact: true }).click();
    await expect(modal).toHaveCount(0);
    const cancelled = await dispatchProfileAction(electronApp, request);
    expect(cancelled).toMatchObject({
      ok: true,
      result: { status: 'cancelled' },
    });
    expect(await fixtureCookies(electronApp, url)).toContain('source-only');
    expect(
      await electronApp.evaluate(
        async ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .find((value) => value.getURL() === url)
            .executeJavaScript("document.querySelector('input').value"),
        url,
      ),
    ).toBe('unsaved source text');
    const secondRequest = { ...request, operationId: randomUUID() };
    const second = await dispatchProfileMcpAction(advisorRoute, secondRequest);
    expect(second).toMatchObject({ ok: true, result: { status: 'pending' } });
    expect(
      await dispatchProfileMcpAction(advisorRoute, {
        type: 'browser.get_dialog',
        browserId: original.id,
        expectedRuntimeGeneration: original.profile.runtimeGeneration,
      }),
    ).toMatchObject({
      ok: true,
      result: { dialog: { id: second.result.dialog.id } },
    });
    await window.evaluate(
      (profile) =>
        window.api.browser.profiles.update({
          operationId: crypto.randomUUID(),
          profileId: profile.profileId,
          expectedMetadataRevision: profile.metadataRevision,
          patch: { allowEnable: false },
        }),
      named,
    );
    const handled = await dispatchProfileMcpAction(advisorRoute, {
      type: 'browser.handle_dialog',
      browserId: original.id,
      expectedRuntimeGeneration: original.profile.runtimeGeneration,
      dialogId: second.result.dialog.id,
      accept: true,
    });
    expect(handled.ok).toBe(true);
    await expect(modal).toHaveCount(0);
    const failed = await dispatchProfileAction(electronApp, secondRequest);
    expect(failed.ok ? failed.result.status : failed.error.code).toMatch(
      /cancelled|agent_enable_denied/,
    );
    expect(await fixtureCookies(electronApp, url)).toContain('source-only');
    expect(
      (await dispatchProfileAction(electronApp, { type: 'browser.list' }))
        .result.browsers[0].profile.resolvedProfileId,
    ).toBe(original.profile.resolvedProfileId);
    expect(
      await electronApp.evaluate(
        ({ webContents }, url) =>
          webContents
            .getAllWebContents()
            .filter((value) => value.getURL() === url).length,
        url,
      ),
    ).toBe(1);
    const currentProfile = await window.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      named.profileId,
    );
    await window.evaluate(
      (profile) =>
        window.api.browser.profiles.update({
          operationId: crypto.randomUUID(),
          profileId: profile.profileId,
          expectedMetadataRevision: profile.metadataRevision,
          patch: { allowEnable: true },
        }),
      currentProfile,
    );
    const acceptedRequest = { ...request, operationId: randomUUID() };
    const acceptedPending = await dispatchProfileAction(
      electronApp,
      acceptedRequest,
    );
    expect(acceptedPending).toMatchObject({
      ok: true,
      result: { status: 'pending' },
    });
    const accepted = await dispatchProfileAction(electronApp, {
      type: 'browser.handle_dialog',
      browserId: original.id,
      expectedRuntimeGeneration: original.profile.runtimeGeneration,
      dialogId: acceptedPending.result.dialog.id,
      accept: true,
    });
    expect(accepted.ok).toBe(true);
    await expect(modal).toHaveCount(0);
    const completed = await dispatchProfileAction(electronApp, acceptedRequest);
    expect(completed).toMatchObject({
      ok: true,
      result: {
        status: 'complete',
        browser: { profile: { resolvedProfileId: named.profileId } },
      },
    });
    await expect
      .poll(() => fixtureCookies(electronApp, url).catch(() => ['loading']))
      .toEqual([]);
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ BrowserWindow }, url) =>
            BrowserWindow.getAllWindows()
              // A Browser page sits two views down in its frame.
              .flatMap((win) =>
                win.contentView.children.map((frame) =>
                  frame.webContents
                    ? frame
                    : (frame.children?.[0]?.children?.[0] ?? frame),
                ),
              )
              .find((view) => view.webContents?.getURL() === url)
              ?.getVisible(),
          url,
        ),
      )
      .toBe(true);
  } catch (error) {
    primaryError = error;
  } finally {
    const cleanup = async (phase, action) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push({
          phase,
          message: boundedCleanupErrorMessage(error),
        });
      }
    };
    if (rendererRouteHandle) {
      await cleanup('finalize-renderer-route', async () => {
        controlledEvidence.rendererRoute = await rendererRouteHandle.evaluate(
          (recorder) => recorder.finalize(),
        );
      });
      await cleanup('dispose-renderer-route', () =>
        rendererRouteHandle.dispose(),
      );
    }
    if (presentationRecorder) {
      await cleanup('restore-visibility-handler', async () => {
        expect(
          await presentationRecorder.evaluate((recorder) => recorder.restore()),
        ).toBe(true);
      });
      await cleanup('dispose-presentation-recorder', () =>
        presentationRecorder.dispose(),
      );
    }
    if (controlledEvidence)
      await cleanup('attach-resize-evidence', () =>
        test.info().attach('graduated-presentation-resize.json', {
          body: Buffer.from(JSON.stringify(controlledEvidence, null, 2)),
          contentType: 'application/json',
        }),
      );
    if (boundaryDiagnostic)
      await cleanup('close-boundary-diagnostic', () =>
        boundaryDiagnostic.close(),
      );
    if (advisorRoute && electronApp)
      await cleanup('delete-advisor-route', () =>
        electronApp.evaluate(
          (_electron, sessionKey) =>
            globalThis.__CANOPY_E2E_BROWSER_MCP_ROUTE__({
              kind: 'delete',
              sessionKey,
            }),
          advisorRoute.sessionKey,
        ),
      );
    const owner = seeded ?? selectionOwner;
    if (owner.electronApp && owner.userDataDir)
      await cleanup('close-canopy', () => launchBoundary.close(owner));
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new Error(JSON.stringify(cleanupErrors));
}

test('returns pending source dialogs to agents, honors veto, and rechecks enable on acceptance', async () => {
  await runGraduatedPendingSourceDialogCase();
});

test('composer resize retains the pending source dialog on the graduated presentation path', async () => {
  await runGraduatedPendingSourceDialogCase({ controlledLaterHide: true });
});

terminalCleanupTest(
  'persists named settings and defaults, distinguishes duplicate names, and previews deletion',
  async ({ runTerminalCleanup }) => {
    // Windows reached the final assertions at 118s; its earlier native close
    // took 16s. Include teardown without changing any user-flow assertion.
    test.setTimeout(process.platform === 'win32' ? 180_000 : 90_000);
    const boundary = createSelectedLaunchBoundary(
      'browser-settings-persistence',
      'initial',
      {
        close: closeCanopy,
        owners: [{ projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }],
      },
    );
    const initialOwner = await seedPanelWorktree(
      selectedSetupDiagnostics(
        'browser-settings-persistence-setup',
        undefined,
        boundary,
      ) ?? boundary.options,
    );
    let { electronApp, window, app } = initialOwner;
    const { userDataDir } = initialOwner;
    let relaunchedOwner;
    try {
      const boundaryDiagnostic = createBrowserBoundaryDiagnostic(
        electronApp,
        window,
        'browser-add-menu-boundary',
      );
      const boundaryScope = {
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      };
      try {
        if (boundaryDiagnostic) await boundaryDiagnostic.arm(boundaryScope);
        await window.getByTestId('panel-add-panel-group-terminal').click();
        if (boundaryDiagnostic)
          await boundaryDiagnostic.checkpoint(
            'open-add-menu-click-return',
            boundaryScope,
          );
        await window.getByTestId('panel-add-menu-item-browser').click();
        if (boundaryDiagnostic)
          await boundaryDiagnostic.checkpoint(
            'browser-item-click-return',
            boundaryScope,
          );
        try {
          await expect(
            window.getByTestId('browser-profile-picker'),
          ).toContainText('Task');
        } catch (error) {
          if (boundaryDiagnostic)
            await boundaryDiagnostic.checkpoint(
              'original-picker-assertion-failed',
              boundaryScope,
            );
          throw error;
        }
        if (boundaryDiagnostic)
          await boundaryDiagnostic.checkpoint(
            'original-picker-assertion-complete',
            boundaryScope,
          );
      } catch (error) {
        boundaryDiagnostic?.failure(error);
        throw error;
      } finally {
        if (boundaryDiagnostic) await boundaryDiagnostic.close();
      }
      await app.openSettings();
      await app.openSettingsSection('browser');
      let settings = window.getByTestId('settings-tab-browser');
      const duplicateName =
        'Work account with a deliberately long but distinct profile identifier';
      for (let index = 0; index < 2; index++) {
        await settings
          .getByTestId('browser-profile-new-name')
          .fill(duplicateName);
        await settings.getByTestId('browser-profile-create').click();
        await expect(
          settings.getByTestId('browser-profile-new-name'),
        ).toHaveValue('');
      }
      const profiles = await window.evaluate(async () =>
        (await window.api.browser.profiles.list()).profiles.filter(
          (profile) => profile.kind === 'named',
        ),
      );
      expect(profiles).toHaveLength(2);
      const named = profiles[0];
      await settings
        .getByTestId(`browser-profile-row-${named.profileId}`)
        .click();
      let detail = settings.getByTestId('browser-profile-details');
      await detail
        .getByRole('textbox', { name: 'Profile name', exact: true })
        .fill('Renamed Work');
      await detail.getByRole('button', { name: 'Rename', exact: true }).click();
      await expect(
        settings.getByTestId(`browser-profile-row-${named.profileId}`),
      ).toContainText('Renamed Work');
      await detail
        .getByRole('switch', {
          name: 'Allow agent to enable this profile',
          exact: true,
        })
        .click();
      await expect(
        detail.getByRole('switch', {
          name: 'Allow agent to enable this profile',
          exact: true,
        }),
      ).toHaveAttribute('aria-checked', 'true');
      await detail
        .getByRole('switch', {
          name: 'Allow agents to clear this profile',
          exact: true,
        })
        .click();
      await expect(
        detail.getByRole('switch', {
          name: 'Allow agents to clear this profile',
          exact: true,
        }),
      ).toHaveAttribute('aria-checked', 'true');
      await app.closeSettings();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      const picker = window.getByTestId('browser-profile-picker');
      await picker.focus();
      await picker.press('Enter');
      await expect
        .poll(() =>
          window.getByTestId('browser-profile-menu').evaluate((menu) => {
            const rect = menu.getBoundingClientRect();
            return (
              rect.top >= 8 &&
              rect.left >= 8 &&
              rect.bottom <= innerHeight - 8 &&
              rect.right <= innerWidth - 8
            );
          }),
        )
        .toBe(true);

      await window
        .getByTestId('browser-profile-selection')
        .selectOption(named.profileId);
      await window.getByTestId('browser-profile-set-default').click();
      await expect(window.getByTestId('browser-profile-menu')).toContainText(
        'Default updated',
      );
      await window.getByTestId('browser-profile-selection').press('Escape');
      await expect(window.getByTestId('browser-profile-menu')).toHaveCount(0);
      await expect(picker).toContainText('Task');
      await window.getByTestId('panel-add-panel-group-terminal').click();
      await window.getByTestId('panel-add-menu-item-browser').click();
      await expect(
        window.getByTestId('browser-profile-picker').last(),
      ).toContainText('Renamed Work');
      await boundary.close(initialOwner, { keepUserData: true });
      relaunchedOwner = await launchCanopy({ userDataDir });
      ({ electronApp } = relaunchedOwner);
      window = await getMainWindow(electronApp);
      app = new CanopyAppDriver(window);
      await app.waitForShell();
      await app.openSettings();
      await app.openSettingsSection('browser');
      settings = window.getByTestId('settings-tab-browser');
      await settings
        .getByTestId(`browser-profile-row-${named.profileId}`)
        .click();
      detail = settings.getByTestId('browser-profile-details');
      await expect(
        detail.getByRole('switch', {
          name: 'Allow agent to enable this profile',
          exact: true,
        }),
      ).toHaveAttribute('aria-checked', 'true');
      await expect(
        detail.getByRole('switch', {
          name: 'Allow agents to clear this profile',
          exact: true,
        }),
      ).toHaveAttribute('aria-checked', 'true');
      const savedNamedTab = (
        await dispatchProfileAction(electronApp, { type: 'browser.list' })
      ).result.browsers.find(
        (tab) => tab.profile?.resolvedProfileId === named.profileId,
      );
      expect(savedNamedTab).toBeTruthy();
      await window.evaluate(
        (tab) =>
          window.api.browser.create({
            browserId: tab.id,
            projectId: tab.projectId,
            worktreeId: tab.worktreeId,
            expectedRuntimeGeneration: tab.profile.runtimeGeneration,
          }),
        savedNamedTab,
      );
      await detail.getByTestId('browser-profile-delete').click();
      const preview = window.getByTestId('browser-profile-delete-preview');
      await expect(preview).toContainText('1 saved tab becomes unavailable');
      await expect(preview).toContainText(
        '1 task default needs another profile',
      );
      await preview.getByTestId('browser-profile-confirm-delete').click();
      await expect(
        settings.getByTestId(`browser-profile-row-${named.profileId}`),
      ).toHaveCount(0);
      await expect(
        settings.getByTestId(`browser-profile-row-${profiles[1].profileId}`),
      ).toBeVisible();
      await expect(
        settings.getByTestId('browser-profile-cleanup-jobs'),
      ).toContainText('waiting for an app restart');
      await app.closeSettings();
      await app.openMainPage();
      await app.selectWorktree('demo-main');
      await expect(
        window.getByTestId('browser-profile-picker').last(),
      ).toContainText('Unavailable profile');
      const task = await window.evaluate(() =>
        window.api.browser.profiles.context({
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
        }),
      );
      expect(task.defaultSelection).toEqual({
        kind: 'named',
        profileId: named.profileId,
      });
    } finally {
      await runTerminalCleanup(() =>
        relaunchedOwner
          ? closeCanopy(
              relaunchedOwner.electronApp,
              relaunchedOwner.userDataDir,
            )
          : boundary.close(initialOwner),
      );
    }
  },
);

terminalCleanupTest(
  'keeps an active download owned by its source profile after switching the tab',
  async ({ runTerminalCleanup }) => {
    // Windows completed download verification at 48s and entered shutdown at 53s.
    test.setTimeout(process.platform === 'win32' ? 90_000 : 60_000);
    const { createServer } = await import('node:http');
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    let response;
    const body = 'source'.repeat(2048);
    const server = createServer((request, reply) => {
      if (request.url === '/download') {
        response = reply;
        reply.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': 'attachment; filename="profile-fixture.txt"',
          'Content-Length': String(Buffer.byteLength(body) + 2),
        });
        // Send enough bytes to pass Chromium's initial body buffering while
        // withholding completion until the account switch has committed.
        reply.write(body);
      } else {
        reply.writeHead(200, { 'Content-Type': 'text/html' });
        reply.end('<a href="/download">Download file</a>');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    const boundary = createSelectedLaunchBoundary(
      'active-download',
      'initial',
      {
        close: closeCanopy,
        owners: [{ projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }],
      },
    );
    const owner = await seedPanelWorktree(boundary.options);
    const { electronApp, userDataDir, window } = owner;
    try {
      const browserOwner = {
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
      };
      const { browser: original } = await seedVisibleBrowserPanel(window, {
        ...browserOwner,
        url,
      });
      await expect(
        window.getByTestId(`browser-pane-${original.id}`),
      ).toBeVisible();
      const listed = (
        await dispatchProfileAction(electronApp, { type: 'browser.list' })
      ).result.browsers.find((browser) => browser.id === original.id);
      expect(listed).toMatchObject({
        id: original.id,
        ...browserOwner,
        profile: {
          resolvedProfileId: original.profile.resolvedProfileId,
          runtimeGeneration: original.profile.runtimeGeneration,
        },
      });
      const target = await window.evaluate(() =>
        window.api.browser.profiles.create({
          operationId: crypto.randomUUID(),
          input: { displayName: 'Download destination', allowEnable: true },
        }),
      );
      const savedPath = join(userDataDir, 'user-saved-download.txt');
      await expect
        .poll(() =>
          electronApp.evaluate(
            ({ webContents }, url) =>
              webContents
                .getAllWebContents()
                .some((contents) => contents.getURL() === url),
            url,
          ),
        )
        .toBe(true);
      await electronApp.evaluate(
        ({ webContents }, { url, savedPath }) => {
          const source = webContents
            .getAllWebContents()
            .find((contents) => contents.getURL() === url);
          globalThis.__profileDownloadProbe = {
            listeners: source.session.listenerCount('will-download'),
            sourceId: source.id,
            events: [],
          };
          source.session.once('will-download', (_event, item, contents) => {
            globalThis.__profileDownloadProbe.events.push({
              type: 'start',
              contentsId: contents?.id,
            });
            item.setSavePath(savedPath);
            item.once('done', (_event, state) =>
              globalThis.__profileDownloadProbe.events.push({
                type: 'done',
                state,
              }),
            );
          });
        },
        { url, savedPath },
      );
      const clicked = await dispatchProfileAction(electronApp, {
        type: 'browser.click',
        browserId: original.id,
        expectedRuntimeGeneration: original.profile.runtimeGeneration,
        locator: 'a',
      });
      expect(clicked).toMatchObject({ ok: true });
      const active = () =>
        electronApp.evaluate(() =>
          globalThis.__CANOPY_E2E_BROWSER_DOWNLOADS__(),
        );
      await expect
        .poll(async () =>
          JSON.stringify({
            active: await active(),
            probe: await electronApp.evaluate(
              () => globalThis.__profileDownloadProbe,
            ),
            requested: Boolean(response),
          }),
        )
        .toContain('"active":[{');
      const owner = (await active())[0];
      expect(owner).toMatchObject({
        browserId: original.id,
        profileId: original.profile.resolvedProfileId,
        runtimeGeneration: original.profile.runtimeGeneration,
      });
      await expect
        .poll(() =>
          window.evaluate(
            (profileId) => window.api.browser.profiles.jobList({ profileId }),
            owner.profileId,
          ),
        )
        .toMatchObject({
          jobs: [
            expect.objectContaining({ kind: 'download', status: 'running' }),
          ],
        });
      const settingsDriver = new CanopyAppDriver(window);
      await settingsDriver.openSettings();
      await settingsDriver.openSettingsSection('browser');
      await window
        .getByTestId(`browser-profile-row-${owner.profileId}`)
        .click();
      await expect(window.getByTestId('browser-profile-measure')).toBeEnabled();
      await window.getByTestId('browser-profile-clear-cache').click();
      await expect(
        window.getByTestId('browser-profile-clear-preview'),
      ).toBeVisible();
      await window.getByTestId('browser-profile-clear-preview').press('Escape');
      await settingsDriver.closeSettings();
      const switched = await dispatchProfileAction(electronApp, {
        type: 'browser.profile.switch',
        operationId: randomUUID(),
        browserId: original.id,
        expectedRuntimeGeneration: original.profile.runtimeGeneration,
        selection: { kind: 'named', profileId: target.profileId },
        mode: 'replace',
      });
      expect(switched).toMatchObject({
        ok: true,
        result: { status: 'complete' },
      });
      expect(await active()).toEqual([owner]);
      response.end('!!');
      await expect.poll(active).toHaveLength(0);
      await expect
        .poll(() => readFile(savedPath, 'utf8').catch(() => ''))
        .toBe(`${body}!!`);
    } finally {
      await runTerminalCleanup(() =>
        runObservedCleanupSteps(
          [
            ['download-response-destroy', () => response?.destroy()],
            ['download-connections-close', () => server.closeAllConnections()],
            [
              'download-server-close',
              () =>
                new Promise((resolve, reject) => {
                  try {
                    server.close((error) =>
                      error ? reject(error) : resolve(),
                    );
                  } catch (error) {
                    reject(error);
                  }
                }),
            ],
            ['download-owner-close', () => boundary.close(owner)],
          ],
          boundary.record,
        ),
      );
    }
  },
);

for (const stage of [
  'prepared',
  'close_intent',
  'target_committed',
  'retired_incarnation',
]) {
  terminalCleanupTest(
    `recovers the ${stage} switch decision before reopening its real account`,
    async ({ runTerminalCleanup }, testInfo) => {
      // Windows CI can spend ~37s in the inline first close versus the ~10s
      // assumption, so the observed ~27s overrun is covered by this extra 30s
      // body budget; final cleanup keeps its separate 30s fixture slot.
      test.setTimeout(process.platform === 'win32' ? 120_000 : 60_000);
      const { readFile, writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const selected = [
        'prepared',
        'close_intent',
        'target_committed',
      ].includes(stage);
      const boundaryFor = (label) =>
        selected
          ? createSelectedLaunchBoundary(`${stage}-switch`, label, {
              close: closeCanopy,
              owners: [
                { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' },
              ],
            })
          : undefined;
      const launchOptionsFor = (selectedBoundary) =>
        stage === 'close_intent' && selectedBoundary?.record
          ? {
              ...selectedBoundary.options,
              boundaryRecord: selectedBoundary.record,
            }
          : selectedBoundary?.options;
      let boundary = boundaryFor('initial');
      let restartDiagnostic = null;
      let restartDiagnosticIdentity = null;
      const preparedRestartDiagnosticSelected =
        stage === 'prepared' &&
        process.env.CANOPY_E2E_PREPARED_RESTART_DIAGNOSTIC === '1' &&
        Boolean(
          process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR?.trim() ||
          process.env.CANOPY_WINDOWS_BROWSER_BOUNDARY_DIAGNOSTICS_DIR?.trim(),
        );
      const initialNavigationDirectory =
        process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR?.trim();
      const initialNavigationRecord =
        stage === 'close_intent' && initialNavigationDirectory
          ? createWindowsCheckpointRecorder(
              'close-intent-initial-navigation',
              initialNavigationDirectory,
            )
          : null;
      const initialNavigationActivityKey = initialNavigationRecord
        ? randomUUID()
        : null;
      const initialNavigationObserverKey = initialNavigationRecord
        ? `__CANOPY_CLOSE_INTENT_INITIAL_NAVIGATION_${randomUUID().replaceAll('-', '_')}`
        : null;
      let initialNavigationObserverInstalled = false;
      let initialNavigationElectronApp = null;
      let initialNavigationPrimaryError = null;
      const cleanupInitialNavigationObserver = async () => {
        if (
          !initialNavigationObserverInstalled ||
          !initialNavigationElectronApp
        )
          return { completed: true };
        try {
          await initialNavigationElectronApp.evaluate(
            (_electron, key) => globalThis[key]?.cleanup(),
            initialNavigationObserverKey,
          );
          initialNavigationObserverInstalled = false;
          return { completed: true };
        } catch (error) {
          initialNavigationRecord?.('initial-navigation-cleanup-unavailable', {
            error: boundedCleanupErrorMessage(error).slice(0, 2048),
          });
          return { completed: false, error };
        }
      };
      let owner = await seedPanelWorktree(
        ['prepared', 'target_committed'].includes(stage)
          ? selectedSetupDiagnostics(
              `${stage.replaceAll('_', '-')}-switch-setup`,
              undefined,
              boundary,
            )
          : launchOptionsFor(boundary),
      );
      let { electronApp, userDataDir, window, app } = owner;
      initialNavigationElectronApp = electronApp;
      try {
        await window.getByTestId('panel-add-tab-group-terminal').click();
        await window.getByTestId('panel-add-menu-item-browser').click();
        const fixtureUrl = new URL(
          `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one`,
        );
        if (initialNavigationActivityKey)
          fixtureUrl.searchParams.set(
            'scenarioKey',
            initialNavigationActivityKey,
          );
        const url = fixtureUrl.toString();
        if (initialNavigationObserverKey) {
          try {
            await electronApp.evaluate(installInitialNavigationObserver, {
              observerKey: initialNavigationObserverKey,
              targetUrl: url,
            });
            initialNavigationObserverInstalled = true;
          } catch (error) {
            initialNavigationRecord?.(
              'initial-navigation-observer-unavailable',
              {
                error: boundedCleanupErrorMessage(error).slice(0, 2048),
              },
            );
          }
        }
        let initialNavigationCleanup = { completed: true };
        try {
          await window.getByTestId('browser-url-input').fill(url);
          await window.getByTestId('browser-url-input').press('Enter');
          await expect
            .poll(() =>
              fixtureCookies(electronApp, url, 'restart-source').catch(
                () => [],
              ),
            )
            .toContain('restart-source');
          if (initialNavigationRecord)
            await captureInitialNavigationEvidence({
              electronApp,
              window,
              url,
              activityKey: initialNavigationActivityKey,
              observerKey: initialNavigationObserverKey,
              record: initialNavigationRecord,
              testInfo,
            });
        } catch (error) {
          initialNavigationPrimaryError = error;
          if (initialNavigationRecord)
            await captureInitialNavigationEvidence({
              electronApp,
              window,
              url,
              activityKey: initialNavigationActivityKey,
              observerKey: initialNavigationObserverKey,
              record: initialNavigationRecord,
              testInfo,
              error,
            }).catch(() => {});
        } finally {
          initialNavigationCleanup = await cleanupInitialNavigationObserver();
        }
        if (initialNavigationPrimaryError) throw initialNavigationPrimaryError;
        if (!initialNavigationCleanup.completed)
          throw initialNavigationCleanup.error;
        const source = (
          await dispatchProfileAction(electronApp, { type: 'browser.list' })
        ).result.browsers[0];
        const target = await window.evaluate(() =>
          window.api.browser.profiles.create({
            operationId: crypto.randomUUID(),
            input: { displayName: 'Restart target', allowEnable: true },
          }),
        );
        const operationId = randomUUID();
        const request = {
          type: 'browser.profile.switch',
          operationId,
          browserId: source.id,
          expectedRuntimeGeneration: source.profile.runtimeGeneration,
          selection: { kind: 'named', profileId: target.profileId },
          mode: 'replace',
        };
        expect(await dispatchProfileAction(electronApp, request)).toMatchObject(
          {
            ok: true,
            result: { status: 'complete' },
          },
        );
        if (boundary) await boundary.close(owner, { keepUserData: true });
        else
          await closeCanopy(electronApp, userDataDir, { keepUserData: true });
        // Retain an actual runtime-produced journal with the last durable decision
        // from each crash boundary. No running app shares these fixture files.
        const journalPath = join(
          userDataDir,
          'browser-profile-switches',
          `${operationId}.json`,
        );
        const journal = JSON.parse(await readFile(journalPath, 'utf8'));
        delete journal.result;
        journal.stage =
          stage === 'retired_incarnation' ? 'close_intent' : stage;
        if (stage === 'retired_incarnation') {
          journal.source.profile.taskIncarnationId = randomUUID();
          journal.target.profile.taskIncarnationId =
            journal.source.profile.taskIncarnationId;
        }
        await writeFile(journalPath, JSON.stringify(journal));
        const restartBoundary = boundaryFor('restart');
        const restarted = await launchCanopy({
          userDataDir,
          ...launchOptionsFor(restartBoundary),
        });
        owner = restarted;
        boundary = restartBoundary;
        ({ electronApp } = restarted);
        window = await getMainWindow(electronApp);
        if (stage === 'close_intent' || preparedRestartDiagnosticSelected) {
          restartDiagnostic = createBrowserBoundaryDiagnostic(
            electronApp,
            window,
            preparedRestartDiagnosticSelected
              ? 'prepared-restart-diagnostic-only'
              : 'close-intent-restart-boundary',
          );
          restartDiagnosticIdentity = {
            projectId: 'demo-ts-pnpm-vite',
            worktreeId: 'demo-main',
            browserId: source.id,
          };
          if (preparedRestartDiagnosticSelected && !restartDiagnostic) {
            try {
              console.error(
                'Prepared restart diagnostic unavailable:',
                JSON.stringify({
                  diagnosticOnly: true,
                  acceptanceEligible: false,
                  status: 'unavailable',
                  reason: 'boundary-observer-setup-unavailable',
                }),
              );
            } catch {
              /* Observation must preserve the original test result. */
            }
          }
          if (restartDiagnostic) {
            await restartDiagnostic.arm(restartDiagnosticIdentity);
          }
        }
        app = new CanopyAppDriver(window);
        await app.waitForShell();
        await app.openMainPage();
        await app.selectWorktree('demo-main');
        const expectedProfileId = [
          'target_committed',
          'retired_incarnation',
        ].includes(stage)
          ? target.profileId
          : source.profile.resolvedProfileId;
        let recoveredBrowser;
        await expect
          .poll(async () => {
            recoveredBrowser = (
              await dispatchProfileAction(electronApp, {
                type: 'browser.list',
              })
            ).result.browsers[0];
            return recoveredBrowser?.profile?.resolvedProfileId;
          })
          .toBe(expectedProfileId);
        if (restartDiagnostic && restartDiagnosticIdentity) {
          const recovered = (
            await dispatchProfileAction(electronApp, { type: 'browser.list' })
          ).result.browsers.find((browser) => browser.id === source.id);
          restartDiagnosticIdentity = {
            ...restartDiagnosticIdentity,
            profileId: recovered?.profile?.resolvedProfileId,
            runtimeGeneration: recovered?.profile?.runtimeGeneration,
            storageGeneration: recovered?.profile?.storageGeneration,
          };
          await restartDiagnostic.checkpoint(
            'recovered-profile-selected',
            restartDiagnosticIdentity,
            preparedRestartDiagnosticSelected
              ? { diagnosticOnly: true, acceptanceEligible: false }
              : {},
            { includeRendererLifecycle: true },
          );
        }
        let latestSuppressedCookieError = null;
        try {
          await expect
            .poll(() =>
              fixtureCookies(electronApp, url).catch((error) => {
                if (preparedRestartDiagnosticSelected)
                  latestSuppressedCookieError = boundedCleanupErrorMessage(
                    error,
                  ).slice(0, 512);
                return ['loading'];
              }),
            )
            .toEqual(
              ['target_committed', 'retired_incarnation'].includes(stage)
                ? []
                : ['restart-source'],
            );
        } catch (error) {
          // The product precondition failed before the switch retry. Observe this
          // invocation once; the separately selected diagnostic is not its proof.
          if (stage === 'prepared' && !preparedRestartDiagnosticSelected) {
            let timer;
            try {
              restartDiagnostic = createBrowserBoundaryDiagnostic(
                electronApp,
                window,
                'prepared-restart-precondition',
              );
              if (restartDiagnostic) {
                restartDiagnosticIdentity = {
                  projectId: 'demo-ts-pnpm-vite',
                  worktreeId: 'demo-main',
                  browserId: recoveredBrowser?.id ?? source.id,
                  profileId: recoveredBrowser?.profile?.resolvedProfileId,
                  runtimeGeneration:
                    recoveredBrowser?.profile?.runtimeGeneration,
                  storageGeneration:
                    recoveredBrowser?.profile?.storageGeneration,
                  url,
                };
                const native = await Promise.race([
                  electronApp
                    .evaluate(({ webContents }, fixtureUrl) => {
                      const all = webContents.getAllWebContents();
                      const visited = all.slice(0, 64);
                      let fixtureViewCount = 0;
                      const contents = visited.map((contents) => {
                        const destroyed = contents.isDestroyed();
                        const currentUrl = destroyed ? '' : contents.getURL();
                        const exactFixture = currentUrl === fixtureUrl;
                        if (exactFixture) fixtureViewCount++;
                        return {
                          id: contents.id,
                          type: contents.getType().slice(0, 32),
                          destroyed,
                          urlCategory: exactFixture
                            ? 'exact-fixture'
                            : currentUrl === 'about:blank'
                              ? 'about-blank'
                              : currentUrl.includes('/browser-fixture/')
                                ? 'other-fixture'
                                : 'other',
                        };
                      });
                      return {
                        fixtureViewCount,
                        totalContents: all.length,
                        contents: contents.slice(0, 16),
                        truncated: all.length > 16,
                        countTruncated: all.length > 64,
                      };
                    }, url)
                    .catch(() => ({ status: 'unavailable' })),
                  new Promise((resolve) => {
                    timer = setTimeout(
                      () =>
                        resolve({
                          status: 'unavailable',
                          reason: 'native-snapshot-timeout',
                        }),
                      750,
                    );
                    timer.unref();
                  }),
                ]);
                await restartDiagnostic.checkpoint(
                  'fixture-cookie-poll-failed',
                  restartDiagnosticIdentity,
                  { expectedProfileId, native },
                  { includeRendererLifecycle: true },
                );
                restartDiagnostic.failure(error);
              }
            } catch {
              // The original cookie assertion remains primary even if observation fails.
            } finally {
              clearTimeout(timer);
            }
          } else if (restartDiagnostic && restartDiagnosticIdentity) {
            await restartDiagnostic
              .checkpoint(
                'fixture-cookie-poll-failed',
                restartDiagnosticIdentity,
                preparedRestartDiagnosticSelected
                  ? {
                      diagnosticOnly: true,
                      acceptanceEligible: false,
                      ...(latestSuppressedCookieError
                        ? { suppressedCookieError: latestSuppressedCookieError }
                        : {}),
                    }
                  : {},
                { includeRendererLifecycle: true },
              )
              .catch(() => {});
            restartDiagnostic.failure(error);
          }
          throw error;
        }
        const result = await dispatchProfileAction(electronApp, request);
        expect(result).toMatchObject(
          stage === 'retired_incarnation'
            ? { ok: false, error: { code: 'scope_retired' } }
            : {
                ok: true,
                result: {
                  status:
                    stage === 'target_committed' ? 'complete' : 'cancelled',
                },
              },
        );
      } finally {
        await cleanupInitialNavigationObserver();
        await restartDiagnostic?.close().catch(() => {});
        await runTerminalCleanup(() =>
          boundary
            ? boundary.close(owner)
            : closeCanopy(electronApp, userDataDir),
        );
      }
    },
  );
}

terminalCleanupTest(
  'opens a separate profile tab and replaces only the selected page through the toolbar',
  async ({ runTerminalCleanup }) => {
    // Windows pointer dispatch plus the final native close exceeds the default
    // minute even when every profile and cookie assertion has already passed.
    test.setTimeout(process.platform === 'win32' ? 90_000 : 60_000);
    const boundary = createSelectedLaunchBoundary(
      'toolbar-profile-switch',
      'initial',
      {
        close: closeCanopy,
        owners: [{ projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }],
      },
    );
    const owner = await seedPanelWorktree(boundary.options);
    const { electronApp, window, app } = owner;
    try {
      await window.getByTestId('panel-add-panel-group-terminal').click();
      await window.getByTestId('panel-add-menu-item-browser').click();
      const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one`;
      await window.getByTestId('browser-url-input').fill(url);
      await window.getByTestId('browser-url-input').press('Enter');
      await expect
        .poll(() =>
          fixtureCookies(electronApp, url, 'toolbar-source').catch(() => []),
        )
        .toContain('toolbar-source');
      const original = (
        await dispatchProfileAction(electronApp, { type: 'browser.list' })
      ).result.browsers[0];
      await app.openSettings();
      await app.openSettingsSection('browser');
      await window.getByTestId('browser-profile-new-name').fill('Toolbar Work');
      await window.getByTestId('browser-profile-create').click();
      await expect(window.getByTestId('browser-profile-details')).toBeVisible();
      const named = await window.evaluate(async () =>
        (await window.api.browser.profiles.list()).profiles.find(
          (profile) => profile.kind === 'named',
        ),
      );
      expect(named.agentPermissions.allowEnable).toBe(false);
      await app.closeSettings();
      await app.openMainPage();
      await window.getByTestId('browser-profile-picker').click();
      await window
        .getByTestId('browser-profile-selection')
        .selectOption(named.profileId);
      await window.getByTestId('browser-profile-new-tab').click();
      await expect(window.getByTestId('browser-profile-menu')).toHaveCount(0);
      const list = () =>
        dispatchProfileAction(electronApp, { type: 'browser.list' }).then(
          (result) => result.result.browsers,
        );
      await expect.poll(list).toHaveLength(2);
      const opened = (await list()).find(
        (browser) => browser.id !== original.id,
      );
      expect(opened.profile.resolvedProfileId).toBe(named.profileId);
      expect(
        (await list()).find((browser) => browser.id === original.id).profile,
      ).toEqual(original.profile);
      await expect(
        window.getByTestId('browser-profile-picker').last(),
      ).toContainText('Toolbar Work');
      const cookies = () =>
        electronApp.evaluate(async ({ webContents }, url) => {
          const values = await Promise.all(
            webContents
              .getAllWebContents()
              .filter((contents) => contents.getURL() === url)
              .map((contents) =>
                contents.session.cookies
                  .get({ url })
                  .then((cookies) => cookies.map((cookie) => cookie.name)),
              ),
          );
          return values.sort((left, right) => left.length - right.length);
        }, url);
      await expect.poll(cookies).toEqual([[], ['toolbar-source']]);
      await window.getByTestId('browser-profile-picker').last().click();
      await window
        .getByTestId('browser-profile-selection')
        .selectOption('task');
      await window.getByTestId('browser-profile-replace').click();
      await expect(window.getByTestId('browser-profile-menu')).toHaveCount(0);
      await expect
        .poll(
          async () =>
            (await list()).find((browser) => browser.id === opened.id)?.profile
              ?.resolvedProfileId,
        )
        .toBe(original.profile.resolvedProfileId);
      expect(
        (await list()).find((browser) => browser.id === original.id).profile,
      ).toEqual(original.profile);
      expect(
        (await list()).find((browser) => browser.id === opened.id).profile
          .runtimeGeneration,
      ).toBeGreaterThan(opened.profile.runtimeGeneration);
      await expect
        .poll(cookies)
        .toEqual([['toolbar-source'], ['toolbar-source']]);
    } finally {
      await runTerminalCleanup(() =>
        observeBoundary(
          'toolbar-owner-close',
          () => boundary.close(owner),
          boundary.record,
        ),
      );
    }
  },
);

test('profile data Settings measures lazily, cancels a preview, and resets while retaining permissions', async () => {
  const checkpoint = createWindowsCheckpointRecorder(
    'profile-data-settings-reset',
  );
  checkpoint?.('launch-started');
  const selectionOwner = {};
  let seeded;
  try {
    seeded = await seedPanelWorktree({
      onSelectWorktreeFailure: retainSelectionFailureOwner(selectionOwner),
    });
  } catch (selectionError) {
    await closeProfileSetupFailure({
      selectionOwner,
      attachmentName: 'profile-data-settings-selection-cleanup-failure.json',
    });
    throw selectionError;
  }
  const { electronApp, userDataDir, window, app } = seeded;
  const diagnostic = createOperationDiagnostic(
    electronApp,
    window,
    'profile-data-operation',
  );
  try {
    await app.openSettings();
    await app.openSettingsSection('browser');
    await window.getByTestId('browser-profile-new-name').fill('Data account');
    await window.getByTestId('browser-profile-create').click();
    const details = window.getByTestId('browser-profile-details');
    await expect(details).toBeVisible();
    const original = await window.evaluate(async () =>
      (await window.api.browser.profiles.list()).profiles.find(
        (profile) => profile.displayName === 'Data account',
      ),
    );
    checkpoint?.('profile-created', {
      profileId: original.profileId,
      metadataRevision: original.metadataRevision,
      storageGeneration: original.storageGeneration,
      agentPermissions: original.agentPermissions,
    });
    await expect(
      details.getByTestId('browser-profile-storage-total'),
    ).toContainText('Size not measured');
    await diagnostic.arm(original, false);
    await details.getByTestId('browser-profile-measure').click();
    await expect(details.getByTestId('browser-profile-data-job')).toContainText(
      'Complete',
    );
    await expect(
      details.getByTestId('browser-profile-storage-total'),
    ).toContainText('Approximately');
    checkpoint?.('measurement-completed', {
      profileId: original.profileId,
      storageGeneration: original.storageGeneration,
      measurementStatus: 'complete',
    });
    await details.getByTestId('browser-profile-reset').click();
    await expect(
      window.getByTestId('browser-profile-clear-preview'),
    ).toContainText('Affects 0 saved tabs');
    await window.getByTestId('browser-profile-clear-preview').press('Escape');
    await expect(
      window.getByTestId('browser-profile-clear-preview'),
    ).toHaveCount(0);
    expect(
      await window.evaluate(
        (id) => window.api.browser.profiles.get({ profileId: id }),
        original.profileId,
      ),
    ).toMatchObject({ storageGeneration: original.storageGeneration });
    checkpoint?.('preview-cancelled', {
      profileId: original.profileId,
      storageGeneration: original.storageGeneration,
    });
    await details.getByTestId('browser-profile-reset').click();
    checkpoint?.('second-confirm-about-to-click', {
      profileId: original.profileId,
      storageGeneration: original.storageGeneration,
    });
    await window.getByTestId('browser-profile-confirm-clear').click();
    checkpoint?.('confirmation-completed', {
      profileId: original.profileId,
      storageGeneration: original.storageGeneration,
    });
    await expect
      .poll(() =>
        window.evaluate(
          (id) => window.api.browser.profiles.get({ profileId: id }),
          original.profileId,
        ),
      )
      .toMatchObject({
        profileId: original.profileId,
        storageGeneration: original.storageGeneration + 1,
        displayName: 'Data account',
        agentPermissions: { allowEnable: false, allowClear: false },
      });
    checkpoint?.('final-profile-assertions-completed', {
      profileId: original.profileId,
      storageGeneration: original.storageGeneration + 1,
      displayName: 'Data account',
      agentPermissions: { allowEnable: false, allowClear: false },
    });
    await expect
      .poll(() =>
        window.evaluate(
          async (id) =>
            (
              await window.api.browser.profiles.jobList({ profileId: id })
            ).jobs.find((job) => job.kind === 'reset')?.status,
          original.profileId,
        ),
      )
      .toBe('complete');
    checkpoint?.('final-job-assertion-completed', {
      profileId: original.profileId,
      storageGeneration: original.storageGeneration + 1,
      resetJobStatus: 'complete',
    });
  } catch (error) {
    diagnostic.failure(error);
    throw error;
  } finally {
    await diagnostic.capture();
    await diagnostic.close(userDataDir);
  }
});

test('shared-profile clearing enforces both agent routes, stops writers, and preserves another account', async () => {
  test.setTimeout(120_000);
  const boundary = selectedWindowsBoundary('shared-profile-clear');
  const workerBoundary = createSelectedWorkerBoundary(
    boundary,
    'shared-profile-clear',
  );
  let server, origin;
  try {
    const { createServer } = await import('node:http');
    const worker = `self.addEventListener('install', () => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(clients.claim())); self.addEventListener('message', e => e.waitUntil((async () => { let i=0; while(true) { const c=await caches.open('writer'); await c.put('/value',new Response(String(++i))); await new Promise(r=>setTimeout(r,10)); } })()));`;
    server = createServer((request, response) => {
      response.setHeader(
        'Content-Type',
        request.url === '/worker.js' ? 'application/javascript' : 'text/html',
      );
      response.end(
        request.url === '/worker.js'
          ? worker
          : '<!doctype html><title>Clear fixture</title><input aria-label="Typing probe">',
      );
    });
    await observeSelectedWorkerBoundary(
      workerBoundary,
      'server-listen',
      () => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)),
    );
    origin = `http://127.0.0.1:${server.address().port}`;
  } catch (error) {
    workerBoundary?.release();
    throw error;
  }
  let electronApp, userDataDir, window, app;
  let primaryError;
  let cleanupError;
  const selectionOwner = {};
  const selectionDiagnostic = createWorktreeSelectionFailureDiagnostic(
    'shared-profile-clear-selection',
  );
  let restoreBarrierProfileId;
  const restoreBarrier = (kind) =>
    electronApp.evaluate(
      (_electron, input) => {
        const control = globalThis.__CANOPY_E2E_BROWSER_RESTORE_BARRIER__;
        if (typeof control !== 'function')
          throw new Error('Browser restoration fixture is unavailable.');
        return control(input);
      },
      { kind, profileId: restoreBarrierProfileId },
    );
  try {
    ({ electronApp, userDataDir, window, app } =
      await observeSelectedWorkerBoundary(workerBoundary, 'panel-seed', () =>
        seedPanelWorktree({
          onSelectWorktreeFailure: retainSelectionFailureOwner(
            selectionOwner,
            selectionDiagnostic,
          ),
        }),
      ));
    await observeSelectedWorkerBoundary(workerBoundary, 'initial-close', () =>
      closeCanopy(electronApp, userDataDir, {
        keepUserData: true,
        ...(boundary ? { boundaryRecord: boundary.record } : {}),
      }),
    );
    const { seedBrowserProfileEntryOwners } =
      await import('./seeders/browser-profile-state.mjs');
    const [coworkOwner] = await observeSelectedWorkerBoundary(
      workerBoundary,
      'entry-owner-seed',
      () => seedBrowserProfileEntryOwners(userDataDir),
    );
    ({ electronApp } = await observeSelectedWorkerBoundary(
      workerBoundary,
      'second-launch',
      () =>
        launchCanopy({
          userDataDir,
          ...(boundary ? { boundaryRecord: boundary.record } : {}),
        }),
    ));
    window = await getMainWindow(electronApp);
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await observeSelectedWorkerBoundary(
      workerBoundary,
      'settings-browser-ready',
      () => app.openSettingsSection('browser'),
    );
    const makeProfile = async (name) => {
      await window.getByTestId('browser-profile-new-name').fill(name);
      await window.getByTestId('browser-profile-create').click();
      await expect(window.getByTestId('browser-profile-new-name')).toHaveValue(
        '',
      );
      return window.evaluate(
        async (name) =>
          (await window.api.browser.profiles.list()).profiles.find(
            (profile) => profile.displayName === name,
          ),
        name,
      );
    };
    const a = await makeProfile('Clear account'),
      b = await makeProfile('Keep account');
    const tabs = [];
    for (const [suffix, profile] of [
      ['a1', a],
      ['a2', a],
      ['b', b],
    ])
      tabs.push(
        await window.evaluate((request) => window.api.browser.create(request), {
          ...(suffix === 'a2'
            ? coworkOwner
            : { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }),
          url: `${origin}/?tab=${suffix}`,
          selection: { kind: 'named', profileId: profile.profileId },
        }),
      );
    await observeSelectedWorkerBoundary(workerBoundary, 'writer-setup', () =>
      electronApp.evaluate(async ({ webContents }, origin) => {
        for (const suffix of ['a1', 'b']) {
          const contents = webContents
            .getAllWebContents()
            .find(
              (contents) => contents.getURL() === `${origin}/?tab=${suffix}`,
            );
          if (!contents) throw new Error('Missing writer tab');
          await contents.session.cookies.set({
            url: origin,
            name: 'account',
            value: suffix,
            expirationDate: Math.floor(Date.now() / 1000) + 3600,
          });
          await contents.executeJavaScript(`(async () => {
          await navigator.serviceWorker.register('/worker.js'); await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, {once:true}));
          navigator.serviceWorker.controller.postMessage('write'); let i=0; localStorage.setItem('writer','0'); setInterval(()=>localStorage.setItem('writer', String(++i)),10);
          const root=await navigator.storage.getDirectory(); const handle=await root.getFileHandle('owned',{create:true}); const file=await handle.createWritable(); await file.write('synthetic'); await file.close();
          await new Promise((resolve,reject)=>{const r=indexedDB.open('account',1);r.onupgradeneeded=()=>r.result.createObjectStore('values');r.onsuccess=()=>{r.result.close();resolve();};r.onerror=reject;});
        })()`);
        }
      }, origin),
    );
    const read = (suffix) =>
      electronApp.evaluate(
        async ({ webContents }, { origin, suffix }) => {
          const contents = webContents
            .getAllWebContents()
            .find(
              (contents) => contents.getURL() === `${origin}/?tab=${suffix}`,
            );
          if (!contents) return null;
          return {
            cookies: (await contents.session.cookies.get({ url: origin })).map(
              (cookie) => cookie.name,
            ),
            ...(await contents.executeJavaScript(
              `(async()=>{const root=await navigator.storage.getDirectory();let files=0;for await(const h of root.values())files++;return {local:localStorage.getItem('writer'),databases:(await indexedDB.databases()).length,caches:(await caches.keys()).length,workers:(await navigator.serviceWorker.getRegistrations()).length,files};})()`,
            )),
          };
        },
        { origin, suffix },
      );
    await expect
      .poll(async () => Number((await read('a1'))?.local))
      .toBeGreaterThan(1);
    const request = {
      type: 'browser.profile.preview_clear',
      profileId: a.profileId,
      storageGeneration: a.storageGeneration,
      metadataRevision: a.metadataRevision,
      operation: { kind: 'site', origin },
    };
    for (const route of ['scoped', 'app-advisor'])
      expect(
        await dispatchProfileAction(electronApp, request, route),
      ).toMatchObject({ ok: false, error: { code: 'agent_clear_denied' } });
    await window.getByTestId(`browser-profile-row-${a.profileId}`).click();
    const clearPermission = window
      .getByTestId('browser-profile-details')
      .getByRole('switch', {
        name: 'Allow agents to clear this profile',
        exact: true,
      });
    const fresh = () =>
      window.evaluate(
        (id) => window.api.browser.profiles.get({ profileId: id }),
        a.profileId,
      );
    await clearPermission.click();
    await expect(clearPermission).toHaveAttribute('aria-checked', 'true');
    let current = await fresh();
    const stale = await dispatchProfileAction(electronApp, {
      ...request,
      metadataRevision: current.metadataRevision,
    });
    if (!stale.ok)
      console.log(
        'profile-observation-diagnostic',
        JSON.stringify({
          console: await window.evaluate(
            (id) => window.api.browser.getConsole({ browserId: id }),
            tabs[0].id,
          ),
          native: await electronApp.evaluate(
            async ({ webContents }, origin) =>
              Promise.all(
                webContents
                  .getAllWebContents()
                  .filter((c) => c.getURL().startsWith(origin))
                  .map(async (c) => ({
                    id: c.id,
                    url: c.getURL(),
                    attached: c.debugger.isAttached(),
                    frame: await c.debugger.sendCommand('Page.getFrameTree'),
                  })),
              ),
            origin,
          ),
        }),
      );

    expect(
      stale,
      JSON.stringify({
        response: stale,
        inventory: await window.evaluate(
          (profile) =>
            window.api.browser.profiles.inventoryGet({
              profileId: profile.profileId,
              storageGeneration: profile.storageGeneration,
            }),
          a,
        ),
      }),
    ).toMatchObject({ ok: true });
    await clearPermission.click();
    await expect(clearPermission).toHaveAttribute('aria-checked', 'false');
    expect(
      await dispatchProfileAction(electronApp, {
        type: 'browser.profile.clear',
        operationId: randomUUID(),
        token: stale.result.token,
      }),
    ).toMatchObject({ ok: false, error: { code: 'stale_revision' } });
    expect((await read('a1')).cookies).toContain('account');
    await clearPermission.click();
    await expect(clearPermission).toHaveAttribute('aria-checked', 'true');
    current = await fresh();
    const preview = await dispatchProfileAction(
      electronApp,
      { ...request, metadataRevision: current.metadataRevision },
      'app-advisor',
    );
    expect(preview, JSON.stringify(preview)).toMatchObject({ ok: true });
    expect(preview.result.tabs).toHaveLength(2);
    expect(new Set(preview.result.tabs.map((tab) => tab.projectId)).size).toBe(
      2,
    );
    restoreBarrierProfileId = a.profileId;
    expect(await restoreBarrier('arm')).toEqual({
      armed: true,
      entered: false,
    });
    const operationId = randomUUID();
    const submitted = await dispatchProfileAction(
      electronApp,
      {
        type: 'browser.profile.clear',
        operationId,
        token: preview.result.token,
      },
      'app-advisor',
    );
    expect(submitted.ok).toBe(true);
    await observeSelectedWorkerBoundary(workerBoundary, 'maintenance-job', () =>
      expect
        .poll(
          async () => {
            const response = await dispatchProfileAction(
              electronApp,
              { type: 'browser.profile.job_get', jobId: operationId },
              'app-advisor',
            );
            if (!response.ok || response.result.status === 'failed')
              throw new Error(JSON.stringify(response));
            return response.result.status;
          },
          { timeout: 30000 },
        )
        .toBe('complete'),
    );
    // A durable receipt precedes restoration. Hold the actual restore promise
    // through this UI action so slower pointer delivery cannot miss the fence.
    await expect
      .poll(() => restoreBarrier('status'))
      .toEqual({
        armed: true,
        entered: true,
      });
    try {
      await window.getByTestId('browser-profile-clear-cache').click();
      await expect(
        window.getByTestId('browser-profile-data').getByRole('alert'),
      ).toContainText('pending maintenance');
      await expect(
        window.getByTestId('browser-profile-clear-preview'),
      ).toHaveCount(0);
    } finally {
      await restoreBarrier('release');
      restoreBarrierProfileId = undefined;
    }
    if (workerBoundary) {
      await workerBoundary.observe('final-storage-assertions', async () => {
        await expect
          .poll(() => read('a1'))
          .toEqual({
            cookies: [],
            local: null,
            databases: 0,
            caches: 0,
            workers: 0,
            files: 0,
          });
        await expect
          .poll(() => read('a2'))
          .toEqual({
            cookies: [],
            local: null,
            databases: 0,
            caches: 0,
            workers: 0,
            files: 0,
          });
        const retained = await read('b');
        expect(retained.cookies).toContain('account');
        expect(retained.databases).toBe(1);
        expect(retained.files).toBe(1);
        await expect
          .poll(async () => Number((await read('b'))?.local))
          .toBeGreaterThan(Number(retained.local));
      });
    } else {
      await expect
        .poll(() => read('a1'))
        .toEqual({
          cookies: [],
          local: null,
          databases: 0,
          caches: 0,
          workers: 0,
          files: 0,
        });
      await expect
        .poll(() => read('a2'))
        .toEqual({
          cookies: [],
          local: null,
          databases: 0,
          caches: 0,
          workers: 0,
          files: 0,
        });
      const retained = await read('b');
      expect(retained.cookies).toContain('account');
      expect(retained.databases).toBe(1);
      expect(retained.files).toBe(1);
      await expect
        .poll(async () => Number((await read('b'))?.local))
        .toBeGreaterThan(Number(retained.local));
    }
    const replay = await dispatchProfileAction(electronApp, {
      type: 'browser.profile.clear',
      operationId,
      token: preview.result.token,
    });
    expect(replay).toMatchObject({ ok: true, result: { status: 'complete' } });
    expect((await fresh()).agentPermissions).toEqual({
      allowEnable: false,
      allowClear: true,
    });
  } catch (error) {
    primaryError = error;
    boundary?.record?.('worker-case-body-rejected', {
      slug: 'shared-profile-clear',
      message: boundedCleanupErrorMessage(error),
    });
  } finally {
    try {
      // Only selection failure exposes these handles through the existing hook.
      electronApp ??= selectionOwner.electronApp;
      userDataDir ??= selectionOwner.userDataDir;
      const retainCleanupError = (error) => {
        if (primaryError || cleanupError)
          console.error('Shared-profile fixture cleanup failed:', error);
        else cleanupError = error;
      };
      try {
        if (restoreBarrierProfileId) await restoreBarrier('release');
      } catch (error) {
        retainCleanupError(error);
      } finally {
        try {
          if (electronApp && userDataDir)
            await (boundary
              ? closeCanopy(electronApp, userDataDir, {
                  boundaryRecord: boundary.record,
                })
              : closeCanopy(electronApp, userDataDir));
        } catch (error) {
          retainCleanupError(error);
        } finally {
          try {
            server.closeAllConnections();
            await new Promise((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            );
          } catch (error) {
            retainCleanupError(error);
          }
        }
      }
    } finally {
      workerBoundary?.release();
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
});

terminalCleanupTest(
  'a cache-clear intent recovers before cold browser admission and retains storage and newer permissions',
  async ({ runTerminalCleanup }) => {
    test.setTimeout(120000);
    const boundary = selectedWindowsBoundary('cache-clear-recovery');
    let { electronApp, userDataDir, window, app } = await seedPanelWorktree();
    try {
      await app.openSettings();
      await app.openSettingsSection('browser');
      await window
        .getByTestId('browser-profile-new-name')
        .fill('Recovered data account');
      await window.getByTestId('browser-profile-create').click();
      await expect(window.getByTestId('browser-profile-details')).toBeVisible();
      const profile = await window.evaluate(async () =>
        (await window.api.browser.profiles.list()).profiles.find(
          (profile) => profile.displayName === 'Recovered data account',
        ),
      );
      const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?profile=clear-recovery`;
      const tab = await window.evaluate(
        (request) => window.api.browser.create(request),
        {
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          selection: { kind: 'named', profileId: profile.profileId },
          url,
        },
      );
      await expect
        .poll(() =>
          fixtureCookies(electronApp, url).then(
            () => true,
            () => false,
          ),
        )
        .toBe(true);
      await electronApp.evaluate(async ({ webContents }, url) => {
        const contents = webContents
          .getAllWebContents()
          .find((contents) => contents.getURL() === url);
        if (!contents) throw new Error('Missing recovery fixture');
        await contents.executeJavaScript(
          "localStorage.setItem('retained', 'synthetic')",
        );
        const native = contents.session,
          clear = native.clearCache.bind(native);
        // Inject a lost completion after the real native operation has run. The
        // durable irreversible intent must keep admission fenced across restart.
        native.clearCache = async () => {
          await clear();
          throw new Error('Injected lost native completion');
        };
      }, url);
      const preview = await window.evaluate(
        (profile) =>
          window.api.browser.profiles.previewClear({
            profileId: profile.profileId,
            storageGeneration: profile.storageGeneration,
            metadataRevision: profile.metadataRevision,
            operation: { kind: 'cache' },
          }),
        profile,
      );
      const operationId = randomUUID();
      await window.evaluate(
        (request) => window.api.browser.profiles.clear(request),
        { operationId, token: preview.token },
      );
      await expect
        .poll(() =>
          window.evaluate(
            (jobId) => window.api.browser.profiles.jobGet({ jobId }),
            operationId,
          ),
        )
        .toMatchObject({
          status: 'failed',
          retryable: true,
          cancellable: false,
        });
      const denied = await dispatchProfileAction(electronApp, {
        type: 'browser.open',
        browserId: tab.id,
        expectedRuntimeGeneration: tab.profile.runtimeGeneration,
      });
      expect(denied).toMatchObject({
        ok: false,
        error: { code: 'operation_conflict' },
      });
      await window.evaluate(
        (profile) =>
          window.api.browser.profiles.update({
            operationId: crypto.randomUUID(),
            profileId: profile.profileId,
            expectedMetadataRevision: profile.metadataRevision,
            patch: { color: '#345678', allowClear: false },
          }),
        profile,
      );
      await closeCanopy(electronApp, userDataDir, {
        keepUserData: true,
        ...(boundary ? { boundaryRecord: boundary.record } : {}),
      });
      ({ electronApp } = await launchCanopy({
        userDataDir,
        ...(boundary ? { boundaryRecord: boundary.record } : {}),
      }));
      window = await getMainWindow(electronApp);
      app = new CanopyAppDriver(window);
      await app.waitForShell();
      await expect
        .poll(() =>
          window.evaluate(
            (jobId) => window.api.browser.profiles.jobGet({ jobId }),
            operationId,
          ),
        )
        .toMatchObject({ status: 'complete', cancellable: false });
      const current = await window.evaluate(
        (profileId) => window.api.browser.profiles.get({ profileId }),
        profile.profileId,
      );
      expect(current).toMatchObject({
        color: '#345678',
        storageGeneration: profile.storageGeneration,
        agentPermissions: { allowEnable: false, allowClear: false },
      });
      const currentTab = (
        await dispatchProfileAction(electronApp, { type: 'browser.list' })
      ).result.browsers.find((entry) => entry.id === tab.id);
      expect(currentTab).toBeTruthy();
      const opened = await dispatchProfileAction(electronApp, {
        type: 'browser.open',
        browserId: tab.id,
        expectedRuntimeGeneration: currentTab.profile.runtimeGeneration,
      });
      expect(opened, JSON.stringify(opened)).toMatchObject({ ok: true });
      await expect
        .poll(() =>
          electronApp.evaluate(async ({ webContents }, url) => {
            const contents = webContents
              .getAllWebContents()
              .find((contents) => contents.getURL() === url);
            return contents
              ? contents.executeJavaScript("localStorage.getItem('retained')")
              : null;
          }, url),
        )
        .toBe('synthetic');
      const replay = await window.evaluate(
        (request) => window.api.browser.profiles.clear(request),
        { operationId, token: preview.token },
      );
      expect(replay.status).toBe('complete');
    } finally {
      await runTerminalCleanup(() =>
        boundary
          ? closeCanopy(electronApp, userDataDir, {
              boundaryRecord: boundary.record,
            })
          : closeCanopy(electronApp, userDataDir),
      );
    }
  },
);

test('loaded Task reset survives one queued-to-running metadata rename denial', async () => {
  test.setTimeout(120000);
  const { electronApp, userDataDir, window, app } = await seedPanelWorktree();
  const injectionId = randomUUID();
  let primaryError;
  const cleanupErrors = [];
  try {
    const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?task-reset=metadata-rename`;
    const tab = await window.evaluate(
      (request) => window.api.browser.create(request),
      { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main', url },
    );
    await expect
      .poll(() =>
        fixtureCookies(electronApp, url).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((entry) => entry.getURL() === url);
      if (!contents) throw new Error('Missing loaded Task rename fixture');
      await contents.session.cookies.set({
        url,
        name: 'task-reset',
        value: 'synthetic',
      });
      await contents.executeJavaScript(
        "localStorage.setItem('task-reset', 'synthetic')",
      );
      globalThis.__taskRenameOriginalSession = contents.session;
    }, url);
    const original = await window.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      tab.profile.resolvedProfileId,
    );
    expect(original.kind).toBe('task');
    await app.openSettings();
    await app.openSettingsSection('browser');
    await window
      .getByTestId(`browser-profile-row-${original.profileId}`)
      .click();
    const details = window.getByTestId('browser-profile-details');
    const clear = details.getByRole('switch', {
      name: 'Allow agents to clear this profile',
      exact: true,
    });
    await expect(clear).toHaveAttribute('aria-checked', 'false');
    await clear.click();
    await expect(clear).toHaveAttribute('aria-checked', 'true');
    const permitted = await window.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      original.profileId,
    );
    await details.getByTestId('browser-profile-reset').click();
    await expect(
      window.getByTestId('browser-profile-clear-preview'),
    ).toContainText('Affects 1 saved tab.');

    // Intercept the actual Electron Node filesystem call, below job APIs and
    // storage. Only this profile's first complete queued -> running reset
    // receipt qualifies. Restore the original binding before throwing, and
    // again in finally if the storage call was never reached.
    const installed = await electronApp.evaluate(
      ({ app }, selection) => {
        const fs = process.getBuiltinModule('node:fs/promises');
        const paths = process.getBuiltinModule('node:path');
        const { syncBuiltinESMExports } =
          process.getBuiltinModule('node:module');
        const root = paths.join(
          app.getPath('userData'),
          'browser-data-jobs',
          'records',
        );
        if (
          paths.resolve(app.getPath('userData')) !==
          paths.resolve(selection.userDataDir)
        )
          throw new Error('Rename injection userData identity mismatch');
        if (globalThis.__taskMetadataRenameInjection)
          throw new Error('Rename injection already installed');
        const originalRename = fs.rename;
        const state = {
          injectionId: selection.injectionId,
          hits: 0,
          restored: false,
          record: null,
        };
        const restore = () => {
          fs.rename = originalRename;
          syncBuiltinESMExports();
          state.restored = fs.rename === originalRename;
        };
        const replacement = async (source, destination) => {
          if (
            typeof source === 'string' &&
            typeof destination === 'string' &&
            paths.dirname(destination) === root &&
            source.startsWith(`${destination}.${process.pid}.`) &&
            source.endsWith('.tmp')
          ) {
            const next = JSON.parse(await fs.readFile(source, 'utf8'));
            if (
              next.job?.profileId === selection.profileId &&
              next.job?.kind === 'reset' &&
              next.job?.storageGeneration === selection.storageGeneration &&
              next.job?.status === 'running' &&
              destination === paths.join(root, `${next.job.jobId}.json`)
            ) {
              const previous = JSON.parse(
                await fs.readFile(destination, 'utf8'),
              );
              if (
                previous.job?.jobId !== next.job.jobId ||
                previous.job?.status !== 'queued'
              )
                throw new Error(
                  'Rename injection did not observe the queued receipt',
                );
              state.hits += 1;
              state.record = {
                source,
                destination,
                jobId: next.job.jobId,
                profileId: next.job.profileId,
                storageGeneration: next.job.storageGeneration,
                previousStatus: previous.job.status,
                nextStatus: next.job.status,
                code: 'EPERM',
              };
              restore();
              throw Object.assign(
                new Error(
                  'Injected queued-to-running profile metadata rename denial',
                ),
                {
                  code: 'EPERM',
                  syscall: 'rename',
                  path: source,
                  dest: destination,
                },
              );
            }
          }
          return originalRename(source, destination);
        };
        globalThis.__taskMetadataRenameInjection = {
          state,
          restore,
          snapshot: () => ({
            ...state,
            bindingRestored: fs.rename === originalRename,
          }),
        };
        fs.rename = replacement;
        syncBuiltinESMExports();
        return {
          injectionId: state.injectionId,
          installed: fs.rename === replacement,
          root,
        };
      },
      {
        injectionId,
        userDataDir,
        profileId: original.profileId,
        storageGeneration: original.storageGeneration,
      },
    );
    expect(installed).toMatchObject({
      injectionId,
      installed: true,
      root: path.join(userDataDir, 'browser-data-jobs', 'records'),
    });

    await window.getByTestId('browser-profile-confirm-clear').click();
    let terminalJob;
    await expect
      .poll(
        async () => {
          const jobs = await window.evaluate(
            async (profileId) =>
              (
                await window.api.browser.profiles.jobList({ profileId })
              ).jobs.filter((job) => job.kind === 'reset'),
            original.profileId,
          );
          expect(jobs.length).toBeLessThanOrEqual(1);
          terminalJob = jobs[0];
          return terminalJob?.status;
        },
        { timeout: 30000 },
      )
      .toMatch(/^(complete|failed)$/);
    const injection = await electronApp.evaluate(() =>
      globalThis.__taskMetadataRenameInjection.snapshot(),
    );
    await test.info().attach('profile-metadata-rename-injection.json', {
      body: Buffer.from(
        JSON.stringify({ installed, injection, terminalJob }, null, 2),
      ),
      contentType: 'application/json',
    });
    expect(injection).toMatchObject({
      injectionId,
      hits: 1,
      restored: true,
      bindingRestored: true,
      record: {
        jobId: terminalJob.jobId,
        profileId: original.profileId,
        storageGeneration: original.storageGeneration,
        previousStatus: 'queued',
        nextStatus: 'running',
        code: 'EPERM',
        destination: path.join(
          userDataDir,
          'browser-data-jobs',
          'records',
          `${terminalJob.jobId}.json`,
        ),
      },
    });
    // RED must be this terminal receipt assertion, after one-hit identity and
    // restoration are proven; a fixture/selector/injection failure is distinct.
    expect(
      terminalJob,
      JSON.stringify({ injection, terminalJob }),
    ).toMatchObject({ status: 'complete', retryable: false });
    await expect(details.getByTestId('browser-profile-reset')).toBeEnabled();
    const changed = await window.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      original.profileId,
    );
    expect(changed).toMatchObject({
      profileId: original.profileId,
      kind: 'task',
      owner: original.owner,
      storageGeneration: original.storageGeneration + 1,
      agentPermissions: permitted.agentPermissions,
    });
    expect(changed.owner.taskIncarnationId).toBeTruthy();
    expect(changed.agentPermissions).toEqual({
      allowEnable: true,
      allowClear: true,
    });
    await expect
      .poll(() =>
        electronApp.evaluate(async ({ webContents }, url) => {
          const contents = webContents
            .getAllWebContents()
            .find((entry) => entry.getURL() === url);
          if (!contents) return null;
          return {
            differentSession:
              contents.session !== globalThis.__taskRenameOriginalSession,
            cookies: (
              await contents.session.cookies.get({ url, name: 'task-reset' })
            ).length,
            stored: await contents.executeJavaScript(
              "localStorage.getItem('task-reset')",
            ),
          };
        }, url),
      )
      .toEqual({ differentSession: true, cookies: 0, stored: null });
  } catch (error) {
    primaryError = error;
    try {
      await test.info().attach('profile-metadata-rename-primary-error.json', {
        body: Buffer.from(
          JSON.stringify({
            phase: 'primary',
            injectionId,
            message: boundedCleanupErrorMessage(error),
          }),
        ),
        contentType: 'application/json',
      });
    } catch {
      // Evidence failure must not replace the original assertion error.
    }
  } finally {
    try {
      await electronApp.evaluate(() => {
        const injection = globalThis.__taskMetadataRenameInjection;
        injection?.restore();
        if (injection && !injection.snapshot().bindingRestored)
          throw new Error('Original filesystem rename was not restored');
        delete globalThis.__taskMetadataRenameInjection;
        delete globalThis.__taskRenameOriginalSession;
      });
    } catch (error) {
      cleanupErrors.push({
        phase: 'restore-rename',
        message: boundedCleanupErrorMessage(error),
      });
    }
    try {
      await closeCanopy(electronApp, userDataDir);
    } catch (error) {
      cleanupErrors.push({
        phase: 'close',
        message: boundedCleanupErrorMessage(error),
      });
    }
    if (cleanupErrors.length) {
      await test
        .info()
        .attach('profile-metadata-rename-cleanup-errors.json', {
          body: Buffer.from(JSON.stringify(cleanupErrors)),
          contentType: 'application/json',
        })
        .catch(() => {});
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length) throw new Error(JSON.stringify(cleanupErrors));
});

async function runLoadedTaskResetOwnerCase({ slug, entryIndex }) {
  const observeSetupClose =
    slug !== 'advisor' ||
    process.env.CANOPY_WINDOWS_ADVISOR_SETUP_CLOSE_DIAGNOSTIC === '1';
  const setupBoundary = observeSetupClose
    ? createSelectedLaunchBoundary(`loaded-task-reset-${slug}`, 'setup', {
        close: closeCanopy,
        owners: [{ projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }],
      })
    : null;
  const setupOwner =
    slug === 'worktree'
      ? await seedPanelWorktree({
          ...setupBoundary.options,
          onSetupFailure: (context) =>
            reportOwnedSetupFailure(context, context.error, {
              capture: createWorktreeSelectionFailureDiagnostic(
                'loaded-task-reset-worktree-selection',
              ),
              close: () => setupBoundary.close(context),
              record: setupBoundary.record,
            }),
        })
      : setupBoundary
        ? await seedPanelWorktree(setupBoundary.options)
        : await seedPanelWorktree();
  let { electronApp, userDataDir, window, app } = setupOwner;
  const { seedBrowserProfileEntryOwners } =
    await import('./seeders/browser-profile-state.mjs');
  const boundary = selectedWindowsBoundary(`loaded-task-reset-${slug}`);
  let owner;
  try {
    if (setupBoundary)
      await setupBoundary.close(setupOwner, {
        keepUserData: true,
      });
    else
      await closeCanopy(setupOwner.electronApp, setupOwner.userDataDir, {
        keepUserData: true,
      });
    const entryOwners = await seedBrowserProfileEntryOwners(userDataDir);
    owner =
      entryIndex === null
        ? { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }
        : entryOwners[entryIndex];
    ({ electronApp } = await launchCanopy({
      userDataDir,
      ...(boundary ? { boundaryRecord: boundary.record } : {}),
      ...(boundary
        ? {
            env: {
              CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS: JSON.stringify({
                file: path.resolve(`${boundary.base}-main.jsonl`),
                mode: 'loaded-task',
                owners: [owner],
              }),
            },
          }
        : {}),
    }));
    window = await getMainWindow(electronApp);
    app = new CanopyAppDriver(window);
    await app.waitForShell();
    await app.openSettings();
    await app.openSettingsSection('browser');
    let exactUrlObserved = false;
    const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?task-reset=${slug}`;
    boundary?.record?.('initial-create-entered', { owner, slug });
    const tab = await window.evaluate(
      (request) => window.api.browser.create(request),
      { ...owner, url },
    );
    boundary?.record?.('initial-create-fulfilled', { owner, slug });
    await expect
      .poll(() =>
        fixtureCookies(electronApp, url).then(
          () => true,
          () => false,
        ),
      )
      .toBe(true);
    await electronApp.evaluate(async ({ webContents }, url) => {
      const contents = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL() === url);
      await contents.session.cookies.set({
        url,
        name: 'task-reset',
        value: 'synthetic',
        expirationDate: Math.floor(Date.now() / 1000) + 3600,
      });
      await contents.executeJavaScript(
        "localStorage.setItem('task-reset', 'synthetic')",
      );
      globalThis.__taskResetOriginalSession = contents.session;
    }, url);
    const profile = await window.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      tab.profile.resolvedProfileId,
    );
    const permitted = await window.evaluate(
      (profile) =>
        window.api.browser.profiles.update({
          operationId: crypto.randomUUID(),
          profileId: profile.profileId,
          expectedMetadataRevision: profile.metadataRevision,
          patch: { allowClear: true },
        }),
      profile,
    );
    const preview = await window.evaluate(
      (profile) =>
        window.api.browser.profiles.previewClear({
          profileId: profile.profileId,
          storageGeneration: profile.storageGeneration,
          metadataRevision: profile.metadataRevision,
          operation: { kind: 'reset' },
        }),
      permitted,
    );
    expect(preview.tabs.some((entry) => entry.browserId === tab.id)).toBe(true);
    const operationId = randomUUID();
    await window.evaluate(
      (request) => window.api.browser.profiles.clear(request),
      { operationId, token: preview.token },
    );
    await expect
      .poll(
        async () => {
          const job = await window.evaluate(
            (jobId) => window.api.browser.profiles.jobGet({ jobId }),
            operationId,
          );
          boundary?.record?.('job-status', {
            owner,
            slug,
            status: job.status,
            jobId: operationId,
          });
          if (job.status === 'failed') throw new Error(JSON.stringify(job));
          return job.status;
        },
        { timeout: 30000 },
      )
      .toBe('complete');
    const changed = await window.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      profile.profileId,
    );
    expect(changed).toMatchObject({
      profileId: profile.profileId,
      kind: 'task',
      storageGeneration: profile.storageGeneration + 1,
      owner: profile.owner,
      agentPermissions: { allowEnable: true, allowClear: true },
    });
    await expect
      .poll(() =>
        electronApp
          .evaluate(async ({ webContents }, url) => {
            const contents = webContents
              .getAllWebContents()
              .find((contents) => contents.getURL() === url);
            if (!contents) return null;
            return {
              differentSession:
                contents.session !== globalThis.__taskResetOriginalSession,
              cookies: (
                await contents.session.cookies.get({
                  url,
                  name: 'task-reset',
                })
              ).length,
              stored: await contents.executeJavaScript(
                "localStorage.getItem('task-reset')",
              ),
            };
          }, url)
          .then((value) => {
            boundary?.record?.('exact-url-poll', {
              owner,
              slug,
              found: value !== null,
              firstSuccessfulObservation: value !== null && !exactUrlObserved,
            });
            if (value !== null) exactUrlObserved = true;
            return value;
          }),
      )
      .toEqual({ differentSession: true, cookies: 0, stored: null });
    const replay = await window.evaluate(
      (request) => window.api.browser.profiles.clear(request),
      { operationId, token: preview.token },
    );
    expect(replay.status).toBe('complete');
    const cleanup = await window.evaluate(() =>
      window.api.browser.profiles.cleanupStatus(),
    );
    expect(
      cleanup.jobs.some(
        (job) =>
          job.profileId === profile.profileId &&
          job.storageGeneration === profile.storageGeneration &&
          job.status === 'pending_restart',
      ),
    ).toBe(true);
  } catch (error) {
    boundary?.record?.('case-body-rejected', {
      owner,
      slug,
      message: boundedCleanupErrorMessage(error),
    });
    throw error;
  } finally {
    if (boundary) {
      await closeCanopy(electronApp, userDataDir, {
        boundaryRecord: boundary.record,
      });
    } else {
      await closeCanopy(electronApp, userDataDir);
    }
  }
}

for (const ownerCase of [
  { slug: 'worktree', entryIndex: null },
  { slug: 'cowork', entryIndex: 0 },
  { slug: 'advisor', entryIndex: 1 },
]) {
  test(`loaded Task reset ${ownerCase.slug} retains its owner incarnation and permissions while replacing storage`, async () => {
    test.setTimeout(120000);
    await runLoadedTaskResetOwnerCase(ownerCase);
  });
}

largeInventoryTest(
  'large native inventory cancels without publication and measures again without blocking Settings',
  async ({ largeInventory }) => {
    test.setTimeout(120000);
    const boundary = createSelectedLaunchBoundary(
      'large-inventory',
      'initial',
      {
        close: closeCanopy,
        owners: [{ projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' }],
      },
    );
    const observe = (stage, operation) =>
      observeBoundary(stage, operation, boundary.record);
    largeInventory.attachRecord(boundary.record, {
      launchBoundaryBase: boundary.base,
    });
    boundary.record?.('test-start', { timeoutMs: 120000 });
    const { relative, isAbsolute } = await import('node:path');
    const launchOptions =
      process.platform === 'win32' &&
      boundary.options.env?.CANOPY_E2E_WINDOWS_BOUNDARY_DIAGNOSTICS
        ? {
            ...boundary.options,
            env: {
              ...boundary.options.env,
              CANOPY_E2E_WINDOWS_ADMISSION_EMISSION_DIAGNOSTICS: '1',
            },
          }
        : boundary.options;
    const owner = await observe('shell-setup', () =>
      seedPanelWorktree(launchOptions),
    );
    const { electronApp, userDataDir, window, app } = owner;
    try {
      await observe('settings-open', () => app.openSettings());
      await observe('settings-section', () =>
        app.openSettingsSection('browser'),
      );
      await window
        .getByTestId('browser-profile-new-name')
        .fill('Large inventory');
      await observe('profile-create-click', () =>
        window.getByTestId('browser-profile-create').click(),
      );
      boundary.record?.('profile-resolve', { outcome: 'entered' });
      const profile = await window.evaluate(async () =>
        (await window.api.browser.profiles.list()).profiles.find(
          (profile) => profile.displayName === 'Large inventory',
        ),
      );
      boundary.record?.('profile-resolve', { outcome: 'fulfilled' });
      boundary.record?.('native-path-resolution', { outcome: 'entered' });
      const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?inventory=private-query`;
      await window.evaluate((request) => window.api.browser.create(request), {
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        url,
        selection: { kind: 'named', profileId: profile.profileId },
      });
      let nativePath;
      await expect
        .poll(async () => {
          nativePath = await electronApp.evaluate(
            ({ webContents }, url) =>
              webContents
                .getAllWebContents()
                .find((contents) => contents.getURL() === url)?.session
                .storagePath,
            url,
          );
          return !!nativePath;
        })
        .toBe(true);
      const owned = relative(userDataDir, nativePath);
      expect(isAbsolute(owned) || owned.startsWith('..')).toBe(false);
      boundary.record?.('native-path-resolution', { outcome: 'fulfilled' });
      const { files, bytes } = largeInventory;
      await observe('inventory-install', () =>
        largeInventory.install(nativePath),
      );
      await observe('first-measure-click', () =>
        window.getByTestId('browser-profile-measure').click(),
      );
      // Activate the real control by keyboard while the short-lived job is live;
      // waiting for pointer geometry on Windows can outlast the entire scan.
      await observe('keyboard-cancel', () =>
        window.getByTestId('browser-profile-cancel-job').press('Enter'),
      );
      // The label, not the wire value: `cancelled` is transport state and the
      // notice has never been allowed to show it.
      await observe('cancelled-state-wait', () =>
        expect(window.getByTestId('browser-profile-data-job')).toContainText(
          'Measurement: Cancelled',
        ),
      );
      boundary.record?.('first-inventory-get', { outcome: 'entered' });
      const cancelled = await window.evaluate(
        (profile) =>
          window.api.browser.profiles.inventoryGet({
            profileId: profile.profileId,
            storageGeneration: profile.storageGeneration,
          }),
        profile,
      );
      boundary.record?.('first-inventory-get', { outcome: 'fulfilled' });
      expect(cancelled.approximateBytes).toBeNull();
      await observe('second-measure-click', () =>
        window.getByTestId('browser-profile-measure').click(),
      );
      const name = window
        .getByTestId('browser-profile-details')
        .getByRole('textbox')
        .first();
      await observe('settings-typing', () =>
        name.fill('Typing remains available'),
      );
      await expect(name).toHaveValue('Typing remains available');
      await observe('complete-state-wait', () =>
        expect(window.getByTestId('browser-profile-data-job')).toContainText(
          'Measurement: Complete',
          { timeout: 30000 },
        ),
      );
      boundary.record?.('second-inventory-get', { outcome: 'entered' });
      const measured = await window.evaluate(
        (profile) =>
          window.api.browser.profiles.inventoryGet({
            profileId: profile.profileId,
            storageGeneration: profile.storageGeneration,
          }),
        profile,
      );
      boundary.record?.('second-inventory-get', { outcome: 'fulfilled' });
      expect(measured.approximateBytes).toBeGreaterThanOrEqual(files * bytes);
      expect(measured.coverage).toBe('partial');
      expect(measured.classBytes).toEqual({
        cache: null,
        indexedDB: null,
        opfs: null,
      });
      expect(JSON.stringify(measured)).not.toContain('private-query');
      boundary.record?.('final-resource-assertion', { outcome: 'entered' });
      await expect
        .poll(
          () =>
            window.evaluate(
              async () =>
                (await window.api.getResourceMonitorSnapshot()).groups
                  .flatMap((group) => group.items)
                  .filter(
                    (item) =>
                      item.label === 'Browser profile inventory' &&
                      item.status === 'running',
                  ).length,
            ),
          { timeout: 15000 },
        )
        .toBe(0);
      boundary.record?.('final-resource-assertion', { outcome: 'fulfilled' });
    } finally {
      boundary.record?.('finally-entry');
      await boundary.close(owner);
    }
  },
);

test('product site clear verifies partitioned contexts and expanded cookies without clearing their top-level sites', async () => {
  test.setTimeout(120_000);
  const { createServer } = await import('node:https');
  const { readFile } = await import('node:fs/promises');
  const tls = {
    key: await readFile(
      new URL(
        './fixtures/browser-profile-clear/localhost-test.key.pem',
        import.meta.url,
      ),
    ),
    cert: await readFile(
      new URL(
        './fixtures/browser-profile-clear/localhost-test.cert.pem',
        import.meta.url,
      ),
    ),
  };
  let embedded;
  let verificationRequests = 0;
  const storage = `window.seed = async value => {
    localStorage.setItem('account', String(value));
    await new Promise((resolve,reject) => { const r=indexedDB.open('account',1); r.onupgradeneeded=()=>r.result.createObjectStore('values'); r.onsuccess=()=>{r.result.close();resolve()};r.onerror=reject; });
    await (await caches.open('account')).put('/value',new Response(String(value)));
    const root=await navigator.storage.getDirectory();const handle=await root.getFileHandle('account',{create:true});const writer=await handle.createWritable();await writer.write(String(value));await writer.close();
    document.cookie='partition='+value+';Secure;SameSite=None;Partitioned;Path=/';
  }; window.readState=async()=>({local:localStorage.getItem('account'), databases:(await indexedDB.databases()).length,caches:(await caches.keys()).length,files:await(async()=>{let n=0;for await(const _ of (await navigator.storage.getDirectory()).keys())n++;return n})()});`;
  const server = createServer(tls, (request, response) => {
    if (request.url.startsWith('/__browser_profile_')) verificationRequests++;
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(
      `<!doctype html><title>Partition account</title><script>${storage}</script>${request.headers.host.startsWith('first.localhost:') || request.headers.host.startsWith('second.localhost:') ? `<iframe src="${embedded}/frame"></iframe>` : ''}`,
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  embedded = `https://embedded.fixture.localhost:${port}`;
  const tops = [
    `https://first.localhost:${port}`,
    `https://second.localhost:${port}`,
  ];
  const sibling = `https://sibling.fixture.localhost:${port}`;
  let owner;
  let primaryError;
  let cleanupError;
  try {
    owner = await seedPanelWorktree();
    const { electronApp, window } = owner;
    const profile = await window.evaluate(() =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName: 'Partitioned account' },
      }),
    );
    const tabs = [];
    for (const url of [...tops, embedded, sibling]) {
      const tab = await window.evaluate(
        (input) => window.api.browser.create(input),
        {
          projectId: 'demo-ts-pnpm-vite',
          worktreeId: 'demo-main',
          selection: { kind: 'named', profileId: profile.profileId },
          url: 'about:blank',
        },
      );
      await electronApp.evaluate(
        ({ session }, { profileId, cert }) => {
          session
            .fromPartition(`persist:canopy-browser-profile-${profileId}-g1`)
            .setCertificateVerifyProc((request, callback) =>
              callback(
                request.hostname.endsWith('.localhost') &&
                  request.certificate.data.replace(/\r\n/g, '\n').trim() ===
                    cert.replace(/\r\n/g, '\n').trim()
                  ? 0
                  : -2,
              ),
            );
        },
        {
          profileId: profile.profileId,
          // Exercise the Windows checkout representation on every platform.
          cert: tls.cert.toString().replace(/\r?\n/g, '\r\n'),
        },
      );
      await window.evaluate((input) => window.api.browser.navigate(input), {
        browserId: tab.id,
        url,
      });
      tabs.push(tab);
    }
    let lastReadinessSnapshot = null;
    const contexts = async () => {
      const observation = await electronApp.evaluate(
        async ({ webContents }, { tops, embedded, sibling }) => {
          const limits = {
            maxContents: 16,
            maxFramesPerContents: 16,
            maxStringLength: 512,
            maxErrors: 8,
          };
          const diagnosticErrors = [];
          let droppedErrors = 0;
          let truncatedStrings = 0;
          const boundedString = (value) => {
            const text = String(value);
            if (text.length <= limits.maxStringLength) return text;
            truncatedStrings++;
            return `${text.slice(0, limits.maxStringLength - 1)}…`;
          };
          const safely = (field, operation, fallback = null) => {
            try {
              return operation();
            } catch (error) {
              if (diagnosticErrors.length < limits.maxErrors)
                diagnosticErrors.push({
                  field: boundedString(field),
                  message: boundedString(error?.message ?? error),
                });
              else droppedErrors++;
              return fallback;
            }
          };
          const expected = [
            {
              role: 'first-top-level',
              expectedUrl: `${tops[0]}/`,
              expectedFrameUrl: `${embedded}/frame`,
            },
            {
              role: 'second-top-level',
              expectedUrl: `${tops[1]}/`,
              expectedFrameUrl: `${embedded}/frame`,
            },
            {
              role: 'embedded-first-party',
              expectedUrl: `${embedded}/`,
            },
            { role: 'sibling', expectedUrl: `${sibling}/` },
          ];
          const allContents = webContents.getAllWebContents();
          const sources = expected.map(({ expectedUrl }) =>
            allContents.find((contents) => contents.getURL() === expectedUrl),
          );
          const describeContents = (contents, prefix) => {
            if (!contents) return null;
            return {
              id: safely(`${prefix}.id`, () => contents.id),
              actualUrl: boundedString(
                safely(`${prefix}.url`, () => contents.getURL(), ''),
              ),
              loading: safely(`${prefix}.loading`, () => contents.isLoading()),
              destroyed: safely(`${prefix}.destroyed`, () =>
                contents.isDestroyed(),
              ),
            };
          };
          const expectedUrlRoles = expected.map((entry, index) => {
            const contents = sources[index];
            const frames = contents
              ? safely(
                  `${entry.role}.frames`,
                  () => contents.mainFrame.framesInSubtree,
                  [],
                )
              : [];
            const observedFrames = frames
              .slice(0, limits.maxFramesPerContents)
              .map((frame, frameIndex) =>
                boundedString(
                  safely(
                    `${entry.role}.frame-${frameIndex}.url`,
                    () => frame.url,
                    '',
                  ),
                ),
              );
            return {
              role: entry.role,
              expectedUrl: boundedString(entry.expectedUrl),
              exactContentsExists: Boolean(contents),
              contents: describeContents(contents, entry.role),
              expectedFrameUrl: entry.expectedFrameUrl
                ? boundedString(entry.expectedFrameUrl)
                : null,
              expectedFrameExists: entry.expectedFrameUrl
                ? frames.some((frame) => frame.url === entry.expectedFrameUrl)
                : null,
              observedFrameUrls: observedFrames,
              framesTruncated: frames.length > limits.maxFramesPerContents,
            };
          });
          const expectedHosts = new Set(
            expected.map(({ expectedUrl }) => new URL(expectedUrl).hostname),
          );
          const observedContents = [];
          let droppedRelevantContents = 0;
          for (const contents of allContents) {
            const actualUrl = safely(
              'observed-contents-filter.url',
              () => contents.getURL(),
              '',
            );
            const relevant = safely(
              'observed-contents-filter.hostname',
              () => expectedHosts.has(new URL(actualUrl).hostname),
              false,
            );
            if (!relevant) continue;
            if (observedContents.length >= limits.maxContents) {
              droppedRelevantContents++;
              continue;
            }
            observedContents.push(
              describeContents(
                contents,
                `observed-contents-${observedContents.length}`,
              ),
            );
          }
          const snapshot = {
            version: 1,
            observedAtUtc: new Date().toISOString(),
            limits,
            expectedUrlRoles,
            observedContents,
            droppedRelevantContents,
            contentsTruncated: droppedRelevantContents > 0,
            diagnosticErrors,
            droppedErrors,
            truncatedStrings,
          };
          if (sources.some((contents) => !contents))
            return { states: null, snapshot };
          const frames = [
            ...sources
              .slice(0, 2)
              .map((c) =>
                c.mainFrame.framesInSubtree.find(
                  (f) => f.url === `${embedded}/frame`,
                ),
              ),
            sources[2].mainFrame,
            sources[3].mainFrame,
            ...sources.slice(0, 2).map((c) => c.mainFrame),
          ];
          if (frames.some((frame) => !frame)) return { states: null, snapshot };
          return {
            states: await Promise.all(
              frames.map((frame) =>
                frame.executeJavaScript(
                  'typeof readState === "function" ? readState() : null',
                ),
              ),
            ),
            snapshot,
          };
        },
        { tops, embedded, sibling },
      );
      lastReadinessSnapshot = observation.snapshot;
      return observation.states;
    };
    try {
      await expect.poll(contexts).toEqual(
        Array.from({ length: 6 }, () => ({
          local: null,
          databases: 0,
          caches: 0,
          files: 0,
        })),
      );
    } catch (error) {
      try {
        await test.info().attach('product-site-clear-readiness.json', {
          body: Buffer.from(
            JSON.stringify({
              phase: 'initial-readiness',
              lastReadinessSnapshot,
            }),
          ),
          contentType: 'application/json',
        });
      } catch (attachmentError) {
        console.error(
          'Product site-clear readiness attachment failed:',
          boundedCleanupErrorMessage(attachmentError),
        );
      }
      throw error;
    }
    await electronApp.evaluate(
      async ({ webContents }, { tops, embedded, sibling }) => {
        const sources = [...tops, embedded, sibling].map((url) =>
          webContents.getAllWebContents().find((c) => c.getURL() === `${url}/`),
        );
        const frames = [
          ...sources
            .slice(0, 2)
            .map((c) =>
              c.mainFrame.framesInSubtree.find(
                (f) => f.url === `${embedded}/frame`,
              ),
            ),
          sources[2].mainFrame,
          sources[3].mainFrame,
          ...sources.slice(0, 2).map((c) => c.mainFrame),
        ];
        for (let i = 0; i < frames.length; i++)
          await frames[i].executeJavaScript(`seed(${100 + i})`);
        await sources[3].executeJavaScript(
          "document.cookie='expanded=account;Domain=fixture.localhost;Secure;SameSite=None;Path=/'",
        );
      },
      { tops, embedded, sibling },
    );
    const before = await contexts();
    expect(before.map((state) => state.local)).toEqual([
      '100',
      '101',
      '102',
      '103',
      '104',
      '105',
    ]);
    await expect
      .poll(async () => {
        const result = await window.evaluate(
          (profile) =>
            window.api.browser.profiles.inventoryGet({
              profileId: profile.profileId,
              storageGeneration: 1,
            }),
          profile,
        );
        return result.sites.filter((site) => site.origin === embedded).length;
      })
      .toBe(3);
    const preview = await window.evaluate(
      ({ profile, origin }) =>
        window.api.browser.profiles.previewClear({
          profileId: profile.profileId,
          storageGeneration: 1,
          metadataRevision: profile.metadataRevision,
          operation: { kind: 'site', origin },
        }),
      { profile, origin: embedded },
    );
    expect(new Set(preview.contexts.map((c) => c.topLevelOrigin))).toEqual(
      new Set([...tops, embedded]),
    );
    expect(
      preview.cookieDomains.map((domain) => domain.replace(/^\./, '')),
    ).toContain('fixture.localhost');
    const job = await window.evaluate(
      (token) =>
        window.api.browser.profiles.clear({
          operationId: crypto.randomUUID(),
          token,
        }),
      preview.token,
    );
    await expect
      .poll(
        async () => {
          const current = await window.evaluate(
            (jobId) => window.api.browser.profiles.jobGet({ jobId }),
            job.jobId,
          );
          if (current.status === 'failed')
            throw new Error(JSON.stringify(current));
          return current.status;
        },
        { timeout: 45_000 },
      )
      .toBe('complete');
    await expect.poll(contexts).toEqual([
      ...Array.from({ length: 3 }, () => ({
        local: null,
        databases: 0,
        caches: 0,
        files: 0,
      })),
      ...before.slice(3),
    ]);
    const cookies = await electronApp.evaluate(
      async ({ webContents }, embedded) => {
        const contents = webContents
          .getAllWebContents()
          .find((c) => c.getURL() === `${embedded}/`);
        return (
          await contents.session.cookies.get({ domain: 'fixture.localhost' })
        ).map((cookie) => cookie.name);
      },
      embedded,
    );
    expect(cookies).toEqual([]);
    expect(verificationRequests).toBe(0);
  } catch (error) {
    primaryError = error;
  } finally {
    const retainCleanupError = (error) => {
      if (primaryError || cleanupError)
        console.error('Product site-clear fixture cleanup failed:', error);
      else cleanupError = error;
    };
    try {
      if (owner) await closeCanopy(owner.electronApp, owner.userDataDir);
    } catch (error) {
      retainCleanupError(error);
    } finally {
      try {
        server.closeAllConnections();
      } catch (error) {
        retainCleanupError(error);
      }
      try {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      } catch (error) {
        retainCleanupError(error);
      }
    }
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
});

test('retirement stops Task workers and removes only that owner’s browser scratch while retaining named data and copied files', async () => {
  test.setTimeout(120_000);
  const { createServer } = await import('node:http');
  const { readFile, copyFile, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const server = createServer((request, response) => {
    response.setHeader(
      'Content-Type',
      request.url === '/worker.js' ? 'application/javascript' : 'text/html',
    );
    response.end(
      request.url === '/worker.js'
        ? "self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('message',e=>e.waitUntil((async()=>{while(true){await(await caches.open('writer')).put('/value',new Response(String(Date.now())));await new Promise(r=>setTimeout(r,10));}})()));"
        : '<!doctype html><title>Retirement writer</title>Retirement writer',
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let { electronApp, userDataDir, window } = await seedPanelWorktree();
  try {
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    const { seedBrowserProfileEntryOwners } =
      await import('./seeders/browser-profile-state.mjs');
    const [owner] = await seedBrowserProfileEntryOwners(userDataDir);
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await getMainWindow(electronApp);
    const app = new CanopyAppDriver(window);
    await app.waitForShell();
    const named = await window.evaluate(() =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName: 'Retained account' },
      }),
    );
    const taskTab = await window.evaluate(
      (input) => window.api.browser.create(input),
      { ...owner, url: `${origin}/task` },
    );
    const namedTab = await window.evaluate(
      (input) => window.api.browser.create(input),
      {
        ...owner,
        selection: { kind: 'named', profileId: named.profileId },
        url: `${origin}/named`,
      },
    );
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ webContents }, origin) =>
            webContents
              .getAllWebContents()
              .filter(
                (c) =>
                  c.getURL().startsWith(origin) &&
                  c.getTitle() === 'Retirement writer',
              ).length,
          origin,
        ),
      )
      .toBe(2);
    await electronApp.evaluate(async ({ webContents }, origin) => {
      const task = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === `${origin}/task`);
      globalThis.__retiringTaskNative = task.session;
      await task.executeJavaScript(
        "(async()=>{await navigator.serviceWorker.register('/worker.js');await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(r=>navigator.serviceWorker.addEventListener('controllerchange',r,{once:true}));navigator.serviceWorker.controller.postMessage('write');})()",
      );
      const named = webContents
        .getAllWebContents()
        .find((c) => c.getURL() === `${origin}/named`);
      globalThis.__retainedNamedNative = named.session;
      await named.session.cookies.set({
        url: origin,
        name: 'retained',
        value: 'synthetic',
        expirationDate: Math.floor(Date.now() / 1000) + 3600,
      });
    }, origin);
    await expect
      .poll(() =>
        electronApp.evaluate(
          () =>
            Object.keys(
              globalThis.__retiringTaskNative.serviceWorkers.getAllRunning(),
            ).length,
        ),
      )
      .toBeGreaterThan(0);
    const retiredDirectory = await electronApp.evaluate(
      () => globalThis.__retiringTaskNative.storagePath,
    );
    await window.evaluate(
      (browserId) =>
        window.api.browser.setBounds({
          browserId,
          bounds: { x: 20, y: 180, width: 640, height: 400 },
          visible: true,
        }),
      namedTab.id,
    );
    const screenshot = await window.evaluate(
      (browserId) =>
        window.api.browser.screenshot({ browserId, saveToAttachments: true }),
      namedTab.id,
    );
    expect(screenshot.attachmentPath).toBeTruthy();
    const before = await readFile(screenshot.attachmentPath);
    expect(before.length).toBeGreaterThan(0);
    const copied = join(userDataDir, 'user-copied-browser-image.png');
    await copyFile(screenshot.attachmentPath, copied);
    const profile = await window.evaluate(
      (profileId) => window.api.browser.profiles.get({ profileId }),
      taskTab.profile.resolvedProfileId,
    );
    expect(profile.agentPermissions.allowClear).toBe(false);
    await app.openMainPage();
    await window.evaluate((request) => window.api.workEntries.delete(request), {
      projectId: owner.projectId,
      entryId: owner.worktreeId,
    });
    await expect
      .poll(() =>
        electronApp.evaluate(
          () =>
            Object.keys(
              globalThis.__retiringTaskNative.serviceWorkers.getAllRunning(),
            ).length,
        ),
      )
      .toBe(0);
    await expect
      .poll(() =>
        stat(screenshot.attachmentPath).then(
          () => true,
          () => false,
        ),
      )
      .toBe(false);
    expect(await readFile(copied)).toEqual(before);
    const cookies = await electronApp.evaluate(async () => ({
      task: await globalThis.__retiringTaskNative.cookies.get({}),
      named: await globalThis.__retainedNamedNative.cookies.get({}),
    }));
    expect(cookies.task).toEqual([]);
    expect(cookies.named.map((cookie) => cookie.name)).toContain('retained');
    const cleanup = await window.evaluate(() =>
      window.api.browser.profiles.cleanupStatus(),
    );
    expect(
      cleanup.jobs.some(
        (job) =>
          job.profileId === profile.profileId &&
          job.status === 'pending_restart',
      ),
    ).toBe(true);
    expect(
      await window.evaluate(
        (profileId) => window.api.browser.profiles.get({ profileId }),
        named.profileId,
      ),
    ).toMatchObject({ profileId: named.profileId, storageGeneration: 1 });
    await closeCanopy(electronApp, userDataDir, { keepUserData: true });
    ({ electronApp } = await launchCanopy({ userDataDir }));
    window = await getMainWindow(electronApp);
    await new CanopyAppDriver(window).waitForShell();
    await expect
      .poll(
        async () =>
          !(
            await window.evaluate(() =>
              window.api.browser.profiles.cleanupStatus(),
            )
          ).jobs.some((job) => job.profileId === profile.profileId),
      )
      .toBe(true);
    await expect(stat(retiredDirectory)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(await readFile(copied)).toEqual(before);
    await window.evaluate((input) => window.api.browser.create(input), {
      projectId: 'demo-ts-pnpm-vite',
      worktreeId: 'demo-main',
      selection: { kind: 'named', profileId: named.profileId },
      url: `${origin}/restored-named`,
    });
    await expect
      .poll(() =>
        electronApp.evaluate(async ({ webContents }, url) => {
          const contents = webContents
            .getAllWebContents()
            .find((c) => c.getURL() === url);
          return contents
            ? (await contents.session.cookies.get({ name: 'retained' })).map(
                (cookie) => cookie.value,
              )
            : [];
        }, `${origin}/restored-named`),
      )
      .toEqual(['synthetic']);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await closeCanopy(electronApp, userDataDir);
  }
});

async function closeSavedTabDuringSharedProfileRestore({ closeVariant }) {
  let holding = false;
  const held = [];
  const finish = (response) =>
    response.end('<!doctype html><title>Resume fixture</title>Resume fixture');
  const releaseHeldResponses = () => {
    holding = false;
    for (const { response } of held) {
      if (!response.destroyed && !response.writableEnded) finish(response);
    }
  };
  const selectionOwner = {};
  let server;
  let serverBoundary;
  let origin;
  const cleanupBoundary = selectedWindowsBoundary(
    `${closeVariant}-saved-tab-cleanup`,
  );
  const setupDiagnostics =
    closeVariant === 'queued'
      ? selectedSetupDiagnostics('queued-saved-tab-setup', selectionOwner)
      : undefined;
  let seeded;
  try {
    const { createServer } = await import('node:http');
    server = createServer((request, response) => {
      response.setHeader('Content-Type', 'text/html');
      const requestPath = request.url ?? '';
      const isRestoreRequest = requestPath.startsWith('/resume/');
      const isHeld = holding && isRestoreRequest;
      if (isHeld) held.push({ response, url: requestPath });
      else finish(response);
      if (isRestoreRequest) {
        cleanupBoundary?.record('restore-request', {
          path: requestPath,
          held: isHeld,
          heldCount: held.length,
        });
      }
    });
    serverBoundary = createLocalHttpBoundaryObserver(
      server,
      held,
      cleanupBoundary?.record,
    );
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener('error', onError);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      try {
        server.listen(0, '127.0.0.1', onListening);
      } catch (error) {
        server.removeListener('error', onError);
        reject(error);
      }
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    seeded = await seedPanelWorktree({
      ...setupDiagnostics,
      onSelectWorktreeFailure: setupDiagnostics
        ? undefined
        : retainSelectionFailureOwner(
            selectionOwner,
            createWorktreeSelectionFailureDiagnostic(
              'saved-tab-restore-selection',
            ),
          ),
    });
  } catch (selectionError) {
    cleanupBoundary?.record('primary-error', {
      outcome: 'caught',
      message: boundedCleanupErrorMessage(selectionError),
      phase: 'setup',
    });
    await closeProfileSetupFailure({
      selectionOwner,
      server,
      releaseHeldResponses,
      attachmentName: 'saved-tab-restore-selection-cleanup-failure.json',
    });
    throw selectionError;
  }
  const { electronApp, userDataDir, window, app } = seeded;
  const launchIdentity = {
    userDataDir,
    electronPid: (() => {
      try {
        return electronApp.process?.()?.pid ?? null;
      } catch {
        return null;
      }
    })(),
  };
  const owner = { projectId: 'demo-ts-pnpm-vite', worktreeId: 'demo-main' };
  const evidence = { closeVariant, owner, cleanup: [], checkpoints: [] };
  let profile;
  let primary;
  let barrierOwned = false;
  let observersInstalled = false;
  const persisted = () =>
    JSON.parse(
      readFileSync(
        path.join(
          userDataDir,
          'workspaces',
          owner.projectId,
          'worktree-data',
          owner.worktreeId,
          'browser-state.json',
        ),
        'utf8',
      ),
    );
  const restoreBarrier = async (kind) => {
    const operation = () =>
      electronApp.evaluate(
        (_electron, input) => {
          const control = globalThis.__CANOPY_E2E_BROWSER_RESTORE_BARRIER__;
          if (typeof control !== 'function')
            throw new Error('Missing restore barrier');
          return control(input);
        },
        { kind, profileId: profile.profileId },
      );
    const result = await (kind === 'release'
      ? observeBoundary(
          'restore-barrier-release',
          operation,
          cleanupBoundary?.record,
        )
      : operation());
    if (kind === 'arm') barrierOwned = true;
    if (kind === 'release') barrierOwned = false;
    return result;
  };
  const observe = () =>
    electronApp.evaluate(() =>
      globalThis.__SAVED_TAB_CLOSE_OBSERVER__.snapshot(),
    );
  const checkpoint = async (stage) => {
    evidence.checkpoints.push({
      stage,
      persisted: persisted(),
      main: await observe(),
      renderer: await window.evaluate(
        () => window.__savedTabCloseObserver.events,
      ),
      requests: held.map(({ url }) => url),
    });
  };
  try {
    profile = await window.evaluate(() =>
      window.api.browser.profiles.create({
        operationId: crypto.randomUUID(),
        input: { displayName: 'Restore boundary' },
      }),
    );
    const panels = [];
    for (let index = 0; index < 5; index += 1) {
      const seededPanel = await seedVisibleBrowserPanel(
        window,
        {
          ...owner,
          url: `${origin}/resume/${index}`,
          selection: { kind: 'named', profileId: profile.profileId },
        },
        { moveToGroupId: DEFAULT_GROUP_IDS.chat, moveEdge: 'center' },
      );
      panels.push(seededPanel);
      const pane = window.getByTestId(`browser-pane-${seededPanel.browser.id}`);
      await expect(pane).toBeVisible();
      await expectBrowserProfile(window, profile.displayName, pane);
    }
    const layout = await getLayout(window);
    const panelIds = panels.map((panel) => panel.panelId).sort();
    const browserIds = panels.map((panel) => panel.browser.id).sort();
    const leaves = collectLeaves(layout.root);
    expect(leaves).toHaveLength(3);
    const chatLeaf = leaves.find(
      (leaf) => leaf.groupId === DEFAULT_GROUP_IDS.chat,
    );
    expect(chatLeaf?.panels.map((panel) => panel.panelId).sort()).toEqual(
      [DEFAULT_PANEL_IDS.chat, ...panelIds].sort(),
    );
    expect(
      chatLeaf?.panels.find(
        (panel) => panel.panelId === DEFAULT_PANEL_IDS.chat,
      ),
    ).toMatchObject({ panelId: DEFAULT_PANEL_IDS.chat, kind: 'chat' });
    for (const panel of panels) {
      expect(
        chatLeaf?.panels.find((entry) => entry.panelId === panel.panelId),
      ).toMatchObject({
        panelId: panel.panelId,
        kind: 'browser',
        instance: { browserId: panel.browser.id },
      });
    }
    expect(
      chatLeaf?.panels
        .filter((panel) => panelIds.includes(panel.panelId))
        .map((panel) => panel.instance?.browserId)
        .sort(),
    ).toEqual(browserIds);
    expect(chatLeaf?.activePanelId).toBe(panels[4].panelId);
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ webContents }, origin) =>
            webContents
              .getAllWebContents()
              .filter(
                (c) =>
                  c.getURL().startsWith(origin) &&
                  c.getTitle() === 'Resume fixture',
              ).length,
          origin,
        ),
      )
      .toBe(5);
    const initial = await window.evaluate(
      (owner) => window.api.browser.loadWorktreeState(owner),
      owner,
    );
    const tabs = initial.state.browsers;
    expect(tabs.map((tab) => tab.id).sort()).toEqual(browserIds);
    expect(tabs).toHaveLength(5);
    for (const tab of tabs) {
      expect(tab).toMatchObject({
        ...owner,
        profile: { resolvedProfileId: profile.profileId },
      });
      expect(tab.profile.taskIncarnationId).toBeTruthy();
    }
    const targetPanel = panels[4];
    const removed = tabs.find((tab) => tab.id === targetPanel.browser.id);
    expect(removed).toBeTruthy();
    const survivors = tabs.filter((tab) => tab.id !== removed.id);
    const survivorIds = survivors.map((tab) => tab.id).sort();
    evidence.initial = {
      profile,
      tabs,
      panels,
      persisted: persisted(),
      targetId: removed.id,
    };
    await window.getByTestId('panel-tab-panel-chat-seed-chat').click();
    await electronApp.evaluate(
      ({ app, ipcMain, webContents }, fixture) => {
        const original = ipcMain._invokeHandlers.get('browser:destroy');
        if (typeof original !== 'function')
          throw new Error('Missing browser destroy IPC');
        if (globalThis.__SAVED_TAB_CLOSE_OBSERVER__)
          throw new Error('Close observer already installed');
        const destroys = [];
        const navigations = [];
        const listeners = new Map();
        const ids = new Set(fixture.tabs.map((tab) => tab.id));
        const urls = new Set(fixture.tabs.map((tab) => tab.url));
        let unmatched = 0;
        let sequence = 0;
        const wrapper = async function (event, request, ...rest) {
          if (!ids.has(request?.browserId)) {
            unmatched += 1;
            return original.call(this, event, request, ...rest);
          }
          const record = {
            enteredSequence: ++sequence,
            browserId: request.browserId,
            expectedRuntimeGeneration: request.expectedRuntimeGeneration,
            outcome: 'pending',
          };
          destroys.push(record);
          if (destroys.length > 64) destroys.shift();
          try {
            const result = await original.call(this, event, request, ...rest);
            record.outcome = 'resolved';
            record.settledSequence = ++sequence;
            return result;
          } catch (error) {
            Object.assign(record, {
              outcome: 'rejected',
              settledSequence: ++sequence,
              code: error?.code,
              message: String(error).slice(0, 2048),
            });
            throw error;
          }
        };
        const created = (_event, contents) => {
          const started = (_event, url, _inPlace, mainFrame) => {
            if (!mainFrame || !urls.has(url)) return;
            navigations.push({
              sequence: ++sequence,
              url,
              nativeId: contents.id,
            });
            if (navigations.length > 64) navigations.shift();
          };
          listeners.set(contents, started);
          contents.on('did-start-navigation', started);
        };
        globalThis.__SAVED_TAB_CLOSE_OBSERVER__ = {
          snapshot: () => ({
            destroys,
            unmatched,
            navigations: navigations.map((entry) => {
              const contents = webContents.fromId(entry.nativeId);
              return {
                ...entry,
                destroyed: !contents || contents.isDestroyed(),
                loading:
                  contents && !contents.isDestroyed()
                    ? contents.isLoading()
                    : false,
              };
            }),
          }),
          cleanup: () => {
            app.removeListener('web-contents-created', created);
            for (const [contents, started] of listeners)
              contents.removeListener('did-start-navigation', started);
            delete globalThis.__SAVED_TAB_CLOSE_OBSERVER__;
            if (ipcMain._invokeHandlers.get('browser:destroy') !== wrapper)
              throw new Error('Destroy observer restoration conflict');
            ipcMain._invokeHandlers.set('browser:destroy', original);
          },
        };
        ipcMain._invokeHandlers.set('browser:destroy', wrapper);
        app.on('web-contents-created', created);
      },
      { tabs },
    );
    observersInstalled = true;
    await window.evaluate(
      (ids) => {
        const events = [];
        const dispose = window.api.browser.onEvent((event) => {
          if (
            !ids.includes(event.browserId) ||
            !['snapshot', 'destroyed'].includes(event.type)
          )
            return;
          events.push(event);
          if (events.length > 128) events.shift();
        });
        window.__savedTabCloseObserver = { events, dispose };
      },
      tabs.map((tab) => tab.id),
    );
    await restoreBarrier('arm');
    await app.openSettings();
    await app.openSettingsSection('browser');
    await window
      .getByTestId(`browser-profile-row-${profile.profileId}`)
      .click();
    holding = true;
    await window.getByTestId('browser-profile-clear-cache').click();
    await window.getByTestId('browser-profile-confirm-clear').click();
    await expect
      .poll(
        async () =>
          (
            await window.evaluate(
              (profileId) => window.api.browser.profiles.jobList({ profileId }),
              profile.profileId,
            )
          ).jobs.find((job) => job.kind === 'cache')?.status,
      )
      .toBe('complete');
    await expect
      .poll(() => restoreBarrier('status'))
      .toEqual({ armed: true, entered: true });
    await app.closeSettings();
    await expect(window.getByTestId(`browser-pane-${removed.id}`)).toBeHidden();
    const rebound = persisted().browsers.find((tab) => tab.id === removed.id);
    expect(rebound.profile.runtimeGeneration).toBe(
      removed.profile.runtimeGeneration + 1,
    );
    await expect
      .poll(() =>
        window.evaluate(
          (target) =>
            window.__savedTabCloseObserver.events.some(
              (event) =>
                event.type === 'snapshot' &&
                event.browserId === target.id &&
                event.snapshot.profile.runtimeGeneration ===
                  target.profile.runtimeGeneration,
            ),
          rebound,
        ),
      )
      .toBe(true);
    expect((await observe()).navigations).toEqual([]);
    expect(held).toHaveLength(0);
    if (closeVariant === 'loading') {
      await restoreBarrier('release');
      await expect
        .poll(() =>
          [...new Set(held.map(({ url }) => `${origin}${url}`))].sort(),
        )
        .toEqual(tabs.map((tab) => tab.url).sort());
      await expect
        .poll(async () =>
          (await observe()).navigations.map((entry) => entry.url).sort(),
        )
        .toEqual(tabs.map((tab) => tab.url).sort());
      await expect
        .poll(async () =>
          (await observe()).navigations.find(
            (entry) => entry.url === removed.url,
          ),
        )
        .toMatchObject({ url: removed.url, destroyed: false, loading: true });
      await expect
        .poll(() =>
          window.evaluate(
            (target) =>
              window.__savedTabCloseObserver.events.some(
                (event) =>
                  event.type === 'snapshot' &&
                  event.browserId === target.id &&
                  event.snapshot.profile.runtimeGeneration ===
                    target.profile.runtimeGeneration + 1,
              ),
            rebound,
          ),
        )
        .toBe(true);
    }
    // Queued means the whole captured batch is still unadmitted. Loading
    // means a real native view is loading, even after create's 1500ms bound.
    await checkpoint('before-panel-close');
    await closePanelTab(window, targetPanel.panelId);
    await expect
      .poll(async () =>
        (await observe()).destroys.some(
          (record) =>
            record.browserId === removed.id && record.outcome === 'resolved',
        ),
      )
      .toBe(true);
    await expect(
      window.getByTestId(`panel-tab-${targetPanel.panelId}`),
    ).toHaveCount(0);
    expect(
      persisted()
        .browsers.map((tab) => tab.id)
        .sort(),
    ).toEqual(survivorIds);
    const afterDestroy = await window.evaluate(
      (owner) => window.api.browser.loadWorktreeState(owner),
      owner,
    );
    expect(
      afterDestroy.state.browsers.find((tab) => tab.id === removed.id),
    ).toBeUndefined();
    expect(afterDestroy.state.browsers.map((tab) => tab.id).sort()).toEqual(
      survivorIds,
    );
    if (closeVariant === 'queued') {
      expect(await restoreBarrier('status')).toEqual({
        armed: true,
        entered: true,
      });
      expect((await observe()).navigations).toEqual([]);
      await checkpoint('closed-before-batch-admission');
      await restoreBarrier('release');
      await expect
        .poll(() =>
          [...new Set(held.map(({ url }) => `${origin}${url}`))].sort(),
        )
        .toEqual(survivors.map((tab) => tab.url).sort());
    } else {
      await expect
        .poll(
          async () =>
            (await observe()).navigations.find(
              (entry) => entry.url === removed.url,
            )?.destroyed,
        )
        .toBe(true);
    }
    await checkpoint('closed-before-response-release');
    releaseHeldResponses();
    await expect
      .poll(
        async () =>
          window.evaluate(async (profile) => {
            try {
              await window.api.browser.profiles.previewClear({
                profileId: profile.profileId,
                storageGeneration: profile.storageGeneration,
                metadataRevision: profile.metadataRevision,
                operation: { kind: 'cache' },
              });
              return true;
            } catch (error) {
              if (!String(error).includes('pending maintenance')) throw error;
              return false;
            }
          }, profile),
        { timeout: 30000 },
      )
      .toBe(true);
    const after = await window.evaluate(
      (owner) => window.api.browser.loadWorktreeState(owner),
      owner,
    );
    expect(
      after.state.browsers.find((tab) => tab.id === removed.id),
    ).toBeUndefined();
    expect(after.state.browsers).toHaveLength(4);
    expect(after.state.browsers.map((tab) => tab.id).sort()).toEqual(
      survivorIds,
    );
    expect(
      persisted()
        .browsers.map((tab) => tab.id)
        .sort(),
    ).toEqual(survivorIds);
    // Maintenance can settle at the bounded navigation return; allow the
    // released responses to commit before checking the final native count.
    await expect
      .poll(() =>
        electronApp.evaluate(
          ({ webContents }, origin) =>
            webContents
              .getAllWebContents()
              .filter((c) => c.getURL().startsWith(origin)).length,
          origin,
        ),
      )
      .toBe(4);
    const finalNative = (await observe()).navigations.filter(
      (entry) => !entry.destroyed,
    );
    expect(finalNative.map((entry) => entry.url).sort()).toEqual(
      survivors.map((tab) => tab.url).sort(),
    );
    await checkpoint('maintenance-settled');
  } catch (error) {
    primary = error;
    evidence.primary = boundedCleanupErrorMessage(error);
    cleanupBoundary?.record('primary-error', {
      outcome: 'caught',
      message: boundedCleanupErrorMessage(error),
    });
  } finally {
    let cleanupFailure;
    const recordCleanup = createObservedCleanupRecorder({
      evidence,
      record: cleanupBoundary?.record,
      serverBoundary,
      launchIdentity,
    });
    try {
      await runObservedCleanupSteps(
        [
          [
            'restore-release',
            async () => {
              if (barrierOwned) await restoreBarrier('release');
            },
          ],
          ['responses-release', releaseHeldResponses],
          [
            'final-observation',
            async () => {
              if (observersInstalled) await checkpoint('cleanup');
            },
          ],
          [
            'main-observer-remove',
            async () => {
              if (observersInstalled)
                await electronApp.evaluate(() =>
                  globalThis.__SAVED_TAB_CLOSE_OBSERVER__.cleanup(),
                );
            },
          ],
          [
            'renderer-observer-remove',
            () =>
              window.evaluate(() => {
                window.__savedTabCloseObserver?.dispose();
                delete window.__savedTabCloseObserver;
              }),
          ],
          ['server-connections-close', () => server.closeAllConnections()],
          [
            'server-close',
            () =>
              serverBoundary
                ? closeServerWithBoundary(server, serverBoundary)
                : new Promise((resolve, reject) =>
                    server.close((error) =>
                      error ? reject(error) : resolve(),
                    ),
                  ),
          ],
          ['owner-close', () => closeCanopy(electronApp, userDataDir)],
        ],
        recordCleanup,
      );
    } catch (error) {
      cleanupFailure = error;
      evidence.cleanupFailure = boundedCleanupErrorMessage(error);
      cleanupBoundary?.record('cleanup-error', {
        outcome: 'caught',
        message: boundedCleanupErrorMessage(error),
      });
    }
    try {
      await test.info().attach('saved-tab-close-boundary.json', {
        body: JSON.stringify(evidence, null, 2),
        contentType: 'application/json',
      });
    } catch (error) {
      cleanupFailure ??= error;
    }
    primary ??= cleanupFailure;
  }
  if (primary) throw primary;
}

test('closing a saved tab while shared-profile views restore does not recreate it', async () => {
  // Windows completed every product assertion before whole-owner teardown.
  test.setTimeout(120000);
  await closeSavedTabDuringSharedProfileRestore({ closeVariant: 'queued' });
});

test('closing a loading saved tab while shared-profile views restore does not recreate it', async () => {
  // Windows completed every product assertion before whole-owner teardown.
  test.setTimeout(120000);
  await closeSavedTabDuringSharedProfileRestore({ closeVariant: 'loading' });
});

async function profileReviewFixture(electronApp, kind, profileId) {
  return electronApp.evaluate(
    (_electron, request) => {
      const fixture = globalThis.__CANOPY_E2E_PROFILE_REVIEW_FIXTURE__;
      if (typeof fixture !== 'function')
        throw new Error('Missing profile review fixture; rebuild E2E.');
      return fixture(request);
    },
    { kind, profileId },
  );
}

for (const returnToA of [false, true]) {
  test(`W2 late deletion preview cannot cross profile selection${returnToA ? ' even after returning to A' : ''}`, async () => {
    test.setTimeout(120_000);
    const { electronApp, userDataDir, window, app } = await seedPanelWorktree();
    let a;
    try {
      await app.openSettings();
      await app.openSettingsSection('browser');
      for (const name of ['Review account A', 'Review account B']) {
        await window.getByTestId('browser-profile-new-name').fill(name);
        await window.getByTestId('browser-profile-create').click();
        await expect(
          window.getByTestId('browser-profile-new-name'),
        ).toHaveValue('');
      }
      const named = await window.evaluate(async () =>
        (await window.api.browser.profiles.list()).profiles.filter(
          (profile) => profile.kind === 'named',
        ),
      );
      a = named.find((profile) => profile.displayName === 'Review account A');
      const b = named.find(
        (profile) => profile.displayName === 'Review account B',
      );
      expect(a).toBeTruthy();
      expect(b).toBeTruthy();
      const url = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one?review=delete-race`;
      await window.evaluate((request) => window.api.browser.create(request), {
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        selection: { kind: 'named', profileId: a.profileId },
        url,
      });
      await expect
        .poll(() => fixtureCookies(electronApp, url, 'review-account-a'))
        .toContain('review-account-a');
      await window.getByTestId(`browser-profile-row-${a.profileId}`).click();
      await profileReviewFixture(electronApp, 'delay-preview', a.profileId);
      await window.getByTestId('browser-profile-delete').click();
      await expect
        .poll(() => profileReviewFixture(electronApp, 'status', a.profileId))
        .toMatchObject({ armed: true, entered: true });
      await window.getByTestId(`browser-profile-row-${b.profileId}`).click();
      if (returnToA)
        await window.getByTestId(`browser-profile-row-${a.profileId}`).click();
      await profileReviewFixture(electronApp, 'release', a.profileId);
      // Busy ends only after the actual delayed IPC response is consumed.
      await expect(window.getByTestId('browser-profile-delete')).toBeEnabled();
      await expect(
        window.getByTestId('browser-profile-delete-preview'),
      ).toHaveCount(0);
      await expect(
        window.getByTestId('browser-profile-confirm-delete'),
      ).toHaveCount(0);
      expect(
        await window.evaluate(
          (id) => window.api.browser.profiles.get({ profileId: id }),
          a.profileId,
        ),
      ).toMatchObject({ lifecycle: 'active' });
      expect(await fixtureCookies(electronApp, url)).toContain(
        'review-account-a',
      );
      const selected = returnToA ? a : b;
      await window.getByTestId('browser-profile-delete').click();
      await expect(
        window.getByTestId('browser-profile-delete-preview'),
      ).toContainText(selected.displayName);
      await window
        .getByTestId('browser-profile-delete-preview')
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
      await expect(
        window.getByTestId('browser-profile-delete-preview'),
      ).toHaveCount(0);
    } finally {
      if (a)
        await profileReviewFixture(electronApp, 'release', a.profileId).catch(
          () => {},
        );
      await closeCanopy(electronApp, userDataDir);
    }
  });
}

test('W3 Settings remount recovers an original-generation reset job without resetting again', async () => {
  test.setTimeout(120_000);
  const { electronApp, userDataDir, window, app } = await seedPanelWorktree(
    selectedSetupDiagnostics('w3-settings-remount-setup'),
  );
  let original;
  try {
    await app.openSettings();
    await app.openSettingsSection('browser');
    for (const name of ['Review reset account', 'Review unrelated account']) {
      await window.getByTestId('browser-profile-new-name').fill(name);
      await window.getByTestId('browser-profile-create').click();
      await expect(window.getByTestId('browser-profile-new-name')).toHaveValue(
        '',
      );
    }
    const named = await window.evaluate(async () =>
      (await window.api.browser.profiles.list()).profiles.filter(
        (profile) => profile.kind === 'named',
      ),
    );
    original = named.find(
      (profile) => profile.displayName === 'Review reset account',
    );
    const unrelated = named.find(
      (profile) => profile.displayName === 'Review unrelated account',
    );
    expect(original).toBeTruthy();
    expect(unrelated).toBeTruthy();
    const baseUrl = `${process.env.CANOPY_E2E_MOCK_BASE_URL ?? 'http://127.0.0.1:4011'}/browser-fixture/one`;
    for (const [profile, suffix] of [
      [original, 'reset'],
      [unrelated, 'unrelated'],
    ]) {
      const url = `${baseUrl}?review=${suffix}`;
      await window.evaluate((request) => window.api.browser.create(request), {
        projectId: 'demo-ts-pnpm-vite',
        worktreeId: 'demo-main',
        selection: { kind: 'named', profileId: profile.profileId },
        url,
      });
      await expect
        .poll(() => fixtureCookies(electronApp, url, `review-${suffix}`))
        .toContain(`review-${suffix}`);
    }
    await window
      .getByTestId(`browser-profile-row-${original.profileId}`)
      .click();
    await profileReviewFixture(
      electronApp,
      'fail-reset-rebind',
      original.profileId,
    );
    await window.getByTestId('browser-profile-reset').click();
    await expect(
      window.getByTestId('browser-profile-clear-preview'),
    ).toContainText('Affects 1 saved tab.');
    await window.getByTestId('browser-profile-confirm-clear').click();
    const resetJobs = () =>
      window.evaluate(
        async (id) =>
          (
            await window.api.browser.profiles.jobList({ profileId: id })
          ).jobs.filter((job) => job.kind === 'reset'),
        original.profileId,
      );
    await expect.poll(resetJobs).toEqual([
      expect.objectContaining({
        status: 'failed',
        retryable: true,
        storageGeneration: original.storageGeneration,
        message: expect.stringContaining('Try again'),
      }),
    ]);
    expect(
      await profileReviewFixture(electronApp, 'status', original.profileId),
    ).toMatchObject({ armed: false, entered: true });
    const [failed] = await resetJobs();
    expect(
      await window.evaluate(
        (id) => window.api.browser.profiles.get({ profileId: id }),
        original.profileId,
      ),
    ).toMatchObject({ storageGeneration: original.storageGeneration + 1 });
    await app.closeSettings();
    await app.openSettings();
    await app.openSettingsSection('browser');
    await window
      .getByTestId(`browser-profile-row-${original.profileId}`)
      .click();
    await expect(window.getByTestId('browser-profile-data-job')).toContainText(
      'Try again',
    );
    await expect(window.getByTestId('browser-profile-retry-job')).toBeVisible();
    await window.getByTestId('browser-profile-retry-job').click();
    await expect
      .poll(() =>
        window.evaluate(
          (jobId) => window.api.browser.profiles.jobGet({ jobId }),
          failed.jobId,
        ),
      )
      .toMatchObject({
        status: 'complete',
        storageGeneration: original.storageGeneration,
      });
    expect(await resetJobs()).toEqual([
      expect.objectContaining({ jobId: failed.jobId, status: 'complete' }),
    ]);
    expect(
      await window.evaluate(
        (id) => window.api.browser.profiles.get({ profileId: id }),
        original.profileId,
      ),
    ).toMatchObject({
      storageGeneration: original.storageGeneration + 1,
      displayName: original.displayName,
      agentPermissions: original.agentPermissions,
    });
    expect(
      await window.evaluate(
        (id) => window.api.browser.profiles.get({ profileId: id }),
        unrelated.profileId,
      ),
    ).toEqual(unrelated);
    expect(
      await fixtureCookies(electronApp, `${baseUrl}?review=unrelated`),
    ).toContain('review-unrelated');
  } finally {
    if (original)
      await profileReviewFixture(
        electronApp,
        'release',
        original.profileId,
      ).catch(() => {});
    await closeCanopy(electronApp, userDataDir);
  }
});

// This controller fixture is absent from normal collection, including skip counts.
if (process.env.CANOPY_E2E_ACCEPTANCE_CONTROLLER_FIXTURE === '1') {
  test('acceptance controller owns and terminates its timeout fixture', async () => {
    test.setTimeout(180_000);
    const root = realpathSync(process.env.RUNNER_TEMP ?? tmpdir());
    const pidFile = process.env.CANOPY_E2E_ACCEPTANCE_CONTROLLER_OWNED_PID_FILE;
    expect(typeof pidFile === 'string' && path.isAbsolute(pidFile)).toBe(true);
    expect(
      realpathSync(path.dirname(pidFile)).startsWith(root + path.sep),
    ).toBe(true);
    expect(path.basename(pidFile)).toBe('owned.pid');
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL(
            './fixtures/browser-profile-acceptance-controller/hang-child.mjs',
            import.meta.url,
          ),
        ),
        pidFile,
      ],
      { stdio: 'ignore', windowsHide: true, shell: false },
    );
    let launchError;
    child.once('error', (error) => {
      launchError = error;
    });
    await expect
      .poll(() => {
        if (launchError) throw launchError;
        try {
          return Number(readFileSync(pidFile, 'utf8'));
        } catch {
          return null;
        }
      })
      .toBe(child.pid);
    await new Promise(() => {});
  });
}

/**
 * Two things a list has to survive: profiles that share a name, and a
 * destructive prompt opened from the keyboard.
 *
 * Nothing rejects a duplicate name, so Settings and the browser picker both
 * have to stay answerable to "which one is this?". And the delete
 * confirmation replaces the button that opened it, so focus has to be carried
 * across by hand or a keyboard user is dropped at the top of the page.
 */
test('duplicate profile names stay distinguishable and the delete prompt keeps keyboard focus', async () => {
  test.setTimeout(process.platform === 'win32' ? 120_000 : 90_000);
  const { electronApp, userDataDir, window, app } = await seedPanelWorktree();
  try {
    await window.getByTestId('panel-add-tab-group-terminal').click();
    await window.getByTestId('panel-add-menu-item-browser').click();
    await expect(window.getByTestId('browser-bar')).toBeVisible();

    const created = await window.evaluate(async () => {
      const api = window.api.browser.profiles;
      const made = [];
      for (const displayName of ['Work', 'Work', 'Personal'])
        made.push(
          await api.create({
            operationId: crypto.randomUUID(),
            input: { displayName },
          }),
        );
      return made.map((profile) => profile.profileId);
    });
    const [firstWork, secondWork, personal] = created;
    const short = (profileId) => profileId.slice(0, 6);

    await app.openSettings();
    await app.openSettingsSection('browser');
    const settings = window.getByTestId('settings-tab-browser');
    const row = (profileId) =>
      settings.getByTestId(`browser-profile-row-${profileId}`);

    // The colliding pair carries its id; the unique name does not.
    await expect(row(firstWork)).toContainText(short(firstWork));
    await expect(row(secondWork)).toContainText(short(secondWork));
    await expect(row(personal)).toHaveText('Personal');

    // The profile submenu uses the same qualifiers as Settings.
    await app.closeSettings();
    await app.openMainPage();
    await app.selectWorktree('demo-main');
    await window.getByTestId('browser-more').click();
    await window.getByTestId('browser-more-profile').hover();
    const options = window
      .getByTestId('browser-profile-submenu')
      .getByRole('menuitemradio');
    await expect(options.filter({ hasText: short(firstWork) })).toHaveCount(1);
    await expect(options.filter({ hasText: short(secondWork) })).toHaveCount(1);
    await expect(options.filter({ hasText: 'Personal' })).toHaveText(
      'Personal',
    );
    await window.keyboard.press('Escape');

    // Reach the destructive action from the keyboard and confirm focus moves
    // with it, then comes back when the prompt is dismissed.
    await app.openSettings();
    await app.openSettingsSection('browser');
    await row(personal).click();
    const remove = settings.getByTestId('browser-profile-delete');
    await remove.focus();
    await window.keyboard.press('Enter');
    const prompt = window.getByTestId('browser-profile-delete-preview');
    await expect(prompt).toBeVisible();
    await expect
      .poll(() =>
        window.evaluate(
          () => document.activeElement?.getAttribute('data-testid') ?? 'none',
        ),
      )
      // The confirmation dialog starts on Cancel: Enter cannot delete.
      .toBe('browser-profile-cancel-delete');

    await window.keyboard.press('Escape');
    await expect(prompt).toHaveCount(0);
    await expect
      .poll(() =>
        window.evaluate(
          () => document.activeElement?.getAttribute('data-testid') ?? 'none',
        ),
      )
      .toBe('browser-profile-delete');
  } finally {
    await closeCanopy(electronApp, userDataDir);
  }
});

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  buildElectronEnv,
  buildE2eLaunchMarkerEnv,
  cleanupFailedLaunch,
  closeCanopy,
  createAbruptTreeKiller,
  ElectronTerminalResultError,
  getMainWindow,
  isPlaywrightTargetClosedError,
  observeElectronTerminalResult,
  parseSupervisedTreePid,
  prepareIsolatedProviderState,
  readSupervisedTreePid,
  reapSupervisedProcessTree,
  registerElectronTerminalObservation,
  registerSupervisedProcessTree,
  resolveLaunchRuntimeRoot,
  resolveE2eMainEntryPath,
  resolveProductionMainEntryPath,
  seedCaptureColorMode,
  seedRendererCodeCacheScheme,
  packagedMainWindowRendererUrl,
  rendererCodeCacheSchemeElectronArgs,
  RENDERER_CODE_CACHE_SCHEME_ENV,
  waitForElectronTerminalResult,
} from '../electron/launchCanopy.mjs';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

import {
  createBoundaryRecorder,
  observeBoundary,
  createTerminalCleanupFixture,
  retainSelectionFailureOwner,
} from '../electron/browser-profile-test-lifecycle.mjs';

const rendererUrl = 'file:///app/renderer/index.html';

function controlledPromise() {
  let resolve, reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function drainMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function selectionFixture(expectedUrl = rendererUrl) {
  const app = new EventEmitter();
  const pages = [];
  let disposed = 0;
  app.windows = () => pages.filter((page) => !page.isClosed());
  app.browserWindow = (page) =>
    Promise.resolve({
      evaluate: (fn) => Promise.resolve(fn(page.owner)),
      dispose: () => {
        disposed++;
        return Promise.resolve();
      },
    });
  const addPage = (owner, initialPageUrl) => {
    const page = new EventEmitter();
    let closed = false;
    const frame = {};
    page.owner = owner;
    page.isClosed = () => closed;
    let pageUrl =
      initialPageUrl ?? owner?.webContents.getURL() ?? 'about:blank';
    page.url = () => pageUrl;
    page.setPageUrl = (url) => {
      pageUrl = url;
    };
    page.mainFrame = () => frame;
    page.navigate = (url) => {
      owner.url = url;
      pageUrl = url;
      page.emit('framenavigated', frame);
    };
    page.close = () => {
      closed = true;
      page.emit('close');
    };
    pages.push(page);
    app.emit('window', page);
    return page;
  };
  return {
    app,
    addPage,
    disposed: () => disposed,
    select: (options) =>
      getMainWindow(app, { rendererUrl: expectedUrl, ...options }),
  };
}

function applicationWindow({ url = rendererUrl, parent = null } = {}) {
  const window = {
    url,
    isDestroyed: () => false,
    getParentWindow: () => parent,
    // The installed native runtime omits preload and preloadURL entirely.
    getTitle: () => 'Application (worktree branding)',
    webContents: {
      getLastWebPreferences: () => ({ sandbox: false, contextIsolation: true }),
      getURL: () => window.url,
    },
  };
  return window;
}

function assertSelectionListenersRemoved(fixture, pages) {
  assert.equal(fixture.app.listenerCount('window'), 0);
  assert.equal(fixture.app.listenerCount('close'), 0);
  for (const page of pages)
    assert.equal(page.listenerCount('framenavigated'), 0);
}

test('main-window selection uses the configured renderer entry while maintenance remains live', async () => {
  const fixture = selectionFixture();
  const maintenance = fixture.addPage(null);
  const unrelated = fixture.addPage(
    applicationWindow({ url: 'file:///other/renderer/index.html' }),
  );
  const advisor = fixture.addPage(
    applicationWindow({ url: `${rendererUrl}?surface=app-advisor` }),
  );
  const child = fixture.addPage(applicationWindow({ parent: { id: 1 } }));
  const selected = fixture.select();
  const main = fixture.addPage(applicationWindow());
  assert.equal(await selected, main);
  assert.equal(maintenance.isClosed(), false);
  assert.equal(await getMainWindow(fixture.app), main);
  assert.equal(fixture.disposed(), 5);
  assertSelectionListenersRemoved(fixture, [
    maintenance,
    unrelated,
    advisor,
    child,
    main,
  ]);
});

test('main-window selection observes the existing native awaits without changing cache identity or calls', async () => {
  const fixture = selectionFixture();
  const owner = applicationWindow();
  const page = fixture.addPage(owner);
  const association = controlledPromise();
  const evaluation = controlledPromise();
  const disposal = controlledPromise();
  const calls = [];
  fixture.app.browserWindow = (candidate) => {
    calls.push(['association', candidate]);
    return association.promise;
  };
  const handle = {
    evaluate: (operation) => {
      calls.push(['evaluate', operation]);
      return evaluation.promise;
    },
    dispose: () => {
      calls.push(['dispose']);
      return disposal.promise;
    },
  };
  const records = [];
  const replacementRecords = [];
  const selected = fixture.select({
    launchObserver: (stage, details) => records.push({ stage, ...details }),
  });
  const cached = fixture.select({
    launchObserver: (stage, details) =>
      replacementRecords.push({ stage, ...details }),
  });

  assert.equal(cached, selected);
  assert.deepEqual(calls, [['association', page]]);
  assert.deepEqual(
    records.map(({ stage, outcome }) => [stage, outcome]),
    [
      ['main-window-selection', 'entered'],
      ['main-window-native-association', 'entered'],
    ],
  );

  association.resolve(handle);
  await drainMicrotasks();
  assert.deepEqual(
    calls.map(([name]) => name),
    ['association', 'evaluate'],
  );
  assert.deepEqual(
    records.slice(-2).map(({ stage, outcome }) => [stage, outcome]),
    [
      ['main-window-native-association', 'fulfilled'],
      ['main-window-native-evaluate', 'entered'],
    ],
  );

  evaluation.resolve({
    nativeOwner: true,
    destroyed: false,
    parent: false,
    url: rendererUrl,
  });
  await drainMicrotasks();
  assert.deepEqual(
    calls.map(([name]) => name),
    ['association', 'evaluate', 'dispose'],
  );
  assert.deepEqual(
    records.slice(-2).map(({ stage, outcome }) => [stage, outcome]),
    [
      ['main-window-native-evaluate', 'fulfilled'],
      ['main-window-native-dispose', 'entered'],
    ],
  );

  disposal.resolve();
  assert.equal(await selected, page);
  assert.equal(await fixture.select(), page);
  assert.deepEqual(
    records.map(({ stage, outcome }) => [stage, outcome]),
    [
      ['main-window-selection', 'entered'],
      ['main-window-native-association', 'entered'],
      ['main-window-native-association', 'fulfilled'],
      ['main-window-native-evaluate', 'entered'],
      ['main-window-native-evaluate', 'fulfilled'],
      ['main-window-native-dispose', 'entered'],
      ['main-window-native-dispose', 'fulfilled'],
      ['main-window-selection', 'fulfilled'],
    ],
  );
  assert.deepEqual(replacementRecords, []);
  assert.deepEqual(
    calls.map(([name]) => name),
    ['association', 'evaluate', 'dispose'],
  );
  assertSelectionListenersRemoved(fixture, [page]);
});

test('main-window launch observer is passive for hostile returns and preserves original errors', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  const pending = new Promise(() => {});
  const hostileThen = Object.create(null, {
    then: {
      get() {
        throw new Error('hostile then getter');
      },
    },
  });
  const callbackCalls = [0, 0, 0, 0, 0];
  const callbacks = [
    () => {
      callbackCalls[0]++;
      throw new Error('observer threw');
    },
    () => {
      callbackCalls[1]++;
      return Promise.reject(new Error('observer rejected'));
    },
    () => {
      callbackCalls[2]++;
      return hostileThen;
    },
    () => {
      callbackCalls[3]++;
      return {
        then: (_resolve, reject) => reject(new Error('thenable rejected')),
      };
    },
    () => {
      callbackCalls[4]++;
      return pending;
    },
  ];
  try {
    for (const [index, callback] of callbacks.entries()) {
      const fixture = selectionFixture();
      const page = fixture.addPage(applicationWindow());
      assert.equal(await fixture.select({ launchObserver: callback }), page);
      assert.ok(callbackCalls[index] > 0);
      assert.equal(fixture.disposed(), 1);
      assertSelectionListenersRemoved(fixture, [page]);
    }
    const primary = new Error('original native rejection');
    const failed = selectionFixture();
    const page = failed.addPage(applicationWindow());
    failed.app.browserWindow = () => Promise.reject(primary);
    await assert.rejects(
      failed.select({ launchObserver: callbacks[1] }),
      (error) => error === primary,
    );
    assertSelectionListenersRemoved(failed, [page]);
    await drainMicrotasks();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

function normalizedSelectionFailureEvidence(error) {
  return {
    ...error.mainWindowSelection,
    events: error.mainWindowSelection.events.map((event) => {
      const normalized = { ...event };
      delete normalized.monotonicNs;
      return normalized;
    }),
  };
}

test('observer-enabled selector preserves evaluation and disposal rejection precedence and inactive failure history', async () => {
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on('unhandledRejection', onUnhandled);
  try {
    for (const scenario of [
      {
        name: 'evaluation-only',
        evaluationError: new Error('original evaluation rejection', {
          cause: new Error('original evaluation cause'),
        }),
        expectedEvidenceStages: [
          'window-observed',
          'inspection-entered',
          'inspection-rejected',
          'selection-rejected',
        ],
        expectedObservationStages: [
          ['main-window-selection', 'entered'],
          ['main-window-native-association', 'entered'],
          ['main-window-native-association', 'fulfilled'],
          ['main-window-native-evaluate', 'entered'],
          ['main-window-native-evaluate', 'rejected'],
          ['main-window-native-dispose', 'entered'],
          ['main-window-native-dispose', 'fulfilled'],
          ['main-window-selection', 'rejected'],
        ],
      },
      {
        name: 'disposal-only',
        disposalError: new Error('original disposal rejection', {
          cause: new Error('original disposal cause'),
        }),
        expectedEvidenceStages: [
          'window-observed',
          'inspection-entered',
          'inspection',
          'inspection-rejected',
          'selection-rejected',
        ],
        expectedObservationStages: [
          ['main-window-selection', 'entered'],
          ['main-window-native-association', 'entered'],
          ['main-window-native-association', 'fulfilled'],
          ['main-window-native-evaluate', 'entered'],
          ['main-window-native-evaluate', 'fulfilled'],
          ['main-window-native-dispose', 'entered'],
          ['main-window-native-dispose', 'rejected'],
          ['main-window-selection', 'rejected'],
        ],
      },
      {
        name: 'evaluation-plus-disposal',
        evaluationError: new Error('superseded evaluation rejection', {
          cause: new Error('superseded evaluation cause'),
        }),
        disposalError: new Error('precedent disposal rejection', {
          cause: new Error('precedent disposal cause'),
        }),
        expectedEvidenceStages: [
          'window-observed',
          'inspection-entered',
          'inspection-rejected',
          'selection-rejected',
        ],
        expectedObservationStages: [
          ['main-window-selection', 'entered'],
          ['main-window-native-association', 'entered'],
          ['main-window-native-association', 'fulfilled'],
          ['main-window-native-evaluate', 'entered'],
          ['main-window-native-evaluate', 'rejected'],
          ['main-window-native-dispose', 'entered'],
          ['main-window-native-dispose', 'rejected'],
          ['main-window-selection', 'rejected'],
        ],
      },
    ]) {
      const runs = [];
      for (const observed of [false, true]) {
        const fixture = selectionFixture();
        const owner = applicationWindow();
        const page = fixture.addPage(owner, 'about:blank');
        const calls = [];
        fixture.app.browserWindow = (candidate) => {
          calls.push(['association', candidate]);
          return Promise.resolve({
            evaluate: (operation) => {
              calls.push(['evaluate', operation]);
              return scenario.evaluationError
                ? Promise.reject(scenario.evaluationError)
                : Promise.resolve(operation(owner));
            },
            dispose: () => {
              calls.push(['dispose']);
              return scenario.disposalError
                ? Promise.reject(scenario.disposalError)
                : Promise.resolve();
            },
          });
        };
        const records = [];
        let observerCalls = 0;
        const launchObserver = observed
          ? (stage, details) => {
              records.push({ stage, ...details });
              observerCalls++;
              if (observerCalls % 3 === 1)
                throw new Error(`hostile observer throw: ${scenario.name}`);
              if (observerCalls % 3 === 2)
                return Promise.reject(
                  new Error(`hostile observer rejection: ${scenario.name}`),
                );
              return Object.create(null, {
                then: {
                  get() {
                    throw new Error(
                      `hostile observer then getter: ${scenario.name}`,
                    );
                  },
                },
              });
            }
          : undefined;
        const expectedError =
          scenario.disposalError ?? scenario.evaluationError;
        let evidence;
        await assert.rejects(
          fixture.select({ launchObserver }),
          (error) => {
            assert.equal(error, expectedError);
            assert.equal(error.message, expectedError.message);
            assert.equal(error.cause, expectedError.cause);
            evidence = normalizedSelectionFailureEvidence(error);
            return true;
          },
          scenario.name,
        );
        assert.deepEqual(
          calls.map(([name]) => name),
          ['association', 'evaluate', 'dispose'],
          scenario.name,
        );
        assert.equal(
          calls.filter(([name]) => name === 'association').length,
          1,
        );
        assert.equal(calls.filter(([name]) => name === 'evaluate').length, 1);
        assert.equal(calls.filter(([name]) => name === 'dispose').length, 1);
        assert.deepEqual(
          evidence.events.map(({ stage }) => stage),
          scenario.expectedEvidenceStages,
          scenario.name,
        );
        assertSelectionListenersRemoved(fixture, [page]);
        assert.equal(page.listenerCount('close'), 0);
        if (observed) {
          assert.ok(observerCalls > 0);
          assert.deepEqual(
            records.map(({ stage, outcome }) => [stage, outcome]),
            scenario.expectedObservationStages,
            scenario.name,
          );
        } else {
          assert.equal(observerCalls, 0);
          assert.deepEqual(records, []);
        }
        runs.push({ evidence, calls: calls.map(([name]) => name) });
      }
      assert.deepEqual(runs[1], runs[0], `${scenario.name} active parity`);
    }
    await drainMicrotasks();
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('main-window launch observer stops selection records after another page settles', async () => {
  const fixture = selectionFixture();
  const delayed = fixture.addPage(applicationWindow({ url: 'about:blank' }));
  const winner = fixture.addPage(applicationWindow());
  const association = controlledPromise();
  const originalBrowserWindow = fixture.app.browserWindow;
  fixture.app.browserWindow = (page) =>
    page === delayed ? association.promise : originalBrowserWindow(page);
  const records = [];
  assert.equal(
    await fixture.select({
      launchObserver: (stage, details) => records.push({ stage, ...details }),
    }),
    winner,
  );
  const settledCount = records.length;
  association.resolve({
    evaluate: async (operation) => operation(delayed.owner),
    dispose: async () => {},
  });
  await drainMicrotasks();
  assert.equal(records.length, settledCount);
  assertSelectionListenersRemoved(fixture, [delayed, winner]);
});

const launchObservationRunner = String.raw`
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const helperPath = process.env.LAUNCH_OBSERVATION_HELPER_PATH;
const source = fs.readFileSync(helperPath, 'utf8');
let clockReads = 0;
const observedHrtime = (...args) => process.hrtime(...args);
observedHrtime.bigint = () => {
  clockReads++;
  return process.hrtime.bigint();
};
const observedProcess = Object.create(process);
let currentPlatform = 'darwin';
Object.defineProperties(observedProcess, {
  env: { value: { ...process.env }, enumerable: true },
  hrtime: { value: observedHrtime, enumerable: true },
  platform: { get: () => currentPlatform, enumerable: true },
});
const resizeEvents = [];
const context = vm.createContext({
  Buffer,
  Event,
  URL,
  clearTimeout,
  console,
  process: observedProcess,
  setTimeout,
  window: { dispatchEvent: (event) => resizeEvents.push(event.type) },
});
const foreignPromiseContext = vm.createContext({});
const helperPromiseConstructor = vm.runInContext('Promise', context);
const foreignPromiseConstructor = vm.runInContext(
  'Promise',
  foreignPromiseContext,
);
let activePromiseRealm = 'helper';
let activeFailureAt;
let activeFailure;
const realmPromise = (value, reject = false, realm = activePromiseRealm) => {
  const promiseContext = realm === 'foreign' ? foreignPromiseContext : context;
  promiseContext.__promiseValue = value;
  return vm.runInContext(
    reject
      ? 'Promise.reject(globalThis.__promiseValue)'
      : 'Promise.resolve(globalThis.__promiseValue)',
    promiseContext,
  );
};
const operationPromise = (boundary, value) =>
  activeFailureAt === boundary
    ? realmPromise(activeFailure, true)
    : realmPromise(value);
const helperPromiseSample = realmPromise(undefined, false, 'helper');
const foreignPromiseSample = realmPromise(undefined, false, 'foreign');
const promiseRealms = {
  constructorsDiffer: helperPromiseConstructor !== foreignPromiseConstructor,
  helperSampleIsHelper:
    helperPromiseSample instanceof helperPromiseConstructor,
  helperSampleIsForeign:
    helperPromiseSample instanceof foreignPromiseConstructor,
  foreignSampleIsHelper:
    foreignPromiseSample instanceof helperPromiseConstructor,
  foreignSampleIsForeign:
    foreignPromiseSample instanceof foreignPromiseConstructor,
};
const operations = [];
let nextWindowCount = 1;
let launcherMode = 'default';
function nativeWindow(url) {
  return {
    isDestroyed: () => false,
    getParentWindow: () => null,
    webContents: { getURL: () => url },
  };
}
function createPage(owner, url, ordinal) {
  const page = new EventEmitter();
  const frame = {};
  Object.assign(page, {
    owner,
    isClosed: () => false,
    url: () => url,
    mainFrame: () => frame,
    setViewportSize: (viewport) => {
      operations.push({ operation: 'viewport-set', ordinal, viewport });
      return operationPromise('viewport-set', undefined);
    },
    evaluate: (operation) => {
      operations.push({ operation: 'resize-dispatch', ordinal });
      let value;
      try {
        value = operation();
      } catch (error) {
        return realmPromise(error, true);
      }
      return operationPromise('resize-dispatch', value);
    },
  });
  return page;
}
function createElectronApp() {
  const rendererUrl = 'file:///workspace/out-e2e/renderer/index.html';
  const pages = [];
  for (let index = 0; index < nextWindowCount - 1; index++)
    pages.push(createPage(null, 'about:blank', index + 1));
  pages.push(
    createPage(nativeWindow(rendererUrl), rendererUrl, nextWindowCount),
  );
  const app = new EventEmitter();
  app.windows = () => pages;
  app.browserWindow = (page) => {
    const ordinal = pages.indexOf(page) + 1;
    operations.push({ operation: 'native-association', ordinal });
    return operationPromise('native-association', {
      evaluate: (operation) => {
        operations.push({ operation: 'native-evaluate', ordinal });
        if (activeFailureAt === 'native-evaluate')
          return operationPromise('native-evaluate', undefined);
        let value;
        try {
          value = operation(page.owner);
        } catch (error) {
          return realmPromise(error, true);
        }
        return operationPromise('native-evaluate', value);
      },
      dispose: () => {
        operations.push({ operation: 'native-dispose', ordinal });
        return operationPromise('native-dispose', undefined);
      },
    });
  };
  app.close = () => realmPromise(undefined);
  app.process = () => {
    operations.push({ operation: 'electron-process' });
    const child = new EventEmitter();
    child.pid = 8181;
    return child;
  };
  if (launcherMode === 'closes-after-app-close') {
    const child = new EventEmitter();
    child.pid = 8181;
    app.process = () => child;
    app.close = () => {
      operations.push({ operation: 'app-close' });
      setTimeout(() => {
        operations.push({ operation: 'launcher-close' });
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      }, 25);
      return realmPromise(undefined);
    };
  } else if (launcherMode === 'unobservable') {
    app.process = () => null;
    app.close = () => {
      operations.push({ operation: 'app-close' });
      return realmPromise(undefined);
    };
  }
  return app;
}
const electron = {
  launch: () => {
    operations.push({ operation: 'electron-launch' });
    return operationPromise('electron-launch', createElectronApp());
  },
};
const playwrightTest = { info: () => ({ attachments: [] }) };
const fakeFs = {
  appendFileSync() {},
  chmodSync() {},
  existsSync: (file) =>
    String(file).endsWith('/out-e2e/main/index.js') ||
    String(file).endsWith('/out/main/index.js'),
  lstatSync: () => ({
    isDirectory: () => true,
    isSymbolicLink: () => false,
  }),
  mkdirSync() {},
  mkdtempSync: () => '/owned-generated',
  readFileSync: (file) =>
    String(file).endsWith('.e2e-supervised-electron.pid') ? '4242' : '{}',
  readdirSync: () => [],
  realpathSync: (file) => file,
  rmSync(file) {
    if (launcherMode !== 'default')
      operations.push({ operation: 'remove', path: String(file) });
  },
  statSync: () => {
    throw Object.assign(new Error('Fixture path does not exist'), {
      code: 'ENOENT',
    });
  },
  writeFileSync() {},
};
const synthetic = (identifier, values) =>
  new vm.SyntheticModule(
    Object.keys(values),
    function () {
      for (const [name, value] of Object.entries(values))
        this.setExport(name, value);
    },
    { context, identifier },
  );
const modules = new Map();
async function getModule(specifier) {
  if (modules.has(specifier)) return modules.get(specifier);
  let values;
  if (specifier === 'node:assert/strict') values = { default: assert };
  else if (specifier === 'node:fs') values = fakeFs;
  else if (specifier === 'node:module') values = { createRequire };
  else if (specifier === 'node:crypto')
    values = { randomUUID: () => '00000000-0000-4000-8000-000000000001' };
  else if (specifier === 'node:os') values = { default: os };
  else if (specifier === 'node:path') values = { default: path };
  else if (specifier === 'node:url') values = { fileURLToPath, pathToFileURL };
  else if (specifier === 'electron') values = { default: '/fake/electron' };
  else if (specifier === '@playwright/test')
    values = { _electron: electron, test: playwrightTest };
  else if (specifier.endsWith('/e2e-harness-measurement.mjs'))
    values = {
      measureE2eHarnessOperation: (_operation, _details, action) => action(),
    };
  else if (specifier.endsWith('/process-tree-supervisor.mjs'))
    values = {
      killProcessTree: async () => {},
      listPosixProcesses: () => [],
      posixProcessGroupIsOwned: () => false,
      processGroupExists: () => false,
    };
  else if (specifier.endsWith('/browser-profiles-production-headless-bootstrap.cjs'))
    values = {
      default: {
        buildExpectedArgv: () => ({}),
        stageBootstrap: () => ({
          contractArgs: [],
          launchEntryPath: '/workspace/out/main/index.js',
          identity: {},
          cleanup() {},
        }),
      },
    };
  else if (specifier.endsWith('/browser-profiles-evidence.mjs'))
    values = { assertProductionHeadlessTerminal() {} };
  else if (specifier === './demoWorkspaces.mjs')
    values = { seedDemoWorkspaces: () => null };
  else if (specifier === './canopyApp.mjs')
    values = { CanopyAppDriver: class CanopyAppDriver {} };
  else throw new Error('Unexpected launch helper import: ' + specifier);
  const module = synthetic('stub:' + specifier, values);
  modules.set(specifier, module);
  return module;
}
const sourceModule = new vm.SourceTextModule(source, {
  context,
  identifier: pathToFileURL(helperPath).href,
  initializeImportMeta(meta) {
    meta.url = pathToFileURL(helperPath).href;
  },
});
await sourceModule.link((specifier) => getModule(specifier));
await sourceModule.evaluate();
async function run({
  observed,
  windows,
  viewport = true,
  platform = 'darwin',
  buildKind,
  productionWindowMode,
  promiseRealm = 'helper',
  failureAt,
}) {
  currentPlatform = platform;
  nextWindowCount = windows;
  activePromiseRealm = promiseRealm;
  activeFailureAt = failureAt;
  const failureCause = failureAt
    ? new Error(promiseRealm + ' ' + failureAt + ' cause')
    : undefined;
  activeFailure = failureAt
    ? new Error(promiseRealm + ' ' + failureAt + ' rejection', {
        cause: failureCause,
      })
    : undefined;
  const records = [];
  const operationStart = operations.length;
  const resizeStart = resizeEvents.length;
  const clockStart = clockReads;
  let owner, rejection;
  try {
    owner = await sourceModule.namespace.launchCanopy({
      rootPath: '/workspace',
      userDataDir: '/owned-' + String(operationStart),
      freshOnboarding: true,
      freshOnboardingChecklist: true,
      preserveProviderState: true,
      ...(buildKind ? { buildKind } : {}),
      ...(productionWindowMode ? { productionWindowMode } : {}),
      ...(viewport ? {} : { viewportSize: null }),
      ...(observed
        ? {
            boundaryRecord: (stage, details) => {
              records.push({ stage, ...details });
            },
          }
        : {}),
    });
  } catch (error) {
    rejection = error;
  }
  if (failureAt) {
    assert.equal(rejection, activeFailure);
    assert.equal(rejection.message, activeFailure.message);
    assert.equal(rejection.cause, failureCause);
  } else assert.equal(rejection, undefined);
  return {
    records,
    operations: operations.slice(operationStart),
    resizeEvents: resizeEvents.slice(resizeStart),
    clockReads: clockReads - clockStart,
    rejected: rejection !== undefined,
    rejectionIdentity: failureAt ? rejection === activeFailure : undefined,
    rejectionMessage: rejection?.message,
    rejectionCauseIdentity:
      failureAt && rejection ? rejection.cause === failureCause : undefined,
    failureHistoryStages: rejection?.mainWindowSelection?.events.map(
      ({ stage }) => stage,
    ),
    owner: owner
      ? {
          supervisedTreePid: owner.supervisedTreePid,
          productMainEntryPath: owner.productMainEntryPath,
          launchEntryPath: owner.launchEntryPath,
        }
      : undefined,
  };
}
// A viewport failure after launch, with a generated data root, so the real
// catch block closes Electron and decides whether to remove that root.
async function launchFailure({ platform, mode }) {
  currentPlatform = platform;
  nextWindowCount = 1;
  activePromiseRealm = 'helper';
  activeFailureAt = 'viewport-set';
  activeFailure = new Error(platform + ' ' + mode + ' viewport-set rejection');
  launcherMode = mode;
  const operationStart = operations.length;
  let rejection;
  try {
    await sourceModule.namespace.launchCanopy({
      rootPath: '/workspace',
      freshOnboarding: true,
      freshOnboardingChecklist: true,
      preserveProviderState: true,
    });
  } catch (error) {
    rejection = error;
  }
  // Let a launcher close scheduled by app.close() land in the record.
  await new Promise((resolve) => setTimeout(resolve, 75));
  launcherMode = 'default';
  activeFailureAt = undefined;
  return {
    operations: operations
      .slice(operationStart)
      .filter(({ operation }) =>
        ['app-close', 'launcher-close', 'remove'].includes(operation),
      )
      .map(({ operation, path }) => (path ? [operation, path] : operation)),
    rejectionName: rejection?.name,
    rejectionIsLaunchFailure: rejection === activeFailure,
    firstErrorIsLaunchFailure: rejection?.errors?.[0] === activeFailure,
    retainedName: rejection?.errors?.[1]?.name,
    rejectionMessage: rejection?.message,
  };
}
const disabled = await run({ observed: false, windows: 1 });
const enabled = await run({ observed: true, windows: 1 });
const noViewport = await run({ observed: true, windows: 1, viewport: false });
const posixTerminal = await run({
  observed: false,
  windows: 1,
  viewport: false,
  platform: 'darwin',
});
const windowsTerminal = await run({
  observed: false,
  windows: 1,
  viewport: false,
  platform: 'win32',
});
const sidecarTerminal = await run({
  observed: false,
  windows: 1,
  viewport: false,
  platform: 'win32',
  buildKind: 'production',
  productionWindowMode: 'headless',
});
const bounded = await run({ observed: true, windows: 40 });
const matched = {};
for (const promiseRealm of ['helper', 'foreign']) {
  matched[promiseRealm] = {
    fulfilled: await run({ observed: true, windows: 1, promiseRealm }),
    launchRejected: await run({
      observed: true,
      windows: 1,
      promiseRealm,
      failureAt: 'electron-launch',
    }),
    associationRejected: await run({
      observed: true,
      windows: 1,
      promiseRealm,
      failureAt: 'native-association',
    }),
    evaluationRejected: await run({
      observed: true,
      windows: 1,
      promiseRealm,
      failureAt: 'native-evaluate',
    }),
  };
}
const launchFailures = {
  windowsLauncherCloses: await launchFailure({
    platform: 'win32',
    mode: 'closes-after-app-close',
  }),
  windowsLauncherUnobservable: await launchFailure({
    platform: 'win32',
    mode: 'unobservable',
  }),
  darwinLauncherCloses: await launchFailure({
    platform: 'darwin',
    mode: 'closes-after-app-close',
  }),
};
process.stdout.write(
  JSON.stringify({ disabled, enabled, noViewport, posixTerminal, windowsTerminal, sidecarTerminal, bounded, promiseRealms, matched, launchFailures }),
);
`;

function runLaunchObservation() {
  const run = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--input-type=module',
      '--eval',
      launchObservationRunner,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        LAUNCH_OBSERVATION_HELPER_PATH: fileURLToPath(
          new URL('../electron/launchCanopy.mjs', import.meta.url),
        ),
      },
    },
  );
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  return JSON.parse(run.stdout);
}

test('actual launchCanopy route observes cross-realm launch, viewport, resize, and bounded selection activity', () => {
  const {
    disabled,
    enabled,
    noViewport,
    posixTerminal,
    windowsTerminal,
    sidecarTerminal,
    bounded,
    promiseRealms,
    matched,
  } = runLaunchObservation();
  assert.deepEqual(promiseRealms, {
    constructorsDiffer: true,
    helperSampleIsHelper: true,
    helperSampleIsForeign: false,
    foreignSampleIsHelper: false,
    foreignSampleIsForeign: true,
  });
  assert.equal(disabled.clockReads, enabled.clockReads);
  assert.deepEqual(disabled.operations, enabled.operations);
  assert.deepEqual(enabled.resizeEvents, ['resize']);
  assert.deepEqual(enabled.owner, {
    supervisedTreePid: 4242,
    productMainEntryPath: '/workspace/out-e2e/main/index.js',
    launchEntryPath: '/workspace/out-e2e/main/index.js',
  });
  assert.deepEqual(
    enabled.records.map(({ stage, outcome }) => [stage, outcome]),
    [
      ['electron-launch', 'entered'],
      ['electron-launch', 'fulfilled'],
      ['main-window-selection', 'entered'],
      ['main-window-native-association', 'entered'],
      ['main-window-native-association', 'fulfilled'],
      ['main-window-native-evaluate', 'entered'],
      ['main-window-native-evaluate', 'fulfilled'],
      ['main-window-native-dispose', 'entered'],
      ['main-window-native-dispose', 'fulfilled'],
      ['main-window-selection', 'fulfilled'],
      ['viewport-set', 'entered'],
      ['viewport-set', 'fulfilled'],
      ['resize-dispatch', 'entered'],
      ['resize-dispatch', 'fulfilled'],
    ],
  );
  assert.deepEqual(
    enabled.operations.map(({ operation }) => operation),
    [
      'electron-launch',
      'native-association',
      'native-evaluate',
      'native-dispose',
      'viewport-set',
      'resize-dispatch',
    ],
  );
  assert.deepEqual(
    noViewport.records.map(({ stage, outcome }) => [stage, outcome]),
    [
      ['electron-launch', 'entered'],
      ['electron-launch', 'fulfilled'],
    ],
  );
  assert.deepEqual(
    noViewport.operations.map(({ operation }) => operation),
    ['electron-launch'],
  );
  assert.deepEqual(
    posixTerminal.operations.map(({ operation }) => operation),
    ['electron-launch'],
  );
  assert.deepEqual(
    windowsTerminal.operations.map(({ operation }) => operation),
    ['electron-launch', 'electron-process'],
  );
  assert.deepEqual(
    sidecarTerminal.operations.map(({ operation }) => operation),
    ['electron-launch'],
  );
  assert.deepEqual(noViewport.resizeEvents, []);
  assert.ok(bounded.records.length <= 64);
  assert.ok(
    Buffer.byteLength(
      bounded.records
        .map(({ stage, ...details }) => JSON.stringify({ stage, ...details }))
        .join(''),
    ) <= 30000,
  );
  assert.equal(
    bounded.records.filter(
      ({ stage }) => stage === 'launch-observation-truncated',
    ).length,
    1,
  );
  assert.ok(
    bounded.records.every(
      (record) =>
        record.events === undefined && record.mainWindowSelection === undefined,
    ),
  );
  const expectedMatched = {
    fulfilled: {
      operations: [
        'electron-launch',
        'native-association',
        'native-evaluate',
        'native-dispose',
        'viewport-set',
        'resize-dispatch',
      ],
      observations: [
        ['electron-launch', 'entered'],
        ['electron-launch', 'fulfilled'],
        ['main-window-selection', 'entered'],
        ['main-window-native-association', 'entered'],
        ['main-window-native-association', 'fulfilled'],
        ['main-window-native-evaluate', 'entered'],
        ['main-window-native-evaluate', 'fulfilled'],
        ['main-window-native-dispose', 'entered'],
        ['main-window-native-dispose', 'fulfilled'],
        ['main-window-selection', 'fulfilled'],
        ['viewport-set', 'entered'],
        ['viewport-set', 'fulfilled'],
        ['resize-dispatch', 'entered'],
        ['resize-dispatch', 'fulfilled'],
      ],
    },
    launchRejected: {
      operations: ['electron-launch'],
      observations: [
        ['electron-launch', 'entered'],
        ['electron-launch', 'rejected'],
      ],
    },
    associationRejected: {
      operations: ['electron-launch', 'native-association'],
      observations: [
        ['electron-launch', 'entered'],
        ['electron-launch', 'fulfilled'],
        ['main-window-selection', 'entered'],
        ['main-window-native-association', 'entered'],
        ['main-window-native-association', 'rejected'],
        ['main-window-selection', 'rejected'],
      ],
      failureHistoryStages: [
        'window-observed',
        'inspection-entered',
        'inspection-rejected',
        'selection-rejected',
      ],
    },
    evaluationRejected: {
      operations: [
        'electron-launch',
        'native-association',
        'native-evaluate',
        'native-dispose',
      ],
      observations: [
        ['electron-launch', 'entered'],
        ['electron-launch', 'fulfilled'],
        ['main-window-selection', 'entered'],
        ['main-window-native-association', 'entered'],
        ['main-window-native-association', 'fulfilled'],
        ['main-window-native-evaluate', 'entered'],
        ['main-window-native-evaluate', 'rejected'],
        ['main-window-native-dispose', 'entered'],
        ['main-window-native-dispose', 'fulfilled'],
        ['main-window-selection', 'rejected'],
      ],
      failureHistoryStages: [
        'window-observed',
        'inspection-entered',
        'inspection-rejected',
        'selection-rejected',
      ],
    },
  };
  for (const [name, expected] of Object.entries(expectedMatched)) {
    const helper = matched.helper[name];
    const foreign = matched.foreign[name];
    assert.equal(helper.rejected, name !== 'fulfilled', name);
    assert.equal(foreign.rejected, name !== 'fulfilled', name);
    assert.deepEqual(
      helper.operations.map(({ operation }) => operation),
      expected.operations,
      `${name} helper operations`,
    );
    assert.deepEqual(
      foreign.operations.map(({ operation }) => operation),
      expected.operations,
      `${name} foreign operations`,
    );
    assert.equal(helper.operations.length, foreign.operations.length, name);
    assert.deepEqual(
      helper.records.map(({ stage, outcome }) => [stage, outcome]),
      expected.observations,
      `${name} helper observations`,
    );
    assert.deepEqual(
      foreign.records.map(({ stage, outcome }) => [stage, outcome]),
      expected.observations,
      `${name} foreign observations`,
    );
    assert.deepEqual(
      helper.failureHistoryStages,
      expected.failureHistoryStages,
      `${name} helper history`,
    );
    assert.deepEqual(
      foreign.failureHistoryStages,
      expected.failureHistoryStages,
      `${name} foreign history`,
    );
    if (name !== 'fulfilled') {
      assert.equal(helper.rejectionIdentity, true, name);
      assert.equal(helper.rejectionCauseIdentity, true, name);
      assert.equal(foreign.rejectionIdentity, true, name);
      assert.equal(foreign.rejectionCauseIdentity, true, name);
    }
  }
});

test('actual launchCanopy route removes a failed Windows launch data root only after its launcher closes', () => {
  const {
    windowsLauncherCloses,
    windowsLauncherUnobservable,
    darwinLauncherCloses,
  } = runLaunchObservation().launchFailures;
  const removals = [
    ['remove', '/owned-generated'],
    ['remove', '/owned-generated-secure'],
  ];
  assert.deepEqual(windowsLauncherCloses.operations, [
    'app-close',
    'launcher-close',
    ...removals,
  ]);
  assert.equal(windowsLauncherCloses.rejectionIsLaunchFailure, true);
  // Without an observable close, both roots stay and the failure names them.
  assert.deepEqual(windowsLauncherUnobservable.operations, ['app-close']);
  assert.equal(windowsLauncherUnobservable.rejectionName, 'AggregateError');
  assert.equal(windowsLauncherUnobservable.firstErrorIsLaunchFailure, true);
  assert.equal(
    windowsLauncherUnobservable.retainedName,
    'ElectronTerminalResultError',
  );
  assert.match(
    windowsLauncherUnobservable.rejectionMessage,
    /user-data-retained@\d+ms\(reason=launcher-open,userDataDir=\/owned-generated\)/,
  );
  // macOS and Linux keep removing the roots right after app.close().
  assert.deepEqual(darwinLauncherCloses.operations, [
    'app-close',
    ...removals,
    'launcher-close',
  ]);
  assert.equal(darwinLauncherCloses.rejectionIsLaunchFailure, true);
});

test('main-window selection observes navigation commit without waiting for DOM or Advisor readiness', async () => {
  const fixture = selectionFixture();
  const main = fixture.addPage(applicationWindow({ url: 'about:blank' }));
  const advisor = fixture.addPage(applicationWindow({ url: 'about:blank' }));
  let settled = false;
  const selected = fixture.select().then((page) => {
    settled = true;
    return page;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  advisor.navigate(`${rendererUrl}?surface=app-advisor`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  main.navigate(rendererUrl);
  assert.equal(await selected, main);
  assert.equal(advisor.isClosed(), false);
  assertSelectionListenersRemoved(fixture, [main, advisor]);
});

test('main-window selection rechecks a valid owner on load after its native URL becomes available', async () => {
  const fixture = selectionFixture();
  const owner = applicationWindow({ url: '' });
  const main = fixture.addPage(owner, rendererUrl);
  const selected = fixture.select({ timeout: 50 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.disposed(), 1, 'initial native inspection completed');
  owner.url = rendererUrl;
  main.emit('load');
  try {
    assert.equal(await selected, main);
  } catch (error) {
    assert.match(error.message, /Timed out identifying the application window/);
    const evidence = error.mainWindowSelection;
    assert.equal(evidence.expectedUrl, rendererUrl);
    assert.deepEqual(
      evidence.events
        .filter(({ stage }) => stage === 'inspection')
        .map(({ nativeOwner, destroyed, parent, nativeUrl, pageUrl }) => ({
          nativeOwner,
          destroyed,
          parent,
          nativeUrl,
          pageUrl,
        })),
      [
        {
          nativeOwner: true,
          destroyed: false,
          parent: false,
          nativeUrl: 'unavailable',
          pageUrl: rendererUrl,
        },
      ],
    );
    assert.fail(
      `A normal load event did not recheck the native URL: ${JSON.stringify(evidence)}`,
    );
  }
  assert.equal(
    fixture.disposed(),
    2,
    'load triggered a second native inspection',
  );
  assertSelectionListenersRemoved(fixture, [main]);
  assert.equal(main.listenerCount('load'), 0);
});

test('main-window selection supports an exact Windows file entry and ignores only its hash', async () => {
  const expected = 'file:///C:/Program%20Files/App/renderer/index.html';
  const fixture = selectionFixture(expected);
  fixture.addPage(
    applicationWindow({ url: 'file:///C:/other/renderer/index.html' }),
  );
  const main = fixture.addPage(applicationWindow({ url: `${expected}#/main` }));
  assert.equal(await fixture.select(), main);
});

test('main-window selection invalidates a closed cached page', async () => {
  const fixture = selectionFixture();
  const original = fixture.addPage(applicationWindow());
  assert.equal(await fixture.select(), original);
  original.close();
  const replacement = fixture.addPage(applicationWindow());
  assert.equal(await fixture.select(), replacement);
  assert.equal(fixture.disposed(), 2);
});

test('main-window selection rejects app closure and removes its owned listeners', async () => {
  const fixture = selectionFixture();
  const blank = fixture.addPage(applicationWindow({ url: 'about:blank' }));
  const selected = fixture.select();
  fixture.app.emit('close');
  await assert.rejects(selected, /Electron closed before/);
  assertSelectionListenersRemoved(fixture, [blank]);
});

test('main-window selection has a bounded deadline without waiting for maintenance completion', async () => {
  const fixture = selectionFixture();
  const maintenance = fixture.addPage(null);
  await assert.rejects(fixture.select({ timeout: 5 }), /Timed out identifying/);
  assert.equal(maintenance.isClosed(), false);
  assert.equal(fixture.disposed(), 1);
  assertSelectionListenersRemoved(fixture, [maintenance]);
});

test('main-window timeout retains independent native/page inspection values and event order', async () => {
  const fixture = selectionFixture();
  const owner = applicationWindow();
  const page = fixture.addPage(owner, 'about:blank');
  const selected = fixture.select({ timeout: 20 });
  await new Promise((resolve) => setImmediate(resolve));
  page.setPageUrl(`${rendererUrl}?surface=app-advisor&token=private-secret`);
  page.emit('framenavigated', page.mainFrame());
  await assert.rejects(selected, (error) => {
    assert.match(error.message, /Timed out identifying/);
    const evidence = error.mainWindowSelection;
    assert.equal(evidence.expectedUrl, rendererUrl);
    const inspections = evidence.events.filter(
      (event) => event.stage === 'inspection',
    );
    assert.equal(inspections[0].nativeUrl, rendererUrl);
    assert.equal(inspections[0].pageUrl, 'about:blank');
    assert.equal(inspections[0].nativeOwner, true);
    assert.equal(inspections[0].parent, false);
    assert.match(inspections[1].pageUrl, /surface=app-advisor/);
    assert.ok(
      evidence.events.some((event) => event.stage === 'main-frame-navigation'),
    );
    assert.deepEqual(
      evidence.events.map((event) => event.order),
      evidence.events.map((_, index) => index + 1),
    );
    assert.ok(!JSON.stringify(evidence).includes('private-secret'));
    return true;
  });
  assert.equal(fixture.disposed(), 2);
  assertSelectionListenersRemoved(fixture, [page]);
});

test('main-window evidence caps windows/events and preserves original inspection rejection', async () => {
  const fixture = selectionFixture();
  const pages = Array.from({ length: 100 }, () =>
    fixture.addPage(
      applicationWindow({
        url: 'https://remote.invalid/private?secret=hidden',
      }),
    ),
  );
  await assert.rejects(fixture.select({ timeout: 20 }), (error) => {
    assert.equal(error.mainWindowSelection.truncated, true);
    assert.ok(error.mainWindowSelection.events.length <= 64);
    assert.ok(
      Buffer.byteLength(JSON.stringify(error.mainWindowSelection)) <= 32768,
    );
    assert.ok(!JSON.stringify(error.mainWindowSelection).includes('private'));
    return true;
  });
  assertSelectionListenersRemoved(fixture, pages);
  const failure = new Error('native inspection rejected');
  fixture.app.browserWindow = () => Promise.reject(failure);
  await assert.rejects(fixture.select(), (error) => {
    assert.equal(error, failure);
    assert.ok(
      error.mainWindowSelection.events.some(
        (event) => event.stage === 'inspection-rejected',
      ),
    );
    return true;
  });
  assertSelectionListenersRemoved(fixture, pages);
});

test('release-like launches explicitly request isolated E2E logging', () => {
  assert.deepEqual(buildE2eLaunchMarkerEnv('production'), {
    CANOPY_E2E_ISOLATED_LOGGING: '1',
    CANOPY_E2E_SHOW_WINDOW: '0',
  });
  assert.deepEqual(buildE2eLaunchMarkerEnv('production', true), {
    CANOPY_E2E_ISOLATED_LOGGING: '1',
    CANOPY_E2E_SHOW_WINDOW: '1',
  });
  assert.deepEqual(buildE2eLaunchMarkerEnv(undefined), {
    CANOPY_E2E_SHOW_WINDOW: '0',
  });
});

test('ordinary E2E launches ignore an inherited headed-window request', () => {
  const previous = process.env.CANOPY_E2E_SHOW_WINDOW;
  process.env.CANOPY_E2E_SHOW_WINDOW = '1';
  try {
    const headless = buildElectronEnv('/tmp/canopy-headless-default');
    assert.equal(headless.CANOPY_E2E_SHOW_WINDOW, '0');

    const headed = buildElectronEnv('/tmp/canopy-headed-opt-in', {
      CANOPY_E2E_SHOW_WINDOW: '1',
    });
    assert.equal(headed.CANOPY_E2E_SHOW_WINDOW, '1');
  } finally {
    if (previous === undefined) delete process.env.CANOPY_E2E_SHOW_WINDOW;
    else process.env.CANOPY_E2E_SHOW_WINDOW = previous;
  }
});

test('E2E launches render offscreen only when the launch asks for it', () => {
  const previous = process.env.CANOPY_E2E_OFFSCREEN_WINDOW;
  process.env.CANOPY_E2E_OFFSCREEN_WINDOW = '1';
  try {
    const inherited = buildElectronEnv('/tmp/canopy-offscreen-default');
    assert.equal(
      Object.hasOwn(inherited, 'CANOPY_E2E_OFFSCREEN_WINDOW'),
      false,
    );
    const requested = buildElectronEnv('/tmp/canopy-offscreen-opt-in', {
      CANOPY_E2E_OFFSCREEN_WINDOW: '1',
    });
    assert.equal(requested.CANOPY_E2E_OFFSCREEN_WINDOW, '1');
  } finally {
    if (previous === undefined) delete process.env.CANOPY_E2E_OFFSCREEN_WINDOW;
    else process.env.CANOPY_E2E_OFFSCREEN_WINDOW = previous;
  }
});

test('E2E launches isolate Claude and Codex state inside launch data', () => {
  const userDataDir = path.join(tmpdir(), 'canopy-e2e-provider-state');
  const env = buildElectronEnv(userDataDir, {
    CLAUDE_CONFIG_DIR: '/real/claude-state',
    CODEX_HOME: '/real/codex-state',
  });

  assert.equal(
    env.CLAUDE_CONFIG_DIR,
    path.join(userDataDir, 'provider-state', 'claude'),
  );
  assert.equal(
    env.CODEX_HOME,
    path.join(userDataDir, 'provider-state', 'codex'),
  );
});

test('explicit live-provider launches preserve the caller provider state', () => {
  const userDataDir = path.join(tmpdir(), 'canopy-live-provider-state');
  const env = buildElectronEnv(
    userDataDir,
    {
      CLAUDE_CONFIG_DIR: '/real/claude-state',
      CODEX_HOME: '/real/codex-state',
    },
    { preserveProviderState: true },
  );

  assert.equal(env.CLAUDE_CONFIG_DIR, '/real/claude-state');
  assert.equal(env.CODEX_HOME, '/real/codex-state');
});

test('E2E launches create both isolated provider state roots', () => {
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), 'canopy-e2e-provider-roots-'),
  );
  try {
    prepareIsolatedProviderState(userDataDir);
    assert.equal(
      existsSync(path.join(userDataDir, 'provider-state', 'claude')),
      true,
    );
    assert.equal(
      existsSync(path.join(userDataDir, 'provider-state', 'codex')),
      true,
    );
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});

test('E2E launch fails once when its main entrypoint is missing without falling back to production', () => {
  const checked = [];
  assert.throws(
    () =>
      resolveE2eMainEntryPath('/repo', (candidate) => {
        checked.push(candidate);
        return candidate === path.join('/repo', 'out', 'main', 'index.js');
      }),
    /Missing the E2E main bundle.*npm run build:e2e/,
  );
  assert.deepEqual(checked, [
    path.join('/repo', 'out-e2e', 'main', 'index.js'),
  ]);
});

test('E2E launch resolves an explicitly isolated variant output directory', () => {
  const expected = path.join('/repo', 'out-e2e-internal', 'main', 'index.js');
  assert.equal(
    resolveE2eMainEntryPath(
      '/repo',
      (candidate) => candidate === expected,
      'out-e2e-internal',
    ),
    expected,
  );
});

test('release-like launch resolves a production bundle from an explicit checkout', () => {
  const expected = path.join('/baseline', 'out', 'main', 'index.js');
  assert.equal(
    resolveProductionMainEntryPath(
      '/baseline',
      (candidate) => candidate === expected,
    ),
    expected,
  );
});

test('release-like launch uses the explicit checkout as its runtime root', () => {
  assert.equal(resolveLaunchRuntimeRoot('/baseline'), '/baseline');
  assert.equal(resolveLaunchRuntimeRoot(undefined), path.resolve('.'));
});

test('abrupt Electron cleanup targets the supervised process tree, not the Playwright launcher', async () => {
  const kills = [];
  const killAbruptly = createAbruptTreeKiller(2468, async (pid, signal) => {
    kills.push([pid, signal]);
  });

  await killAbruptly();

  assert.deepEqual(kills, [[2468, 'SIGKILL']]);
});

test('supervised Electron PID files reject missing or malformed process identities', () => {
  assert.equal(parseSupervisedTreePid('2468\n'), 2468);
  assert.throws(() => parseSupervisedTreePid(''), /valid process-tree PID/);
  assert.throws(
    () => parseSupervisedTreePid('not-a-pid'),
    /valid process-tree PID/,
  );
});

test('Electron terminal observer retains distinct exit and close tuples without changing the child', () => {
  const child = new EventEmitter();
  child.pid = 2468;
  const app = {
    processCalls: 0,
    process() {
      this.processCalls++;
      return child;
    },
  };

  const result = observeElectronTerminalResult(app);
  assert.equal(app.processCalls, 1);
  assert.equal(child.listenerCount('exit'), 1);
  assert.equal(child.listenerCount('close'), 1);
  assert.equal(child.listenerCount('error'), 1);
  assert.deepEqual(result, {
    pid: 2468,
    exit: undefined,
    close: undefined,
    error: undefined,
  });

  child.emit('exit', 125, null);
  assert.deepEqual(result.exit, { code: 125, signal: null });
  assert.equal(result.close, undefined);
  child.emit('close', 125, null);
  assert.deepEqual(result.close, { code: 125, signal: null });
  assert.equal(app.processCalls, 1);
});

test('Electron terminal observer retains bounded child errors and rejects unavailable handles without side effects', () => {
  const child = new EventEmitter();
  child.pid = 9753;
  const observed = observeElectronTerminalResult({ process: () => child });
  child.emit('error', new Error('terminal stream failed'));
  assert.deepEqual(observed.error, {
    name: 'Error',
    message: 'terminal stream failed',
  });
  assert.equal(observed.exit, undefined);
  assert.equal(observed.close, undefined);
  assert.equal(observed.closeUnobservable, undefined);

  const unavailable = observeElectronTerminalResult({ process: () => null });
  assert.equal(unavailable.pid, undefined);
  assert.match(unavailable.error?.message ?? '', /observable child process/);
  assert.equal(unavailable.closeUnobservable, true);
  assert.equal(Object.keys(unavailable).includes('closeUnobservable'), false);

  const thrown = observeElectronTerminalResult({
    process: () => {
      throw new Error('process unavailable');
    },
  });
  assert.deepEqual(thrown.error, {
    name: 'Error',
    message: 'process unavailable',
  });
  assert.equal(thrown.closeUnobservable, true);
});

test('Electron terminal observer keeps each launch result isolated and uses the installed target-closed constructor', () => {
  const first = new EventEmitter();
  first.pid = 1;
  const second = new EventEmitter();
  second.pid = 2;
  const firstResult = observeElectronTerminalResult({ process: () => first });
  const secondResult = observeElectronTerminalResult({ process: () => second });
  first.emit('exit', 0, null);
  first.emit('close', 0, null);
  assert.deepEqual(firstResult.exit, { code: 0, signal: null });
  assert.equal(secondResult.exit, undefined);

  const require = createRequire(import.meta.url);
  const packagePath = require.resolve('playwright-core/package.json');
  const { TargetClosedError } = require(
    path.join(path.dirname(packagePath), 'lib/client/errors.js'),
  );
  assert.equal(isPlaywrightTargetClosedError(new TargetClosedError()), true);
  assert.equal(
    isPlaywrightTargetClosedError(new Error('Target closed')),
    false,
  );
});

test('Windows ordinary close rejects a complete nonzero terminal tuple after mandatory cleanup', async () => {
  const events = [];
  const app = {
    close: async () => {
      events.push('close');
    },
  };
  registerSupervisedProcessTree(app, 2468);
  registerElectronTerminalObservation(app, {
    pid: 1357,
    exit: { code: 125, signal: null },
    close: { code: 125, signal: null },
    error: undefined,
  });

  await assert.rejects(
    closeCanopy(app, '/unused', {
      keepUserData: true,
      reapTree: async (pid) => {
        assert.equal(pid, 2468);
        events.push('reap');
      },
    }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error?.result?.pid === 1357 &&
      error?.result?.exit?.code === 125 &&
      error?.result?.close?.code === 125,
  );
  assert.deepEqual(events, ['close', 'reap']);
});

/**
 * The Windows close seen on the desktop runner: app.quit() ends Electron and
 * its wrapper, so Playwright's close resolves on the CDP disconnect while the
 * cmd.exe launcher is still running the supervisor's cleanup.
 */
function windowsLauncherApp({ launcherClosesAtMs, exitCode = 0 }) {
  const child = new EventEmitter();
  child.pid = 7531;
  const events = [];
  let clock = 0;
  const app = {
    process: () => child,
    evaluate: async () => {
      events.push('quit');
    },
    close: async () => {
      events.push('playwright-close');
    },
  };
  registerSupervisedProcessTree(app, 2468);
  registerElectronTerminalObservation(app);
  return {
    app,
    events,
    elapsedMs: () => clock,
    options: {
      platform: 'win32',
      treeExists: () => false,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
        if (
          launcherClosesAtMs !== undefined &&
          clock >= launcherClosesAtMs &&
          child.listenerCount('close') > 0
        ) {
          events.push('launcher-closed');
          child.emit('exit', exitCode, null);
          child.emit('close', exitCode, null);
        }
      },
      reapTree: async (pid) => {
        events.push(['reap', pid]);
      },
      removeDataDir: async (dir) => {
        events.push(['remove', dir]);
      },
    },
  };
}

test('Windows close waits for the launcher to finish supervisor cleanup before its terminal check', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: 20_000 });
  await closeCanopy(launch.app, '/data', launch.options);
  // A retired Windows PID may already be reused, so it is never reaped; the
  // data roots go only after the supervisor has finished with them.
  assert.deepEqual(launch.events, [
    'quit',
    'playwright-close',
    'launcher-closed',
    ['remove', '/data'],
    ['remove', '/data-secure'],
  ]);
  assert.equal(launch.elapsedMs(), 20_000);
});

test('Windows close reports a nonzero launcher result once the launcher closes', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: 50, exitCode: 125 });
  await assert.rejects(
    closeCanopy(launch.app, '/data', {
      ...launch.options,
      keepUserData: true,
    }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error.result.exit?.code === 125 &&
      error.result.close?.code === 125,
  );
});

test('Windows close bounds the launcher wait, keeps the data roots, and reports the missing result', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  await assert.rejects(
    closeCanopy(launch.app, '/data', {
      ...launch.options,
      windowsLauncherCloseTimeoutMs: 1_234,
    }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error.result.pid === 7531 &&
      error.result.exit === undefined &&
      error.result.close === undefined &&
      error.diagnostics.closeSteps.some(
        (step) =>
          step.startsWith('user-data-retained@') &&
          step.endsWith('(reason=launcher-open,userDataDir=/data)'),
      ) &&
      error.message.includes('userDataDir=/data'),
  );
  assert.equal(launch.elapsedMs(), 1_234);
  // The still-open launcher's supervisor may be using the roots, so neither
  // is removed and the old numeric PID is still not reaped.
  assert.deepEqual(launch.events, ['quit', 'playwright-close']);
});

test('Windows close still fails and keeps the data roots when the launcher closes just after its wait expires', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  const child = launch.app.process();
  const timeoutMs = 1_234;
  let lateReads = 0;
  await assert.rejects(
    closeCanopy(launch.app, '/data', {
      ...launch.options,
      windowsLauncherCloseTimeoutMs: timeoutMs,
      now: () => {
        const clock = launch.options.now();
        // The first read at the deadline ends the wait; the launcher closes
        // on the next, before the data-root decision and validation run.
        if (clock >= timeoutMs && ++lateReads === 2) {
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        }
        return clock;
      },
    }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error.result.close === undefined &&
      error.diagnostics.closeSteps.some((step) =>
        step.startsWith('user-data-retained@'),
      ),
  );
  assert.equal(launch.app.process().listenerCount('close'), 0);
  assert.equal(lateReads >= 2, true);
  assert.deepEqual(launch.events, ['quit', 'playwright-close']);
});

test('Windows close with kept user data reports an expired launcher wait without a retention step', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  await assert.rejects(
    closeCanopy(launch.app, '/data', {
      ...launch.options,
      keepUserData: true,
      windowsLauncherCloseTimeoutMs: 1_234,
    }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error.result.close === undefined &&
      !error.diagnostics.closeSteps.some((step) =>
        step.startsWith('user-data-retained@'),
      ),
  );
  assert.deepEqual(launch.events, ['quit', 'playwright-close']);
});

test('Windows close keeps the data roots when the launcher reports a child error without closing', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  const child = launch.app.process();
  const timeoutMs = 1_234;
  let errored = false;
  const wait = launch.options.wait;
  await assert.rejects(
    closeCanopy(launch.app, '/data', {
      ...launch.options,
      windowsLauncherCloseTimeoutMs: timeoutMs,
      wait: async (ms) => {
        await wait(ms);
        // An undeliverable signal surfaces as `error` while the launcher, and
        // its supervisor's cleanup, keep running.
        if (!errored && launch.elapsedMs() >= 50) {
          errored = true;
          child.emit('error', new Error('kill EPERM'));
        }
      },
    }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error.result.error?.message === 'kill EPERM' &&
      error.result.close === undefined &&
      error.diagnostics.closeSteps.some((step) =>
        step.startsWith('launcher-close-wait-complete@'),
      ) &&
      error.diagnostics.closeSteps.some(
        (step) =>
          step.startsWith('user-data-retained@') &&
          step.endsWith('(reason=launcher-open,userDataDir=/data)'),
      ),
  );
  assert.equal(errored, true);
  assert.equal(launch.elapsedMs(), timeoutMs);
  assert.deepEqual(launch.events, ['quit', 'playwright-close']);
});

test('Windows close keeps the data roots when a child error was recorded before close began', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  launch.app.process().emit('error', new Error('kill EPERM'));
  await assert.rejects(
    closeCanopy(launch.app, '/data', {
      ...launch.options,
      windowsLauncherCloseTimeoutMs: 1_234,
    }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error.result.error?.message === 'kill EPERM' &&
      error.result.close === undefined &&
      error.diagnostics.closeSteps.some((step) =>
        step.startsWith('user-data-retained@'),
      ),
  );
  assert.equal(launch.elapsedMs(), 1_234);
  assert.deepEqual(launch.events, ['quit', 'playwright-close']);
});

test('Windows close keeps the data roots without waiting when the launcher could not be observed', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  const app = { ...launch.app, process: () => null };
  registerSupervisedProcessTree(app, 2468);
  registerElectronTerminalObservation(
    app,
    observeElectronTerminalResult(app, { platform: 'win32' }),
  );
  await assert.rejects(
    closeCanopy(app, '/data', launch.options),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      /observable child process/.test(error.result.error?.message ?? '') &&
      error.diagnostics.closeSteps.includes(
        'launcher-close-wait-complete@0ms(launcherClosed=false,waitedMs=0)',
      ) &&
      error.diagnostics.closeSteps.some((step) =>
        step.startsWith('user-data-retained@'),
      ),
  );
  assert.equal(launch.elapsedMs(), 0);
  assert.deepEqual(launch.events, ['quit', 'playwright-close']);
});

test('Windows close removes the data roots only after a child error is followed by the launcher close', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: 500, exitCode: 1 });
  const child = launch.app.process();
  let errored = false;
  const wait = launch.options.wait;
  await assert.rejects(
    closeCanopy(launch.app, '/data', {
      ...launch.options,
      wait: async (ms) => {
        if (!errored && launch.elapsedMs() + ms >= 50) {
          errored = true;
          launch.events.push('launcher-error');
          child.emit('error', new Error('kill EPERM'));
        }
        await wait(ms);
      },
    }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error.result.error?.message === 'kill EPERM' &&
      error.result.close?.code === 1 &&
      !error.diagnostics.closeSteps.some((step) =>
        step.startsWith('user-data-retained@'),
      ),
  );
  assert.equal(launch.elapsedMs(), 500);
  assert.deepEqual(launch.events, [
    'quit',
    'playwright-close',
    'launcher-error',
    'launcher-closed',
    ['remove', '/data'],
    ['remove', '/data-secure'],
  ]);
});

test('Windows close keeps the data roots and reports both failures when Playwright close fails and the launcher wait expires', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  const closeFailure = new Error('playwright close failed');
  launch.app.close = async () => {
    launch.events.push('playwright-close');
    throw closeFailure;
  };
  await assert.rejects(
    closeCanopy(launch.app, '/data', {
      ...launch.options,
      windowsLauncherCloseTimeoutMs: 1_234,
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors[0] === closeFailure &&
      error.errors[1]?.name === 'ElectronTerminalResultError' &&
      error.errors[1].result.close === undefined &&
      error.errors[1].diagnostics.closeSteps.some((step) =>
        step.startsWith('user-data-retained@'),
      ),
  );
  // Without a completed Playwright close the supervised tree is reaped, but
  // the roots stay while the launcher is open.
  assert.deepEqual(launch.events, ['quit', 'playwright-close', ['reap', 2468]]);
});

test('Windows close keeps the data roots when Playwright close times out and the launcher wait expires', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  launch.app.close = () => {
    launch.events.push('playwright-close');
    return new Promise(() => {});
  };
  await assert.rejects(
    closeCanopy(launch.app, '/data', {
      ...launch.options,
      windowsLauncherCloseTimeoutMs: 1_234,
      scheduleTimeout: (resolve) => {
        queueMicrotask(resolve);
        return 1;
      },
      cancelTimeout: () => {},
    }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error.result.close === undefined &&
      error.diagnostics.closeSteps.some((step) =>
        step.startsWith('playwright-close-complete@0ms(status=timed-out)'),
      ) &&
      error.diagnostics.closeSteps.some((step) =>
        step.startsWith('user-data-retained@'),
      ),
  );
  assert.deepEqual(launch.events, ['quit', 'playwright-close', ['reap', 2468]]);
});

test('Windows launch failure keeps the data roots and names them when the launcher wait expires', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  const playwrightClose = launch.app.close;
  launch.app.close = async () => {
    await launch.options.wait(300);
    return playwrightClose();
  };
  const launchError = new Error('E2E supervisor PID file missing');
  await assert.rejects(
    cleanupFailedLaunch(launch.app, '/data', launchError, {
      ...launch.options,
      windowsLauncherCloseTimeoutMs: 1_234,
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.length === 2 &&
      error.errors[0] === launchError &&
      error.errors[1]?.name === 'ElectronTerminalResultError' &&
      error.errors[1].result.pid === 7531 &&
      error.errors[1].result.close === undefined &&
      error.errors[1].diagnostics.closeSteps.includes(
        'launcher-close-wait-complete@1534ms(launcherClosed=false,waitedMs=1234)',
      ) &&
      error.errors[1].diagnostics.closeSteps.includes(
        'user-data-retained@1534ms(reason=launcher-open,userDataDir=/data)',
      ) &&
      error.message.includes(launchError.message) &&
      error.message.includes('userDataDir=/data'),
  );
  assert.equal(launch.elapsedMs(), 1_534);
  // Neither root is removed, and the possibly reused PID is never reaped.
  assert.deepEqual(launch.events, ['playwright-close']);
});

test('Windows launch failure keeps the data roots when the launcher closes just after its wait expires', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  const child = launch.app.process();
  const launchError = new Error('launch failed');
  let lateReads = 0;
  await assert.rejects(
    cleanupFailedLaunch(launch.app, '/data', launchError, {
      ...launch.options,
      windowsLauncherCloseTimeoutMs: 1_234,
      now: () => {
        const clock = launch.options.now();
        if (clock >= 1_234 && ++lateReads === 2) {
          child.emit('exit', 0, null);
          child.emit('close', 0, null);
        }
        return clock;
      },
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === launchError &&
      error.errors[1]?.result.close === undefined &&
      error.errors[1].diagnostics.closeSteps.some((step) =>
        step.startsWith('user-data-retained@'),
      ),
  );
  assert.equal(lateReads >= 2, true);
  assert.deepEqual(launch.events, ['playwright-close']);
});

test('Windows launch failure removes the data roots only after the launcher closes', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: 700 });
  const launchError = new Error('launch failed');
  await assert.rejects(
    cleanupFailedLaunch(launch.app, '/data', launchError, launch.options),
    (error) => error === launchError,
  );
  assert.equal(launch.elapsedMs(), 700);
  assert.deepEqual(launch.events, [
    'playwright-close',
    'launcher-closed',
    ['remove', '/data'],
    ['remove', '/data-secure'],
  ]);
});

test('Windows launch failure keeps the data roots without waiting when the launcher could not be observed', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  const app = { ...launch.app, process: () => null };
  registerElectronTerminalObservation(
    app,
    observeElectronTerminalResult(app, { platform: 'win32' }),
  );
  const launchError = new Error('launch failed');
  await assert.rejects(
    cleanupFailedLaunch(app, '/data', launchError, launch.options),
    (error) =>
      error instanceof AggregateError &&
      error.errors[0] === launchError &&
      /observable child process/.test(
        error.errors[1]?.result.error?.message ?? '',
      ) &&
      error.errors[1].diagnostics.closeSteps.includes(
        'user-data-retained@0ms(reason=launcher-open,userDataDir=/data)',
      ),
  );
  assert.equal(launch.elapsedMs(), 0);
  assert.deepEqual(launch.events, ['playwright-close']);
});

test('Windows launch failure with a caller-owned data root neither waits nor removes it', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  const launchError = new Error('launch failed');
  await assert.rejects(
    cleanupFailedLaunch(launch.app, '/data', launchError, {
      ...launch.options,
      reuseDir: true,
    }),
    (error) => error === launchError,
  );
  assert.equal(launch.elapsedMs(), 0);
  assert.deepEqual(launch.events, ['playwright-close']);
});

test('launch failure before Electron starts removes the data roots without waiting', async () => {
  const events = [];
  const launchError = new Error('electron.launch rejected');
  await assert.rejects(
    cleanupFailedLaunch(undefined, '/data', launchError, {
      platform: 'win32',
      wait: async () => {
        events.push('wait');
      },
      removeDataDir: async (dir) => {
        events.push(['remove', dir]);
      },
    }),
    (error) => error === launchError,
  );
  assert.deepEqual(events, [
    ['remove', '/data'],
    ['remove', '/data-secure'],
  ]);
});

test('non-Windows launch failure removes the data roots at once, even with an open launcher observation', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  const launchError = new Error('launch failed');
  for (const platform of ['darwin', 'linux']) {
    launch.events.length = 0;
    await assert.rejects(
      cleanupFailedLaunch(launch.app, '/data', launchError, {
        ...launch.options,
        platform,
      }),
      (error) => error === launchError,
    );
    assert.deepEqual(launch.events, [
      'playwright-close',
      ['remove', '/data'],
      ['remove', '/data-secure'],
    ]);
  }
  assert.equal(launch.elapsedMs(), 0);
});

function launcherChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  return child;
}

test('Windows terminal observation keeps bounded launcher output without changing its result shape', async () => {
  const child = launcherChild(4321);
  const observed = observeElectronTerminalResult(
    { process: () => child },
    { platform: 'win32' },
  );
  assert.deepEqual(observed, {
    pid: 4321,
    exit: undefined,
    close: undefined,
    error: undefined,
  });
  assert.equal(Object.keys(observed).includes('launcherOutput'), false);

  for (let line = 0; line < 40; line += 1)
    child.stdout.write(`[shutdown] stage ${line}\n`);
  // A line split across chunks, CRLF endings, and a UTF-8 character split
  // between chunks are each kept whole.
  const accented = Buffer.from('é');
  child.stderr.write(
    Buffer.concat([
      Buffer.from('[e2e-supervisor] Exi'),
      accented.subarray(0, 1),
    ]),
  );
  child.stderr.write(
    Buffer.concat([accented.subarray(1), Buffer.from('ting with code 1\r\n')]),
  );
  child.stderr.write(
    `Fatal uncaught exception in main process: ${'x'.repeat(600)}\n`,
  );
  child.stderr.end('[e2e-supervisor] trailing line without newline');
  child.stdout.end();
  // Flowing streams deliver their data and end on later ticks.
  for (let tick = 0; tick < 3; tick += 1)
    await new Promise((resolve) => setImmediate(resolve));

  const output = observed.launcherOutput;
  assert.deepEqual(output.pinned.slice(0, 1), [
    'err: [e2e-supervisor] Exiéting with code 1',
  ]);
  assert.equal(output.pinned.length, 3);
  assert.equal(output.pinned[1].length, 'err: '.length + 400);
  assert.ok(output.pinned[1].endsWith('…'));
  assert.equal(
    output.pinned[2],
    'err: [e2e-supervisor] trailing line without newline',
  );
  assert.equal(output.tail.length, 30);
  assert.equal(output.tail[0], 'out: [shutdown] stage 13');
  assert.equal(output.tail.at(-1), output.pinned[2]);
});

test('POSIX terminal observation does not read the launcher streams', () => {
  const child = launcherChild(4322);
  const observed = observeElectronTerminalResult(
    { process: () => child },
    { platform: 'darwin' },
  );
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
  assert.equal(observed.launcherOutput, undefined);
});

test('Windows close reports its steps and the launcher output with a nonzero launcher result', async () => {
  const child = launcherChild(7532);
  let clock = 0;
  const app = {
    process: () => child,
    evaluate: async () => undefined,
    close: async () => undefined,
  };
  registerSupervisedProcessTree(app, 2468);
  registerElectronTerminalObservation(
    app,
    observeElectronTerminalResult(app, { platform: 'win32' }),
  );
  let alive = true;
  await assert.rejects(
    closeCanopy(app, '/data', {
      keepUserData: true,
      platform: 'win32',
      gracefulCloseTimeoutMs: 100,
      forcedCloseTimeoutMs: 50,
      treeExists: () => alive,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
        if (clock >= 400 && alive) {
          alive = false;
          child.stderr.end(
            '[e2e-supervisor] Exiting with code 1: wrapper closed (code=1, signal=null); target exit not reported\n',
          );
          await new Promise((resolve) => setImmediate(resolve));
          child.emit('exit', 1, null);
          child.emit('close', 1, null);
        }
      },
      reapTree: async () => undefined,
    }),
    (error) => {
      assert.equal(error?.name, 'ElectronTerminalResultError');
      assert.equal(error.result.exit.code, 1);
      assert.deepEqual(error.diagnostics.closeSteps, [
        'start@0ms(platform=win32,supervisedTreePid=2468,controllerPid=' +
          `${process.pid})`,
        'quit-requested@0ms',
        'quit-wait-complete@100ms(gracefullyExited=false)',
        'exit-requested@100ms',
        'exit-wait-complete@150ms(forciblyExited=false)',
        'playwright-close-start@150ms',
        'playwright-close-complete@150ms(status=closed)',
        'reap-skipped-retired-windows-pid@150ms',
        'launcher-close-wait-complete@400ms(launcherClosed=true,waitedMs=250)',
        'complete@400ms',
      ]);
      assert.match(
        error.message,
        /\[terminal\.close-steps=start@0ms\(.*\) > quit-requested@0ms > .* > complete@400ms\]/,
      );
      assert.match(
        error.message,
        /\[terminal\.launcher-output\.pinned=err: \[e2e-supervisor\] Exiting with code 1: wrapper closed \(code=1, signal=null\); target exit not reported\]/,
      );
      return true;
    },
  );
});

test('terminal result errors add no diagnostics without close steps or launcher output', () => {
  const plain = new ElectronTerminalResultError(
    {
      pid: 5,
      exit: { code: 1, signal: null },
      close: { code: 1, signal: null },
    },
    { closeSteps: [] },
  );
  assert.equal(plain.diagnostics, undefined);
  assert.equal(plain.message.includes('terminal.close-steps'), false);
  assert.equal(plain.message.includes('terminal.launcher-output'), false);

  const observation = {
    pid: 6,
    exit: { code: 1, signal: null },
    close: { code: 1, signal: null },
  };
  Object.defineProperty(observation, 'launcherOutput', {
    value: {
      pinned: [],
      tail: Array.from({ length: 30 }, () => 'y'.repeat(400)),
    },
  });
  const bounded = new ElectronTerminalResultError(observation, {
    closeSteps: ['complete@1ms', 7, null],
  });
  assert.deepEqual(bounded.diagnostics.closeSteps, ['complete@1ms']);
  assert.equal(bounded.diagnostics.launcherOutput.pinned.length, 0);
  const suffix = bounded.message.slice(
    bounded.message.indexOf(' [terminal.close-steps='),
  );
  assert.equal(suffix.length, 6144);
  assert.ok(suffix.endsWith('…[truncated]'));
  assert.match(
    suffix,
    /^ \[terminal\.close-steps=complete@1ms\] \[terminal\.launcher-output\.pinned=none\] \[terminal\.launcher-output\.tail=y+/,
  );
});

test('POSIX close keeps its terminal error free of close steps', async () => {
  const child = new EventEmitter();
  child.pid = 1358;
  const app = { process: () => child, close: async () => undefined };
  registerSupervisedProcessTree(app, 1358);
  registerElectronTerminalObservation(app);
  await assert.rejects(
    closeCanopy(app, '/unused', {
      keepUserData: true,
      platform: 'darwin',
      treeExists: () => false,
      reapTree: async () => undefined,
    }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error.diagnostics === undefined &&
      !error.message.includes('terminal.close-steps'),
  );
});

test('Windows close waits 60 s for the launcher by default', async () => {
  const launch = windowsLauncherApp({ launcherClosesAtMs: undefined });
  await assert.rejects(
    closeCanopy(launch.app, '/data', { ...launch.options, keepUserData: true }),
    { name: 'ElectronTerminalResultError' },
  );
  assert.equal(launch.elapsedMs(), 60_000);
});

for (const [label, platform, observe] of [
  ['POSIX', 'darwin', true],
  ['Windows without a terminal observation', 'win32', false],
]) {
  test(`${label} close does not wait for a launcher`, async () => {
    const events = [];
    const child = new EventEmitter();
    child.pid = 1357;
    const app = {
      process: () => child,
      evaluate: async () => {},
      close: async () => {
        events.push('playwright-close');
      },
    };
    registerSupervisedProcessTree(app, 1357);
    if (observe) registerElectronTerminalObservation(app);
    const closing = closeCanopy(app, '/unused', {
      keepUserData: true,
      platform,
      treeExists: () => false,
      wait: async () => assert.fail('must not wait for a launcher'),
      reapTree: async (pid) => {
        events.push(['reap', pid]);
      },
    });
    if (observe)
      await assert.rejects(closing, { name: 'ElectronTerminalResultError' });
    else await closing;
    assert.deepEqual(
      events,
      platform === 'win32'
        ? ['playwright-close']
        : ['playwright-close', ['reap', 1357]],
    );
  });
}

test('launcher wait settles only on close and is bounded', async () => {
  let clock = 0;
  const timing = {
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
  };
  assert.equal(
    await waitForElectronTerminalResult(
      { close: { code: 0, signal: null } },
      { ...timing, wait: async () => assert.fail('already closed') },
    ),
    true,
  );
  // A child error, such as an undeliverable signal, does not prove the
  // launcher exited.
  assert.equal(
    await waitForElectronTerminalResult(
      { error: { name: 'Error', message: 'kill EPERM' } },
      { ...timing, timeoutMs: 80 },
    ),
    false,
  );
  assert.equal(clock, 80);
  // An exit alone is not settled: the launcher's stdio may still be open.
  assert.equal(
    await waitForElectronTerminalResult(
      { exit: { code: 0, signal: null } },
      { ...timing, timeoutMs: 120 },
    ),
    false,
  );
  assert.equal(clock, 200);
  // Without a close listener the launcher's close can never be seen.
  assert.equal(
    await waitForElectronTerminalResult(
      Object.defineProperty(
        { error: { name: 'Error', message: 'no child' } },
        'closeUnobservable',
        { value: true },
      ),
      { ...timing, wait: async () => assert.fail('close is unobservable') },
    ),
    false,
  );
  assert.equal(
    await waitForElectronTerminalResult(
      {
        error: { name: 'Error', message: 'kill EPERM' },
        close: { code: 1, signal: null },
      },
      { ...timing, wait: async () => assert.fail('already closed') },
    ),
    true,
  );
});

test('supervised PID file reads once off Windows and keeps the original read error', async () => {
  const missing = Object.assign(new Error('missing pid'), { code: 'ENOENT' });
  let reads = 0;
  await assert.rejects(
    readSupervisedTreePid('/data/.e2e-supervised-electron.pid', {
      platform: 'darwin',
      readFile: () => {
        reads += 1;
        throw missing;
      },
      wait: async () => assert.fail('POSIX reads must not wait'),
    }),
    (error) => error === missing,
  );
  assert.equal(reads, 1);
  assert.equal(
    await readSupervisedTreePid('/data/pid', {
      platform: 'linux',
      readFile: () => '2468\n',
    }),
    2468,
  );
});

test('supervised PID file on Windows waits for a missing or empty file to be written', async () => {
  let clock = 0;
  const contents = [undefined, '', '  \n', '9753\r\n'];
  const waits = [];
  const pid = await readSupervisedTreePid('C:\\data\\pid', {
    platform: 'win32',
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    readFile: (file, encoding) => {
      assert.equal(file, 'C:\\data\\pid');
      assert.equal(encoding, 'utf8');
      const value = contents.shift();
      if (value === undefined)
        throw Object.assign(new Error('missing pid'), { code: 'ENOENT' });
      return value;
    },
  });
  assert.equal(pid, 9753);
  assert.deepEqual(waits, [50, 50, 50]);
});

test('supervised PID file on Windows reports the original error at its deadline', async () => {
  let clock = 0;
  let reads = 0;
  const missing = Object.assign(new Error('missing pid'), { code: 'ENOENT' });
  await assert.rejects(
    readSupervisedTreePid('C:\\data\\pid', {
      platform: 'win32',
      timeoutMs: 120,
      now: () => clock,
      wait: async (ms) => {
        clock += ms;
      },
      readFile: () => {
        reads += 1;
        throw missing;
      },
    }),
    (error) => error === missing,
  );
  // Three polls inside the 120 ms window, then the final reported read.
  assert.equal(reads, 4);
});

test('supervised PID file on Windows does not retry malformed or unreadable files', async () => {
  const denied = Object.assign(new Error('denied'), { code: 'EPERM' });
  for (const [readFile, expected] of [
    [() => 'not-a-pid', /valid process-tree PID/],
    [
      () => {
        throw denied;
      },
      (error) => error === denied,
    ],
  ]) {
    await assert.rejects(
      readSupervisedTreePid('C:\\data\\pid', {
        platform: 'win32',
        readFile,
        wait: async () => assert.fail('must not wait'),
      }),
      expected,
    );
  }
});

test('Electron terminal registration observes once and never replaces the first exact-app result', () => {
  const child = new EventEmitter();
  child.pid = 2468;
  const app = {
    processCalls: 0,
    process() {
      this.processCalls++;
      return child;
    },
  };
  const first = registerElectronTerminalObservation(app);
  const replacement = {
    pid: 9999,
    exit: { code: 0, signal: null },
    close: { code: 0, signal: null },
    error: undefined,
  };
  assert.equal(registerElectronTerminalObservation(app), first);
  assert.equal(registerElectronTerminalObservation(app, replacement), first);
  assert.equal(app.processCalls, 1);
  assert.equal(child.listenerCount('exit'), 1);
  assert.equal(child.listenerCount('close'), 1);
  assert.equal(child.listenerCount('error'), 1);
});

test('Windows terminal close consumer accepts only a complete clean tuple and keeps apps isolated', async () => {
  const close = async () => {};
  const clean = { close };
  const invalid = { close };
  registerElectronTerminalObservation(clean, {
    pid: 111,
    exit: { code: 0, signal: null },
    close: { code: 0, signal: null },
    error: undefined,
  });
  registerElectronTerminalObservation(invalid, {
    pid: 222,
    exit: { code: 125, signal: null },
    close: { code: 125, signal: null },
    error: undefined,
  });
  await closeCanopy(clean, '/unused', { keepUserData: true });
  await assert.rejects(
    closeCanopy(invalid, '/unused', { keepUserData: true }),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error?.result?.pid === 222,
  );
});

test('Windows terminal close consumer rejects every incomplete, signaled, errored, conflicting, or invalid-PID observation', async () => {
  const cases = [
    ['missing exit', { pid: 1, close: { code: 0, signal: null } }],
    ['missing close', { pid: 2, exit: { code: 0, signal: null } }],
    [
      'signaled',
      {
        pid: 3,
        exit: { code: null, signal: 'SIGTERM' },
        close: { code: null, signal: 'SIGTERM' },
      },
    ],
    [
      'child error',
      {
        pid: 4,
        exit: { code: 0, signal: null },
        close: { code: 0, signal: null },
        error: new Error('child failed'),
      },
    ],
    [
      'conflicting tuples',
      {
        pid: 5,
        exit: { code: 0, signal: null },
        close: { code: 125, signal: null },
      },
    ],
    [
      'invalid pid',
      {
        pid: 0,
        exit: { code: 0, signal: null },
        close: { code: 0, signal: null },
      },
    ],
  ];
  for (const [label, observation] of cases) {
    const app = { close: async () => {} };
    registerElectronTerminalObservation(app, observation);
    await assert.rejects(
      closeCanopy(app, '/unused', { keepUserData: true }),
      (error) => error?.name === 'ElectronTerminalResultError',
      label,
    );
  }
});

test('Windows terminal observation remains enforced across repeated and concurrent close attempts', async () => {
  const app = { close: async () => {} };
  registerElectronTerminalObservation(app, {
    pid: 42,
    exit: { code: 125, signal: null },
    close: { code: 125, signal: null },
    error: undefined,
  });
  await assert.rejects(
    closeCanopy(app, '/unused', { keepUserData: true }),
    (error) => error?.name === 'ElectronTerminalResultError',
  );
  const results = await Promise.allSettled([
    closeCanopy(app, '/unused', { keepUserData: true }),
    closeCanopy(app, '/unused', { keepUserData: true }),
  ]);
  assert.deepEqual(
    results.map((result) => result.status),
    ['rejected', 'rejected'],
  );
  assert.ok(
    results.every(
      (result) =>
        result.reason?.name === 'ElectronTerminalResultError' &&
        result.reason?.result?.exit?.code === 125,
    ),
  );
});

test('Windows terminal rejection follows successful user and secure data removal', async () => {
  const userDataDir = mkdtempSync(
    path.join(tmpdir(), 'canopy-terminal-remove-'),
  );
  const secureUserDataDir = `${userDataDir}-secure`;
  mkdirSync(secureUserDataDir);
  writeFileSync(path.join(userDataDir, 'sentinel'), 'remove');
  writeFileSync(path.join(secureUserDataDir, 'sentinel'), 'remove');
  const app = { close: async () => {} };
  registerElectronTerminalObservation(app, {
    pid: 57,
    exit: { code: 125, signal: null },
    close: { code: 125, signal: null },
    error: undefined,
  });
  await assert.rejects(
    closeCanopy(app, userDataDir),
    (error) =>
      error?.name === 'ElectronTerminalResultError' &&
      error?.result?.pid === 57 &&
      error?.result?.exit?.code === 125,
  );
  assert.equal(existsSync(userDataDir), false);
  assert.equal(existsSync(secureUserDataDir), false);
});

test('Windows terminal close retains close, reap, and terminal failures in order without deleting unsafe data', async (t) => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'canopy-terminal-reap-'));
  const secureUserDataDir = `${userDataDir}-secure`;
  writeFileSync(path.join(userDataDir, 'sentinel'), 'retain');
  writeFileSync(secureUserDataDir, 'retain');
  t.after(() => {
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(secureUserDataDir, { recursive: true, force: true });
  });
  const closeFailure = new Error('close failed');
  const reapFailure = new Error('reap failed');
  const app = {
    close: async () => {
      throw closeFailure;
    },
  };
  registerSupervisedProcessTree(app, 642);
  registerElectronTerminalObservation(app, {
    pid: 642,
    exit: { code: 125, signal: null },
    close: { code: 125, signal: null },
    error: undefined,
  });
  await assert.rejects(
    closeCanopy(app, userDataDir, {
      reapTree: async () => {
        throw reapFailure;
      },
    }),
    (error) => {
      assert.equal(error?.name, 'AggregateError');
      assert.deepEqual(error.errors.slice(0, 2), [closeFailure, reapFailure]);
      assert.equal(error.errors[2]?.name, 'ElectronTerminalResultError');
      return true;
    },
  );
  assert.equal(existsSync(path.join(userDataDir, 'sentinel')), true);
  assert.equal(existsSync(secureUserDataDir), true);
});

test('Electron terminal result errors retain one snapshot and publish complete, missing, signaled, and conflicting tuples', () => {
  let pidReads = 0;
  const complete = new ElectronTerminalResultError({
    get pid() {
      pidReads += 1;
      return 2468;
    },
    exit: { code: 125, signal: null },
    close: { code: 125, signal: null },
  });
  assert.equal(pidReads, 1);
  assert.ok(complete instanceof ElectronTerminalResultError);
  assert.deepEqual(complete.result, {
    pid: 2468,
    exit: { code: 125, signal: null },
    close: { code: 125, signal: null },
    error: undefined,
  });
  assert.match(
    complete.message,
    /terminal\.pid=2468 terminal\.exit\.code=125 terminal\.exit\.signal=null terminal\.close\.code=125 terminal\.close\.signal=null terminal\.child-error\.name=missing terminal\.child-error\.message=missing/,
  );

  const missing = new ElectronTerminalResultError({ pid: 1 });
  assert.match(
    missing.message,
    /terminal\.exit\.code=missing terminal\.exit\.signal=missing terminal\.close\.code=missing terminal\.close\.signal=missing/,
  );

  const signaled = new ElectronTerminalResultError({
    pid: 2,
    exit: { code: null, signal: 'SIGTERM' },
    close: { code: null, signal: 'SIGTERM' },
  });
  assert.match(
    signaled.message,
    /terminal\.exit\.code=null terminal\.exit\.signal=SIGTERM terminal\.close\.code=null terminal\.close\.signal=SIGTERM/,
  );

  const conflicting = new ElectronTerminalResultError({
    pid: 3,
    exit: { code: 0, signal: null },
    close: { code: 125, signal: null },
  });
  assert.match(
    conflicting.message,
    /terminal\.exit\.code=0 terminal\.exit\.signal=null terminal\.close\.code=125 terminal\.close\.signal=null/,
  );

  const childFailure = new Error('child observation failed');
  childFailure.name = 'ChildObservationError';
  const childError = new ElectronTerminalResultError({
    pid: 4,
    exit: { code: 0, signal: null },
    close: { code: 0, signal: null },
    error: childFailure,
  });
  assert.deepEqual(childError.result.error, {
    name: 'ChildObservationError',
    message: 'child observation failed',
  });
  assert.match(
    childError.message,
    /terminal\.child-error\.name=ChildObservationError terminal\.child-error\.message=child observation failed/,
  );
});

test('Electron terminal result errors bound malformed optional details without changing their result snapshot', () => {
  const circular = {};
  circular.self = circular;
  let arbitraryCoercions = 0;
  const coercionTrap = {
    toJSON() {
      arbitraryCoercions += 1;
      throw new Error('must not serialize optional terminal fields');
    },
    toString() {
      arbitraryCoercions += 1;
      throw new Error('must not coerce optional terminal fields');
    },
    valueOf() {
      arbitraryCoercions += 1;
      throw new Error('must not coerce optional terminal fields');
    },
  };
  const childError = new Error('child failure');
  childError.name = 'x'.repeat(4096);
  const error = new ElectronTerminalResultError({
    pid: 1n,
    exit: { code: 125n, signal: coercionTrap },
    close: { code: 125n, signal: circular },
    error: childError,
  });
  const suffix = error.message.slice(
    'Electron launch did not complete with matching exit(0, null) and close(0, null).'
      .length,
  );
  assert.equal(error.result.pid, 1n);
  assert.equal(error.result.exit.code, 125n);
  assert.equal(error.result.exit.signal, coercionTrap);
  assert.equal(error.result.error.name, childError.name);
  assert.equal(arbitraryCoercions, 0);
  assert.equal(suffix.length, 2048);
  assert.ok(suffix.endsWith('…[truncated]'));
  assert.match(
    suffix,
    /terminal\.pid=1 terminal\.exit\.code=125 terminal\.exit\.signal=invalid-object terminal\.close\.code=125 terminal\.close\.signal=invalid-object terminal\.child-error\.name=/,
  );
});

test('supervised tree reaping hard-kills the group and waits for it to die', async () => {
  const kills = [];
  let livenessChecks = 0;
  await reapSupervisedProcessTree(2468, {
    killTree: async (pid, signal) => {
      kills.push([pid, signal]);
    },
    treeExists: () => {
      livenessChecks += 1;
      return livenessChecks < 3;
    },
    delay: async () => {},
  });
  assert.deepEqual(kills, [[2468, 'SIGKILL']]);
  assert.equal(livenessChecks, 3);
});

test('supervised tree reaping does not signal a group that is already gone', async () => {
  let killCalls = 0;
  await reapSupervisedProcessTree(2468, {
    killTree: async () => {
      killCalls += 1;
    },
    treeExists: () => false,
  });
  assert.equal(killCalls, 0);
});

test('supervised tree reaping gives up at its bounded deadline', async () => {
  let clock = 0;
  let delays = 0;
  await reapSupervisedProcessTree(2468, {
    killTree: async () => {},
    treeExists: () => true,
    delay: async (ms) => {
      delays += 1;
      clock += ms;
    },
    now: () => clock,
    pollIntervalMs: 50,
    deadlineMs: 200,
  });
  assert.equal(delays, 4);
});

test('closing a launched app reaps its supervised tree even when close fails', async () => {
  const reaped = [];
  const reapTree = async (pid) => {
    reaped.push(pid);
  };

  const cleanClose = { close: async () => {} };
  registerSupervisedProcessTree(cleanClose, 1357);
  await closeCanopy(cleanClose, path.join(tmpdir(), 'canopy-e2e-missing'), {
    keepUserData: true,
    reapTree,
  });
  assert.deepEqual(reaped, [1357]);

  const failingClose = {
    close: async () => {
      throw new Error('close failed');
    },
  };
  registerSupervisedProcessTree(failingClose, 8642);
  await assert.rejects(
    closeCanopy(failingClose, path.join(tmpdir(), 'canopy-e2e-missing'), {
      keepUserData: true,
      reapTree,
    }),
    /close failed/,
  );
  assert.deepEqual(reaped, [1357, 8642]);

  // Apps that were never registered (not launched by this harness) skip reaping.
  await closeCanopy(
    { close: async () => {} },
    path.join(tmpdir(), 'canopy-e2e-missing'),
    { keepUserData: true, reapTree },
  );
  assert.deepEqual(reaped, [1357, 8642]);
});

test('capture color mode merges into existing launch preferences', (t) => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'canopy-capture-mode-'));
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  writeFileSync(
    preferencesPath,
    JSON.stringify({
      version: 1,
      preferences: { theme: 'ocean', colorMode: 'light' },
    }),
  );

  seedCaptureColorMode(userDataDir, { CANOPY_E2E_CAPTURE_COLOR_MODE: 'dark' });

  assert.deepEqual(JSON.parse(readFileSync(preferencesPath, 'utf8')), {
    version: 1,
    preferences: { theme: 'ocean', colorMode: 'dark' },
  });
});

test('the renderer code-cache scheme is seeded only when the local env var asks', (t) => {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'canopy-code-cache-'));
  t.after(() => rmSync(userDataDir, { recursive: true, force: true }));
  const preferencesPath = path.join(userDataDir, 'preferences.json');
  writeFileSync(
    preferencesPath,
    JSON.stringify({ version: 1, preferences: { theme: 'ocean' } }),
  );

  assert.equal(
    RENDERER_CODE_CACHE_SCHEME_ENV,
    'CANOPY_E2E_RENDERER_CODE_CACHE_SCHEME',
  );
  for (const env of [
    {},
    { [RENDERER_CODE_CACHE_SCHEME_ENV]: '0' },
    { [RENDERER_CODE_CACHE_SCHEME_ENV]: 'true' },
  ]) {
    seedRendererCodeCacheScheme(userDataDir, env);
    assert.deepEqual(JSON.parse(readFileSync(preferencesPath, 'utf8')), {
      version: 1,
      preferences: { theme: 'ocean' },
    });
  }

  seedRendererCodeCacheScheme(userDataDir, {
    [RENDERER_CODE_CACHE_SCHEME_ENV]: '1',
  });
  assert.deepEqual(JSON.parse(readFileSync(preferencesPath, 'utf8')), {
    version: 1,
    preferences: { theme: 'ocean', rendererCodeCacheSchemeEnabled: true },
  });

  const fresh = mkdtempSync(path.join(tmpdir(), 'canopy-code-cache-fresh-'));
  t.after(() => rmSync(fresh, { recursive: true, force: true }));
  seedRendererCodeCacheScheme(fresh, { [RENDERER_CODE_CACHE_SCHEME_ENV]: '1' });
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(fresh, 'preferences.json'), 'utf8')),
    { version: 1, preferences: { rendererCodeCacheSchemeEnabled: true } },
  );
});

test('the main window is expected on the renderer scheme only when it is seeded', () => {
  const mainEntryPath = path.join('/repo', 'out-e2e', 'main', 'index.js');
  assert.equal(
    packagedMainWindowRendererUrl(mainEntryPath, {}),
    'file:///repo/out-e2e/renderer/index.html',
  );
  assert.equal(
    packagedMainWindowRendererUrl(mainEntryPath, {
      [RENDERER_CODE_CACHE_SCHEME_ENV]: '1',
    }),
    'app-renderer://bundle/index.html',
  );
});

test('a code-cache scheme launch keeps Chromium storage and the origin record in its own profile', () => {
  const userDataDir = path.join('/runs', 'canopy-e2e-1');
  const profileArg = `--user-data-dir=${path.join(userDataDir, 'electron-profile')}`;
  const on = { [RENDERER_CODE_CACHE_SCHEME_ENV]: '1' };

  // Off (CI and every default run): today's args, byte for byte.
  for (const env of [{}, { [RENDERER_CODE_CACHE_SCHEME_ENV]: '0' }]) {
    assert.deepEqual(
      rendererCodeCacheSchemeElectronArgs(userDataDir, ['--lang=en'], env),
      ['--lang=en'],
    );
  }
  // On: Electron's sessionData (Local Storage, Code Cache, the origin
  // record) moves out of the host-wide default profile into the run's.
  assert.deepEqual(rendererCodeCacheSchemeElectronArgs(userDataDir, [], on), [
    profileArg,
  ]);
  assert.deepEqual(
    rendererCodeCacheSchemeElectronArgs(userDataDir, ['--lang=en'], on),
    [profileArg, '--lang=en'],
  );
  // A caller's own profile wins.
  assert.deepEqual(
    rendererCodeCacheSchemeElectronArgs(
      userDataDir,
      ['--user-data-dir=/own'],
      on,
    ),
    ['--user-data-dir=/own'],
  );
});

test('launchCanopy passes the code-cache scheme profile to Electron and the headless bootstrap', () => {
  const source = readFileSync(
    new URL('../electron/launchCanopy.mjs', import.meta.url),
    'utf8',
  );
  assert.match(
    source,
    /const electronArgs = platformElectronArgs\(\s*userDataDir,\s*rendererCodeCacheSchemeElectronArgs\(\s*userDataDir,\s*options\.electronArgs \?\? \[\],\s*\{ \.\.\.process\.env, \.\.\.options\.env \},?\s*\),\s*options,?\s*\);/,
  );
  assert.match(
    source,
    /if \(options\.productionWindowMode === 'headless'\) \{[\s\S]*?headlessBootstrap\.buildExpectedArgv\(\{[\s\S]*?productMainEntryPath: mainEntryPath,[\s\S]*?executablePath: electronPath,\s*electronArgs,\s*launcherSourcePath:/,
  );
  assert.match(
    source,
    /args: \[\s*\.\.\.electronArgs,\s*\.\.\.\(sidecar\?\.contractArgs \?\? \[\]\),\s*sidecar\?\.launchEntryPath \?\? mainEntryPath,\s*\.\.\.\(options\.applicationArgs \?\? \[\]\),\s*\],/,
  );
  assert.match(source, /return \['--use-mock-keychain', \.\.\.electronArgs\];/);
  assert.doesNotMatch(
    source,
    /args: \[\s*\.\.\.\(options\.electronArgs \?\? \[\]\)/,
  );
});

test('Windows terminal cleanup registers during use and runs once after the body in a separate fixture budget', async () => {
  const [fixture, options] = createTerminalCleanupFixture('win32');
  const events = [];
  await fixture({}, async (runTerminalCleanup) => {
    events.push('body');
    await runTerminalCleanup(async () => events.push('cleanup'));
    events.push('registered');
    assert.deepEqual(events, ['body', 'registered']);
    events.push('body finished');
  });
  assert.deepEqual(events, ['body', 'registered', 'body finished', 'cleanup']);
  assert.equal(options.timeout, 30_000);
});

for (const platform of ['darwin', 'linux']) {
  test(`${platform} terminal cleanup remains inline with no separate timeout`, async () => {
    const [fixture, options] = createTerminalCleanupFixture(platform);
    const events = [];
    await fixture({}, async (runTerminalCleanup) => {
      events.push('body');
      await runTerminalCleanup(async () => events.push('cleanup'));
      assert.deepEqual(events, ['body', 'cleanup']);
      events.push('body finished');
    });
    assert.deepEqual(events, ['body', 'cleanup', 'body finished']);
    assert.equal(options.timeout, undefined);
  });
}

test('Windows terminal cleanup runs after use rejects and preserves a body failure', async () => {
  const [fixture] = createTerminalCleanupFixture('win32');
  const bodyError = new Error('product assertion failed');
  const events = [];
  await assert.rejects(
    fixture({}, async (runTerminalCleanup) => {
      try {
        events.push('body');
        throw bodyError;
      } finally {
        await runTerminalCleanup(async () => events.push('cleanup'));
        events.push('finally finished');
      }
    }),
    (error) => error === bodyError,
  );
  assert.deepEqual(events, ['body', 'finally finished', 'cleanup']);
});

for (const platform of ['win32', 'darwin']) {
  test(`${platform} terminal cleanup rejection remains a failure`, async () => {
    const [fixture] = createTerminalCleanupFixture(platform);
    const cleanupError = new Error('close failed');
    let cleanupCalls = 0;
    await assert.rejects(
      fixture({}, async (runTerminalCleanup) => {
        await runTerminalCleanup(async () => {
          cleanupCalls++;
          throw cleanupError;
        });
      }),
      (error) => error === cleanupError,
    );
    assert.equal(cleanupCalls, 1);
  });
}

test('Windows terminal cleanup has nothing to close before registration', async () => {
  const [fixture] = createTerminalCleanupFixture('win32');
  await fixture({}, async () => {});
});

test('selection failure retains launched ownership before a diagnostic rejects', async () => {
  const owner = {};
  const context = {
    electronApp: { close: async () => {} },
    userDataDir: '/isolated/selection-failure',
  };
  const diagnosticError = new Error('diagnostic failed');
  let observedOwner;
  const handler = retainSelectionFailureOwner(owner, async (actualContext) => {
    assert.equal(actualContext, context);
    observedOwner = { ...owner };
    throw diagnosticError;
  });
  await assert.rejects(handler(context), (error) => error === diagnosticError);
  assert.deepEqual(observedOwner, context);
  assert.deepEqual(owner, context);
});

test('Playwright runs Windows terminal cleanup after a body deadline failure and reports cleanup failures', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'profile-cleanup-runner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const eventsPath = path.join(directory, 'events.jsonl');
  const configPath = path.join(directory, 'playwright.config.mjs');
  writeFileSync(
    configPath,
    `export default ${JSON.stringify({
      testDir: directory,
      outputDir: path.join(directory, 'results'),
      workers: 1,
      retries: 0,
      reporter: 'json',
    })};`,
  );
  writeFileSync(
    path.join(directory, 'cleanup.spec.mjs'),
    String.raw`
    import { expect, test as base } from ${JSON.stringify(import.meta.resolve('@playwright/test'))};
    import { appendFileSync } from 'node:fs';
    import { createTerminalCleanupFixture } from ${JSON.stringify(new URL('../electron/browser-profile-test-lifecycle.mjs', import.meta.url).href)};
    const test = base.extend({ runTerminalCleanup: createTerminalCleanupFixture('win32') });
    const record = (event) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\n');
    test('body deadline still fails', async ({ runTerminalCleanup }, testInfo) => {
      test.setTimeout(25);
      try {
        await expect.poll(() => false, { timeout: 1_000 }).toBe(true);
      } finally {
        await runTerminalCleanup(async () => record(['cleanup', testInfo.timeout]));
        record(['registered']);
      }
    });
    test('cleanup rejection still fails', async ({ runTerminalCleanup }) => {
      await runTerminalCleanup(async () => { throw new Error('terminal close rejected'); });
    });
    test('body and cleanup failures remain visible', async ({ runTerminalCleanup }) => {
      try {
        throw new Error('original product failure');
      } finally {
        await runTerminalCleanup(async () => { throw new Error('secondary close failure'); });
      }
    });
  `,
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('cli.js', import.meta.resolve('playwright/package.json')),
      ),
      'test',
      '--config',
      configPath,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  const results = report.suites.flatMap((suite) =>
    suite.specs.flatMap((spec) => spec.tests.flatMap((entry) => entry.results)),
  );
  assert.equal(results.length, 3, result.stdout);
  assert.ok(['failed', 'timedOut'].includes(results[0].status), result.stdout);
  assert.match(
    JSON.stringify(results[0].errors),
    /Test timeout of 25ms exceeded/,
  );
  assert.equal(results[1].status, 'failed', result.stdout);
  assert.match(JSON.stringify(results[1].errors), /terminal close rejected/);
  assert.equal(results[2].status, 'failed', result.stdout);
  assert.match(JSON.stringify(results[2].errors), /original product failure/);
  assert.match(JSON.stringify(results[2].errors), /secondary close failure/);
  assert.deepEqual(
    readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    [['registered'], ['cleanup', 25]],
  );
});

test('Playwright gives large inventory setup and teardown one explicit slot separate from the product body', (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'large-inventory-runner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const eventsPath = path.join(directory, 'events.jsonl');
  const configPath = path.join(directory, 'playwright.config.mjs');
  writeFileSync(
    configPath,
    `export default ${JSON.stringify({
      testDir: directory,
      outputDir: path.join(directory, 'results'),
      workers: 1,
      retries: 0,
      reporter: 'json',
    })};`,
  );
  writeFileSync(
    path.join(directory, 'inventory.spec.mjs'),
    String.raw`
    import { expect, test as base } from ${JSON.stringify(import.meta.resolve('@playwright/test'))};
    import { appendFileSync } from 'node:fs';
    import { createLargeInventoryFixture } from ${JSON.stringify(new URL('../electron/browser-profile-test-lifecycle.mjs', import.meta.url).href)};
    const record = (event) => appendFileSync(${JSON.stringify(eventsPath)}, JSON.stringify(event) + '\n');
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const test = base.extend({
      largeInventory: createLargeInventoryFixture({
        temporaryDirectory: '/virtual',
        mkdtemp: async () => '/virtual/owned-root',
        mkdir: async () => record('fixture-setup'),
        open: async () => ({ truncate: async () => {}, close: async () => {} }),
        lstat: async () => { throw missing; },
        stat: async () => ({ dev: 1 }),
        rename: async () => {},
        rm: async () => record('fixture-cleanup'),
      }),
    });
    test('body deadline remains independent', async ({ largeInventory }) => {
      test.setTimeout(25);
      record(['body', largeInventory.files]);
      await expect.poll(() => false, { timeout: 1_000 }).toBe(true);
    });
  `,
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('cli.js', import.meta.resolve('playwright/package.json')),
      ),
      'test',
      '--config',
      configPath,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  const [playwrightResult] = report.suites.flatMap((suite) =>
    suite.specs.flatMap((spec) => spec.tests.flatMap((entry) => entry.results)),
  );
  assert.ok(['failed', 'timedOut'].includes(playwrightResult.status));
  assert.match(
    JSON.stringify(playwrightResult.errors),
    /Test timeout of 25ms exceeded/,
  );
  assert.deepEqual(
    readFileSync(eventsPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
    ['fixture-setup', ['body', 10000], 'fixture-cleanup'],
  );
});

test('real large-inventory registration persists pre-body preparation failure and cleanup boundaries', (t) => {
  const directory = mkdtempSync(
    path.join(tmpdir(), 'large-inventory-failure-'),
  );
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const diagnosticsPath = path.join(directory, 'diagnostics');
  const bodyPath = path.join(directory, 'body-entered');
  const configPath = path.join(directory, 'playwright.config.mjs');
  writeFileSync(
    configPath,
    `export default ${JSON.stringify({
      testDir: directory,
      outputDir: path.join(directory, 'results'),
      workers: 1,
      retries: 0,
      reporter: 'json',
    })};`,
  );
  writeFileSync(
    path.join(directory, 'inventory-failure.spec.mjs'),
    String.raw`
    import { test as base } from ${JSON.stringify(import.meta.resolve('@playwright/test'))};
    import { writeFileSync } from 'node:fs';
    import { createLargeInventoryFixture } from ${JSON.stringify(new URL('../electron/browser-profile-test-lifecycle.mjs', import.meta.url).href)};
    process.env.CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR = ${JSON.stringify(diagnosticsPath)};
    const test = base.extend({
      largeInventory: createLargeInventoryFixture({
        temporaryDirectory: '/virtual',
        mkdtemp: async () => '/virtual/owned-root',
        mkdir: async () => { throw new Error('early preparation failure'); },
        rm: async () => {},
      }),
    });
    test('body must not start', async ({ largeInventory }) => {
      void largeInventory;
      writeFileSync(${JSON.stringify(bodyPath)}, 'entered');
    });
  `,
  );
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('cli.js', import.meta.resolve('playwright/package.json')),
      ),
      'test',
      '--config',
      configPath,
    ],
    { encoding: 'utf8', timeout: 15_000 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stdout, /early preparation failure/);
  assert.equal(existsSync(bodyPath), false);
  const files = existsSync(diagnosticsPath)
    ? readdirSync(diagnosticsPath).filter((file) => file.endsWith('.jsonl'))
    : [];
  assert.equal(files.length, 1);
  const records = readFileSync(path.join(diagnosticsPath, files[0]), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    records.map(({ stage, outcome }) => [stage, outcome]),
    [
      ['preparation', 'entered'],
      ['preparation-summary', 'rejected'],
      ['fixture-cleanup', 'entered'],
      ['fixture-cleanup', 'fulfilled'],
    ],
  );
  assert.ok(records.every((record) => typeof record.monotonicNs === 'string'));
  assert.ok(records.every((record) => typeof record.elapsedMs === 'number'));
  assert.ok(
    records.every(
      (record, index) =>
        index === 0 ||
        BigInt(record.monotonicNs) >= BigInt(records[index - 1].monotonicNs),
    ),
  );
});

test('selection failure retains ownership when optional diagnostics are disabled', async () => {
  const owner = {};
  const context = { electronApp: {}, userDataDir: '/isolated/no-diagnostics' };
  await retainSelectionFailureOwner(owner, undefined)(context);
  assert.deepEqual(owner, context);
});

const profileSelectionCallSiteRunner = String.raw`
  import vm from 'node:vm';
  import { readFileSync } from 'node:fs';
  import { fileURLToPath, pathToFileURL } from 'node:url';

  const scenario = JSON.parse(process.env.PROFILE_SELECTION_SCENARIO);
  const specPath = process.env.PROFILE_SELECTION_SPEC_PATH;
  const lifecycleUrl = process.env.PROFILE_SELECTION_LIFECYCLE_URL;
  const lifecycle = await import(lifecycleUrl);
  const titles = {
    permissions:
      'named profile permissions are independent and Task enable stays fixed on',
    inspector:
      'inspector browser dispatch isolates ambient context while native IPC and HTTP enforce profile permissions',
    settings:
      'profile data Settings measures lazily, cancels a preview, and resets while retaining permissions',
    menuBoundary:
      'persists named settings and defaults, distinguishes duplicate names, and previews deletion',
    savedTab:
      'closing a saved tab while shared-profile views restore does not recreate it',
  };
  const targetTitle = titles[scenario.target ?? 'inspector'];
  const callbacks = new Map();
  const closeCalls = [];
  const serverCalls = [];
  const attachmentAttempts = [];
  const attached = [];
  const diagnosticFailures = [];
  const consoleErrors = [];
  const boundaryCalls = [];
  const boundaryDirectories = [];
  const boundaryRecords = [];
  const boundaryTimerDelays = [];
  const unhandledBoundaryRejections = [];
  const onBoundaryUnhandled = error => unhandledBoundaryRejections.push(error.message);
  if (scenario.pendingBoundary) process.on('unhandledRejection', onBoundaryUnhandled);
  const observationCalls = {
    hrtime: 0,
    mkdir: 0,
    write: 0,
    evaluate: 0,
    screenshot: 0,
  };
  const selectionError = new Error('selection sentinel');
  const seedError = new Error('seed sentinel');
  const bodyError = new Error('body sentinel');
  const closeError = new Error('close sentinel');
  const closeAllError = new Error('close-all sentinel');
  const serverCloseError = new Error('server-close sentinel');
  const longError = new Error('x'.repeat(10_000));
  const attachmentError = new Error('attachment sentinel');
  const listenError = new Error('listen sentinel');
  const createError = new Error('create sentinel');
  const importError = new Error('import sentinel');
  const originError = new Error('origin sentinel');
  const factoryError = new Error('factory sentinel');
  const hostileError = Object.create(null, {
    code: { get() { throw new Error('hostile code getter'); } },
    message: { get() { throw new Error('hostile message getter'); } },
    toString: { value() { throw new Error('hostile toString'); } },
  });
  const electronApp = {
    evaluate: async (_fn, input) => {
      observationCalls.evaluate++;
      boundaryCalls.push(input?.kind);
      if (scenario.pendingBoundary && (scenario.pendingBoundary === 'all' || input?.kind === 'release-create' || (input?.kind === 'browser-snapshot' && boundaryCalls.includes('picker-assertion')))) {
        if (scenario.lateBoundaryReject) return new Promise((_resolve, reject) => setTimeout(() => reject(new Error('late boundary sentinel')), 30));
        return new Promise(() => {});
      }
      if (scenario.boundaryObservationFails) throw new Error('boundary observation sentinel');
      return { status: 'observed', kind: input?.kind };
    },
    browserWindow: async () => ({
      evaluate: async () => scenario.pendingDom && boundaryCalls.includes('picker-assertion') ? new Promise(() => {}) : ({ menu: { present: true }, panels: [], pickers: [] }),
      dispose: async () => {},
    }),
  };
  const ownerContext = {
    electronApp,
    userDataDir: '/isolated/profile-selection',
    window: {
      screenshot: async () => {
        observationCalls.screenshot++;
      },
    },
    app: {},
    branch: 'demo-main',
    error: selectionError,
  };

  const fakeTest = (title, callback) => callbacks.set(title, callback);
  fakeTest.extend = () => fakeTest;
  fakeTest.setTimeout = () => {};
  fakeTest.info = () => ({
    attach: async (name, value) => {
      attachmentAttempts.push(name);
      if (scenario.attachmentFails) throw attachmentError;
      attached.push({ name, body: value.body.toString('utf8') });
    },
  });

  const expectProxy = new Proxy(() => expectProxy, {
    get: (_target, key) => scenario.target === 'menuBoundary' && key === 'toContainText'
      ? async () => { boundaryCalls.push('picker-assertion'); if (scenario.pickerFails) throw bodyError; }
      : expectProxy,
    apply: () => expectProxy,
  });
  const fakeConsole = {
    ...console,
    error: (...values) => {
      if (scenario.consoleFails) throw new Error('console sentinel');
      consoleErrors.push(values.map((value) => {
        try {
          return value instanceof Error ? value.message : String(value);
        } catch {
          return 'unprintable';
        }
      }));
    },
  };
  const fakeProcess = Object.create(process);
  fakeProcess.env = {
    ...process.env,
    CANOPY_WINDOWS_BOUNDARY_DIAGNOSTICS_DIR:
      scenario.canonicalBoundaryDirectory ?? '',
    CANOPY_WINDOWS_BROWSER_BOUNDARY_DIAGNOSTICS_DIR: scenario.boundaryEnabled ? '/isolated/boundary' : '',
    CANOPY_WINDOWS_PROFILE_DIAGNOSTICS_DIR:
      scenario.diagnosticThrows || scenario.factoryThrows || scenario.legacyEnabled
      ? '/isolated/diagnostics'
      : '',
  };
  fakeProcess.hrtime = (...args) => process.hrtime(...args);
  fakeProcess.hrtime.bigint = () => {
    observationCalls.hrtime++;
    if (scenario.factoryThrows && observationCalls.hrtime === 1)
      throw factoryError;
    if (scenario.diagnosticThrows && observationCalls.hrtime > 1)
      throw new Error('diagnostic sentinel');
    return process.hrtime.bigint();
  };

  const seedPanelWorktree = async (options) => {
    if (scenario.setupFailure) {
      options?.onBeforeLaunch?.({
        userDataDir: ownerContext.userDataDir,
        workspaceIds: ['demo-ts-pnpm-vite'],
      });
      if (typeof options?.onSetupFailure === 'function')
        await options.onSetupFailure(ownerContext);
      throw selectionError;
    }
    if (scenario.target === 'menuBoundary') return {
      electronApp, userDataDir: ownerContext.userDataDir,
      window: { getByTestId: name => ({ click: async () => { boundaryCalls.push(name); if (scenario.clickFails && name === 'panel-add-menu-item-browser') throw bodyError; } }) },
      app: { openSettings: async () => { boundaryCalls.push('original-following-action'); throw bodyError; } },
    };
    if (scenario.kind === 'body') {
      const window = {
        evaluate: async () => {
          observationCalls.evaluate++;
          throw bodyError;
        },
      };
      return {
        electronApp,
        userDataDir: ownerContext.userDataDir,
        window,
        app: {
          openSettings: async () => {
            if (scenario.target === 'settings') throw bodyError;
          },
        },
      };
    }
    if (scenario.kind === 'no-owner') throw selectionError;
    if (scenario.kind === 'seed') throw seedError;
    if (typeof options?.onSelectWorktreeFailure === 'function') {
      try {
        await options.onSelectWorktreeFailure(ownerContext);
      } catch (error) {
        diagnosticFailures.push(error.message);
      }
    }
    throw selectionError;
  };
  const closeCanopy = async (actualApp, actualUserDataDir) => {
    serverCalls.push('app-close');
    closeCalls.push({
      appMatches: actualApp === electronApp,
      userDataDir: actualUserDataDir,
    });
    if (scenario.closeFails)
      throw scenario.hostileErrors
        ? hostileError
        : scenario.longErrors
          ? longError
          : closeError;
  };
  let server;
  const createServer = () => {
    serverCalls.push('create');
    if (scenario.createThrows) throw createError;
    const listeners = new Map();
    let listening = false;
    server = {
      once(name, listener) {
        serverCalls.push('once-' + name);
        listeners.set(name, listener);
        return this;
      },
      removeListener(name, listener) {
        serverCalls.push('remove-' + name);
        if (listeners.get(name) === listener) listeners.delete(name);
        return this;
      },
      listen(_port, _host, callback) {
        serverCalls.push('listen');
        if (scenario.listenThrows) throw listenError;
        if (scenario.listenError) {
          queueMicrotask(() => listeners.get('error')?.(listenError));
        } else {
          listening = true;
          queueMicrotask(callback);
        }
        return this;
      },
      address() {
        serverCalls.push('address');
        if (scenario.originThrows) throw originError;
        return { port: 43210 };
      },
      closeAllConnections() {
        serverCalls.push('close-all');
        if (scenario.closeAllFails)
          throw scenario.hostileErrors
            ? hostileError
            : scenario.longErrors
              ? longError
              : closeAllError;
      },
      close(callback) {
        serverCalls.push('server-close');
        if (scenario.serverCloseThrows) throw serverCloseError;
        if (!listening) {
          const error = new Error('Server is not running.');
          error.code = 'ERR_SERVER_NOT_RUNNING';
          if (scenario.notRunningIsUnexpected) error.code = 'OTHER';
          queueMicrotask(() => callback(error));
          return this;
        }
        listening = false;
        queueMicrotask(() =>
          callback(
            scenario.serverCloseFails
              ? scenario.hostileErrors
                ? hostileError
                : scenario.longErrors
                  ? longError
                  : serverCloseError
              : undefined,
          ),
        );
        return this;
      },
      listenerCount(name) {
        return listeners.has(name) ? 1 : 0;
      },
    };
    return server;
  };

  const context = vm.createContext({
    Buffer,
    console: fakeConsole,
    crypto,
    JSON: {
      ...JSON,
      stringify: (value, ...args) => {
        if (scenario.serializationFails && value?.phase === 'fixture-setup-failure-cleanup')
          throw new Error('serialization sentinel');
        return JSON.stringify(value, ...args);
      },
    },
    process: fakeProcess,
    queueMicrotask,
    setTimeout: scenario.pendingBoundary ? (callback, delay, ...args) => {
      boundaryTimerDelays.push(delay);
      return setTimeout(callback, delay === 2000 ? 5 : delay, ...args);
    } : setTimeout,
    clearTimeout,
  });
  const synthetic = (identifier, values) =>
    new vm.SyntheticModule(
      Object.keys(values),
      function () {
        for (const [name, value] of Object.entries(values))
          this.setExport(name, value);
      },
      { context, identifier },
    );
  const modules = new Map();
  const getModule = async (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    let values;
    if (specifier === '@playwright/test') {
      values = { expect: expectProxy, test: fakeTest };
    } else if (specifier === './panelHarness.mjs') {
      values = {
        seedPanelWorktree,
        collectLeaves: () => [],
        DEFAULT_GROUP_IDS: {
          chat: 'group-chat',
          terminal: 'group-terminal',
          activity: 'group-activity',
        },
        DEFAULT_PANEL_IDS: {
          chat: 'panel-chat-seed-chat',
          terminal: 'panel-terminal',
          activity: 'panel-activity',
        },
        getLayout: async () => ({}),
        seedVisibleBrowserPanel: async () => {
          throw new Error('Unexpected inspector spec panel seeding');
        },
      };
    } else if (specifier === './launchCanopy.mjs') {
      values = {
        closeCanopy,
        getMainWindow: async () => {},
        launchCanopy: async () => {},
      };
    } else if (specifier === './canopyApp.mjs') {
      values = { CanopyAppDriver: class {}, closePanelTab: async () => {} };
    } else if (specifier === './browser-profile-test-lifecycle.mjs') {
      values = {
        ...lifecycle,
        createBoundaryRecorder: () => {
          const record = (stage, details) =>
            boundaryRecords.push({ stage, ...details });
          record.observe = (stage, operation) =>
            lifecycle.observeBoundary(stage, operation, record);
          return record;
        },
        createTerminalCleanupFixture: lifecycle.createTerminalCleanupFixture,
        retainSelectionFailureOwner: lifecycle.retainSelectionFailureOwner,
      };
    } else if (specifier === 'node:child_process') {
      values = {
        execFileSync: () => {},
        spawn: () => {
          throw new Error('Unexpected inspector spec process spawn');
        },
      };
    } else if (specifier === 'node:crypto') {
      values = await import('node:crypto');
    } else if (specifier === 'node:fs') {
      values = {
        appendFileSync: (_file, value) => { boundaryRecords.push(JSON.parse(value)); },
        mkdirSync: (directory) => { observationCalls.mkdir++; boundaryDirectories.push(directory); },
        readFileSync: () => '',
        realpathSync: () => {
          throw new Error('Unexpected inspector spec realpath access');
        },
        writeFileSync: () => { observationCalls.write++; },
      };
    } else if (specifier === 'node:os') {
      values = { tmpdir: () => '/tmp' };
    } else if (specifier === 'node:url') {
      values = { fileURLToPath };
    } else if (specifier === 'node:path') {
      values = { default: (await import('node:path')).default };
    } else if (specifier === 'node:http') {
      if (scenario.importThrows) throw importError;
      values = { createServer };
    } else if (specifier === './seeders/registerScenario.mjs') {
      values = {
        getScenarioActivity: async () => {
          throw new Error('Unexpected inspector spec scenario activity');
        },
      };
    } else {
      throw new Error('Unexpected inspector spec import: ' + specifier);
    }
    const module = synthetic('stub:' + specifier, values);
    modules.set(specifier, module);
    return module;
  };

  const source = readFileSync(specPath, 'utf8');
  const sourceModule = new vm.SourceTextModule(source, {
    context,
    identifier: pathToFileURL(specPath).href,
    importModuleDynamically: async (specifier) => {
      const module = await getModule(specifier);
      if (module.status === 'unlinked') await module.link(() => {});
      if (module.status === 'linked') await module.evaluate();
      return module;
    },
  });
  await sourceModule.link((specifier) => getModule(specifier));
  await sourceModule.evaluate();
  const callback = callbacks.get(targetTitle);
  if (!callback) throw new Error('Profile callback was not registered: ' + targetTitle);

  let escaped, callbackSettled = false;
  let watchdog;
  try {
    const running = callback({ runTerminalCleanup: async operation => { boundaryCalls.push('terminal-cleanup'); await operation(); } });
    if (scenario.pendingBoundary) {
      await Promise.race([
        running.finally(() => { callbackSettled = true; }),
        new Promise((_resolve, reject) => { watchdog = setTimeout(() => reject(new Error('pending callback watchdog')), 250); }),
      ]);
    } else await running;
  } catch (error) {
    escaped = error;
  } finally { clearTimeout(watchdog); }
  if (scenario.lateBoundaryReject) await new Promise(resolve => setTimeout(resolve, 50));
  if (scenario.pendingBoundary) process.off('unhandledRejection', onBoundaryUnhandled);
  process.stdout.write(
    JSON.stringify({
      primaryIdentity:
        escaped ===
        (scenario.importThrows
          ? importError
          : scenario.createThrows
            ? createError
            : scenario.listenThrows || scenario.listenError
              ? listenError
              : scenario.originThrows
                ? originError
                : scenario.factoryThrows
                  ? factoryError
                  : scenario.kind === 'body'
                    ? bodyError
                    : scenario.kind === 'seed'
                      ? seedError
                      : selectionError),
      escapedMessage: (() => {
        try { return escaped?.message ?? String(escaped); }
        catch { return 'unprintable'; }
      })(),
      closeCalls,
      serverCalls,
      serverListenerCount: server?.listenerCount('error') ?? 0,
      attachmentAttempts,
      attached,
      diagnosticFailures,
      consoleErrors,
      observationCalls,
      boundaryCalls,
      boundaryDirectories,
      boundaryRecords,
      boundaryTimerDelays,
      callbackSettled,
      unhandledBoundaryRejections,
    }),
  );
`;

function runProfileSelectionCallSite(scenario) {
  const filteredEnv = { ...process.env };
  delete filteredEnv.CANOPY_DEV_E2E_SUITE_MAX_RUN_CONCURRENCY;
  delete filteredEnv.CANOPY_DEV_PERF_SUITE_MAX_RUN_CONCURRENCY;
  delete filteredEnv.CANOPY_DEV_SCRIPT_MEMORY_PRESSURE_THRESHOLD_MB;
  const result = spawnSync(
    process.execPath,
    [
      '--experimental-vm-modules',
      '--input-type=module',
      '-e',
      profileSelectionCallSiteRunner,
    ],
    {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...filteredEnv,
        PROFILE_SELECTION_SCENARIO: JSON.stringify(scenario),
        PROFILE_SELECTION_SPEC_PATH: fileURLToPath(
          new URL('../electron/browser-profiles.spec.mjs', import.meta.url),
        ),
        PROFILE_SELECTION_LIFECYCLE_URL: new URL(
          '../electron/browser-profile-test-lifecycle.mjs',
          import.meta.url,
        ).href,
      },
    },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('inspector call site closes retained ownership when diagnostics are disabled', () => {
  const result = runProfileSelectionCallSite({ kind: 'selection' });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(result.closeCalls, [
    {
      appMatches: true,
      userDataDir: '/isolated/profile-selection',
    },
  ]);
  assert.deepEqual(result.diagnosticFailures, []);
});

test('inspector call site retains ownership before a diagnostic throws', () => {
  const result = runProfileSelectionCallSite({
    kind: 'selection',
    diagnosticThrows: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.closeCalls.length, 1);
  assert.deepEqual(result.diagnosticFailures, ['diagnostic sentinel']);
});

test('inspector call site runs ordinary final cleanup once after body rejection', () => {
  const result = runProfileSelectionCallSite({ kind: 'body' });
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.closeCalls.length, 1);
});

test('inspector call site has nothing to close when selection exposes no owner', () => {
  const result = runProfileSelectionCallSite({ kind: 'no-owner' });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(result.closeCalls, []);
});

test('inspector call site attaches close failure without replacing selection failure', () => {
  const result = runProfileSelectionCallSite({
    kind: 'selection',
    closeFails: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.closeCalls.length, 1);
  assert.equal(result.attached.length, 1);
  assert.match(result.attached[0].body, /close sentinel/);
});

test('inspector call site preserves selection failure when close and attachment fail', () => {
  const result = runProfileSelectionCallSite({
    kind: 'selection',
    closeFails: true,
    attachmentFails: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.closeCalls.length, 1);
  assert.equal(result.attachmentAttempts.length, 1);
  assert.deepEqual(result.attached, []);
});

test('profile fixture call site RED ownership: Settings closes retained owner with diagnostics disabled', () => {
  const result = runProfileSelectionCallSite({
    target: 'settings',
    kind: 'selection',
  });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(result.closeCalls, [
    { appMatches: true, userDataDir: '/isolated/profile-selection' },
  ]);
  assert.deepEqual(result.observationCalls, {
    hrtime: 0,
    mkdir: 0,
    write: 0,
    evaluate: 0,
    screenshot: 0,
  });
});

test('profile fixture call site RED ownership: saved tab closes server and retained owner with diagnostics disabled', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'selection',
  });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(result.closeCalls, [
    { appMatches: true, userDataDir: '/isolated/profile-selection' },
  ]);
  assert.deepEqual(result.serverCalls.slice(-3), [
    'close-all',
    'server-close',
    'app-close',
  ]);
  assert.equal(result.serverListenerCount, 0);
});

test('profile fixture call site RED ownership: saved tab closes server after seed rejection without exposed owner', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'seed',
  });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(result.closeCalls, []);
  assert.deepEqual(result.serverCalls.slice(-2), ['close-all', 'server-close']);
});

test('profile fixture call site RED ownership: saved tab preserves selection identity when diagnostics throw and closes both owners', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'selection',
    diagnosticThrows: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(result.diagnosticFailures, ['diagnostic sentinel']);
  assert.deepEqual(result.serverCalls.slice(-3), [
    'close-all',
    'server-close',
    'app-close',
  ]);
});

for (const target of ['settings', 'savedTab']) {
  test(`${target} profile fixture call site runs ordinary final cleanup once after body rejection`, () => {
    const result = runProfileSelectionCallSite({ target, kind: 'body' });
    assert.equal(result.primaryIdentity, true);
    assert.equal(result.closeCalls.length, 1);
    if (target === 'savedTab')
      assert.deepEqual(result.serverCalls.slice(-3), [
        'close-all',
        'server-close',
        'app-close',
      ]);
  });
}

test('Settings profile fixture has nothing to close when selection exposes no owner', () => {
  const result = runProfileSelectionCallSite({
    target: 'settings',
    kind: 'no-owner',
  });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(result.closeCalls, []);
});

for (const scenario of [
  { createThrows: true, expected: [], message: 'create sentinel' },
  { importThrows: true, expected: [], message: 'import sentinel' },
  {
    listenThrows: true,
    expected: ['close-all', 'server-close'],
    message: 'listen sentinel',
  },
  {
    listenError: true,
    expected: ['close-all', 'server-close'],
    message: 'listen sentinel',
  },
  {
    originThrows: true,
    expected: ['close-all', 'server-close'],
    message: 'origin sentinel',
  },
]) {
  test(`saved-tab setup preserves ${scenario.message} and releases acquired resources`, () => {
    const result = runProfileSelectionCallSite({
      target: 'savedTab',
      ...scenario,
    });
    assert.equal(result.primaryIdentity, true);
    assert.equal(result.escapedMessage, scenario.message);
    assert.deepEqual(
      result.serverCalls.filter((call) =>
        ['close-all', 'server-close', 'app-close'].includes(call),
      ),
      scenario.expected,
    );
    assert.equal(result.serverListenerCount, 0);
    assert.deepEqual(result.closeCalls, []);
  });
}

test('saved-tab diagnostic factory failure closes its allocated server', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    factoryThrows: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.escapedMessage, 'factory sentinel');
  assert.deepEqual(result.serverCalls.slice(-2), ['close-all', 'server-close']);
  assert.deepEqual(result.closeCalls, []);
});

test('saved-tab cleanup attempts server close and app close after connection-close failure', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'selection',
    closeAllFails: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(result.serverCalls.slice(-3), [
    'close-all',
    'server-close',
    'app-close',
  ]);
  assert.equal(result.attached.length, 1);
  assert.match(result.attached[0].body, /close-all sentinel/);
});

test('saved-tab cleanup records server callback and app failures in fixed order', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'selection',
    serverCloseFails: true,
    closeFails: true,
  });
  assert.equal(result.primaryIdentity, true);
  const record = JSON.parse(result.attached[0].body);
  assert.deepEqual(
    record.failures.map(({ resource, operation }) => [resource, operation]),
    [
      ['http-server', 'close'],
      ['electron-app', 'close'],
    ],
  );
});

test('saved-tab cleanup attempts app close after synchronous server-close failure', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'selection',
    serverCloseThrows: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(result.serverCalls.slice(-3), [
    'close-all',
    'server-close',
    'app-close',
  ]);
  assert.match(result.attached[0].body, /server-close sentinel/);
});

test('saved-tab cleanup reports unexpected not-running errors without an acquired app', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    listenThrows: true,
    notRunningIsUnexpected: true,
  });
  assert.equal(result.escapedMessage, 'listen sentinel');
  assert.deepEqual(result.closeCalls, []);
  assert.match(result.attached[0].body, /Server is not running/);
});

test('saved-tab cleanup bounds hostile failures and attachment payload', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'selection',
    closeAllFails: true,
    serverCloseFails: true,
    closeFails: true,
    hostileErrors: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.attached.length, 1);
  assert.ok(Buffer.byteLength(result.attached[0].body) < 80 * 1024);
  const record = JSON.parse(result.attached[0].body);
  assert.equal(record.failures.length, 3);
  for (const failure of record.failures)
    assert.ok(failure.message.length <= 4096);
});

test('saved-tab cleanup truncates long error messages and keeps its payload bounded', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'selection',
    closeAllFails: true,
    serverCloseFails: true,
    closeFails: true,
    longErrors: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.ok(Buffer.byteLength(result.attached[0].body) < 80 * 1024);
  const record = JSON.parse(result.attached[0].body);
  assert.equal(record.failures.length, 3);
  for (const failure of record.failures)
    assert.equal(failure.message.length, 4096);
});

test('saved-tab cleanup survives serialization failure without replacing the primary error', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'selection',
    closeFails: true,
    serializationFails: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.attached.length, 1);
  assert.deepEqual(JSON.parse(result.attached[0].body), {
    phase: 'fixture-setup-failure-cleanup',
    failures: [],
  });
});

test('saved-tab cleanup falls back to one console report when attachment fails', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'selection',
    closeFails: true,
    attachmentFails: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.attachmentAttempts.length, 1);
  assert.equal(result.consoleErrors.length, 1);
});

test('saved-tab cleanup preserves primary failure when attachment and console fallback fail', () => {
  const result = runProfileSelectionCallSite({
    target: 'savedTab',
    kind: 'selection',
    closeFails: true,
    attachmentFails: true,
    consoleFails: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.equal(result.attachmentAttempts.length, 1);
  assert.deepEqual(result.attached, []);
});

test('registered menu callback has zero new observation with disabled or legacy-only opt-in', () => {
  for (const legacyEnabled of [false, true]) {
    const result = runProfileSelectionCallSite({
      target: 'menuBoundary',
      kind: 'body',
      legacyEnabled,
    });
    assert.equal(result.primaryIdentity, true);
    assert.deepEqual(result.boundaryCalls, [
      'panel-add-panel-group-terminal',
      'panel-add-menu-item-browser',
      'picker-assertion',
      'original-following-action',
      'terminal-cleanup',
    ]);
    assert.equal(result.observationCalls.evaluate, 0);
    assert.equal(result.observationCalls.mkdir, 0);
    assert.deepEqual(result.boundaryRecords, []);
    assert.equal(result.closeCalls.length, 1);
  }
});

for (const target of ['permissions', 'menuBoundary'])
  test(`registered ${target} setup failure closes the exact partial launch when diagnostics are disabled`, () => {
    const result = runProfileSelectionCallSite({
      target,
      setupFailure: true,
    });
    assert.equal(result.primaryIdentity, true, result.escapedMessage);
    assert.deepEqual(result.closeCalls, [
      {
        appMatches: true,
        userDataDir: '/isolated/profile-selection',
      },
    ]);
    assert.equal(result.observationCalls.evaluate, 0);
    assert.equal(result.observationCalls.mkdir, 0);
  });

for (const target of ['permissions', 'menuBoundary'])
  test(`registered ${target} setup failure records bounded seed and failure evidence when diagnostics are enabled`, () => {
    const result = runProfileSelectionCallSite({
      target,
      setupFailure: true,
      canonicalBoundaryDirectory: '/isolated/canonical-boundary',
    });
    assert.equal(result.primaryIdentity, true, result.escapedMessage);
    assert.equal(result.closeCalls.length, 1);
    assert.ok(
      result.boundaryRecords.some((record) => record.stage === 'seed-identity'),
    );
    assert.equal(result.observationCalls.write, 1);
    assert.equal(result.observationCalls.screenshot, 1);
    assert.ok(
      result.boundaryRecords.every(
        (record) => !String(record.stage).includes('hydration'),
      ),
    );
  });

test('registered menu callback arms before original clicks and releases before original continuation', () => {
  const result = runProfileSelectionCallSite({
    target: 'menuBoundary',
    kind: 'body',
    boundaryEnabled: true,
  });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(result.boundaryCalls, [
    'arm-create',
    'panel-add-panel-group-terminal',
    'browser-snapshot',
    'panel-add-menu-item-browser',
    'browser-snapshot',
    'picker-assertion',
    'browser-snapshot',
    'release-create',
    'original-following-action',
    'terminal-cleanup',
  ]);
  assert.deepEqual(
    result.boundaryRecords.map((value) => value.checkpoint),
    [
      'armed',
      'open-add-menu-click-return',
      'browser-item-click-return',
      'original-picker-assertion-complete',
      'observer-release',
    ],
  );
  assert.equal(result.closeCalls.length, 1);
});

test('registered menu callback uses the trimmed canonical boundary diagnostics directory', () => {
  const result = runProfileSelectionCallSite({
    target: 'menuBoundary',
    kind: 'body',
    canonicalBoundaryDirectory: '  /isolated/canonical-boundary  ',
  });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(
    result.boundaryDirectories,
    Array(3).fill('/isolated/canonical-boundary'),
  );
  assert.deepEqual(result.boundaryCalls, [
    'arm-create',
    'panel-add-panel-group-terminal',
    'browser-snapshot',
    'panel-add-menu-item-browser',
    'browser-snapshot',
    'picker-assertion',
    'browser-snapshot',
    'release-create',
    'original-following-action',
    'terminal-cleanup',
  ]);
  assert.deepEqual(
    result.boundaryRecords.map((value) => value.checkpoint),
    [
      'armed',
      'open-add-menu-click-return',
      'browser-item-click-return',
      'original-picker-assertion-complete',
      'observer-release',
    ],
  );
});

test('registered menu callback gives the canonical boundary directory precedence', () => {
  const result = runProfileSelectionCallSite({
    target: 'menuBoundary',
    kind: 'body',
    boundaryEnabled: true,
    canonicalBoundaryDirectory: '  /isolated/canonical-boundary  ',
  });
  assert.equal(result.primaryIdentity, true);
  assert.deepEqual(
    result.boundaryDirectories,
    Array(3).fill('/isolated/canonical-boundary'),
  );
  assert.ok(result.boundaryCalls.includes('browser-snapshot'));
  assert.ok(result.boundaryRecords.length > 0);
});

test('registered menu callback preserves original picker/click errors when observation and release fail', () => {
  for (const failure of [{ pickerFails: true }, { clickFails: true }]) {
    const result = runProfileSelectionCallSite({
      target: 'menuBoundary',
      kind: 'body',
      boundaryEnabled: true,
      boundaryObservationFails: true,
      ...failure,
    });
    assert.equal(result.primaryIdentity, true);
    assert.equal(
      result.boundaryCalls.filter(
        (value) => value === 'panel-add-menu-item-browser',
      ).length,
      1,
    );
    assert.ok(result.boundaryCalls.includes('release-create'));
    assert.ok(!result.boundaryCalls.includes('original-following-action'));
    assert.equal(result.closeCalls.length, 1);
    if (failure.pickerFails)
      assert.ok(
        result.boundaryRecords.some(
          (value) => value.checkpoint === 'original-picker-assertion-failed',
        ),
      );
  }
});

test('registered menu callback preserves picker sentinel and cleanup through never-settling diagnostic transport', () => {
  for (const pendingBoundary of ['failure', 'all']) {
    const result = runProfileSelectionCallSite({
      pendingDom: true,
      target: 'menuBoundary',
      kind: 'body',
      boundaryEnabled: true,
      pickerFails: true,
      pendingBoundary,
    });
    assert.equal(result.primaryIdentity, true, result.escapedMessage);
    assert.equal(result.callbackSettled, true);
    assert.equal(result.closeCalls.length, 1);
    assert.equal(
      result.boundaryCalls.filter((value) => value === 'terminal-cleanup')
        .length,
      1,
    );
    assert.equal(
      result.boundaryCalls.filter(
        (value) => value === 'panel-add-menu-item-browser',
      ).length,
      1,
    );
    assert.ok(result.boundaryTimerDelays.length >= 2);
    assert.ok(result.boundaryTimerDelays.every((value) => value === 2000));
    assert.ok(
      result.boundaryRecords.some(
        (value) =>
          value.checkpoint === 'original-picker-assertion-failed' &&
          value.dom?.status === 'unavailable',
      ),
    );
    assert.ok(
      result.boundaryRecords.some(
        (value) =>
          value.checkpoint === 'original-picker-assertion-failed' &&
          value.main?.status === 'unavailable',
      ),
    );
    assert.ok(
      result.boundaryRecords.some(
        (value) =>
          value.checkpoint === 'observer-release' &&
          value.status === 'unavailable',
      ),
    );
  }
});

test('registered menu callback consumes late diagnostic rejection after preserving original error and cleanup', () => {
  const result = runProfileSelectionCallSite({
    target: 'menuBoundary',
    kind: 'body',
    boundaryEnabled: true,
    pickerFails: true,
    pendingBoundary: 'failure',
    lateBoundaryReject: true,
  });
  assert.equal(result.primaryIdentity, true, result.escapedMessage);
  assert.equal(result.callbackSettled, true);
  assert.equal(result.closeCalls.length, 1);
  assert.deepEqual(result.unhandledBoundaryRejections, []);
  assert.ok(
    result.boundaryRecords.some((value) => value.status === 'late-rejected'),
  );
});

test('opted-in close markers retain original close/reap failure order and default close adds no observation', async () => {
  const events = [];
  const app = {
    close: async () => {
      events.push('actual-close');
    },
  };
  registerSupervisedProcessTree(app, 9274);
  const record = (stage, value) => events.push(`${stage}:${value.outcome}`);
  record.observe = (stage, action) => observeBoundary(stage, action, record);
  await closeCanopy(app, '/unused', {
    keepUserData: true,
    boundaryRecord: record,
    reapTree: async (pid) => {
      assert.equal(pid, 9274);
      events.push('actual-reap');
    },
  });
  assert.deepEqual(events, [
    'electronApp.close:entered',
    'actual-close',
    'electronApp.close:fulfilled',
    'owned-tree-reap:entered',
    'actual-reap',
    'owned-tree-reap:fulfilled',
  ]);
  const primary = new Error('graceful failed');
  const failing = {
    close: async () => {
      throw primary;
    },
  };
  await assert.rejects(
    closeCanopy(failing, '/unused', {
      keepUserData: true,
      boundaryRecord: createBoundaryRecorder(
        '/nonexistent-boundary-fixture/events.jsonl',
      ),
    }),
    (error) => error === primary,
  );
});

test('selected close records pending entry immediately without reaping early or mistaking a reused directory for the same app', async () => {
  let settle;
  const pending = new Promise((resolve) => {
    settle = resolve;
  });
  const records = [],
    reaped = [];
  const first = { close: () => pending };
  const second = { close: async () => {} };
  registerSupervisedProcessTree(first, 7101);
  registerSupervisedProcessTree(second, 7102);
  const record = (stage, operation) =>
    observeBoundary(stage, operation, (stage, details) =>
      records.push({ stage, ...details }),
    );
  const options = {
    keepUserData: true,
    reapTree: async (pid) => reaped.push(pid),
    boundaryRecord: { observe: record },
  };
  const closing = closeCanopy(first, '/owned-shared', options);
  await Promise.resolve();
  assert.ok(
    records.some(
      (row) => row.stage === 'electronApp.close' && row.outcome === 'entered',
    ),
  );
  assert.ok(!records.some((row) => row.outcome === 'fulfilled'));
  assert.deepEqual(reaped, []);
  settle();
  await closing;
  await closeCanopy(second, '/owned-shared', options);
  assert.deepEqual(reaped, [7101, 7102]);
});

test('an unavailable diagnostic page URL on an excluded native window cannot reject successful selection', async () => {
  const fixture = selectionFixture();
  const excluded = fixture.addPage(applicationWindow({ url: 'about:blank' }));
  excluded.url = () => {
    throw new Error('cached page URL unavailable');
  };
  const selected = fixture.select();
  const main = fixture.addPage(applicationWindow());
  assert.equal(await selected, main);
  assertSelectionListenersRemoved(fixture, [excluded, main]);
});

for (const disposal of ['pending', 'rejected'])
  test(`main-window inspection values survive ${disposal} disposal with the original error and calls`, async () => {
    const fixture = selectionFixture();
    const owner = applicationWindow();
    const page = fixture.addPage(owner, 'about:blank');
    const calls = [];
    const primary = new Error('original disposal rejection');
    let finishDisposal;
    const pending = new Promise((resolve) => {
      finishDisposal = resolve;
    });
    fixture.app.browserWindow = async () => ({
      evaluate: async (fn) => {
        calls.push('evaluate');
        return fn(owner);
      },
      dispose: () => {
        calls.push('dispose');
        return disposal === 'pending' ? pending : Promise.reject(primary);
      },
    });
    let evidence;
    try {
      await assert.rejects(fixture.select({ timeout: 20 }), (error) => {
        if (disposal === 'rejected') assert.equal(error, primary);
        else
          assert.equal(
            error.message,
            'Timed out identifying the application window.',
          );
        evidence = error.mainWindowSelection;
        const inspected = evidence.events.find(
          (event) => event.stage === 'inspection',
        );
        assert.ok(
          inspected,
          'completed evaluation must be retained before disposal settles',
        );
        assert.equal(inspected.nativeUrl, rendererUrl);
        assert.equal(inspected.pageUrl, 'about:blank');
        assert.equal(inspected.nativeOwner, true);
        assert.equal(inspected.parent, false);
        assert.ok(
          inspected.order <
            evidence.events.find(
              (event) => event.stage === 'selection-rejected',
            ).order,
        );
        return true;
      });
      assertSelectionListenersRemoved(fixture, [page]);
      assert.equal(page.listenerCount('close'), 0);
      assert.deepEqual(calls, ['evaluate', 'dispose']);
    } finally {
      finishDisposal();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.deepEqual(calls, ['evaluate', 'dispose']);
    assert.equal(
      evidence.events.filter((event) => event.stage === 'inspection').length,
      1,
    );
  });

test('real Playwright worker JSON reporting retains bounded selector evidence without rewriting errors', (t) => {
  const root = mkdtempSync(path.join(tmpdir(), 'selection-reporting-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reportPath = path.join(root, 'report.json');
  const configPath = path.join(root, 'playwright.config.mjs');
  const fixturePath = path.join(root, 'selection.spec.mjs');
  const playwrightTestUrl = new URL(
    '../../../../node_modules/@playwright/test/index.mjs',
    import.meta.url,
  ).href;
  const helperUrl = new URL('../electron/launchCanopy.mjs', import.meta.url)
    .href;
  writeFileSync(
    configPath,
    `export default ${JSON.stringify({ testDir: root, testMatch: 'selection.spec.mjs', outputDir: path.join(root, 'results'), workers: 1, retries: 0, reporter: [['json', { outputFile: reportPath }]] })};\n`,
  );
  writeFileSync(
    fixturePath,
    `
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from ${JSON.stringify(playwrightTestUrl)};
import { ElectronTerminalResultError, getMainWindow } from ${JSON.stringify(helperUrl)};
const rendererUrl = 'file:///owned/out-e2e/renderer/index.html';
function fixture(pageUrl, disposalError) {
  const app = new EventEmitter(), page = new EventEmitter(), calls = [];
  const frame = {};
  page.isClosed = () => false;
  page.url = () => pageUrl;
  page.mainFrame = () => frame;
  app.windows = () => [page];
  app.browserWindow = async () => ({
    evaluate: async (fn) => { calls.push('evaluate'); return fn({ isDestroyed: () => false, getParentWindow: () => null, webContents: { getURL: () => rendererUrl } }); },
    dispose: async () => { calls.push('dispose'); if (disposalError) throw disposalError; },
  });
  return { app, page, calls };
}
test('timeout preserves mismatch in the report', async () => {
  const value = fixture(rendererUrl + '?surface=app-advisor&token=private-query-secret');
  try { await getMainWindow(value.app, { rendererUrl, timeout: 20 }); assert.fail('selection must time out'); }
  catch (error) {
    assert.equal(error.message, 'Timed out identifying the application window.');
    assert.deepEqual(value.calls, ['evaluate', 'dispose']);
    assert.equal(value.app.listenerCount('window'), 0);
    throw error;
  }
});
test('disposal rejection preserves original identity message and cause', async () => {
  const cause = new Error('original disposal cause');
  const primary = new Error('original disposal rejection', { cause });
  const value = fixture('about:blank', primary);
  try { await getMainWindow(value.app, { rendererUrl }); assert.fail('selection must reject'); }
  catch (error) {
    assert.equal(error, primary);
    assert.equal(error.message, 'original disposal rejection');
    assert.equal(error.cause, cause);
    assert.deepEqual(value.calls, ['evaluate', 'dispose']);
    assert.equal(value.app.listenerCount('window'), 0);
    throw error;
  }
});
test('successful selection has no failure attachment', async () => {
  const value = fixture(rendererUrl);
  assert.equal(await getMainWindow(value.app, { rendererUrl }), value.page);
});
test('terminal tuple is retained in the error message', () => {
  throw new ElectronTerminalResultError({
    pid: 2468,
    exit: { code: 125, signal: null },
    close: { code: 125, signal: null },
  });
});
`,
  );
  const run = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('../../../../node_modules/playwright/cli.js', import.meta.url),
      ),
      'test',
      '--config',
      configPath,
    ],
    { encoding: 'utf8', env: process.env },
  );
  assert.equal(run.error, undefined);
  assert.equal(run.status, 1, run.stdout + run.stderr);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const specs = [];
  const visit = (suite) => {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites) visit(suite);
  assert.equal(specs.length, 4);
  const failed = specs.filter(
    (spec) => spec.title !== 'successful selection has no failure attachment',
  );
  for (const spec of failed) {
    const result = spec.tests[0].results[0];
    assert.equal(result.status, 'failed');
    if (spec.title === 'terminal tuple is retained in the error message') {
      assert.match(result.error.message, /terminal\.pid=2468/);
      assert.match(result.error.message, /terminal\.exit\.code=125/);
      assert.match(result.error.message, /terminal\.close\.code=125/);
      continue;
    }
    assert.equal(
      result.error.message,
      spec.title.startsWith('timeout')
        ? 'Error: Timed out identifying the application window.'
        : 'Error: original disposal rejection',
    );
    if (!spec.title.startsWith('timeout'))
      assert.equal(
        result.error.cause.message,
        'Error: original disposal cause',
      );
    const attachment = result.attachments.find(
      (item) => item.name === 'main-window-selection.json',
    );
    assert.ok(
      attachment,
      'actual worker/dispatcher/JSON reporter must retain the selection body',
    );
    assert.equal(attachment.contentType, 'application/json');
    const body = Buffer.from(attachment.body, 'base64');
    assert.ok(body.byteLength <= 32768);
    assert.ok(!body.toString().includes('private-query-secret'));
    const evidence = JSON.parse(body);
    assert.equal(
      evidence.expectedUrl,
      'file:///owned/out-e2e/renderer/index.html',
    );
    const inspected = evidence.events.find(
      (event) => event.stage === 'inspection',
    );
    assert.equal(inspected.nativeUrl, evidence.expectedUrl);
    assert.equal(
      inspected.pageUrl,
      spec.title.startsWith('timeout')
        ? evidence.expectedUrl + '?surface=app-advisor'
        : 'about:blank',
    );
    assert.ok(
      evidence.events.some((event) => event.stage === 'selection-rejected'),
    );
  }
  const success = specs.find(
    (spec) => spec.title === 'successful selection has no failure attachment',
  ).tests[0].results[0];
  assert.equal(success.status, 'passed');
  assert.deepEqual(success.attachments, []);
  t.diagnostic(
    JSON.stringify({
      actualPlaywrightReport: failed.map((spec) => ({
        title: spec.title,
        result: spec.tests[0].results[0],
      })),
    }),
  );
});

for (const context of ['absent', 'throwing-access', 'throwing-push'])
  test(`selector preserves original error when Playwright reporting context is ${context}`, async () => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const globals = require('../../../../node_modules/playwright/lib/common/globals.js');
    const previous = globals.currentTestInfo();
    let calls = 0;
    const attachments = [];
    attachments.push = () => {
      calls++;
      throw new Error('attachment reporting rejected');
    };
    globals.setCurrentTestInfo(
      context === 'absent'
        ? null
        : context === 'throwing-push'
          ? { attachments }
          : {
              get attachments() {
                calls++;
                throw new Error('reporting context rejected');
              },
            },
    );
    const cause = new Error('unchanged cause');
    const primary = new Error('unchanged native rejection', { cause });
    const fixture = selectionFixture();
    fixture.addPage(applicationWindow());
    fixture.app.browserWindow = () => Promise.reject(primary);
    try {
      await assert.rejects(fixture.select(), (error) => {
        assert.equal(error, primary);
        assert.equal(error.message, 'unchanged native rejection');
        assert.equal(error.cause, cause);
        assert.ok(error.mainWindowSelection);
        return true;
      });
      assert.equal(calls, context === 'absent' ? 0 : 1);
    } finally {
      globals.setCurrentTestInfo(previous);
    }
  });

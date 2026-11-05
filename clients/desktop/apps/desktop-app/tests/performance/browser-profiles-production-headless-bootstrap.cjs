'use strict';
// Test-only sidecar. The sole production target is the literal sibling ./index.js.
// Importing this file from the test harness is inactive; Electron executes its
// staged copy as the entry. No product environment variable or initialization hook.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const ADAPTER_VERSION = 'production-hidden-native-v1';
const BASENAME = 'browser-profiles-production-headless-bootstrap.cjs';
const SNAPSHOT_KEY = '__BROWSER_PROFILES_HEADLESS_SNAPSHOT__';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
function regular(file) {
  const stat = fs.lstatSync(file);
  assert(
    stat.isFile() && !stat.isSymbolicLink(),
    'Headless identity requires regular non-symlink file',
  );
  assert.equal(
    fs.realpathSync(file),
    file,
    'Headless identity realpath changed',
  );
  return stat;
}
const LAUNCHER_POLICY = Object.freeze({
  policy: 'playwright-explicit-executable-macos-v1',
  version: '1.64.1',
  sha256: '829521b67ed7be90c7d6d6098ff39f2241562d47e4ad7ccab13710924a56001d',
});
function buildExpectedArgv({
  productMainEntryPath,
  executablePath,
  electronArgs = [],
  launcherSourcePath,
  launcherVersion,
  platform = process.platform,
}) {
  assert.equal(
    platform,
    'darwin',
    'Production headless argv policy is verified only for macOS',
  );
  assert.equal(
    launcherVersion,
    LAUNCHER_POLICY.version,
    'Unknown Playwright launcher version',
  );
  assert.equal(
    hash(fs.readFileSync(launcherSourcePath)),
    LAUNCHER_POLICY.sha256,
    'Unknown Playwright launcher source',
  );
  const executable = fs.realpathSync(executablePath);
  assert(
    electronArgs.every(
      (arg) => typeof arg === 'string' && !arg.startsWith('--headless-'),
    ),
  );
  return freeze({
    expectedArgv: [
      executable,
      '--inspect=0',
      '--remote-debugging-port=0',
      // Already normalized by platformElectronArgs in the launch harness.
      ...electronArgs,
      productMainEntryPath,
    ],
    launcherIdentity: {
      ...LAUNCHER_POLICY,
      sourcePath: fs.realpathSync(launcherSourcePath),
      executablePath: executable,
    },
  });
}
function stageBootstrap(
  productMainEntryPath,
  { archivePath, expectedArgv, launcherIdentity } = {},
) {
  assert(
    typeof archivePath === 'string' &&
      path.isAbsolute(archivePath) &&
      archivePath.endsWith('.adapter.cjs'),
    'Adapter archive path must be absolute',
  );
  assert(
    Array.isArray(expectedArgv) && expectedArgv.at(-1) === productMainEntryPath,
    'Complete independent argv expectation required',
  );
  assert(
    launcherIdentity &&
      Object.entries(LAUNCHER_POLICY).every(
        ([key, value]) => launcherIdentity[key] === value,
      ),
    'Unknown launcher argv policy',
  );

  assert.equal(
    path.basename(productMainEntryPath),
    'index.js',
    'Exact production main required',
  );
  assert.equal(
    path.basename(path.dirname(productMainEntryPath)),
    'main',
    'Exact production main directory required',
  );
  assert.equal(
    path.basename(path.dirname(path.dirname(productMainEntryPath))),
    'out',
    'Production out required',
  );
  regular(productMainEntryPath);
  const sourcePath = fs.realpathSync(__filename);
  const bytes = fs.readFileSync(sourcePath);
  const launchEntryPath = path.join(
    path.dirname(productMainEntryPath),
    BASENAME,
  );
  // wx is the ownership boundary. A collision is never adopted or overwritten.
  const fd = fs.openSync(launchEntryPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
  const owned = regular(launchEntryPath);
  const adapterSha256 = hash(bytes);
  assert.equal(
    hash(fs.readFileSync(launchEntryPath)),
    adapterSha256,
    'Staged adapter hash changed',
  );
  const terminalPath = `${archivePath}.lifecycle.jsonl`;
  const terminalFd = fs.openSync(terminalPath, 'wx', 0o600);
  const terminalStat = fs.fstatSync(terminalFd);
  fs.closeSync(terminalFd);
  const contract = {
    schemaVersion: 1,
    launchId: randomUUID(),
    expectedArgv,
    launcherIdentity,
    archivePath,
    terminalPath,
    terminalFile: { dev: terminalStat.dev, ino: terminalStat.ino },
  };
  const contractBytes = JSON.stringify(contract);
  const identity = freeze({
    ...contract,
    launchContractSha256: hash(contractBytes),
    adapterVersion: ADAPTER_VERSION,
    adapterSha256,
    sourcePath,
    archivePath,
    launchEntryPath,
    productMainEntryPath,
    productMainSha256: hash(fs.readFileSync(productMainEntryPath)),
  });
  let cleaned = false;
  return {
    productMainEntryPath,
    launchEntryPath,
    identity,
    contractArgs: [
      `--headless-product-sha256=${identity.productMainSha256}`,
      `--headless-adapter-sha256=${adapterSha256}`,
      `--headless-launch-contract=${Buffer.from(contractBytes).toString('base64url')}`,
    ],
    cleanup() {
      assert(!cleaned, 'Sidecar already cleaned');
      const current = regular(launchEntryPath);
      assert(
        current.dev === owned.dev && current.ino === owned.ino,
        'Sidecar ownership identity changed',
      );
      assert.equal(
        hash(fs.readFileSync(launchEntryPath)),
        adapterSha256,
        'Sidecar bytes changed',
      );
      if (archivePath) {
        fs.writeFileSync(archivePath, fs.readFileSync(launchEntryPath), {
          flag: 'wx',
          mode: 0o600,
        });
        assert.equal(
          hash(fs.readFileSync(archivePath)),
          adapterSha256,
          'Archived staged adapter hash mismatch',
        );
      }
      fs.unlinkSync(launchEntryPath);
      cleaned = true;
    },
  };
}
function consumeLaunchContract(entry, argv) {
  regular(entry);
  assert.equal(path.basename(entry), BASENAME, 'Invalid bootstrap entry');
  const productMainEntryPath = path.join(path.dirname(entry), 'index.js');
  regular(productMainEntryPath);
  const names = ['product', 'adapter'];
  const expected = {};
  const remove = [];
  let contractBytes;
  for (let index = 0; index < argv.length; index++) {
    if (!argv[index].startsWith('--headless-')) continue;
    if (argv[index].startsWith('--headless-launch-contract=')) {
      assert(contractBytes === undefined, 'Repeated headless launch contract');
      const encoded = argv[index].slice('--headless-launch-contract='.length);
      assert(
        /^[A-Za-z0-9_-]+$/.test(encoded) && encoded.length <= 32768,
        'Invalid headless launch contract',
      );
      contractBytes = Buffer.from(encoded, 'base64url').toString('utf8');
      remove.push(index);
      continue;
    }
    const match = /^--headless-(product|adapter)-sha256=([a-f0-9]{64})$/.exec(
      argv[index],
    );
    assert(
      match && !expected[match[1]],
      'Unknown/repeated headless launch contract',
    );
    expected[match[1]] = match[2];
    remove.push(index);
  }
  assert(
    names.every((name) => expected[name]),
    'Missing headless launch contract',
  );
  assert.equal(
    hash(fs.readFileSync(entry)),
    expected.adapter,
    'Adapter identity hash mismatch',
  );
  assert.equal(
    hash(fs.readFileSync(productMainEntryPath)),
    expected.product,
    'Product identity hash mismatch',
  );
  assert.equal(
    argv.filter((arg) => arg === entry).length,
    1,
    'Bootstrap argv must contain one exact entry',
  );
  assert(!argv.includes(productMainEntryPath), 'Duplicate product argv entry');
  assert(contractBytes, 'Missing independent headless launch contract');
  const contract = JSON.parse(contractBytes);
  assert.deepEqual(
    Object.keys(contract).sort(),
    [
      'schemaVersion',
      'launchId',
      'expectedArgv',
      'launcherIdentity',
      'archivePath',
      'terminalPath',
      'terminalFile',
    ].sort(),
    'Unknown headless launch contract field',
  );
  assert.equal(contract.schemaVersion, 1);
  assert.match(contract.launchId, /^[a-f0-9-]{36}$/);
  assert(
    Array.isArray(contract.expectedArgv) &&
      contract.expectedArgv.at(-1) === productMainEntryPath,
  );
  assert(
    Object.entries(LAUNCHER_POLICY).every(
      ([key, value]) => contract.launcherIdentity?.[key] === value,
    ),
    'Unknown launcher argv policy',
  );
  assert.equal(
    contract.terminalPath,
    `${contract.archivePath}.lifecycle.jsonl`,
  );
  assert(
    path.isAbsolute(contract.archivePath) &&
      contract.archivePath.endsWith('.adapter.cjs'),
  );
  const terminalStat = regular(contract.terminalPath);
  assert(
    terminalStat.dev === contract.terminalFile?.dev &&
      terminalStat.ino === contract.terminalFile?.ino &&
      terminalStat.size === 0,
    'Terminal journal ownership or initial state changed',
  );
  for (const index of remove.reverse()) argv.splice(index, 1);
  argv[argv.indexOf(entry)] = productMainEntryPath;
  assert.equal(
    JSON.stringify(argv),
    JSON.stringify(contract.expectedArgv),
    'Native argv differs from complete independent direct-entry expectation',
  );
  return freeze({
    ...contract,
    launchContractSha256: hash(contractBytes),
    adapterVersion: ADAPTER_VERSION,
    adapterSha256: expected.adapter,
    productMainEntryPath,
    productMainSha256: expected.product,
    launchEntryPath: entry,
  });
}
function installAdapter(
  { app, BrowserWindow },
  identity,
  { limit = 2048, onActivity = () => {}, now = () => performance.now() } = {},
) {
  assert(Number.isInteger(limit) && limit > 0 && limit <= 2048);
  const installedAtMs = now();
  const windows = new Map(),
    calls = [],
    events = [],
    violations = [];
  let overflow = false;
  let lifetimeObservationIntact = true;
  const append = (list, value) => {
    onActivity('diagnostic-record');
    if (list.length >= limit) overflow = true;
    else list.push(value);
  };
  const violation = (reason) => append(violations, reason);
  const loseObservation = (window) => {
    if (!lifetimeObservationIntact) return;
    lifetimeObservationIntact = false;
    violation(`Native window ${window.id} observation lost while live`);
  };
  const installations = [];
  const targets = [
    [BrowserWindow.prototype, 'show'],
    [BrowserWindow.prototype, 'showInactive'],
    [BrowserWindow.prototype, 'focus'],
    [BrowserWindow.prototype, 'moveTop'],
    [app, 'focus'],
  ];
  // Native Electron methods may be inherited (BrowserWindow -> BaseWindow,
  // app -> App). Shadow only the selected target; never alter unrelated classes.
  const plans = targets.map(([target, method]) => {
    let owner = target;
    while (owner && !Object.hasOwn(owner, method))
      owner = Object.getPrototypeOf(owner);
    const descriptor = owner && Object.getOwnPropertyDescriptor(owner, method);
    assert(
      descriptor &&
        typeof descriptor.value === 'function' &&
        (owner === target
          ? descriptor.configurable || descriptor.writable
          : Object.isExtensible(target)),
      `Cannot intercept method descriptor: ${method}`,
    );
    return { target, owner, method, original: descriptor };
  });
  for (const { target, owner, method, original } of plans) {
    const wrapper = function () {
      append(calls, {
        method,
        target: target === app ? 'app' : 'window',
        id: target === app ? null : this.id,
        suppressed: true,
      });
    };
    Object.defineProperty(target, method, { ...original, value: wrapper });
    installations.push({
      target,
      owner,
      method,
      original,
      descriptor: Object.getOwnPropertyDescriptor(target, method),
      wrapper,
    });
  }
  const inspect = (window) => {
    const destroyed = window.isDestroyed();
    return {
      id: window.id,
      destroyed,
      visible: destroyed ? false : window.isVisible(),
      focused: destroyed ? false : window.isFocused(),
      webContentsId: destroyed ? null : window.webContents.id,
      rendererPid: destroyed ? null : window.webContents.getOSProcessId(),
      url: destroyed ? null : window.webContents.getURL(),
    };
  };
  const onWindowCreated = (_event, window) => {
    onActivity('browser-window-created');
    if (windows.size >= limit) {
      overflow = true;
      return;
    }
    const initial = inspect(window);
    const record = {
      window,
      initial,
      createdAtMs: now(),
      firstReadyToShowAtMs: null,
      readyToShow: 0,
      listeners: [],
    };
    if (windows.has(window.id)) violation('Duplicate native window ID');
    windows.set(window.id, record);
    if (initial.visible || initial.focused)
      violation('Visible/focused at construction; capability unavailable');
    const onReadyToShow = () => {
      onActivity('ready-to-show');
      if (record.firstReadyToShowAtMs === null)
        record.firstReadyToShowAtMs = now();
      record.readyToShow++;
    };
    window.on('ready-to-show', onReadyToShow);
    record.listeners.push({ event: 'ready-to-show', listener: onReadyToShow });
    for (const event of ['show', 'focus']) {
      const listener = () => {
        append(events, { id: window.id, event });
        violation(`Native ${event} event`);
      };
      window.on(event, listener);
      record.listeners.push({ event, listener });
    }
    // EventEmitter reports removals synchronously, before close can destroy the
    // window. Two sentinels observe each other's removal too: removing the meta
    // observers first cannot silently disable this lifetime-integrity latch.
    // Native cleanup after destruction is expected and does not indicate a gap.
    const onObserverRemoved = (event, listener) => {
      if (
        !window.isDestroyed() &&
        record.listeners.some(
          (entry) => entry.event === event && entry.listener === listener,
        )
      )
        loseObservation(window);
    };
    const onOtherObserverRemoved = (event, listener) =>
      onObserverRemoved(event, listener);
    for (const listener of [onObserverRemoved, onOtherObserverRemoved]) {
      window.on('removeListener', listener);
      record.listeners.push({ event: 'removeListener', listener });
    }
  };
  app.on('browser-window-created', onWindowCreated);
  assert.equal(
    BrowserWindow.getAllWindows().length,
    0,
    'Adapter installed after native windows',
  );
  return () => {
    for (const { window, listeners } of windows.values()) {
      if (
        !window.isDestroyed() &&
        !listeners.every(({ event, listener }) =>
          window.listeners(event).includes(listener),
        )
      )
        loseObservation(window);
    }
    const installed =
      lifetimeObservationIntact &&
      app.listeners('browser-window-created').includes(onWindowCreated) &&
      installations.every(
        ({ target, owner, original, method, descriptor, wrapper }) => {
          const current = Object.getOwnPropertyDescriptor(target, method);
          return (
            (owner === target ||
              Object.getOwnPropertyDescriptor(owner, method)?.value ===
                original.value) &&
            current?.value === wrapper &&
            current.configurable === descriptor.configurable &&
            current.writable === descriptor.writable &&
            current.enumerable === descriptor.enumerable
          );
        },
      );
    const observed = [...windows.values()].map(
      ({ window, initial, readyToShow }) => ({
        initial,
        current: inspect(window),
        readyToShow,
      }),
    );
    const inventory = BrowserWindow.getAllWindows().map((window) => window.id);
    const allWindowsObserved = inventory.every((id) => windows.has(id));
    const activated = observed.some(
      ({ current }) => current.visible || current.focused,
    );
    return freeze(
      JSON.parse(
        JSON.stringify({
          schemaVersion: 1,
          ...identity,
          pid: process.pid,
          installed,
          lifetimeObservationIntact,
          overflow,
          allWindowsObserved,
          valid:
            installed &&
            !overflow &&
            allWindowsObserved &&
            !activated &&
            violations.length === 0,
          calls,
          events,
          violations,
          windows: observed,
          timings: {
            installedAtMs,
            windows: [...windows.values()].map((record) => ({
              id: record.window.id,
              createdAtMs: record.createdAtMs,
              firstReadyToShowAtMs: record.firstReadyToShowAtMs,
            })),
          },
          liveWindowIds: inventory,
        }),
      ),
    );
  };
}
// Electron emits process exit inside an earlier app quit listener. Observe both
// complete dispatches without changing their listeners; terminalize only after
// the enclosing quit returns, including all listeners after the exit bridge.
// Missing, standalone or repeated dispatches never yield clean evidence.
function installTerminalLifecycle({ runtime, app, identity, snapshot }) {
  const stat = regular(identity.terminalPath);
  assert(
    stat.dev === identity.terminalFile.dev &&
      stat.ino === identity.terminalFile.ino &&
      stat.size === 0,
    'Terminal journal ownership changed',
  );
  const fd = fs.openSync(
    identity.terminalPath,
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_NOFOLLOW,
  );
  const opened = fs.fstatSync(fd);
  assert(
    opened.dev === stat.dev && opened.ino === stat.ino,
    'Terminal journal descriptor identity changed',
  );
  let quitObserved = false,
    quitActive = false,
    quitDispatchCompleted = false,
    invalidQuit = false,
    invalidExit = false,
    exitState,
    terminalWritten = false,
    records = 0,
    closed = false;
  const append = (record) => {
    assert(!closed, 'Terminal journal unexpectedly closed');
    // At most one start, one terminal and bounded late-activity diagnostics.
    if (records >= 66) return;
    fs.writeSync(
      fd,
      `${JSON.stringify({ schemaVersion: 1, launchId: identity.launchId, launchContractSha256: identity.launchContractSha256, pid: runtime.pid, ...record })}\n`,
    );
    records++;
    fs.fsyncSync(fd);
  };
  const descriptorMatches = (actual, expected) =>
    actual &&
    ['value', 'writable', 'configurable', 'enumerable'].every(
      (key) => actual[key] === expected[key],
    );
  // Plan both descriptors before changing either target. Native emit may be
  // inherited; retain and verify the ancestral original as well as our shadow.
  const plans = [
    [app, 'quit'],
    [runtime, 'exit'],
  ].map(([target, event]) => {
    let owner = target;
    while (owner && !Object.hasOwn(owner, 'emit'))
      owner = Object.getPrototypeOf(owner);
    const original = owner && Object.getOwnPropertyDescriptor(owner, 'emit');
    assert(
      original &&
        typeof original.value === 'function' &&
        (owner === target
          ? original.writable || original.configurable
          : Object.isExtensible(target)),
      `Native ${event} dispatch cannot be observed`,
    );
    return { target, event, owner, original };
  });
  const observerIntact = ({ target, owner, original, installed }) => {
    if (
      !descriptorMatches(
        Object.getOwnPropertyDescriptor(target, 'emit'),
        installed,
      )
    )
      return false;
    if (owner === target) return true;
    let ancestor = Object.getPrototypeOf(target);
    while (ancestor && !Object.hasOwn(ancestor, 'emit'))
      ancestor = Object.getPrototypeOf(ancestor);
    return (
      ancestor === owner &&
      descriptorMatches(
        Object.getOwnPropertyDescriptor(owner, 'emit'),
        original,
      )
    );
  };
  const terminalize = () => {
    let finalSnapshot, snapshotError;
    try {
      finalSnapshot = snapshot();
    } catch (error) {
      snapshotError = String(error);
    }
    terminalWritten = true;
    append({
      phase: 'process-exit',
      dispatchCompleted: exitState?.completed === true && !invalidExit,
      quitDispatchCompleted:
        quitDispatchCompleted && exitState?.enclosed === true && !invalidQuit,
      quitObserved,
      observerInstalled: plans.every(observerIntact),
      exitCode: exitState?.code,
      snapshot: finalSnapshot,
      snapshotError,
    });
  };
  for (const plan of plans) {
    const { target, event, original } = plan;
    const wrapper = function (...args) {
      if (args[0] !== event) return Reflect.apply(original.value, this, args);
      const first = event === 'quit' ? !quitObserved : !exitState;
      if (first) {
        if (event === 'quit') {
          quitObserved = true;
          quitActive = true;
        } else {
          exitState = { code: args[1], enclosed: quitActive, completed: false };
        }
      } else if (event === 'quit') invalidQuit = true;
      else invalidExit = true;
      let result, dispatchError, terminalError;
      let dispatchFailed = false,
        terminalFailed = false;
      try {
        result = Reflect.apply(original.value, this, args);
      } catch (error) {
        dispatchFailed = true;
        dispatchError = error;
      }
      if (first) {
        if (event === 'quit') {
          quitActive = false;
          quitDispatchCompleted = !dispatchFailed;
        } else exitState.completed = !dispatchFailed;
      }
      try {
        if (terminalWritten || !first) {
          append({
            phase: terminalWritten
              ? 'activity-after-exit-dispatch'
              : 'invalid-dispatch',
            kind: `${first ? 'late' : 'duplicate'}-${event}`,
          });
        } else if (event === 'quit' || !quitActive) terminalize();
      } catch (error) {
        terminalFailed = true;
        terminalError = error;
      }
      if (dispatchFailed && terminalFailed)
        throw new AggregateError(
          [dispatchError, terminalError],
          `Native ${event} and terminal persistence failed`,
        );
      if (dispatchFailed) throw dispatchError;
      if (terminalFailed) throw terminalError;
      return result;
    };
    Object.defineProperty(target, 'emit', { ...original, value: wrapper });
    plan.installed = Object.getOwnPropertyDescriptor(target, 'emit');
  }
  append({ phase: 'installed' });
  return {
    activity(kind) {
      if (terminalWritten)
        append({ phase: 'activity-after-exit-dispatch', kind });
    },
    // Used only by nonnative fixtures after simulating exit. Native OS shutdown
    // owns descriptor closure; no early close is exposed to production code.
    closeFixture() {
      if (!closed) {
        fs.closeSync(fd);
        closed = true;
      }
    },
  };
}
function readTerminalLifecycle(identity, pid) {
  const stat = regular(identity.terminalPath);
  assert(
    stat.dev === identity.terminalFile.dev &&
      stat.ino === identity.terminalFile.ino,
    'Terminal journal ownership changed',
  );
  assert(
    stat.size > 0 && stat.size <= 16 * 1024 * 1024,
    'Missing or oversized terminal evidence',
  );
  const bytes = fs.readFileSync(identity.terminalPath);
  assert(bytes.at(-1) === 10, 'Incomplete terminal journal record');
  const records = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line));
  return {
    schemaVersion: 1,
    terminalPath: identity.terminalPath,
    fileSha256: hash(bytes),
    size: bytes.length,
    pid,
    records,
  };
}
module.exports = {
  ADAPTER_VERSION,
  BASENAME,
  SNAPSHOT_KEY,
  stageBootstrap,
  consumeLaunchContract,
  installAdapter,
  LAUNCHER_POLICY,
  buildExpectedArgv,
  installTerminalLifecycle,
  readTerminalLifecycle,
};
const electronDefaultAppEntry =
  Boolean(process.versions.electron) &&
  process.defaultApp === true &&
  process.argv.slice(1).find((arg) => !arg.startsWith('-')) === __filename;
if (electronDefaultAppEntry) {
  assert.equal(
    process.argv.at(-1),
    __filename,
    'Electron default-app bootstrap must be the final argument',
  );
  assert.equal(
    process.argv.filter((arg) => arg === __filename).length,
    1,
    'Electron default-app bootstrap must occur exactly once',
  );
}
if (require.main === module || electronDefaultAppEntry) {
  assert(
    process.versions.electron,
    'Production bootstrap requires native Electron',
  );
  const identity = consumeLaunchContract(__filename, process.argv);
  const electron = require('electron');
  let lifecycle;
  const read = installAdapter(electron, identity, {
    onActivity: (kind) => lifecycle?.activity(kind),
  });
  const beforeImport = {
    appPath: electron.app.getAppPath(),
    cwd: process.cwd(),
    argv: [...process.argv],
    resourcesPath: process.resourcesPath,
    mainDirectory: path.dirname(identity.productMainEntryPath),
  };
  let productImported = false;
  Object.defineProperty(globalThis, SNAPSHOT_KEY, {
    value: () =>
      freeze({
        ...read(),
        beforeImport: structuredClone(beforeImport),
        productImported,
        currentIdentity: {
          appPath: electron.app.getAppPath(),
          cwd: process.cwd(),
          argv: [...process.argv],
          resourcesPath: process.resourcesPath,
        },
      }),
    writable: false,
    configurable: false,
    enumerable: false,
  });
  lifecycle = installTerminalLifecycle({
    runtime: process,
    app: electron.app,
    identity,
    snapshot: () => globalThis[SNAPSHOT_KEY](),
  });
  assert.equal(
    beforeImport.appPath,
    path.dirname(identity.productMainEntryPath),
    'Direct-entry application path mismatch',
  );
  // This literal is a production launch identity, never an overlaid test import.
  require('./index.js');
  productImported = true;
}

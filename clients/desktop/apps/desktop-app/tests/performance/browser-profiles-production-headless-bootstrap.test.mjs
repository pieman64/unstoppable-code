import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const load = () =>
  require('./browser-profiles-production-headless-bootstrap.cjs');
function fixture() {
  const root = realpathSync(
    mkdtempSync(path.join(os.tmpdir(), 'headless-bootstrap-unit-')),
  );
  const main = path.join(root, 'out/main/index.js');
  mkdirSync(path.dirname(main), { recursive: true });
  writeFileSync(main, 'module.exports = 1;\n');
  return {
    root,
    main,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
function stageFixture(main, options = {}) {
  const expectedArgv = [
    '/electron',
    '--inspect=0',
    '--remote-debugging-port=0',
    '--use-mock-keychain',
    main,
  ];
  return load().stageBootstrap(main, {
    archivePath: path.join(
      path.dirname(path.dirname(path.dirname(main))),
      'staged.adapter.cjs',
    ),
    expectedArgv,
    launcherIdentity: {
      ...load().LAUNCHER_POLICY,
      executablePath: '/electron',
      sourcePath: '/reviewed/playwright/electron.js',
    },
    ...options,
  });
}
function native() {
  const instances = [];
  class BaseWindow extends EventEmitter {
    moveTop() {
      this.visible = true; // Native ordering need not emit show/focus.
    }
  }
  class Window extends BaseWindow {
    constructor(id) {
      super();
      this.id = id;
      instances.push(this);
      this.visible = false;
      this.focused = false;
      this.webContents = {
        id: id + 10,
        getOSProcessId: () => id + 100,
        getURL: () => 'file:///renderer/index.html',
      };
    }
    isVisible() {
      return this.visible;
    }
    isFocused() {
      return this.focused;
    }
    isDestroyed() {
      return this.destroyed ?? false;
    }
    show() {
      throw new Error('activation escaped');
    }
    showInactive() {
      throw new Error('activation escaped');
    }
    focus() {
      throw new Error('activation escaped');
    }
  }
  Window.getAllWindows = () =>
    instances.filter((window) => !window.isDestroyed());
  const app = new EventEmitter();
  app.focus = () => {
    throw new Error('app activation escaped');
  };
  return { app, BrowserWindow: Window };
}
test('bootstrap staging owns one exact sibling, preserves product bytes and refuses collisions or modified cleanup', () => {
  const f = fixture();
  try {
    const before = readFileSync(f.main);
    const staged = stageFixture(f.main);
    assert.equal(path.dirname(staged.launchEntryPath), path.dirname(f.main));
    assert.equal(staged.productMainEntryPath, f.main);
    assert.deepEqual(readFileSync(f.main), before);
    assert.throws(() => stageFixture(f.main), /exist|collision/i);
    writeFileSync(staged.launchEntryPath, 'changed');
    assert.throws(() => staged.cleanup(), /changed|identity/i);
    assert(existsSync(staged.launchEntryPath));
  } finally {
    f.cleanup();
  }
});
test('bootstrap closed contract restores argv and rejects wrong main/hash/arbitrary target', () => {
  const { consumeLaunchContract } = load(),
    f = fixture();
  try {
    const staged = stageFixture(f.main);
    const argv = [
      '/electron',
      '--inspect=0',
      '--remote-debugging-port=0',
      '--use-mock-keychain',
      ...staged.contractArgs,
      staged.launchEntryPath,
    ];
    const value = consumeLaunchContract(staged.launchEntryPath, argv);
    assert.deepEqual(argv, [
      '/electron',
      '--inspect=0',
      '--remote-debugging-port=0',
      '--use-mock-keychain',
      f.main,
    ]);
    assert.equal(value.productMainSha256, staged.identity.productMainSha256);
    assert.throws(
      () =>
        consumeLaunchContract(staged.launchEntryPath, [
          'electron',
          '--headless-product-target=/tmp/other',
          ...staged.contractArgs,
          staged.launchEntryPath,
        ]),
      /contract/i,
    );
    writeFileSync(f.main, 'different production');
    assert.throws(
      () =>
        consumeLaunchContract(staged.launchEntryPath, [
          'electron',
          ...staged.contractArgs,
          staged.launchEntryPath,
        ]),
      /hash|identity/i,
    );
    staged.cleanup();
    assert(!existsSync(staged.launchEntryPath));
  } finally {
    f.cleanup();
  }
});
test('adapter suppresses activation before import and retains immutable all-window records', () => {
  const { installAdapter } = load(),
    electron = native();
  const snapshot = installAdapter(electron, { adapterSha256: 'a'.repeat(64) });
  const main = new electron.BrowserWindow(1);
  electron.app.emit('browser-window-created', {}, main);
  const first = snapshot();
  main.show();
  main.showInactive();
  main.focus();
  electron.app.focus();
  const advisor = new electron.BrowserWindow(2);
  electron.app.emit('browser-window-created', {}, advisor);
  const second = snapshot();
  assert(Object.isFrozen(first));
  assert(Object.isFrozen(first.windows));
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 4);
  assert.equal(second.windows.length, 2);
  assert.equal(second.valid, true);
  advisor.emit('show');
  assert.equal(snapshot().valid, false);
});
test('adapter records native creation and first ready-to-show on one monotonic clock', () => {
  const electron = native();
  let clock = 10;
  const snapshot = load().installAdapter(electron, {}, { now: () => clock });
  clock = 25;
  const main = new electron.BrowserWindow(1);
  electron.app.emit('browser-window-created', {}, main);
  clock = 40;
  main.emit('ready-to-show');
  clock = 50;
  main.emit('ready-to-show');
  assert.deepEqual(snapshot().timings, {
    installedAtMs: 10,
    windows: [{ id: 1, createdAtMs: 25, firstReadyToShowAtMs: 40 }],
  });
});

test('adapter fails closed on method descriptors, construction activation and bounded overflow', () => {
  const { installAdapter } = load();
  const broken = native();
  Object.defineProperty(broken.BrowserWindow.prototype, 'show', {
    value() {},
    configurable: false,
    writable: false,
  });
  assert.throws(() => installAdapter(broken, {}), /descriptor|intercept/i);
  const electron = native(),
    snapshot = installAdapter(electron, {}, { limit: 2 });
  const main = new electron.BrowserWindow(1);
  main.visible = true;
  electron.app.emit('browser-window-created', {}, main);
  assert.equal(snapshot().valid, false);
  main.show();
  main.show();
  main.show();
  assert.equal(snapshot().overflow, true);
  assert.equal(snapshot().calls.length, 2);
});
test('adapter intercepts inherited native methods and detects later descriptor replacement', () => {
  const { installAdapter } = load(),
    electron = native();
  delete electron.app.focus;
  Object.setPrototypeOf(
    electron.app,
    Object.assign(Object.create(EventEmitter.prototype), {
      focus() {
        throw new Error('escaped');
      },
    }),
  );
  const snapshot = installAdapter(electron, {});
  electron.app.focus();
  assert.equal(snapshot().calls.length, 1);
  electron.BrowserWindow.prototype.focus = () => {};
  assert.equal(snapshot().installed, false);
});

function runNativeEntry({
  requireMain = 'same',
  electronVersion = true,
  defaultApp = requireMain !== 'same',
  argv: argvOverride,
} = {}) {
  const f = fixture();
  try {
    const staged = stageFixture(f.main),
      electron = native(),
      module = { exports: {} };
    electron.app.getAppPath = () => path.dirname(f.main);
    const argv = argvOverride?.(staged) ?? [
      '/electron',
      '--inspect=0',
      '--remote-debugging-port=0',
      '--use-mock-keychain',
      ...staged.contractArgs,
      staged.launchEntryPath,
    ];
    const productArgv = [
      '/electron',
      '--inspect=0',
      '--remote-debugging-port=0',
      '--use-mock-keychain',
      f.main,
    ];
    let imported = 0;
    const fakeRequire = (name) => {
      if (name === 'electron') return electron;
      if (name === './index.js') {
        imported++;
        assert.deepEqual(argv, productArgv);
        const window = new electron.BrowserWindow(1);
        electron.app.emit('browser-window-created', {}, window);
        window.show();
        window.focus();
        electron.app.focus();
        return {};
      }
      assert(name.startsWith('node:'));
      return require(name);
    };
    fakeRequire.main =
      requireMain === 'same'
        ? module
        : requireMain === 'different'
          ? { exports: {} }
          : undefined;
    const context = {
      require: fakeRequire,
      module,
      __filename: staged.launchEntryPath,
      process: Object.assign(new EventEmitter(), {
        versions: electronVersion ? { electron: 'native-mock-only' } : {},
        defaultApp,
        pid: 100,
        argv,
        cwd: () => f.root,
        resourcesPath: '/electron/Resources',
      }),
      Buffer,
      structuredClone,
    };
    let error;
    try {
      runInNewContext(readFileSync(staged.launchEntryPath, 'utf8'), context);
    } catch (caught) {
      error = caught;
    }
    return {
      context,
      error,
      f,
      imported,
      module,
      productArgv,
      staged,
      cleanup() {
        staged.cleanup();
        f.cleanup();
      },
    };
  } catch (error) {
    f.cleanup();
    throw error;
  }
}

test('native entry installs suppression before literal product import for CJS main and Electron-import routes', () => {
  for (const requireMain of ['same', 'undefined', 'different']) {
    const entry = runNativeEntry({ requireMain });
    try {
      assert.ifError(entry.error);
      assert.equal(entry.imported, 1, `${requireMain} entry product import`);
      const evidence = entry.context.__BROWSER_PROFILES_HEADLESS_SNAPSHOT__();
      assert.equal(evidence.productImported, true);
      assert.equal(evidence.calls.length, 3);
      assert.equal(evidence.beforeImport.cwd, entry.f.root);
      assert.equal(evidence.beforeImport.appPath, path.dirname(entry.f.main));
      assert.deepEqual([...evidence.beforeImport.argv], entry.productArgv);
      assert.equal(
        Object.getOwnPropertyDescriptor(
          entry.context,
          '__BROWSER_PROFILES_HEADLESS_SNAPSHOT__',
        ).writable,
        false,
      );
    } finally {
      entry.cleanup();
    }
  }
});

test('ordinary Node and Electron library imports keep the bootstrap inactive', () => {
  for (const options of [
    { electronVersion: false, defaultApp: false },
    { electronVersion: false, defaultApp: true },
    { defaultApp: false },
    {
      argv: (staged) => [
        '/electron',
        '--headless-product-sha256=' + staged.identity.productMainSha256,
        '/another/application.cjs',
      ],
    },
    {
      argv: () => ['/electron', path.join('/another', load().BASENAME)],
    },
    {
      argv: (staged) => [
        '/electron',
        '/another/application.cjs',
        staged.launchEntryPath,
      ],
    },
    { argv: () => ['/electron', '--headless-unrelated'] },
  ]) {
    const entry = runNativeEntry({ requireMain: 'undefined', ...options });
    try {
      assert.ifError(entry.error);
      assert.equal(entry.imported, 0);
      assert.equal(
        entry.context.__BROWSER_PROFILES_HEADLESS_SNAPSHOT__,
        undefined,
      );
      assert.equal(readFileSync(entry.staged.identity.terminalPath).length, 0);
      assert.equal(
        typeof entry.module.exports.consumeLaunchContract,
        'function',
      );
    } finally {
      entry.cleanup();
    }
  }
});

test('selected Electron entry rejects malformed launcher and contract arguments before product import', () => {
  const cases = [
    {
      name: 'missing contract field',
      pattern: /Missing headless launch contract/,
      mutate(args) {
        args.splice(
          args.findIndex((arg) => arg.startsWith('--headless-product-sha256=')),
          1,
        );
      },
    },
    {
      name: 'repeated contract field',
      pattern: /Unknown\/repeated headless launch contract/,
      mutate(args) {
        args.splice(
          -1,
          0,
          args.find((arg) => arg.startsWith('--headless-product-sha256=')),
        );
      },
    },
    {
      name: 'hash-mismatched contract',
      pattern: /Product identity hash mismatch/,
      mutate(args) {
        const index = args.findIndex((arg) =>
          arg.startsWith('--headless-product-sha256='),
        );
        args[index] = `--headless-product-sha256=${'0'.repeat(64)}`;
      },
    },
    {
      name: 'extra launcher argument',
      pattern: /Native argv differs/,
      mutate(args) {
        args.splice(3, 0, '--unreviewed');
      },
    },
    {
      name: 'reordered launcher arguments',
      pattern: /Native argv differs/,
      mutate(args) {
        [args[1], args[2]] = [args[2], args[1]];
      },
    },
    {
      name: 'unknown headless argument',
      pattern: /Unknown\/repeated headless launch contract/,
      mutate(args) {
        args.splice(-1, 0, '--headless-unknown=value');
      },
    },
    {
      name: 'trailing argument',
      pattern: /final argument/,
      mutate(args) {
        args.push('--trailing');
      },
    },
    {
      name: 'duplicate entry',
      pattern: /exactly once/,
      mutate(args) {
        args.splice(-1, 0, args.at(-1));
      },
    },
  ];
  for (const scenario of cases) {
    const entry = runNativeEntry({
      requireMain: 'different',
      argv: (staged) => {
        const args = [
          '/electron',
          '--inspect=0',
          '--remote-debugging-port=0',
          '--use-mock-keychain',
          ...staged.contractArgs,
          staged.launchEntryPath,
        ];
        scenario.mutate(args);
        return args;
      },
    });
    try {
      assert(entry.error, `${scenario.name} must reject`);
      assert.match(String(entry.error), scenario.pattern, scenario.name);
      assert.equal(entry.imported, 0, scenario.name);
      assert.equal(
        entry.context.__BROWSER_PROFILES_HEADLESS_SNAPSHOT__,
        undefined,
        scenario.name,
      );
    } finally {
      entry.cleanup();
    }
  }
});
test('launchCanopy rejects unsupported production window options before any native launch', async () => {
  const { launchCanopy } = await import('../electron/launchCanopy.mjs');
  await assert.rejects(
    launchCanopy({ productionWindowMode: 'headless' }),
    /production headless/,
  );
  await assert.rejects(
    launchCanopy({ buildKind: 'production', productionWindowMode: 'headed' }),
    /production headless/,
  );
});
test('sidecar cleanup archives verified staged bytes exclusively after use', () => {
  const f = fixture();
  try {
    const archivePath = path.join(f.root, 'staged.adapter.cjs');
    const staged = stageFixture(f.main, { archivePath });
    const bytes = readFileSync(staged.launchEntryPath);
    assert.equal(existsSync(archivePath), false);
    staged.cleanup();
    assert.deepEqual(readFileSync(archivePath), bytes);
    rmSync(`${archivePath}.lifecycle.jsonl`);
    const collision = stageFixture(f.main, { archivePath });
    assert.throws(() => collision.cleanup(), /exist/i);
    assert(existsSync(collision.launchEntryPath));
  } finally {
    f.cleanup();
  }
});
test('adapter detects removed native window observers before admitting evidence', () => {
  const { installAdapter } = load(),
    electron = native();
  const snapshot = installAdapter(electron, {});
  const main = new electron.BrowserWindow(1);
  electron.app.emit('browser-window-created', {}, main);
  main.removeAllListeners('show');
  assert.equal(snapshot().installed, false);
});
test('headless teardown retains primary close failure and independent cleanup failure', async () => {
  const { closeWithRetainedFailures } =
    await import('../electron/launchCanopy.mjs');
  const primary = new Error('native close failed'),
    cleanup = new Error('owned group remains');
  let cleanupAttempted = false;
  await assert.rejects(
    closeWithRetainedFailures(
      async () => {
        throw primary;
      },
      async () => {
        cleanupAttempted = true;
        throw cleanup;
      },
    ),
    (error) => {
      assert(error instanceof AggregateError);
      assert.deepEqual(error.errors, [primary, cleanup]);
      assert.match(error.message, /native close failed.*owned group remains/);
      return true;
    },
  );
  assert.equal(cleanupAttempted, true);
  await assert.rejects(
    closeWithRetainedFailures(
      async () => {
        throw primary;
      },
      async () => {},
    ),
    (error) => error === primary,
  );
  await assert.rejects(
    closeWithRetainedFailures(
      async () => {},
      async () => {
        throw cleanup;
      },
    ),
    (error) => error === cleanup,
  );
});

test('complete expected argv rejects dropped, extra and reordered native launcher arguments before import', () => {
  const f = fixture();
  try {
    const staged = stageFixture(f.main);
    const argv = [
      '/electron',
      '--inspect=0',
      '--remote-debugging-port=0',
      '--use-mock-keychain',
      ...staged.contractArgs,
      staged.launchEntryPath,
    ];
    for (const mutate of [
      (args) => args.splice(3, 1),
      (args) => args.splice(3, 0, '--unreviewed'),
      (args) => {
        [args[1], args[2]] = [args[2], args[1]];
      },
    ]) {
      const broken = [...argv];
      mutate(broken);
      assert.throws(
        () => load().consumeLaunchContract(staged.launchEntryPath, broken),
        /argv/,
      );
    }
    staged.cleanup();
  } finally {
    f.cleanup();
  }
});

test('expected argv matches normalized launch args and pins the launcher source and version', async () => {
  const { platformElectronArgs } = await import('../electron/launchCanopy.mjs');
  const f = fixture();
  try {
    const packagePath = require.resolve('playwright-core/package.json');
    const options = {
      productMainEntryPath: f.main,
      executablePath: process.execPath,
      electronArgs: platformElectronArgs(
        '/tmp/headless-argv',
        ['--user-owned'],
        {
          platform: 'darwin',
        },
      ),
      launcherSourcePath: path.join(
        path.dirname(packagePath),
        'lib/server/electron/electron.js',
      ),
      launcherVersion: require(packagePath).version,
      platform: 'darwin',
    };
    const value = load().buildExpectedArgv(options);
    assert.deepEqual(value.expectedArgv, [
      realpathSync(process.execPath),
      '--inspect=0',
      '--remote-debugging-port=0',
      '--use-mock-keychain',
      '--user-owned',
      f.main,
    ]);
    assert.equal(value.launcherIdentity.sha256, load().LAUNCHER_POLICY.sha256);
    for (const changed of [
      { launcherVersion: 'unknown' },
      { launcherSourcePath: f.main },
      { platform: 'linux' },
    ])
      assert.throws(
        () => load().buildExpectedArgv({ ...options, ...changed }),
        /Unknown|verified only/,
      );
  } finally {
    f.cleanup();
  }
});

function lifecycleFixture({ bridge = true, configure = () => {} } = {}) {
  const f = fixture(),
    staged = stageFixture(f.main),
    electron = native();
  const runtime = Object.assign(new EventEmitter(), { pid: process.pid });
  const exitResults = [];
  if (bridge)
    electron.app.on('quit', (_event, code = 0) => {
      exitResults.push(runtime.emit('exit', code));
    });
  configure({ runtime, app: electron.app });
  let lifecycle;
  const nativeRead = load().installAdapter(electron, staged.identity, {
    onActivity: (kind) => lifecycle?.activity(kind),
  });
  const identity = {
    appPath: path.dirname(f.main),
    cwd: f.root,
    argv: staged.identity.expectedArgv,
    resourcesPath: '/electron/Resources',
  };
  const read = () => ({
    ...nativeRead(),
    productImported: true,
    beforeImport: structuredClone(identity),
    currentIdentity: structuredClone(identity),
  });
  const window = new electron.BrowserWindow(1);
  electron.app.emit('browser-window-created', {}, window);
  lifecycle = load().installTerminalLifecycle({
    runtime,
    app: electron.app,
    identity: staged.identity,
    snapshot: read,
  });
  return {
    ...f,
    staged,
    electron,
    runtime,
    exitResults,
    window,
    read,
    lifecycle,
    close() {
      lifecycle.closeFixture();
      f.cleanup();
    },
    terminal() {
      return load().readTerminalLifecycle(staged.identity, runtime.pid);
    },
  };
}

test('terminal journal observes activation from exit listeners registered after measurement and binds each record', () => {
  const f = lifecycleFixture();
  try {
    assert.equal(f.read().valid, true);
    f.runtime.on('exit', () => {
      f.window.emit('show');
      f.window.destroyed = true;
    });
    f.electron.app.emit('quit', {}, 0);
    const terminal = f.terminal(),
      ended = terminal.records.at(-1);
    assert.equal(ended.phase, 'process-exit');
    assert.equal(ended.dispatchCompleted, true);
    assert.equal(ended.quitObserved, true);
    assert.equal(ended.observerInstalled, true);
    assert.equal(ended.snapshot.valid, false);
    assert(ended.snapshot.events.some((event) => event.event === 'show'));
    for (const record of terminal.records) {
      assert.equal(record.launchId, f.staged.identity.launchId);
      assert.equal(
        record.launchContractSha256,
        f.staged.identity.launchContractSha256,
      );
      assert.equal(record.pid, process.pid);
    }
    f.window.emit('focus');
    assert.equal(
      f.terminal().records.at(-1).phase,
      'activity-after-exit-dispatch',
    );
  } finally {
    f.close();
  }
});

test('terminal journal preserves primary exit and terminal persistence failures', () => {
  const f = lifecycleFixture();
  try {
    f.runtime.on('exit', () => {
      throw new Error('primary exit failure');
    });
    f.lifecycle.closeFixture();
    assert.throws(
      () => f.runtime.emit('exit', 0),
      (error) =>
        error instanceof AggregateError &&
        error.errors.some((entry) =>
          /primary exit failure/.test(entry.message),
        ) &&
        error.errors.some((entry) => /unexpectedly closed/.test(entry.message)),
    );
  } finally {
    f.close();
  }
});

test('terminal journal rejects partial bytes and retains incomplete or replaced observers as incomplete', () => {
  const f = lifecycleFixture();
  try {
    assert.deepEqual(
      f.terminal().records.map(({ phase }) => phase),
      ['installed'],
    );
    delete f.electron.app.emit;
    f.runtime.emit('exit', 0);
    assert.equal(f.terminal().records.at(-1).observerInstalled, false);
    writeFileSync(f.staged.identity.terminalPath, '{"partial":');
    assert.throws(() => f.terminal(), /Incomplete/);
  } finally {
    f.close();
  }
});

for (const removal of [
  'activation-observers',
  'remove-listener-sentinels',
  'all-listeners',
  'remove-and-restore',
]) {
  test(`terminal rejects live observer loss followed by activation and destruction: ${removal}`, async () => {
    const {
      assertProductionHeadlessAdapter,
      assertProductionHeadlessTerminal,
    } = await import('./browser-profiles-evidence.mjs');
    const f = lifecycleFixture();
    try {
      const measured = f.read();
      assertProductionHeadlessAdapter(measured);
      f.runtime.on('exit', () => {
        if (removal === 'remove-listener-sentinels')
          f.window.removeAllListeners('removeListener');
        if (removal === 'all-listeners') f.window.removeAllListeners();
        const show = f.window.listeners('show');
        const focus = f.window.listeners('focus');
        f.window.removeAllListeners('show');
        f.window.removeAllListeners('focus');
        f.window.visible = true;
        f.window.emit('show');
        f.window.visible = false;
        if (removal === 'remove-and-restore') {
          for (const listener of show) f.window.on('show', listener);
          for (const listener of focus) f.window.on('focus', listener);
        }
        f.window.destroyed = true;
      });
      f.electron.app.emit('quit', {}, 0);
      const terminal = { ...f.terminal(), processGroupGone: true };
      assert.equal(
        terminal.records.at(-1).snapshot.windows[0].current.destroyed,
        true,
      );
      assert.throws(
        () =>
          assertProductionHeadlessTerminal(
            terminal,
            { ...f.staged.identity, pid: process.pid },
            [measured],
          ),
        /observation|capability|installed/i,
      );
    } finally {
      f.close();
    }
  });
}

test('terminal accepts normal listener cleanup after native window destruction', async () => {
  const { assertProductionHeadlessAdapter, assertProductionHeadlessTerminal } =
    await import('./browser-profiles-evidence.mjs');
  const f = lifecycleFixture();
  try {
    const measured = f.read();
    assertProductionHeadlessAdapter(measured);
    f.runtime.on('exit', () => {
      f.window.destroyed = true;
      f.window.removeAllListeners();
    });
    f.electron.app.emit('quit', {}, 0);
    const terminal = { ...f.terminal(), processGroupGone: true };
    assertProductionHeadlessTerminal(
      terminal,
      { ...f.staged.identity, pid: process.pid },
      [measured],
    );
  } finally {
    f.close();
  }
});

test('advisor show/focus/inherited moveTop remains hidden without native activation events', () => {
  const electron = native();
  assert.equal(
    Object.hasOwn(electron.BrowserWindow.prototype, 'moveTop'),
    false,
  );
  const read = load().installAdapter(electron, {});
  const advisor = new electron.BrowserWindow(2);
  electron.app.emit('browser-window-created', {}, advisor);
  advisor.show();
  advisor.focus();
  advisor.moveTop();
  const observed = read();
  assert.deepEqual(observed.events, []);
  assert.equal(
    advisor.isVisible(),
    false,
    'advisor native ordering escaped suppression',
  );
  assert.equal(observed.valid, true);
  assert.deepEqual(
    observed.calls.map(({ method }) => method),
    ['show', 'focus', 'moveTop'],
  );
});

test('Electron earlier quit-to-exit bridge produces a fully completed clean terminal', async () => {
  const { assertProductionHeadlessTerminal } =
    await import('./browser-profiles-evidence.mjs');
  const f = lifecycleFixture({ bridge: true });
  try {
    const measured = f.read();
    f.runtime.on('exit', () => {
      f.window.destroyed = true;
    });
    f.electron.app.on('quit', () => {
      assert.deepEqual(
        f.terminal().records.map(({ phase }) => phase),
        ['installed'],
        'nested exit must not terminalize before later quit listeners',
      );
    });
    assert.equal(f.electron.app.emit('quit', {}, 0), true);
    const terminal = { ...f.terminal(), processGroupGone: true };
    assert.deepEqual(
      terminal.records.map(({ phase }) => phase),
      ['installed', 'process-exit'],
    );
    assert.equal(terminal.records[1].dispatchCompleted, true);
    assert.equal(terminal.records[1].quitDispatchCompleted, true);
    assertProductionHeadlessTerminal(
      terminal,
      { ...f.staged.identity, pid: process.pid },
      [measured],
    );
  } finally {
    f.close();
  }
});

async function validateFixtureTerminal(f, measured, extra = {}) {
  const { assertProductionHeadlessTerminal } =
    await import('./browser-profiles-evidence.mjs');
  return assertProductionHeadlessTerminal(
    { ...f.terminal(), processGroupGone: true, ...extra },
    { ...f.staged.identity, pid: process.pid },
    [measured],
  );
}

for (const event of ['show', 'focus']) {
  test(`quit listener after nested exit cannot activate then destroy a window: ${event}`, async () => {
    const f = lifecycleFixture();
    try {
      const measured = f.read();
      f.electron.app.on('quit', () => {
        f.window.emit(event);
        f.window.destroyed = true;
      });
      f.electron.app.emit('quit');
      const ended = f.terminal().records[1];
      assert.equal(f.terminal().records.length, 2);
      assert.equal(ended.quitDispatchCompleted, true);
      assert.equal(ended.snapshot.windows[0].current.destroyed, true);
      assert.equal(ended.snapshot.valid, false);
      assert(ended.snapshot.events.some((entry) => entry.event === event));
      await assert.rejects(
        () => validateFixtureTerminal(f, measured),
        /capability/,
      );
    } finally {
      f.close();
    }
  });
}

test('quit listener after nested exit cannot leave a newly created live window', async () => {
  const f = lifecycleFixture();
  try {
    const measured = f.read();
    f.runtime.on('exit', () => {
      f.window.destroyed = true;
    });
    f.electron.app.on('quit', () => {
      const next = new f.electron.BrowserWindow(2);
      f.electron.app.emit('browser-window-created', {}, next);
    });
    f.electron.app.emit('quit');
    const ended = f.terminal().records[1];
    assert.deepEqual(ended.snapshot.liveWindowIds, [2]);
    assert.equal(ended.snapshot.windows.length, 2);
    await assert.rejects(
      () => validateFixtureTerminal(f, measured),
      /live native windows/,
    );
  } finally {
    f.close();
  }
});

for (const target of ['app', 'runtime']) {
  for (const change of [
    'remove',
    'flags',
    'ancestor',
    'ancestral-flags',
    'prototype',
  ]) {
    test(`quit listener after nested exit detects ${target} dispatch observer ${change}`, async () => {
      const f = lifecycleFixture({
        configure(objects) {
          const value = objects[target];
          const proto = Object.create(Object.getPrototypeOf(value));
          Object.defineProperty(proto, 'emit', {
            value: value.emit,
            configurable: true,
            writable: true,
            enumerable: false,
          });
          Object.setPrototypeOf(value, proto);
        },
      });
      try {
        const measured = f.read();
        const value = target === 'app' ? f.electron.app : f.runtime;
        f.electron.app.on('quit', () => {
          f.window.destroyed = true;
          if (change === 'remove') delete value.emit;
          if (change === 'flags')
            Object.defineProperty(value, 'emit', { enumerable: true });
          if (change === 'ancestor')
            Object.getPrototypeOf(value).emit = () => false;
          if (change === 'ancestral-flags')
            Object.defineProperty(Object.getPrototypeOf(value), 'emit', {
              enumerable: true,
            });
          if (change === 'prototype')
            Object.setPrototypeOf(value, EventEmitter.prototype);
        });
        f.electron.app.emit('quit');
        assert.equal(f.terminal().records[1].observerInstalled, false);
        await assert.rejects(
          () => validateFixtureTerminal(f, measured),
          /observer lost/,
        );
      } finally {
        f.close();
      }
    });
  }
}

for (const event of ['quit', 'exit']) {
  for (const thrown of [new Error(`${event} dispatch failed`), undefined]) {
    test(`${event} dispatch preserves ${thrown ? 'error identity' : 'undefined throws'} and incomplete evidence`, async () => {
      const f = lifecycleFixture();
      try {
        const measured = f.read();
        const emitter = event === 'quit' ? f.electron.app : f.runtime;
        emitter.on(event, () => {
          f.window.destroyed = true;
          throw thrown;
        });
        let caught = false;
        try {
          f.electron.app.emit('quit');
        } catch (error) {
          caught = true;
          assert.equal(error, thrown);
        }
        assert.equal(caught, true);
        const ended = f.terminal().records[1];
        assert.equal(ended.dispatchCompleted, event === 'quit');
        assert.equal(ended.quitDispatchCompleted, false);
        await assert.rejects(
          () => validateFixtureTerminal(f, measured),
          /dispatch incomplete/,
        );
      } finally {
        f.close();
      }
    });
  }
  test(`${event} errors aggregate terminal persistence failure without replacing primary error`, () => {
    const f = lifecycleFixture();
    const primary = new Error(`${event} primary`);
    try {
      const emitter = event === 'quit' ? f.electron.app : f.runtime;
      emitter.on(event, () => {
        throw primary;
      });
      f.lifecycle.closeFixture();
      assert.throws(
        () => f.electron.app.emit('quit'),
        (error) =>
          error instanceof AggregateError &&
          error.errors[0] === primary &&
          /unexpectedly closed/.test(error.errors[1].message),
      );
    } finally {
      f.close();
    }
  });
}

for (const event of ['quit', 'exit']) {
  for (const ordering of [
    'reentrant',
    'duplicate-during-quit',
    'post-terminal',
  ]) {
    test(`${ordering} ${event} retains first dispatch and cannot become clean evidence`, async () => {
      const f = lifecycleFixture();
      try {
        const measured = f.read();
        const emitter = event === 'quit' ? f.electron.app : f.runtime;
        const emitAgain = () =>
          event === 'quit'
            ? emitter.emit(event, {}, 9)
            : emitter.emit(event, 9);
        f.runtime.on('exit', () => {
          f.window.destroyed = true;
        });
        if (ordering === 'reentrant') emitter.once(event, emitAgain);
        if (ordering === 'duplicate-during-quit')
          f.electron.app.once('quit', emitAgain);
        f.electron.app.emit('quit', {}, 0);
        const firstTerminal = f
          .terminal()
          .records.find((record) => record.phase === 'process-exit');
        if (ordering === 'post-terminal') emitAgain();
        const records = f.terminal().records;
        assert.equal(
          records.filter((record) => record.phase === 'process-exit').length,
          1,
        );
        assert.equal(firstTerminal.exitCode, 0);
        assert.deepEqual(
          records.find((record) => record.phase === 'process-exit'),
          firstTerminal,
        );
        assert(
          records.some((record) =>
            /invalid-dispatch|activity-after-exit-dispatch/.test(record.phase),
          ),
        );
        if (ordering !== 'post-terminal')
          assert.equal(
            firstTerminal[
              event === 'quit' ? 'quitDispatchCompleted' : 'dispatchCompleted'
            ],
            false,
          );
        await assert.rejects(
          () => validateFixtureTerminal(f, measured),
          /lifecycle records/,
        );
      } finally {
        f.close();
      }
    });
  }
}

for (const mode of [
  'standalone-exit',
  'missing-exit',
  'nonzero-exit',
  'process-not-gone',
  'post-terminal-activation',
]) {
  test(`terminal consumer rejects ${mode}`, async () => {
    const f = lifecycleFixture({ bridge: mode !== 'missing-exit' });
    try {
      const measured = f.read();
      f.runtime.on('exit', () => {
        f.window.destroyed = true;
      });
      if (mode === 'standalone-exit') f.runtime.emit('exit', 0);
      else f.electron.app.emit('quit', {}, mode === 'nonzero-exit' ? 1 : 0);
      if (mode === 'post-terminal-activation') f.window.emit('show');
      if (mode === 'standalone-exit' || mode === 'missing-exit') {
        const ended = f.terminal().records[1];
        assert.equal(ended.quitDispatchCompleted, false);
        assert.equal(ended.dispatchCompleted, mode === 'standalone-exit');
        assert.equal(ended.quitObserved, mode === 'missing-exit');
        // A later synthetic event cannot replace the incomplete first terminal.
        if (mode === 'missing-exit') f.runtime.emit('exit', 0);
        else f.electron.app.emit('quit');
        assert.deepEqual(f.terminal().records[1], ended);
      }
      await assert.rejects(() =>
        validateFixtureTerminal(
          f,
          measured,
          mode === 'process-not-gone' ? { processGroupGone: false } : {},
        ),
      );
    } finally {
      f.close();
    }
  });
}

test('lifecycle forwards original emit receivers, arguments, returns and product listener order', async () => {
  const dispatches = [],
    order = [];
  const returns = { app: {}, runtime: {} };
  const f = lifecycleFixture({
    configure(objects) {
      for (const [name, target] of Object.entries(objects)) {
        const original = target.emit;
        target.emit = function (...args) {
          dispatches.push({ name, receiver: this, args });
          Reflect.apply(original, this, args);
          return returns[name];
        };
      }
    },
  });
  try {
    const measured = f.read();
    const token = {};
    f.runtime.on('exit', function (code) {
      assert.equal(this, f.runtime);
      assert.equal(code, 0);
      order.push('exit');
      f.window.destroyed = true;
    });
    f.electron.app.on('quit', function (arg, code) {
      assert.equal(this, f.electron.app);
      assert.equal(arg, token);
      assert.equal(code, 0);
      order.push('later-quit');
    });
    assert.equal(f.electron.app.emit('quit', token, 0), returns.app);
    assert.deepEqual(order, ['exit', 'later-quit']);
    assert.deepEqual(f.exitResults, [returns.runtime]);
    assert.deepEqual(
      dispatches.filter(({ args }) => ['quit', 'exit'].includes(args[0])),
      [
        { name: 'app', receiver: f.electron.app, args: ['quit', token, 0] },
        { name: 'runtime', receiver: f.runtime, args: ['exit', 0] },
      ],
    );
    await validateFixtureTerminal(f, measured);
    const other = new EventEmitter();
    assert.equal(
      Reflect.apply(f.runtime.emit, other, ['unrelated', token]),
      returns.runtime,
    );
    assert.equal(dispatches.at(-1).receiver, other);
    assert.deepEqual(dispatches.at(-1).args, ['unrelated', token]);
  } finally {
    f.close();
  }
});

test('moveTop descriptor interception retains inherited original integrity and bounded diagnostics', () => {
  for (const mutation of ['shadow', 'ancestor']) {
    const electron = native();
    const originalOwner = Object.getPrototypeOf(
      electron.BrowserWindow.prototype,
    );
    const read = load().installAdapter(electron, {}, { limit: 2 });
    const window = new electron.BrowserWindow(1);
    electron.app.emit('browser-window-created', {}, window);
    for (let count = 0; count < 3; count++) window.moveTop();
    assert.equal(window.isVisible(), false);
    assert.equal(read().overflow, true);
    assert.equal(read().calls.length, 2);
    (mutation === 'shadow'
      ? electron.BrowserWindow.prototype
      : originalOwner
    ).moveTop = () => {};
    assert.equal(read().installed, false);
  }
  const electron = native();
  Object.defineProperty(electron.BrowserWindow.prototype, 'moveTop', {
    value() {},
    configurable: false,
    writable: false,
  });
  assert.throws(
    () => load().installAdapter(electron, {}),
    /intercept method descriptor: moveTop/,
  );
});

test('repeated dispatch diagnostics stay bounded and never overwrite the initial terminal', async () => {
  const f = lifecycleFixture();
  try {
    const measured = f.read();
    f.runtime.on('exit', () => {
      f.window.destroyed = true;
    });
    f.electron.app.emit('quit', {}, 0);
    const ended = f.terminal().records[1];
    for (let count = 0; count < 100; count++)
      f.electron.app.emit('quit', {}, 9);
    assert.equal(f.terminal().records.length, 66);
    assert.deepEqual(f.terminal().records[1], ended);
    assert.equal(ended.exitCode, 0);
    await assert.rejects(
      () => validateFixtureTerminal(f, measured),
      /lifecycle records/,
    );
  } finally {
    f.close();
  }
});

test('a product-caught exit error still leaves the nested dispatch incomplete', async () => {
  const primary = new Error('caught exit error');
  const f = lifecycleFixture({
    bridge: false,
    configure({ app, runtime }) {
      app.on('quit', () => {
        assert.throws(
          () => runtime.emit('exit', 0),
          (error) => error === primary,
        );
      });
    },
  });
  try {
    const measured = f.read();
    f.runtime.on('exit', () => {
      f.window.destroyed = true;
      throw primary;
    });
    assert.equal(f.electron.app.emit('quit'), true);
    assert.equal(f.terminal().records[1].dispatchCompleted, false);
    assert.equal(f.terminal().records[1].quitDispatchCompleted, true);
    await assert.rejects(
      () => validateFixtureTerminal(f, measured),
      /exit dispatch incomplete/,
    );
  } finally {
    f.close();
  }
});

for (const phase of ['measurement', 'terminal']) {
  test(`actual adapter moveTop call history passes ${phase} consumer`, async () => {
    const { assertProductionHeadlessAdapter } =
      await import('./browser-profiles-evidence.mjs');
    const f = lifecycleFixture();
    try {
      f.window.show();
      f.window.focus();
      f.window.moveTop();
      const measured = f.read();
      assert.equal(measured.valid, true);
      assert.equal(f.window.isVisible(), false);
      assert.deepEqual(
        measured.calls.map(({ method }) => method),
        ['show', 'focus', 'moveTop'],
      );
      if (phase === 'measurement')
        assertProductionHeadlessAdapter(measured, f.staged.identity);
      else {
        f.runtime.on('exit', () => {
          f.window.destroyed = true;
        });
        f.electron.app.emit('quit', {}, 0);
        assert.deepEqual(
          f.terminal().records[1].snapshot.calls,
          measured.calls,
        );
        await validateFixtureTerminal(f, measured);
      }
    } finally {
      f.close();
    }
  });
}

test('moveTop consumer vocabulary retains target, id, suppression, bounds and visibility constraints', async () => {
  const { assertProductionHeadlessAdapter, assertProductionHeadlessTerminal } =
    await import('./browser-profiles-evidence.mjs');
  const f = lifecycleFixture();
  try {
    f.window.show();
    f.window.focus();
    f.window.moveTop();
    f.window.showInactive();
    f.electron.app.focus();
    const measured = f.read();
    assertProductionHeadlessAdapter(measured, f.staged.identity);
    f.runtime.on('exit', () => {
      f.window.destroyed = true;
    });
    f.electron.app.emit('quit', {}, 0);
    const terminal = { ...f.terminal(), processGroupGone: true };
    const launch = { ...f.staged.identity, pid: process.pid };
    assertProductionHeadlessTerminal(terminal, launch, [measured]);
    const callChanges = [
      ['app moveTop', { target: 'app', id: null }],
      ['app show', { target: 'app', id: null, method: 'show' }],
      ['app showInactive', { target: 'app', id: null, method: 'showInactive' }],
      ['app focus with window id', { target: 'app', method: 'focus' }],
      ['unsupported restore', { method: 'restore' }],
      ['unsupported hide', { method: 'hide' }],
      ['arbitrary method', { method: 'unknown' }],
      ['wrong method case', { method: 'movetop' }],
      ['unknown target', { target: 'browser-window' }],
      ['missing target', { target: undefined }],
      ['null id', { id: null }],
      ['zero id', { id: 0 }],
      ['negative id', { id: -1 }],
      ['fractional id', { id: 1.5 }],
      ['string id', { id: '1' }],
      ['nonfinite id', { id: NaN }],
      ['missing id', { id: undefined }],
      ['unsuppressed call', { suppressed: false }],
      ['missing suppression', { suppressed: undefined }],
    ];
    const mutations = [
      ...callChanges.map(([name, change]) => [
        name,
        (snapshot) => {
          Object.assign(snapshot.calls[2], change);
        },
      ]),
      [
        'malformed call',
        (snapshot) => {
          snapshot.calls[2] = null;
        },
      ],
      [
        'missing calls',
        (snapshot) => {
          delete snapshot.calls;
        },
      ],
      [
        'call bound exceeded',
        (snapshot) => {
          snapshot.calls = Array.from({ length: 2049 }, () => ({
            ...snapshot.calls[2],
          }));
        },
      ],
      [
        'overflow flag',
        (snapshot) => {
          snapshot.overflow = true;
        },
      ],
      [
        'native visibility',
        (snapshot) => {
          snapshot.windows[0].current.visible = true;
        },
      ],
      [
        'native focus',
        (snapshot) => {
          snapshot.windows[0].current.focused = true;
        },
      ],
    ];
    for (const [name, mutate] of mutations) {
      const invalidMeasurement = structuredClone(measured);
      mutate(invalidMeasurement);
      assert.throws(
        () =>
          assertProductionHeadlessAdapter(
            invalidMeasurement,
            f.staged.identity,
          ),
        undefined,
        `${name}: measurement`,
      );
      const invalidTerminal = structuredClone(terminal);
      mutate(invalidTerminal.records[1].snapshot);
      assert.throws(
        () =>
          assertProductionHeadlessTerminal(invalidTerminal, launch, [measured]),
        undefined,
        `${name}: terminal`,
      );
    }
    // The inclusive maximum remains accepted independently of the producer's overflow latch.
    const atLimit = structuredClone(measured);
    atLimit.calls = Array.from({ length: 2048 }, () => ({
      ...measured.calls[2],
    }));
    assertProductionHeadlessAdapter(atLimit, f.staged.identity);
  } finally {
    f.close();
  }
});

// Bounded, credential-free checkpoints for the two cloud-save ordering flows.
// Main-process output must survive even if its evaluation context disappears.
export async function captureCloudCredentialDiagnostics(electronApp, testInfo) {
  const entries = [];
  let bytes = 0;
  const limit = 128 * 1024;
  const mark = (event, detail = {}) => {
    const line = JSON.stringify({ at: Date.now(), event, ...detail });
    entries.push(line);
    bytes += Buffer.byteLength(line) + 1;
    while (bytes > limit && entries.length > 1)
      bytes -= Buffer.byteLength(entries.shift()) + 1;
  };
  // Electron evaluate rewrites generic CDP failures as "context destroyed".
  // Retain the original protocol category before that rewrite, without logging
  // expressions, arguments, return values or arbitrary error text.
  const session = electronApp._connection?.toImpl?.(electronApp)?._nodeSession;
  const restoreProtocol = [];
  if (session) {
    const send = session.send;
    session.send = async function (method, ...args) {
      try {
        return await send.call(this, method, ...args);
      } catch (error) {
        if (method.startsWith('Runtime.')) {
          const reason =
            [
              'Cannot find object with given id',
              'Could not find object with given id',
              'Cannot find context with specified id',
              'Execution context was destroyed',
              'Execution was terminated',
              'Internal server error, session closed.',
              'Internal error',
            ].find((text) => error.message?.includes(text)) ?? 'other';
          mark('main-protocol-error', { method, type: error.type, reason });
        }
        throw error;
      }
    };
    restoreProtocol.push(() => {
      session.send = send;
    });
    for (const event of [
      'Runtime.executionContextCreated',
      'Runtime.executionContextDestroyed',
      'Runtime.executionContextsCleared',
    ]) {
      const listener = () => mark('main-context-lifecycle', { kind: event });
      session.on(event, listener);
      restoreProtocol.push(() => session.removeListener(event, listener));
    }
  }
  const consoleListener = (message) => {
    const text = message.text();
    if (text.startsWith('[cloud-credential-diagnostic] '))
      mark('main', { message: text });
  };
  const stderrListener = (chunk) => {
    // Only native termination diagnostics: never retain ordinary application
    // output, IPC arguments, credential contents or native child wire data.
    for (const line of chunk.toString().split('\n'))
      if (
        /FATAL|Check failed|Assertion|SIG(?:ABRT|TRAP|SEGV)|Trace\/breakpoint trap/.test(
          line,
        )
      )
        mark('native-fatal', { message: line.slice(0, 2048) });
  };
  electronApp.on('console', consoleListener);
  const child = electronApp.process();
  child.stderr?.on('data', stderrListener);
  const onExit = (code, signal) => mark('process-exit', { code, signal });
  child.on('exit', onExit);
  const onWindow = (page) => {
    page.on('crash', () => mark('renderer-crash'));
    page.on('close', () => mark('renderer-close'));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) mark('renderer-navigation');
    });
  };
  for (const page of electronApp.windows()) onWindow(page);
  electronApp.on('window', onWindow);
  const handle = await electronApp.evaluateHandle(
    ({ app, ipcMain, safeStorage }) => {
      const restore = [];
      const note = (event, detail = {}) =>
        console.log(
          '[cloud-credential-diagnostic] ' +
            JSON.stringify({
              at: Date.now(),
              pid: process.pid,
              event,
              ...detail,
            }),
        );
      for (const event of [
        'before-quit',
        'will-quit',
        'quit',
        'render-process-gone',
      ]) {
        const listener = () => note(event);
        app.on(event, listener);
        restore.push(() => app.removeListener(event, listener));
      }
      const handlers = ipcMain._invokeHandlers;
      const channel = 'settings:save-canopy-cloud-api-key';
      const original = handlers.get(channel);
      let sequence = 0;
      if (original) {
        handlers.set(channel, async function (...args) {
          const attempt = ++sequence;
          const started = Date.now();
          note('save-enter', { attempt });
          try {
            const result = await original.apply(this, args);
            note('save-return', {
              attempt,
              ms: Date.now() - started,
              authenticated: result?.status?.authenticated,
              read: result?.account?.read,
              failure: result?.account?.secureStorageFailure?.code,
            });
            return result;
          } catch (error) {
            note('save-throw', {
              attempt,
              ms: Date.now() - started,
              name: error?.name,
            });
            throw error;
          }
        });
        restore.push(() => handlers.set(channel, original));
      }
      for (const method of ['encryptString', 'decryptString']) {
        const descriptor = Object.getOwnPropertyDescriptor(safeStorage, method);
        const original = safeStorage[method];
        safeStorage[method] = function (...args) {
          const started = Date.now();
          note('native-enter', { method });
          try {
            const result = original.apply(this, args);
            note('native-return', { method, ms: Date.now() - started });
            return result;
          } catch (error) {
            note('native-throw', {
              method,
              ms: Date.now() - started,
              name: error?.name,
            });
            throw error;
          }
        };
        restore.push(() => {
          if (descriptor)
            Object.defineProperty(safeStorage, method, descriptor);
          else delete safeStorage[method];
        });
      }
      const childProcess = process.getBuiltinModule('node:child_process');
      const spawn = childProcess.spawnSync;
      childProcess.spawnSync = function (file, args, options) {
        const helper =
          options?.env?.CANOPY_LINUX_SAFE_STORAGE_HELPER_MODE === '1';
        const started = Date.now();
        if (helper) note('helper-enter');
        try {
          const result = spawn.apply(this, arguments);
          if (helper)
            note('helper-return', {
              ms: Date.now() - started,
              status: result.status,
              signal: result.signal,
              error: result.error?.code,
            });
          return result;
        } catch (error) {
          if (helper)
            note('helper-throw', {
              ms: Date.now() - started,
              name: error?.name,
            });
          throw error;
        }
      };
      restore.push(() => {
        childProcess.spawnSync = spawn;
      });
      note('attached');
      return {
        restore() {
          for (const action of restore.reverse()) action();
        },
      };
    },
  );
  return {
    mark,
    async finish() {
      mark('test-finished', {
        exitCode: child.exitCode,
        signal: child.signalCode,
      });
      try {
        await handle.evaluate((fixture) => fixture.restore());
        mark('main-available-at-cleanup');
      } catch (error) {
        mark('main-unavailable-at-cleanup', { name: error.name });
      }
      await handle.dispose().catch(() => {});
      for (const restore of restoreProtocol.reverse()) restore();
      electronApp.removeListener('console', consoleListener);
      electronApp.removeListener('window', onWindow);
      child.stderr?.removeListener('data', stderrListener);
      child.removeListener('exit', onExit);
      await testInfo.attach('cloud-credential-main-process.log', {
        body: entries.join('\n') + '\n',
        contentType: 'text/plain',
      });
    },
  };
}

/* eslint-disable @typescript-eslint/no-require-imports -- Isolated native capability probe. */
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const { createServer } = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const [root, output] = process.argv.slice(-2);
assert.match(path.basename(root), /^browser-profile-clear-/);
app.setPath('userData', path.join(root, 'user-data'));
app.on('window-all-closed', () => {});
const evidence = {
  kind: 'shared-worker-quiescence',
  versions: process.versions,
  platform: process.platform,
  checks: [],
};
const startedAt = process.hrtime.bigint();
const readiness = (evidence.readiness = {
  requests: { a: 0, b: 0 },
  scriptRequests: 0,
  pageRequests: 0,
  iterations: 0,
  phases: [],
  errors: [],
  dropped: 0,
});
const phase = (stage, owner) => {
  if (readiness.phases.length >= 64) {
    readiness.dropped++;
    return;
  }
  readiness.phases.push({
    stage,
    owner,
    elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  });
};
const startupError = (owner, message) => {
  if (readiness.errors.length >= 16) {
    readiness.dropped++;
    return;
  }
  readiness.errors.push({
    owner,
    message: String(message).slice(0, 512),
    elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
  });
};
const releases = [];
const views = [];
const windows = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (test) => {
  for (let i = 0; i < 250; i++) {
    if (await test()) return;
    await delay(20);
  }
  throw new Error('Shared worker probe timed out');
};
const requests = readiness.requests;
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/shared.js') {
    readiness.scriptRequests = Math.min(100000, readiness.scriptRequests + 1);
    phase('worker-script-request');
    response.setHeader('Content-Type', 'application/javascript');
    response.end(
      `const diagnosticPorts = []; const reportError = value => { for (const port of diagnosticPorts) { try { port.postMessage({profileSharedWorkerError:String(value).slice(0,512)}); } catch {} } }; self.addEventListener('error', event => reportError(event.message)); self.addEventListener('unhandledrejection', event => reportError(event.reason)); let running = false; onconnect = event => { const port = event.ports[0]; if (diagnosticPorts.length < 8) diagnosticPorts.push(port); port.onmessage = async event => { if (running) return; running = true; const id = event.data; let count = 0; while (true) { const cache = await caches.open('shared'); await cache.put('/value', new Response(String(++count))); await fetch('/producer?id=' + id); await new Promise(resolve => setTimeout(resolve, 10)); } }; port.start(); };`,
    );
  } else if (url.pathname === '/producer') {
    const id = url.searchParams.get('id');
    if (id === 'a' || id === 'b')
      requests[id] = Math.min(100000, requests[id] + 1);
    response.end('ok');
  } else {
    readiness.pageRequests = Math.min(100000, readiness.pageRequests + 1);
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Shared worker owner</title>');
  }
});
const make = async (native, url, owner) => {
  phase('page-create-entered', owner);
  const view = new WebContentsView({
    webPreferences: {
      session: native,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  const win = new BrowserWindow({ show: false });
  windows.push(win);
  win.contentView.addChildView(view);
  views.push(view.webContents);
  if (owner) {
    const contents = view.webContents;
    const consoleError = (details) => {
      if (
        typeof details?.message === 'string' &&
        details.message.startsWith('__PROFILE_SHARED_WORKER_ERROR__')
      )
        startupError(owner, details.message);
    };
    const failed = (_event, code, description) =>
      startupError(owner, `load ${code}: ${description}`);
    const gone = (_event, details) =>
      startupError(owner, `renderer ${details?.reason}`);
    contents.on('console-message', consoleError);
    contents.on('did-fail-load', failed);
    contents.on('render-process-gone', gone);
    releases.push(() => {
      contents.removeListener('console-message', consoleError);
      contents.removeListener('did-fail-load', failed);
      contents.removeListener('render-process-gone', gone);
    });
  }
  phase('page-load-entered', owner);
  await view.webContents.loadURL(url);
  phase('page-load-fulfilled', owner);
  return view.webContents;
};
const check = (name, condition) => {
  assert(condition, name);
  evidence.checks.push(name);
};
app
  .whenReady()
  .then(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const a = session.fromPartition('persist:shared-a'),
      b = session.fromPartition('persist:shared-b');
    const control = await make(a, 'about:blank');
    control.debugger.attach('1.3');
    const controlB = await make(b, 'about:blank');
    controlB.debugger.attach('1.3');
    const context = (await control.debugger.sendCommand('Target.getTargetInfo'))
      .targetInfo.browserContextId;
    const contextB = (
      await controlB.debugger.sendCommand('Target.getTargetInfo')
    ).targetInfo.browserContextId;
    evidence.contexts = { a: context, b: contextB };
    check(
      'Each Session exposes a distinct nonempty browser context',
      context && contextB && context !== contextB,
    );
    const pageA = await make(a, origin, 'a'),
      pageB = await make(b, origin, 'b');
    for (const [page, id] of [
      [pageA, 'a'],
      [pageB, 'b'],
    ]) {
      phase('writer-start-entered', id);
      await page.executeJavaScript(
        `window.writer = new SharedWorker('/shared.js'); window.writer.addEventListener('error', event => console.error('__PROFILE_SHARED_WORKER_ERROR__' + String(event.message).slice(0,512))); window.writer.port.addEventListener('message', event => { if (typeof event.data?.profileSharedWorkerError === 'string') console.error('__PROFILE_SHARED_WORKER_ERROR__' + event.data.profileSharedWorkerError); }); window.writer.port.start(); window.writer.port.postMessage('${id}');`,
      );
      phase('writer-start-fulfilled', id);
    }
    phase('writer-readiness-entered');
    await until(() => {
      readiness.iterations++;
      return requests.a >= 5 && requests.b >= 5;
    });
    phase('writer-readiness-fulfilled');
    const targets = () =>
      control.debugger
        .sendCommand('Target.getTargets')
        .then((result) =>
          result.targetInfos.filter((info) => info.type === 'shared_worker'),
        );
    evidence.before = await targets();
    check(
      'Both workers have their owning Session context',
      evidence.before.some((t) => t.browserContextId === context) &&
        evidence.before.some((t) => t.browserContextId === contextB),
    );
    phase('shutdown-entered', 'a');
    const destroyed = new Promise((resolve) =>
      pageA.once('destroyed', resolve),
    );
    pageA.close({ waitForBeforeUnload: false });
    await destroyed;
    await delay(300);
    evidence.afterLastClientClose = await targets();
    const owned = evidence.afterLastClientClose.filter(
      (t) => t.browserContextId === context,
    );
    for (const target of owned) {
      const closed = await control.debugger.sendCommand('Target.closeTarget', {
        targetId: target.targetId,
      });
      check('Explicit owned shared-worker shutdown succeeds', closed.success);
    }
    await until(
      async () =>
        !(await targets()).some((t) => t.browserContextId === context),
    );
    const before = { ...requests };
    await delay(400);
    evidence.requests = { before, after: { ...requests } };
    check(
      'The cleared Session has no writer requests after shutdown',
      before.a === requests.a,
    );
    check('The other Session continues producing', requests.b > before.b);
    phase('shutdown-fulfilled', 'a');
    evidence.passed = true;
  })
  .catch((error) => {
    phase('failure');
    evidence.error = error.stack;
  })
  .finally(async () => {
    for (const release of releases) release();
    for (const contents of views) {
      try {
        if (!contents.isDestroyed())
          contents.close({ waitForBeforeUnload: false });
      } catch {
        /* The fixture target may already be destroyed during cleanup. */
      }
    }
    for (const win of windows) {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch {
        /* The fixture target may already be destroyed during cleanup. */
      }
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.writeFile(output, JSON.stringify(evidence, null, 2));
    app.exit(evidence.passed ? 0 : 1);
  });

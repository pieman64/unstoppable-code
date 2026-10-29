import { BrowserWindow, WebContentsView } from 'electron';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(25);
  }
  throw new Error(`Condition timed out after ${ms} ms`);
}
export function bounded(promise, ms = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ms} ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
export async function createFixtures() {
  const routes = new Map();
  const servers = [];
  for (let i = 0; i < 2; i++) {
    const server = createServer((req, res) => {
      const handler = routes.get(new URL(req.url, 'http://127.0.0.1').pathname);
      if (!handler) {
        res.writeHead(404);
        res.end('probe route missing');
        return;
      }
      if (typeof handler === 'function') handler(req, res);
      else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(handler);
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
  }
  return {
    mainOrigin: `http://127.0.0.1:${servers[0].address().port}`,
    crossOrigin: `http://localhost:${servers[1].address().port}`,
    register: (route, handler) => routes.set(route, handler),
    close: () =>
      Promise.all(
        servers.map(
          (server) =>
            new Promise((resolve) => {
              server.closeAllConnections();
              server.close(resolve);
            }),
        ),
      ),
  };
}
export async function createView(url, options = {}) {
  const window = new BrowserWindow({ show: false, width: 900, height: 700 });
  const view = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      partition: `can1570-${Date.now()}-${Math.random()}`,
      ...(options.preload ? { preload: options.preload } : {}),
    },
  });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
  const wc = view.webContents;
  // A never-navigated WebContents has no live frame, and the first CDP command
  // on it does not answer. Commit a blank document before attaching.
  await bounded(wc.loadURL('about:blank'), 10000);
  wc.debugger.attach('1.3');
  const events = [];
  const commands = [];
  const sessions = new Map();
  const send = async (method, params = {}, sessionId) => {
    const record = {
      seq: commands.length,
      method,
      params,
      sessionId: sessionId ?? null,
      startedMs: performance.now(),
    };
    commands.push(record);
    try {
      const result = await bounded(
        wc.debugger.sendCommand(method, params, sessionId),
        options.commandTimeoutMs ?? 6000,
      );
      // Cost sampling repeats large snapshots; keeping every response would
      // make the report too large to serialize.
      if (options.retainResults === false) record.resultRetained = false;
      else record.result = result;
      return result;
    } catch (error) {
      record.error = String(error);
      throw error;
    } finally {
      record.durationMs = performance.now() - record.startedMs;
    }
  };
  const attachParams = {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: 'iframe', exclude: false }, { exclude: true }],
  };
  wc.debugger.on('message', (_event, method, params, sessionId) => {
    events.push({
      seq: events.length,
      atMs: performance.now(),
      method,
      params,
      // Electron reports the root session as an empty string.
      sessionId: sessionId || null,
    });
    if (
      method === 'Target.attachedToTarget' &&
      params.targetInfo.type === 'iframe'
    ) {
      sessions.set(params.sessionId, params.targetInfo);
      void Promise.all([
        send('Target.setAutoAttach', attachParams, params.sessionId),
        send('Page.enable', {}, params.sessionId),
      ]).catch(() => {});
    }
    // An iframe target attaches with an empty URL; the committed URL arrives
    // in a later targetInfoChanged, so keep the stored info current.
    if (method === 'Target.targetInfoChanged') {
      for (const [id, info] of sessions) {
        if (info.targetId === params.targetInfo.targetId)
          sessions.set(id, params.targetInfo);
      }
    }
    if (method === 'Target.detachedFromTarget')
      sessions.delete(params.sessionId);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Target.setAutoAttach', attachParams);
  // Production enables focus emulation when it attaches the debugger
  // (browser-service.ts attachDebugger, CAN-1993), so it is the default here.
  // `focusEmulation: false` is the control: in a host that is not shown the
  // page then reports visibilityState "hidden" and pointer input stalls.
  const focusEmulation = options.focusEmulation !== false;
  if (focusEmulation)
    await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const evaluate = async (expression, sessionId, extra = {}) => {
    const result = await send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true, ...extra },
      sessionId,
    );
    if (result.exceptionDetails)
      throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  if (url) {
    await wc.loadURL(url);
    await sleep(250);
  }
  return {
    window,
    view,
    wc,
    send,
    evaluate,
    events,
    commands,
    sessions,
    focusEmulation,
    evidence: () => ({ events, commands }),
    dispose: () => {
      if (!wc.isDestroyed()) wc.close();
      if (!window.isDestroyed()) window.destroy();
    },
  };
}

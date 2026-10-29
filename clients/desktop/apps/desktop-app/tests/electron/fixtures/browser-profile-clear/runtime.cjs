/* eslint-disable @typescript-eslint/no-require-imports -- Standalone Electron CommonJS entry, launched outside the app bundle. */
// Adversarial native capability evidence for browser profile clear. Synthetic only.
// The product must still enforce preview authorization, fencing and recovery.
const { app, BrowserWindow, WebContentsView, session } = require('electron');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { createServer: createHttpsServer } = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const partitioned = require('./partitioned.cjs');
const verifyClosedDocument = require('./verify-closed.cjs');
const verifyClosed = (control, origin, topLevelOrigin) =>
  verifyClosedDocument(
    control,
    origin,
    topLevelOrigin,
    (evidence.verifierProgress ??= []),
  );
const [root, output] = process.argv.slice(-2);
assert.match(path.basename(root), /^browser-profile-clear-/);
assert(path.isAbsolute(root));
app.setPath('userData', path.join(root, 'user-data'));
// Only this isolated probe process resolves these reserved synthetic hosts.
app.commandLine.appendSwitch(
  'host-resolver-rules',
  'MAP embedded.test 127.0.0.1, MAP first.test 127.0.0.1, MAP second.test 127.0.0.1',
);
app.on('window-all-closed', () => {});
const evidence = {
  kind: 'adversarial-native-clear-capability',
  versions: process.versions,
  platform: process.platform,
  checks: [],
};
const windows = [];
const servers = [];
const diagnosticReleases = [];
let writerPhaseSnapshot;
// Public service-worker console events, synthetic Session/source/marker only.
function observeWriterPhases(native, origins) {
  const marker = '__PROFILE_CLEAR_OPFS_PHASE__';
  const records = [];
  const latest = new Map();
  let first = null;
  let dropped = 0,
    fieldTruncations = 0,
    size = 0,
    latestSize = 0,
    firstSize = 4;
  const serializedBytes = (value) => Buffer.byteLength(JSON.stringify(value));
  const envelope = () => ({
    dropped,
    fieldTruncations,
    truncated: dropped > 0 || fieldTruncations > 0,
    observation:
      'Latest delivered console phase, not an atomic worker shutdown snapshot; console observer adds scheduling overhead.',
  });
  // Include array separators, the reserved first/latest records, every label and
  // counter in the same serialized-byte budget; Unicode/JSON escaping count too.
  const snapshotBytes = () =>
    serializedBytes({ records: [], first: null, latest: [], ...envelope() }) +
    size +
    Math.max(0, records.length - 1) +
    firstSize -
    4 +
    latestSize +
    Math.max(0, latest.size - 1);
  const trim = () => {
    while (records.length > 128 || snapshotBytes() > 64 * 1024) {
      size -= serializedBytes(records.shift());
      dropped++;
    }
  };
  const listener = (_event, message) => {
    if (
      !Number.isSafeInteger(message.versionId) ||
      !origins.some((origin) => message.sourceUrl === `${origin}/worker.js`) ||
      !message.message.startsWith(marker) ||
      message.message.length > 2048
    )
      return;
    try {
      const value = JSON.parse(message.message.slice(marker.length));
      if (
        ![
          'get-handle',
          'create-writable',
          'write',
          'close',
          'closed',
          'error',
        ].includes(value.phase) ||
        !Number.isSafeInteger(value.sequence) ||
        !Number.isSafeInteger(value.completedSequence)
      )
        return;
      const record = {
        receivedAt: Date.now(),
        versionId: message.versionId,
        sourceUrl: message.sourceUrl,
        phase: value.phase,
        sequence: value.sequence,
        completedSequence: value.completedSequence,
      };
      if (value.error) {
        const name = String(value.error.name),
          message = String(value.error.message);
        record.error = {
          name: name.slice(0, 128),
          message: message.slice(0, 240),
          truncated: name.length > 128 || message.length > 240,
        };
        if (record.error.truncated) fieldTruncations++;
      }
      const bytes = serializedBytes(record);
      if (!first) {
        first = record;
        firstSize = bytes;
      }
      records.push(record);
      size += bytes;
      if (latest.has(message.versionId) || latest.size < 8) {
        const previous = latest.get(message.versionId);
        if (previous) latestSize -= serializedBytes(previous);
        latest.set(message.versionId, record);
        latestSize += bytes;
      }
      trim();
    } catch {
      dropped++;
      // A counter gaining another digit also belongs to the serialized budget.
      trim();
    }
  };
  native.serviceWorkers.on('console-message', listener);
  const release = () =>
    native.serviceWorkers.removeListener('console-message', listener);
  diagnosticReleases.push(release);
  return () => ({
    records: [...records],
    first,
    latest: [...latest.values()],
    ...envelope(),
  });
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deadline = setTimeout(() => {
  evidence.error = 'Native probe timed out';
  void finish(1);
}, 60_000);
let finishing = false;
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (writerPhaseSnapshot) evidence.writerPhasesFinal = writerPhaseSnapshot();
  for (const release of diagnosticReleases) release();
  for (const win of windows) if (!win.isDestroyed()) win.destroy();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
  await fs.writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  app.exit(code);
}
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  evidence.checks.push(name);
}
async function until(test, name) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (await test()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${name}`);
}
const storage = `
async function database() { return new Promise((resolve, reject) => {
 const request = indexedDB.open('writer', 1); request.onupgradeneeded = () => request.result.createObjectStore('data');
 request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
}); }
async function write(sequence) {
 const db = await database(); await new Promise((resolve, reject) => { const tx = db.transaction('data', 'readwrite');
 tx.objectStore('data').put(sequence, 'value'); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close();
 const cache = await caches.open('writer'); await cache.put('/value', new Response(String(sequence)));
 const root = await navigator.storage.getDirectory(); if (typeof writerPhase === 'function') writerPhase('get-handle',sequence); const handle = await root.getFileHandle('writer', { create: true });
 if (typeof writerPhase === 'function') writerPhase('create-writable',sequence); const file = await handle.createWritable(); if (typeof writerPhase === 'function') writerPhase('write',sequence); await file.write(String(sequence)); if (typeof writerPhase === 'function') writerPhase('close',sequence); await file.close(); if (typeof writerPhase === 'function') writerPhase('closed',sequence);
}
async function read(omitFile = false) {
 const databases = await indexedDB.databases(); let value = null;
 if (databases.some((entry) => entry.name === 'writer')) { const db = await database(); value = await new Promise((resolve, reject) => {
 const request = db.transaction('data').objectStore('data').get('value'); request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(request.error); }); db.close(); }
 const cached = await caches.match('/value'); let opfs = null;
 try { if (!omitFile) { const root = await navigator.storage.getDirectory(); opfs = await (await (await root.getFileHandle('writer')).getFile()).text(); } } catch (error) { if (error.name !== 'NotFoundError') throw error; }
 return { indexed: value, cache: cached ? await cached.text() : null, opfs, worker: (await navigator.serviceWorker.getRegistrations()).length > 0 };
}`;
const worker = `let completedSequence = 0;
function writerPhase(phase,sequence,error) { try { if (phase === 'closed') completedSequence = sequence; console.log('__PROFILE_CLEAR_OPFS_PHASE__' + JSON.stringify({phase,sequence,completedSequence,...(error ? {error:{name:String(error.name).slice(0,128),message:String(error.message).slice(0,240)}} : {})})); } catch {} }
${storage}
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => { if (event.data === 'write') event.waitUntil((async () => {
 let sequence = 0; while (true) { try { await write(++sequence); } catch (error) { writerPhase('error',sequence,error); throw error; } await fetch('/producer'); await new Promise(resolve => setTimeout(resolve, 10)); }
})()); });`;
const html = `<!doctype html><title>Adversarial writer</title><script>${storage}
window.readState = async () => ({ ...await read(), local: localStorage.getItem('writer') });
window.readProgress = async () => ({ ...await read(true), local: localStorage.getItem('writer') });
window.startWriter = async () => { await navigator.serviceWorker.register('/worker.js'); await navigator.serviceWorker.ready;
 await new Promise(resolve => { if (navigator.serviceWorker.controller) resolve(); else navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }); });
 navigator.serviceWorker.controller.postMessage('write'); let counter = 0; localStorage.setItem('writer', '0'); setInterval(() => { localStorage.setItem('writer', String(++counter)); }, 10); };
</script>`;
async function server() {
  let requests = 0;
  let verificationRequests = 0;
  const instance = createServer((request, response) => {
    if (request.url.startsWith('/__browser_profile_verify__'))
      verificationRequests++;
    if (request.url === '/worker.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(worker);
    } else if (request.url === '/producer') {
      requests++;
      response.end('ok');
    } else {
      response.setHeader('Content-Type', 'text/html');
      response.end(html);
    }
  });
  servers.push(instance);
  await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${instance.address().port}`,
    requests: () => requests,
    verificationRequests: () => verificationRequests,
  };
}
async function page(native, url) {
  const win = new BrowserWindow({ show: false });
  windows.push(win);
  const view = new WebContentsView({
    webPreferences: {
      session: native,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.contentView.addChildView(view);
  await view.webContents.loadURL(url);
  return view.webContents;
}
app
  .whenReady()
  .then(async () => {
    const first = await server();
    const second = await server();
    const a = session.fromPartition('persist:clear-capability-a');
    const b = session.fromPartition('persist:clear-capability-b');
    const writerSnapshot = (writerPhaseSnapshot = observeWriterPhases(a, [
      first.origin,
      second.origin,
    ]));
    let blocked = false;
    let trustedControlId;
    a.webRequest.onBeforeRequest((details, callback) =>
      callback({
        cancel: blocked && details.webContentsId !== trustedControlId,
      }),
    );
    const a1 = await page(a, first.origin);
    const a2 = await page(a, second.origin);
    const b1 = await page(b, first.origin);
    for (const contents of [a1, a2, b1])
      await contents.executeJavaScript('startWriter()');
    await until(
      async () =>
        (
          await a1.executeJavaScript(
            'readProgress().catch(error => { throw new Error(error.name + ": " + error.message); })',
          )
        ).indexed > 2 &&
        (
          await a2.executeJavaScript(
            'readProgress().catch(error => { throw new Error(error.name + ": " + error.message); })',
          )
        ).indexed > 2 &&
        (
          await b1.executeJavaScript(
            'readProgress().catch(error => { throw new Error(error.name + ": " + error.message); })',
          )
        ).indexed > 2,
      'all writers producing',
    );
    await until(async () => {
      const states = await Promise.all(
        [a1, a2, b1].map((contents) =>
          contents.executeJavaScript(
            'readProgress().catch(error => { throw new Error(error.name + ": " + error.message); })',
          ),
        ),
      );
      return states.every(
        (state) => Number(state.local) >= 2 && state.cache !== null,
      );
    }, 'page timers repeatedly write despite hidden-window throttling');
    check(
      'page and worker producers active in both profiles',
      Object.keys(a.serviceWorkers.getAllRunning()).length >= 2 &&
        Object.keys(b.serviceWorkers.getAllRunning()).length >= 1,
      true,
    );
    await a.cookies.set({
      url: first.origin,
      name: 'host-cookie',
      value: 'synthetic',
    });
    const storageKeys = new Map();
    for (const contents of [a1, a2]) {
      contents.debugger.attach('1.3');
      const { frameTree } =
        await contents.debugger.sendCommand('Page.getFrameTree');
      const { storageKey } = await contents.debugger.sendCommand(
        'Storage.getStorageKeyForFrame',
        { frameId: frameTree.frame.id },
      );
      storageKeys.set(new URL(contents.getURL()).origin, storageKey);
      contents.debugger.detach();
    }
    blocked = true;
    a1.close({ waitForBeforeUnload: false });
    a2.close({ waitForBeforeUnload: false });
    await until(
      () => a1.isDestroyed() && a2.isDestroyed(),
      'profile views closed',
    );
    const control = await page(a, 'about:blank');
    control.debugger.attach('1.3');
    const inspectClosedOrigin = async (origin) => {
      const result = {};
      for (const [key, command, parameters] of [
        ['quota', 'Storage.getUsageAndQuota', { origin }],
        [
          'localStorage',
          'DOMStorage.getDOMStorageItems',
          { storageId: { securityOrigin: origin, isLocalStorage: true } },
        ],
        [
          'indexedDB',
          'IndexedDB.requestDatabaseNames',
          { securityOrigin: origin },
        ],
        [
          'caches',
          'CacheStorage.requestCacheNames',
          { securityOrigin: origin },
        ],
        [
          'localStorageByKey',
          'DOMStorage.getDOMStorageItems',
          {
            storageId: {
              storageKey: storageKeys.get(origin),
              isLocalStorage: true,
            },
          },
        ],
        [
          'indexedDBByKey',
          'IndexedDB.requestDatabaseNames',
          { storageKey: storageKeys.get(origin) },
        ],
        [
          'cachesByKey',
          'CacheStorage.requestCacheNames',
          { storageKey: storageKeys.get(origin) },
        ],
      ]) {
        try {
          const value = await control.debugger.sendCommand(command, parameters);
          // Retain capability/counts only, never storage keys or values.
          result[key] =
            key === 'quota'
              ? { usage: value.usage, usageBreakdown: value.usageBreakdown }
              : {
                  count: (value.entries ?? value.databaseNames ?? value.caches)
                    .length,
                };
        } catch (error) {
          result[key] = { error: String(error.message).slice(0, 240) };
        }
      }
      return result;
    };
    await control.debugger.sendCommand('ServiceWorker.enable');
    await control.debugger.sendCommand('ServiceWorker.stopAllWorkers');
    await until(
      () => Object.keys(a.serviceWorkers.getAllRunning()).length === 0,
      'profile workers stopped',
    );
    evidence.writerPhasesAtStop = writerSnapshot();
    check(
      'stopAllWorkers leaves other profile worker active',
      Object.keys(b.serviceWorkers.getAllRunning()).length >= 1,
      true,
    );
    evidence.closedOriginInspection = {
      before: await inspectClosedOrigin(first.origin),
      retainedBefore: await inspectClosedOrigin(second.origin),
    };
    trustedControlId = control.id;
    evidence.trustedDocumentInspection = {
      before: await verifyClosed(control, first.origin),
      retainedBefore: await verifyClosed(control, second.origin),
    };
    let immediateFailure;
    try {
      check(
        'trusted inspection sees closed origin stores without site scripts',
        evidence.trustedDocumentInspection.before,
        {
          title: 'Local storage verification',
          origin: first.origin,
          localStorageCount: 1,
          databaseCount: 1,
          cacheCount: 1,
          workerCount: 1,
          opfsEntries: 1,
        },
      );
    } catch (error) {
      immediateFailure = error;
      evidence.immediateAssertionFailure = error.stack ?? String(error);
    }
    // Repeated observations belong only to the failed immediate assertion.
    if (immediateFailure) {
      // Retain the original immediate sample and assertion; never retry to pass.
      evidence.postStopSamples = [];
      const sampleStartedAt = Date.now();
      for (const afterMs of [100, 500]) {
        await delay(Math.max(0, afterMs - (Date.now() - sampleStartedAt)));
        try {
          evidence.postStopSamples.push({
            requestedAfterImmediateMs: afterMs,
            actualAfterImmediateMs: Date.now() - sampleStartedAt,
            state: await verifyClosed(control, first.origin),
            writerPhases: writerSnapshot(),
          });
        } catch (error) {
          evidence.postStopSamples.push({
            requestedAfterImmediateMs: afterMs,
            actualAfterImmediateMs: Date.now() - sampleStartedAt,
            error: String(error.stack ?? error).slice(0, 8192),
          });
          break;
        }
      }
      throw immediateFailure;
    }
    check(
      'trusted verification bypasses registered worker execution',
      Object.keys(a.serviceWorkers.getAllRunning()).length,
      0,
    );
    await a.clearData({
      origins: [first.origin],
      dataTypes: [
        'cookies',
        'fileSystems',
        'indexedDB',
        'localStorage',
        'serviceWorkers',
        'cache',
      ],
    });
    evidence.closedOriginInspection.after = await inspectClosedOrigin(
      first.origin,
    );
    evidence.closedOriginInspection.retainedAfter = await inspectClosedOrigin(
      second.origin,
    );
    evidence.trustedDocumentInspection.after = await verifyClosed(
      control,
      first.origin,
    );
    evidence.trustedDocumentInspection.retainedAfter = await verifyClosed(
      control,
      second.origin,
    );
    check(
      'trusted post-clear inspection validates every declared durable class',
      evidence.trustedDocumentInspection.after,
      {
        title: 'Local storage verification',
        origin: first.origin,
        localStorageCount: 0,
        databaseCount: 0,
        cacheCount: 0,
        workerCount: 0,
        opfsEntries: 0,
      },
    );
    check(
      'trusted post-clear inspection preserves unrelated origin counts',
      evidence.trustedDocumentInspection.retainedAfter,
      evidence.trustedDocumentInspection.retainedBefore,
    );
    check(
      'trusted verification sends no document request to origin servers',
      first.verificationRequests() + second.verificationRequests(),
      0,
    );
    trustedControlId = undefined;
    check(
      'target cookies cleared across ports',
      (await a.cookies.get({ url: second.origin })).length,
      0,
    );
    blocked = false;
    const reopened = await page(a, first.origin);
    const retained = await page(a, second.origin);
    const target = await reopened.executeJavaScript(
      'readState().catch(error => { throw new Error(error.name + ": " + error.message); })',
    );
    check('declared target classes remain empty after reopening', target, {
      indexed: null,
      cache: null,
      opfs: null,
      worker: false,
      local: null,
    });
    await delay(200);
    check(
      'continuous producer cannot repopulate cleared target',
      await reopened.executeJavaScript(
        'readState().catch(error => { throw new Error(error.name + ": " + error.message); })',
      ),
      target,
    );
    const other = await retained.executeJavaScript(
      'readState().catch(error => { throw new Error(error.name + ": " + error.message); })',
    );
    evidence.otherPortState = other;
    check(
      'other port durable stores and registration survive',
      other.indexed > 0 &&
        other.cache !== null &&
        other.opfs !== null &&
        other.worker &&
        other.local !== null,
      true,
    );
    const before = await b1.executeJavaScript(
      'readProgress().catch(error => { throw new Error(error.name + ": " + error.message); })',
    );
    await until(
      async () =>
        (
          await b1.executeJavaScript(
            'readProgress().catch(error => { throw new Error(error.name + ": " + error.message); })',
          )
        ).indexed > before.indexed,
      'other profile continues writing',
    );
    // Intercept HTTPS only in a third synthetic Session: no DNS/TLS/network access.
    // Chromium still computes the real PSL domain and native cookie clear scope.
    const c = session.fromPartition('persist:clear-capability-domains');
    c.protocol.handle(
      'https',
      () => new Response('<!doctype html><title>Domain fixture</title>'),
    );
    const domainOrigin = 'https://a.accounts.example.co.uk:9443';
    const domainPage = await page(c, domainOrigin);
    domainPage.debugger.attach('1.3');
    const frame = (await domainPage.debugger.sendCommand('Page.getFrameTree'))
      .frameTree.frame;
    check(
      'Chromium supplies PSL-aware registrable domain',
      frame.domainAndRegistry,
      'example.co.uk',
    );
    for (const url of [
      domainOrigin,
      'https://b.example.co.uk:8443',
      'https://unrelated.example.com',
    ])
      await c.cookies.set({ url, name: 'domain-check', value: 'synthetic' });
    await c.clearData({ origins: [domainOrigin] });
    check(
      'cookie clearing expands across subdomains and ports',
      (await c.cookies.get({ url: 'https://b.example.co.uk:8443' })).length,
      0,
    );
    check(
      'unrelated registrable-domain cookie survives',
      (await c.cookies.get({ url: 'https://unrelated.example.com' })).length,
      1,
    );
    evidence.partitioned = await partitioned({
      session,
      page,
      check,
      until,
      storage,
      evidence,
      verifyClosed,
      createHttpsServer,
      tls: {
        key: await fs.readFile(path.join(__dirname, 'localhost-test.key.pem')),
        cert: await fs.readFile(
          path.join(__dirname, 'localhost-test.cert.pem'),
        ),
      },
      servers,
    });
    evidence.passed = true;
    await finish(0);
  })
  .catch(async (error) => {
    evidence.error = error.stack ?? String(error);
    await finish(1);
  });

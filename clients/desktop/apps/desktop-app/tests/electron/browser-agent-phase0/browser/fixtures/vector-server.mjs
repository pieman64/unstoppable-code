// S0.3 vector server: serves synthetic /s03/ pages that trigger one network,
// navigation, worker, or permission vector at a time from a loopback origin
// (a secure context, so service workers register). Pages report through
// window.__s03Result; ground truth is the canary server's hit log.
// Nothing is served from disk; no page/clipboard/file/device content is kept.

import {
  MAX_TARGET_LENGTH,
  NONCE_RE,
  createLoopbackHttpServer,
  drainBody,
  parseRedirect,
  parseRequestUrl,
  pushCapped,
  send,
} from './fixture-common.mjs';

/**
 * Vector ids, in documentation order. Outcome strings per vector:
 *  fetch, xhr-post        resolved:<status> | rejected:<error name>
 *  frame, frame-navigate,
 *  form-post-frame        load | error | timeout   (weak evidence; use canary log)
 *  websocket              open | message | error | close:<code> | timeout
 *  dedicated-worker       resolved:<status> | rejected:<name> | worker-error | timeout
 *  dedicated-worker-ws    open | message | error | close:<code> | worker-error | timeout
 *  shared-worker          resolved:<status> | rejected:<name> | worker-error | timeout
 *  service-worker         resolved:<status> | rejected:<name> | register-rejected:<name> | timeout
 *  service-worker-intercept
 *                         resolved:<status> | rejected:<name> | register-rejected:<name>
 *                         | activate-failed:<name> | timeout  (detail: controller:yes|no)
 *  popup-window-open      returned-window | returned-null | threw:<name>
 *  popup-anchor,
 *  download-anchor        clicked
 *  file-chooser           change:<files.length> | cancel | timeout
 *  external-protocol      attempted | error:<name>
 *  permissions            '|'-joined: notifications:<result> | geo-query:<state> |
 *                         geo:granted | geo:error:<code> |
 *                         clipboard:resolved-content-discarded | clipboard:rejected:<name> |
 *                         media:granted | media:rejected:<name>  (each may be
 *                         :unavailable / :timeout); a trailing '|timeout' marks a deadline cut-off
 *  device-chooser         usb:resolved | usb:rejected:<name> | usb:unavailable
 * @type {readonly string[]}
 */
export const VECTOR_IDS = Object.freeze([
  'fetch',
  'xhr-post',
  'frame',
  'frame-navigate',
  'form-post-frame',
  'websocket',
  'dedicated-worker',
  'dedicated-worker-ws',
  'shared-worker',
  'service-worker',
  'service-worker-intercept',
  'popup-window-open',
  'popup-anchor',
  'download-anchor',
  'file-chooser',
  'external-protocol',
  'permissions',
  'device-chooser',
]);

const NO_TARGET_VECTORS = new Set([
  'file-chooser',
  'permissions',
  'device-chooser',
]);
const PERMISSION_STEPS = Object.freeze([
  'notifications',
  'geo-query',
  'geo',
  'clipboard',
  'media',
]);
const DEFAULT_DEADLINE_MS = 4000;
const DOWNLOAD_BYTES = Buffer.from('S03-VECTOR-BYTES', 'ascii'); // exactly 16 bytes

/**
 * @typedef {object} VectorRequest
 * @property {number} seq
 * @property {string} method
 * @property {string} path Pathname only (targets can be long and are not logged).
 * @property {string | null} nonce From `?n=` or an /s03/sw-scope/<nonce>/ or /s03/download/<nonce>.bin path.
 * @property {number} at Epoch milliseconds.
 */

/**
 * @typedef {object} VectorServer
 * @property {(port?: number, host?: string) => Promise<{ port: number, origin: string }>} listen
 *   Rejects for any non-loopback host.
 * @property {() => Promise<void>} close Idempotent; destroys every socket.
 * @property {() => VectorRequest[]} requests Copy of the request log (capped at 5000).
 * @property {() => void} reset Clears the request log.
 */

/**
 * JSON for embedding inside an inline <script>. Escapes < > & and the JS line
 * separators so no value can terminate the script or open an HTML tag.
 * @param {unknown} value
 * @returns {string}
 */
export function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

// ---------------------------------------------------------------------------
// Page runtime (runs inside the page). Plain ES2017, no template literals and
// no closing script tags. `cfg` is injected as JSON.
//
// Auto mode (default): sets __s03Result pending and runs at once.
// Manual mode (manual=1): sets {state:'armed'} and exposes window.__s03Run();
// the first call runs the vector (later calls are no-ops) so user-gesture
// vectors get transient activation. The deadline starts when the vector runs.
// ---------------------------------------------------------------------------
const RUNTIME_HEAD = `
var vectorId = cfg.vectorId;
var nonce = cfg.nonce;
var target = cfg.target;
var done = false;
var started = false;
var timer = null;
var onDeadline = null;
function clip(s) { s = String(s); return s.length > 200 ? s.slice(0, 200) : s; }
function errName(e) { return e && e.name ? String(e.name) : 'Error'; }
function errMsg(e) { return clip(e && e.message ? e.message : ''); }
function setState(state) { document.documentElement.dataset.s03State = state; }
function finish(outcome, detail) {
  if (done) return;
  done = true;
  if (timer !== null) clearTimeout(timer);
  window.__s03Result = { vectorId: vectorId, nonce: nonce, state: 'done', outcome: clip(outcome), detail: clip(detail || '') };
  setState('done');
}
function appendToBody(node) { (document.body || document.documentElement).appendChild(node); }
function makeIframe() { return document.createElement('iframe'); }
function runVector() {
`;

const RUNTIME_TAIL = `
}
function start() {
  if (started) return;
  started = true;
  window.__s03Result = { vectorId: vectorId, nonce: nonce, state: 'pending' };
  setState('pending');
  timer = setTimeout(function () {
    if (onDeadline) onDeadline();
    else finish('timeout', 'deadline ' + cfg.deadline + 'ms');
  }, cfg.deadline);
  try { runVector(); } catch (e) { finish('error:' + errName(e), errMsg(e)); }
}
window.__s03Run = function () { start(); };
if (cfg.manual) {
  window.__s03Result = { vectorId: vectorId, nonce: nonce, state: 'armed' };
  setState('armed');
} else {
  start();
}
`;

/** @type {Record<string, string>} */
const VECTOR_BODIES = {
  fetch: `
fetch(target, { mode: 'cors', cache: 'no-store' }).then(
  function (r) { finish('resolved:' + r.status, ''); },
  function (e) { finish('rejected:' + errName(e), errMsg(e)); });
`,
  'xhr-post': `
fetch(target, { method: 'POST', body: 'x', mode: 'cors', cache: 'no-store' }).then(
  function (r) { finish('resolved:' + r.status, ''); },
  function (e) { finish('rejected:' + errName(e), errMsg(e)); });
`,
  frame: `
var f = makeIframe();
f.addEventListener('load', function () { finish('load', 'load event only; see canary log'); });
f.addEventListener('error', function () { finish('error', ''); });
f.src = target;
appendToBody(f);
`,
  'frame-navigate': `
var step = 0;
var f = makeIframe();
f.addEventListener('load', function () {
  if (step === 0) {
    var href = '';
    try { href = f.contentWindow.location.href; } catch (e) { href = ''; }
    if (href === 'about:blank') return;
    step = 1;
    f.src = target;
    return;
  }
  finish('load', 'load event only; see canary log');
});
f.addEventListener('error', function () { finish('error', 'step:' + step); });
f.src = '/s03/blank';
appendToBody(f);
`,
  'form-post-frame': `
var frameName = 's03-form-target';
var f = makeIframe();
f.name = frameName;
appendToBody(f);
var form = document.createElement('form');
form.method = 'POST';
form.action = target;
form.target = frameName;
var field = document.createElement('input');
field.type = 'hidden';
field.name = 'x';
field.value = 'x';
form.appendChild(field);
appendToBody(form);
var submitted = false;
f.addEventListener('load', function () { if (submitted) finish('load', 'load event only; see canary log'); });
f.addEventListener('error', function () { finish('error', ''); });
form.submit();
submitted = true;
`,
  websocket: `
var ws;
var opened = false;
try { ws = new WebSocket(target); } catch (e) { finish('error', 'ctor:' + errName(e)); return; }
function closeQuietly() { try { ws.close(); } catch (e) { /* ignore */ } }
ws.onopen = function () {
  opened = true;
  setTimeout(function () { finish('open', 'no message within 1000ms'); closeQuietly(); }, 1000);
};
ws.onmessage = function () { finish('message', 'opened:' + opened); closeQuietly(); };
ws.onerror = function () { finish('error', 'opened:' + opened); };
ws.onclose = function (ev) { finish('close:' + ev.code, 'opened:' + opened); };
`,
  'dedicated-worker': `
var w;
try { w = new Worker('/s03/worker/dedicated.js?kind=fetch&target=' + encodeURIComponent(target)); }
catch (e) { finish('worker-error', 'ctor:' + errName(e)); return; }
w.onmessage = function (ev) { finish(String(ev.data), ''); w.terminate(); };
w.onerror = function () { finish('worker-error', ''); };
`,
  'dedicated-worker-ws': `
var w;
try { w = new Worker('/s03/worker/dedicated.js?kind=ws&target=' + encodeURIComponent(target)); }
catch (e) { finish('worker-error', 'ctor:' + errName(e)); return; }
w.onmessage = function (ev) { finish(String(ev.data), ''); w.terminate(); };
w.onerror = function () { finish('worker-error', ''); };
`,
  'shared-worker': `
var sw;
try {
  sw = new SharedWorker('/s03/worker/shared.js?target=' + encodeURIComponent(target) + '&n=' + encodeURIComponent(nonce),
    { name: 's03-' + nonce });
} catch (e) { finish('worker-error', 'ctor:' + errName(e)); return; }
sw.onerror = function () { finish('worker-error', ''); };
sw.port.onmessage = function (ev) { finish(String(ev.data), ''); };
`,
  'service-worker': `
if (!('serviceWorker' in navigator)) { finish('register-rejected:unavailable', ''); return; }
var registration = null;
function cleanup() {
  if (registration) { try { registration.unregister().catch(function () {}); } catch (e) { /* ignore */ } }
}
onDeadline = function () { finish('timeout', 'no service worker message'); cleanup(); };
navigator.serviceWorker.onmessage = function (ev) {
  var d = ev.data;
  if (d && d.type === 's03-sw-result' && d.n === nonce) { finish(String(d.outcome), ''); cleanup(); }
};
navigator.serviceWorker.register(
  '/s03/sw.js?target=' + encodeURIComponent(target) + '&n=' + encodeURIComponent(nonce),
  { scope: '/s03/sw-scope/' + nonce + '/' }
).then(
  function (reg) { registration = reg; },
  function (e) { finish('register-rejected:' + errName(e), errMsg(e)); });
`,
  'service-worker-intercept': `
if (!('serviceWorker' in navigator)) { finish('register-rejected:unavailable', ''); return; }
var registration = null;
var scopeFrame = null;
function cleanup() {
  if (registration) { try { registration.unregister().catch(function () {}); } catch (e) { /* ignore */ } }
}
function waitActivated(reg) {
  return new Promise(function (resolve, reject) {
    var sw = reg.installing || reg.waiting || reg.active;
    if (!sw) { reject(new Error('no-worker')); return; }
    if (sw.state === 'activated') { resolve(); return; }
    sw.addEventListener('statechange', function () {
      if (sw.state === 'activated') resolve();
      else if (sw.state === 'redundant') reject(new Error('redundant'));
    });
  });
}
onDeadline = function () { finish('timeout', 'no proxy result'); cleanup(); };
window.addEventListener('message', function (ev) {
  var d = ev.data;
  if (scopeFrame && ev.source === scopeFrame.contentWindow && d && d.type === 's03-proxy-result' && d.n === nonce) {
    finish(String(d.outcome), String(d.detail || ''));
    cleanup();
  }
});
navigator.serviceWorker.register(
  '/s03/sw-intercept.js?target=' + encodeURIComponent(target) + '&n=' + encodeURIComponent(nonce),
  { scope: '/s03/sw-scope/' + nonce + '/' }
).then(
  function (reg) {
    registration = reg;
    return waitActivated(reg).then(
      function () {
        scopeFrame = makeIframe();
        scopeFrame.src = '/s03/sw-scope/' + nonce + '/page';
        appendToBody(scopeFrame);
      },
      function (e) { finish('activate-failed:' + errName(e), errMsg(e)); });
  },
  function (e) { finish('register-rejected:' + errName(e), errMsg(e)); });
`,
  'popup-window-open': `
var w = window.open(target, '_blank');
finish(w ? 'returned-window' : 'returned-null', '');
`,
  'popup-anchor': `
var a = document.createElement('a');
a.href = target;
a.target = '_blank';
appendToBody(a);
a.click();
finish('clicked', '');
`,
  'download-anchor': `
var a = document.createElement('a');
a.href = target;
a.download = 's03-download.bin';
appendToBody(a);
a.click();
finish('clicked', '');
`,
  'file-chooser': `
var input = document.createElement('input');
input.type = 'file';
input.id = 's03-file';
appendToBody(input);
input.addEventListener('change', function () { finish('change:' + input.files.length, ''); });
input.addEventListener('cancel', function () { finish('cancel', ''); });
input.click();
`,
  'external-protocol': `
var f = makeIframe();
appendToBody(f);
try { f.contentWindow.location.href = target; finish('attempted', ''); }
catch (e) { finish('error:' + errName(e), errMsg(e)); }
`,
  permissions: `
var order = cfg.only || ${safeJson(PERMISSION_STEPS)};
var results = [];
function withTimeout(promise, ms, timeoutValue) {
  return new Promise(function (resolve) {
    var t = setTimeout(function () { resolve(timeoutValue); }, ms);
    promise.then(function (v) { clearTimeout(t); resolve(v); });
  });
}
var steps = {
  notifications: function () {
    return new Promise(function (resolve) {
      if (typeof Notification === 'undefined') { resolve('notifications:unavailable'); return; }
      try {
        Promise.resolve(Notification.requestPermission()).then(
          function (r) { resolve('notifications:' + r); },
          function (e) { resolve('notifications:rejected:' + errName(e)); });
      } catch (e) { resolve('notifications:rejected:' + errName(e)); }
    });
  },
  'geo-query': function () {
    return new Promise(function (resolve) {
      if (!navigator.permissions || !navigator.permissions.query) { resolve('geo-query:unavailable'); return; }
      try {
        navigator.permissions.query({ name: 'geolocation' }).then(
          function (s) { resolve('geo-query:' + s.state); },
          function (e) { resolve('geo-query:rejected:' + errName(e)); });
      } catch (e) { resolve('geo-query:rejected:' + errName(e)); }
    });
  },
  geo: function () {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) { resolve('geo:unavailable'); return; }
      try {
        navigator.geolocation.getCurrentPosition(
          function () { resolve('geo:granted'); },
          function (err) { resolve('geo:error:' + (err && err.code)); },
          { timeout: 1200, maximumAge: 0 });
      } catch (e) { resolve('geo:error:' + errName(e)); }
    });
  },
  clipboard: function () {
    return new Promise(function (resolve) {
      if (!navigator.clipboard || !navigator.clipboard.readText) { resolve('clipboard:unavailable'); return; }
      try {
        navigator.clipboard.readText().then(
          function () { resolve('clipboard:resolved-content-discarded'); },
          function (e) { resolve('clipboard:rejected:' + errName(e)); });
      } catch (e) { resolve('clipboard:rejected:' + errName(e)); }
    });
  },
  media: function () {
    return new Promise(function (resolve) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { resolve('media:unavailable'); return; }
      try {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(
          function (stream) {
            try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
            resolve('media:granted');
          },
          function (e) { resolve('media:rejected:' + errName(e)); });
      } catch (e) { resolve('media:rejected:' + errName(e)); }
    });
  }
};
onDeadline = function () { finish(results.concat(['timeout']).join('|'), 'partial:' + results.length + '/' + order.length); };
var chain = Promise.resolve();
order.forEach(function (name) {
  chain = chain.then(function () {
    if (done) return null;
    return withTimeout(steps[name](), 1500, name + ':timeout').then(function (r) { results.push(r); });
  });
});
chain.then(function () { finish(results.join('|'), 'steps:' + order.length); });
`,
  'device-chooser': `
if (!navigator.usb || !navigator.usb.requestDevice) { finish('usb:unavailable', ''); return; }
try {
  navigator.usb.requestDevice({ filters: [] }).then(
    function () { finish('usb:resolved', ''); },
    function (e) { finish('usb:rejected:' + errName(e), ''); });
} catch (e) { finish('usb:rejected:' + errName(e), ''); }
`,
};

/**
 * @param {string} vectorId
 * @param {{ target: string, nonce: string, deadline: number, manual: boolean, only: string[] | null }} params
 * @returns {string}
 */
function renderVectorPage(vectorId, params) {
  const cfg = {
    vectorId,
    nonce: params.nonce,
    target: params.target,
    deadline: params.deadline,
    manual: params.manual,
    only: params.only,
  };
  const script = `(function () {\n'use strict';\nvar cfg = ${safeJson(cfg)};${RUNTIME_HEAD}${VECTOR_BODIES[vectorId]}${RUNTIME_TAIL}})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>s03 ${vectorId}</title></head><body><script>\n${script}\n</script></body></html>`;
}

function renderNavResultPage(nonce) {
  const script = `(function () {
var r = { vectorId: 'nav-result', nonce: ${safeJson(nonce)}, state: 'done', outcome: 'navigated', detail: '' };
window.__s03Result = r;
document.documentElement.dataset.s03State = 'done';
})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>s03 nav-result</title></head><body><script>\n${script}\n</script></body></html>`;
}

/** The in-scope page loaded into an iframe controlled by the intercepting service worker. */
function renderScopePage(nonce) {
  const script = `(function () {
var n = ${safeJson(nonce)};
function post(outcome) {
  var controlled = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  parent.postMessage({ type: 's03-proxy-result', n: n, outcome: outcome, detail: 'controller:' + (controlled ? 'yes' : 'no') }, '*');
}
fetch('./proxy', { cache: 'no-store' }).then(
  function (r) { post('resolved:' + r.status); },
  function (e) { post('rejected:' + (e && e.name ? e.name : 'Error')); });
})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>s03 sw-scope</title></head><body><script>\n${script}\n</script></body></html>`;
}

const BLANK_PAGE =
  '<!doctype html><html><head><meta charset="utf-8"><title>s03 blank</title></head><body></body></html>';

// Worker scripts are static; parameters come from the script URL's query.
const WORKER_COMMON = `'use strict';
var params = new URL(self.location.href).searchParams;
var target = params.get('target') || '';
function errName(e) { return e && e.name ? String(e.name) : 'Error'; }
`;

const DEDICATED_WORKER_SCRIPT = `${WORKER_COMMON}var kind = params.get('kind') || 'fetch';
function report(outcome) { self.postMessage(String(outcome).slice(0, 200)); }
if (kind === 'ws') {
  var settled = false;
  var settle = function (o) { if (!settled) { settled = true; report(o); } };
  try {
    var ws = new WebSocket(target);
    var opened = false;
    ws.onopen = function () { opened = true; setTimeout(function () { settle('open'); try { ws.close(); } catch (e) { /* ignore */ } }, 1000); };
    ws.onmessage = function () { settle('message'); try { ws.close(); } catch (e) { /* ignore */ } };
    ws.onerror = function () { settle('error'); };
    ws.onclose = function (ev) { settle('close:' + ev.code); };
  } catch (e) { settle('error'); }
  setTimeout(function () { settle('timeout'); }, 3500);
} else {
  fetch(target, { mode: 'cors', cache: 'no-store' }).then(
    function (r) { report('resolved:' + r.status); },
    function (e) { report('rejected:' + errName(e)); });
}
`;

const SHARED_WORKER_SCRIPT = `${WORKER_COMMON}self.onconnect = function (ev) {
  var port = ev.ports[0];
  fetch(target, { mode: 'cors', cache: 'no-store' }).then(
    function (r) { port.postMessage('resolved:' + r.status); },
    function (e) { port.postMessage('rejected:' + errName(e)); });
};
`;

const SERVICE_WORKER_SCRIPT = `${WORKER_COMMON}var n = params.get('n') || '';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) {
  event.waitUntil(
    fetch(target, { mode: 'cors', cache: 'no-store' }).then(
      function (r) { return 'resolved:' + r.status; },
      function (e) { return 'rejected:' + errName(e); }
    ).then(function (outcome) {
      return self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(function (list) {
        list.forEach(function (c) { c.postMessage({ type: 's03-sw-result', n: n, outcome: outcome }); });
      });
    })
  );
});
`;

const SERVICE_WORKER_INTERCEPT_SCRIPT = `${WORKER_COMMON}var n = params.get('n') || '';
var proxyPath = '/s03/sw-scope/' + n + '/proxy';
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (event) { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (url.origin === self.location.origin && url.pathname === proxyPath) {
    event.respondWith(fetch(target, { mode: 'cors', cache: 'no-store' }));
  }
});
`;

/**
 * @param {URLSearchParams} params
 * @returns {{ ok: true, target: string | null, nonce: string | null } | { ok: false }}
 */
function readTargetAndNonce(params) {
  const target = params.get('target');
  const nonce = params.get('n');
  if (target !== null && target.length > MAX_TARGET_LENGTH)
    return { ok: false };
  if (nonce !== null && !NONCE_RE.test(nonce)) return { ok: false };
  return { ok: true, target, nonce };
}

/**
 * @returns {VectorServer}
 */
export function createVectorServer() {
  /** @type {VectorRequest[]} */
  let log = [];
  let seq = 0;

  /** @param {import('node:http').IncomingMessage} req @param {string} pathname @param {string | null} nonce */
  function record(req, pathname, nonce) {
    pushCapped(log, {
      seq: ++seq,
      method: String(req.method ?? '').slice(0, 16),
      path: pathname.slice(0, 256),
      nonce,
      at: Date.now(),
    });
  }

  const HTML = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  const JS = {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Cache-Control': 'no-store',
  };
  const TEXT = {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function onRequest(req, res) {
    const url = parseRequestUrl(req.url);
    const pathname = url ? url.pathname : '(invalid)';
    const pathNonce = url
      ? ((/^\/s03\/sw-scope\/([A-Za-z0-9_-]{1,64})\//.exec(pathname) ??
          /^\/s03\/download\/([A-Za-z0-9_-]{1,64})\.bin$/.exec(
            pathname,
          ))?.[1] ?? null)
      : null;
    const queryNonce = url?.searchParams.get('n') ?? null;
    record(
      req,
      pathname,
      pathNonce ??
        (queryNonce !== null && NONCE_RE.test(queryNonce) ? queryNonce : null),
    );
    drainBody(req, res, () => respond(req, res, url));
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL | null} url
   */
  function respond(req, res, url) {
    const method = req.method ?? '';
    if (!url || !url.pathname.startsWith('/s03/')) {
      send(res, 404, 'not found', TEXT);
      return;
    }
    const { pathname, searchParams } = url;
    const isRead = method === 'GET' || method === 'HEAD';

    if (pathname === '/s03/redirect') {
      if (!isRead && method !== 'POST')
        return send(res, 405, 'method not allowed', TEXT);
      const parsed = parseRedirect(searchParams);
      if (!parsed.ok) return send(res, 400, parsed.reason, TEXT);
      return send(res, parsed.code, '', {
        Location: parsed.location,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
    }

    const known =
      /^\/s03\/(?:vector\/[a-z0-9-]+|blank|worker\/(?:dedicated|shared)\.js|sw\.js|sw-intercept\.js|download\/[A-Za-z0-9_-]{1,64}\.bin|nav-result|sw-scope\/[A-Za-z0-9_-]{1,64}\/(?:page|proxy))$/.test(
        pathname,
      );
    if (!known) return send(res, 404, 'not found', TEXT);
    if (!isRead)
      return send(res, 405, 'method not allowed', {
        ...TEXT,
        Allow: 'GET, HEAD',
      });

    if (pathname === '/s03/blank') return send(res, 200, BLANK_PAGE, HTML);

    const download = /^\/s03\/download\/([A-Za-z0-9_-]{1,64})\.bin$/.exec(
      pathname,
    );
    if (download) {
      return send(res, 200, DOWNLOAD_BYTES, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="s03-${download[1]}.bin"`,
        'Cache-Control': 'no-store',
      });
    }

    if (pathname === '/s03/nav-result') {
      const nonce = searchParams.get('n');
      if (nonce === null || !NONCE_RE.test(nonce))
        return send(res, 400, 'invalid nonce', TEXT);
      return send(res, 200, renderNavResultPage(nonce), HTML);
    }

    const scoped =
      /^\/s03\/sw-scope\/([A-Za-z0-9_-]{1,64})\/(page|proxy)$/.exec(pathname);
    if (scoped) {
      // `proxy` is only reached when the intercepting service worker is NOT in control.
      if (scoped[2] === 'proxy')
        return send(res, 404, 'sw-not-intercepting', TEXT);
      return send(res, 200, renderScopePage(scoped[1]), HTML);
    }

    const scripts = {
      '/s03/worker/dedicated.js': DEDICATED_WORKER_SCRIPT,
      '/s03/worker/shared.js': SHARED_WORKER_SCRIPT,
      '/s03/sw.js': SERVICE_WORKER_SCRIPT,
      '/s03/sw-intercept.js': SERVICE_WORKER_INTERCEPT_SCRIPT,
    };
    if (Object.hasOwn(scripts, pathname)) {
      const fields = readTargetAndNonce(searchParams);
      if (!fields.ok || fields.target === null)
        return send(res, 400, 'invalid target or nonce', TEXT);
      return send(res, 200, scripts[pathname], JS);
    }

    const vector = /^\/s03\/vector\/([a-z0-9-]+)$/.exec(pathname);
    const vectorId = vector ? vector[1] : '';
    if (!VECTOR_IDS.includes(vectorId))
      return send(res, 404, 'not found', TEXT);
    const fields = readTargetAndNonce(searchParams);
    if (!fields.ok || fields.nonce === null)
      return send(res, 400, 'invalid target or nonce', TEXT);
    if (fields.target === null && !NO_TARGET_VECTORS.has(vectorId))
      return send(res, 400, 'missing target', TEXT);

    let deadline = DEFAULT_DEADLINE_MS;
    const rawDeadline = searchParams.get('deadline');
    if (rawDeadline !== null) {
      deadline = /^\d{1,5}$/.test(rawDeadline) ? Number(rawDeadline) : -1;
      if (deadline < 100 || deadline > 15000)
        return send(res, 400, 'invalid deadline', TEXT);
    }
    const manualParam = searchParams.get('manual');
    if (manualParam !== null && manualParam !== '0' && manualParam !== '1')
      return send(res, 400, 'invalid manual', TEXT);
    /** @type {string[] | null} */
    let only = null;
    const rawOnly = searchParams.get('only');
    if (rawOnly !== null) {
      only = rawOnly.split(',');
      if (
        vectorId !== 'permissions' ||
        only.some((name) => !PERMISSION_STEPS.includes(name))
      ) {
        return send(res, 400, 'invalid only', TEXT);
      }
    }
    return send(
      res,
      200,
      renderVectorPage(vectorId, {
        target: fields.target ?? '',
        nonce: fields.nonce,
        deadline,
        manual: manualParam === '1',
        only,
      }),
      HTML,
    );
  }

  const lifecycle = createLoopbackHttpServer({ onRequest });
  return {
    listen: lifecycle.listen,
    close: lifecycle.close,
    requests: () => log.map((entry) => ({ ...entry })),
    reset() {
      log = [];
    },
  };
}

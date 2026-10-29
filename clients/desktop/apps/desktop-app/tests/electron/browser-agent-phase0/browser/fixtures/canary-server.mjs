// S0.3 canary server: a loopback HTTP/WebSocket destination that records every
// inbound request so the Electron probe can tell whether a vector really
// reached it. Synthetic content only; nothing is read from disk, env, or net.

import { createHash } from 'node:crypto';
import {
  NONCE_RE,
  createLoopbackHttpServer,
  drainBody,
  parseRedirect,
  parseRequestUrl,
  pushCapped,
  send,
} from './fixture-common.mjs';

const ROLE_RE = /^[A-Za-z0-9_-]{1,32}$/;
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const WS_CLOSE_AFTER_MS = 2000;
const DOWNLOAD_BYTES = Buffer.from('S03-CANARY-BYTES', 'ascii'); // exactly 16 bytes

/**
 * @typedef {object} CanaryHit
 * @property {number} seq Monotonic per server (not reset by `reset()`).
 * @property {string} role
 * @property {string} method
 * @property {string} path Pathname only (no query string), capped at 256 chars.
 * @property {string | null} nonce
 * @property {string | null} host Host header as sent.
 * @property {'http' | 'websocket'} via
 * @property {number} at Epoch milliseconds.
 */

/**
 * @typedef {object} CanaryServer
 * @property {string} role
 * @property {(port?: number, host?: string) => Promise<{ port: number, origin: string }>} listen
 *   Rejects for any non-loopback host (only 127.0.0.0/8 literals and ::1 are accepted).
 * @property {() => Promise<void>} close Idempotent; destroys every socket and timer.
 * @property {() => CanaryHit[]} hits Copy of the hit log (capped at 5000).
 * @property {(nonce: string) => CanaryHit[]} hitsFor
 * @property {() => void} reset Clears the hit log.
 */

/**
 * @param {string} pathname
 * @param {URLSearchParams} params
 * @returns {{ kind: 'hit' | 'hit-js' | 'ws' | 'download' | 'probe-hits' | 'redirect' | 'none', nonce: string | null }}
 */
function matchRoute(pathname, params) {
  let m = /^\/hit\/([A-Za-z0-9_-]{1,64})(\.js)?$/.exec(pathname);
  if (m) return { kind: m[2] ? 'hit-js' : 'hit', nonce: m[1] };
  m = /^\/ws\/([A-Za-z0-9_-]{1,64})$/.exec(pathname);
  if (m) return { kind: 'ws', nonce: m[1] };
  m = /^\/download\/([A-Za-z0-9_-]{1,64})\.bin$/.exec(pathname);
  if (m) return { kind: 'download', nonce: m[1] };
  const queryNonce = params.get('n');
  const nonce =
    queryNonce !== null && NONCE_RE.test(queryNonce) ? queryNonce : null;
  if (pathname === '/__probe/hits') return { kind: 'probe-hits', nonce };
  if (pathname === '/redirect') return { kind: 'redirect', nonce };
  return { kind: 'none', nonce };
}

/**
 * @param {string} text short (<126 byte) ASCII text
 * @returns {Buffer} unmasked server->client text frame
 */
function textFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  if (payload.length < 126)
    return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  return Buffer.concat([
    Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff]),
    payload,
  ]);
}

/**
 * @param {{ role: string }} options
 * @returns {CanaryServer}
 */
export function createCanaryServer({ role }) {
  if (typeof role !== 'string' || !ROLE_RE.test(role)) {
    throw new TypeError('role must match /^[A-Za-z0-9_-]{1,32}$/');
  }
  /** @type {CanaryHit[]} */
  let log = [];
  let seq = 0;
  /** @type {Set<NodeJS.Timeout>} */
  const timers = new Set();

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {string} pathname
   * @param {string | null} nonce
   * @param {'http' | 'websocket'} via
   */
  function record(req, pathname, nonce, via) {
    const host =
      typeof req.headers.host === 'string'
        ? req.headers.host.slice(0, 256)
        : null;
    pushCapped(log, {
      seq: ++seq,
      role,
      method: String(req.method ?? '').slice(0, 16),
      path: pathname.slice(0, 256),
      nonce,
      host,
      via,
      at: Date.now(),
    });
  }

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Cache-Control': 'no-store',
  };
  const PREFLIGHT = {
    ...CORS,
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '0',
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function onRequest(req, res) {
    const url = parseRequestUrl(req.url);
    const pathname = url ? url.pathname : '(invalid)';
    const route = url
      ? matchRoute(pathname, url.searchParams)
      : { kind: 'none', nonce: null };
    record(req, pathname, route.nonce, 'http');
    drainBody(req, res, () => respond(req, res, url, route));
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {URL | null} url
   * @param {ReturnType<typeof matchRoute>} route
   */
  function respond(req, res, url, route) {
    const method = req.method ?? '';
    const text = { 'Content-Type': 'text/plain; charset=utf-8' };
    if (route.kind === 'none' || route.kind === 'ws' || !url) {
      send(res, 404, 'not found', { ...text, 'Cache-Control': 'no-store' });
      return;
    }
    if (method === 'OPTIONS') {
      res.writeHead(204, PREFLIGHT);
      res.end();
      return;
    }
    if (
      method !== 'GET' &&
      method !== 'HEAD' &&
      !(
        method === 'POST' &&
        (route.kind === 'hit' || route.kind === 'redirect')
      )
    ) {
      send(res, 405, 'method not allowed', {
        ...text,
        ...CORS,
        Allow: 'GET, HEAD, OPTIONS',
      });
      return;
    }
    switch (route.kind) {
      case 'hit':
        send(res, 200, `canary:${role}:${route.nonce}`, { ...text, ...CORS });
        return;
      case 'hit-js':
        send(res, 200, `self.__s03CanaryLoaded = '${role}';`, {
          'Content-Type': 'application/javascript; charset=utf-8',
          ...CORS,
        });
        return;
      case 'download':
        send(res, 200, DOWNLOAD_BYTES, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="s03-${route.nonce}.bin"`,
          ...CORS,
        });
        return;
      case 'probe-hits':
        send(res, 200, JSON.stringify({ role, count: log.length, hits: log }), {
          'Content-Type': 'application/json; charset=utf-8',
          ...CORS,
        });
        return;
      case 'redirect': {
        const parsed = parseRedirect(url.searchParams);
        if (!parsed.ok) {
          send(res, 400, parsed.reason, { ...text, ...CORS });
          return;
        }
        send(res, parsed.code, '', { Location: parsed.location, ...CORS });
        return;
      }
      default:
        send(res, 404, 'not found', text);
    }
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   */
  function onUpgrade(req, socket) {
    const url = parseRequestUrl(req.url);
    const pathname = url ? url.pathname : '(invalid)';
    const route = url
      ? matchRoute(pathname, url.searchParams)
      : { kind: 'none', nonce: null };
    record(req, pathname, route.nonce, 'websocket');

    const key = req.headers['sec-websocket-key'];
    const isWebSocket =
      String(req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    const validKey =
      typeof key === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(key);
    if (route.kind !== 'ws' || req.method !== 'GET') {
      socket.end(
        'HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    if (
      !isWebSocket ||
      !validKey ||
      req.headers['sec-websocket-version'] !== '13'
    ) {
      socket.end(
        'HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
    );
    socket.write(textFrame(`canary:${role}:${route.nonce}`));
    // Client frames (e.g. close replies) are ignored; never buffered.
    socket.on('data', () => {});
    const closeTimer = setTimeout(() => {
      timers.delete(closeTimer);
      if (socket.destroyed) return;
      socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8])); // close, 1000
      const destroyTimer = setTimeout(() => {
        timers.delete(destroyTimer);
        socket.destroy();
      }, 500);
      timers.add(destroyTimer);
      destroyTimer.unref();
      socket.end();
    }, WS_CLOSE_AFTER_MS);
    timers.add(closeTimer);
    closeTimer.unref();
    socket.once('close', () => {
      clearTimeout(closeTimer);
      timers.delete(closeTimer);
    });
  }

  const lifecycle = createLoopbackHttpServer({
    onRequest,
    onUpgrade,
    onClose() {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    },
  });

  return {
    role,
    listen: lifecycle.listen,
    close: lifecycle.close,
    hits: () => log.map((hit) => ({ ...hit })),
    hitsFor: (nonce) =>
      log.filter((hit) => hit.nonce === nonce).map((hit) => ({ ...hit })),
    reset() {
      log = [];
    },
  };
}

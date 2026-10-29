// Shared helpers for the S0.3 browser-probe fixture servers.
// Pure Node built-ins. Loopback-only listeners, bounded headers/bodies/timeouts,
// tracked sockets so close() leaves no open handles. All content is synthetic.

import http from 'node:http';
import net from 'node:net';

/** Nonces are short opaque tokens chosen by the probe. */
export const NONCE_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** Maximum accepted length of any `target` / `to` URL parameter. */
export const MAX_TARGET_LENGTH = 2048;
/** Redirect status codes the fixtures will emit. */
export const REDIRECT_CODES = Object.freeze(new Set([301, 302, 303, 307, 308]));
/** Request bodies above this many bytes are rejected with 413. */
export const MAX_BODY_BYTES = 64 * 1024;
/** Hit/request logs are capped at this many entries (oldest dropped first). */
export const LOG_CAP = 5000;

const REDIRECT_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);

/**
 * Validate that `host` is a loopback literal and return it. Hostnames
 * (including "localhost") are rejected on purpose: resolution is not ours to
 * trust.
 * @param {unknown} host
 * @returns {string}
 */
export function assertLoopbackHost(host) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new TypeError(
      'fixture servers require an explicit loopback host string',
    );
  }
  if (host === '::1') return host;
  if (net.isIPv4(host) && host.startsWith('127.')) return host;
  throw new Error(
    `refusing to listen on non-loopback host: ${host.slice(0, 64)}`,
  );
}

/**
 * @param {string} host loopback literal
 * @param {number} port
 * @returns {string}
 */
export function originFor(host, port) {
  return host.includes(':')
    ? `http://[${host}]:${port}`
    : `http://${host}:${port}`;
}

/**
 * Parse a raw request target without letting `//x` be read as a host.
 * @param {string | undefined} rawUrl
 * @returns {URL | null}
 */
export function parseRequestUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 8192) return null;
  try {
    return new URL(
      rawUrl.startsWith('/') ? `http://fixture.invalid${rawUrl}` : rawUrl,
    );
  } catch {
    return null;
  }
}

/**
 * Validate `?to=&code=` redirect parameters.
 * @param {URLSearchParams} params
 * @returns {{ ok: true, location: string, code: number } | { ok: false, reason: string }}
 */
export function parseRedirect(params) {
  const to = params.get('to');
  if (to === null || to.length === 0 || to.length > MAX_TARGET_LENGTH) {
    return { ok: false, reason: 'invalid to' };
  }
  let parsed;
  try {
    parsed = new URL(to);
  } catch {
    return { ok: false, reason: 'invalid to' };
  }
  if (!REDIRECT_PROTOCOLS.has(parsed.protocol))
    return { ok: false, reason: 'invalid to scheme' };
  const rawCode = params.get('code');
  let code = 302;
  if (rawCode !== null) {
    if (!/^\d{3}$/.test(rawCode) || !REDIRECT_CODES.has(Number(rawCode))) {
      return { ok: false, reason: 'invalid code' };
    }
    code = Number(rawCode);
  }
  return { ok: true, location: parsed.href, code };
}

/**
 * Append to a capped log, dropping the oldest entry when full.
 * @template T
 * @param {T[]} log
 * @param {T} entry
 */
export function pushCapped(log, entry) {
  log.push(entry);
  if (log.length > LOG_CAP) log.splice(0, log.length - LOG_CAP);
}

/**
 * Consume a request body under a byte cap, then call `onEnd`. Over-cap bodies
 * get 413 and the socket is destroyed.
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {() => void} onEnd
 */
export function drainBody(req, res, onEnd) {
  let received = 0;
  let tooBig = false;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (tooBig || received <= MAX_BODY_BYTES) return;
    tooBig = true;
    res.once('finish', () => req.socket.destroy());
    res.writeHead(413, { Connection: 'close', 'Content-Length': '0' });
    res.end();
  });
  req.on('end', () => {
    if (!tooBig) onEnd();
  });
  req.on('error', () => {});
}

/**
 * Send a fully-buffered response.
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {string | Buffer} body
 * @param {Record<string, string>} headers
 */
export function send(res, status, body, headers) {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'Content-Length': String(buf.length),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}

/**
 * Bounded loopback-only HTTP server with socket tracking and idempotent close.
 * @param {{
 *   onRequest: (req: http.IncomingMessage, res: http.ServerResponse) => void,
 *   onUpgrade?: (req: http.IncomingMessage, socket: import('node:net').Socket, head: Buffer) => void,
 *   onClose?: () => void,
 * }} handlers
 * @returns {{
 *   listen: (port?: number, host?: string) => Promise<{ port: number, origin: string }>,
 *   close: () => Promise<void>,
 * }}
 */
export function createLoopbackHttpServer({ onRequest, onUpgrade, onClose }) {
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();
  const server = http.createServer(
    {
      maxHeaderSize: 16 * 1024,
      headersTimeout: 5000,
      requestTimeout: 10000,
      keepAliveTimeout: 2000,
    },
    (req, res) => {
      try {
        onRequest(req, res);
      } catch {
        if (!res.headersSent) res.writeHead(500, { 'Content-Length': '0' });
        res.end();
      }
    },
  );
  server.setTimeout(30000);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_err, socket) => {
    if (socket.writable)
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });
  if (onUpgrade) {
    server.on('upgrade', (req, socket, head) => {
      socket.on('error', () => {});
      try {
        onUpgrade(req, socket, head);
      } catch {
        socket.destroy();
      }
    });
  }

  let listening = false;
  /** @type {Promise<void> | null} */
  let closePromise = null;

  return {
    async listen(port = 0, host = '127.0.0.1') {
      const loopbackHost = assertLoopbackHost(host);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new RangeError('port must be an integer between 0 and 65535');
      }
      if (closePromise) throw new Error('fixture server is closed');
      if (listening) throw new Error('fixture server is already listening');
      listening = true;
      await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen({ port, host: loopbackHost }, () => {
          server.off('error', onError);
          resolve(undefined);
        });
      });
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('unexpected listen address');
      return {
        port: address.port,
        origin: originFor(loopbackHost, address.port),
      };
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = new Promise((resolve) => {
        try {
          onClose?.();
        } catch {
          // best effort
        }
        if (server.listening) server.close(() => resolve(undefined));
        else resolve(undefined);
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
      return closePromise;
    },
  };
}

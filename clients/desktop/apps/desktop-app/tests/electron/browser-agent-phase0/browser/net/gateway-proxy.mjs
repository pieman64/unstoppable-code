// @ts-check
/**
 * Probe-owned resolving forward proxy for the S0.3 per-tab enforcement spike.
 *
 * Chromium's webRequest never exposes the resolved address before a request, so
 * this probe models "actual resolved-destination enforcement" with a per-Session
 * HTTP forward proxy: each destination is resolved ONCE by a synthetic resolver,
 * that exact address is classified and decided on, and the dial uses the same
 * lookup result (through a loopback-only route table). There is no TOCTOU.
 *
 * Safety: the gateway never dials anything except 127.0.0.1 / ::1 (route hosts
 * are validated), never performs real DNS, and bounds headers, log size and
 * socket lifetimes.
 */
import http from 'node:http';
import net from 'node:net';
import { classifyAddress, isAllowedAddressClass } from './address-policy.mjs';

/**
 * @typedef {{ host: string, address: string|null, index: number, error?: string }} LookupEntry
 * @typedef {{ resolve(host: string): { address: string, index: number }, lookups: LookupEntry[] }} SyntheticResolver
 * @typedef {'http'|'connect'|'upgrade'} GatewayKind
 * @typedef {{
 *   kind: GatewayKind, host: string, port: number, address: string, addressClass: string,
 *   attribution: string|null, method: string, target: string,
 * }} DecideContext
 * @typedef {{ allow: boolean, reason: string }} Decision
 * @typedef {{
 *   seq: number, gateway: string, kind: GatewayKind, host: string, port: number,
 *   address: string|null, addressClass: string|null, lookupIndex: number,
 *   attribution: string|null, decision: 'allow'|'deny'|'nxdomain'|'unroutable'|'error',
 *   reason: string, at: number,
 * }} GatewayLogEntry
 * @typedef {{
 *   name: string,
 *   resolver: { resolve(host: string): { address: string, index: number } },
 *   route: (address: string, port: number) => { host: string, port: number } | null,
 *   decide: (ctx: DecideContext) => Decision,
 *   attributionHeader?: string, timeoutMs?: number, maxHeaderBytes?: number, maxEntries?: number,
 * }} GatewayOptions
 * @typedef {{
 *   listen(port: number, host: string): Promise<{ port: number }>,
 *   close(): Promise<void>,
 *   log: GatewayLogEntry[],
 *   readonly logTruncated: boolean,
 *   address(): import('node:net').AddressInfo | string | null,
 * }} GatewayProxy
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1']);
const MAX_ATTRIBUTION_CHARS = 128;
const MAX_RESOLVER_LOG = 2000;

/**
 * @param {string} host
 * @returns {string}
 */
function canonicalHost(host) {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.') && !net.isIP(h)) h = h.slice(0, -1);
  return h;
}

/**
 * Synthetic resolver. Table values are sequences of IP strings; each call
 * returns the next entry and repeats the last one once exhausted (DNS
 * rebinding with TTL 0). IP literals resolve to themselves. Unknown names
 * throw ENOTFOUND. There is never real DNS.
 * @param {Record<string, string[]>} table
 * @returns {SyntheticResolver}
 */
export function createSyntheticResolver(table) {
  /** @type {Map<string, string[]>} */
  const entries = new Map();
  for (const [name, seq] of Object.entries(table))
    entries.set(canonicalHost(name), [...seq]);
  /** @type {Map<string, number>} */
  const counters = new Map();
  /** @type {LookupEntry[]} */
  const lookups = [];

  /** @param {LookupEntry} entry */
  const record = (entry) => {
    if (lookups.length < MAX_RESOLVER_LOG) lookups.push(entry);
  };

  return {
    lookups,
    resolve(host) {
      const key = canonicalHost(String(host));
      if (net.isIP(key)) {
        record({ host: key, address: key, index: -1 });
        return { address: key, index: -1 };
      }
      const seq = entries.get(key);
      if (!seq || seq.length === 0) {
        record({ host: key, address: null, index: -1, error: 'ENOTFOUND' });
        throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${key}`), {
          code: 'ENOTFOUND',
        });
      }
      const n = counters.get(key) ?? 0;
      const index = Math.min(n, seq.length - 1);
      counters.set(key, n + 1);
      record({ host: key, address: seq[index], index });
      return { address: seq[index], index };
    },
  };
}

/**
 * @param {string} s
 * @returns {string}
 */
function headerSafe(s) {
  return String(s)
    .replace(/[^\x20-\x7e]/g, '_')
    .slice(0, 200);
}

/**
 * Split raw headers into a forwardable flat list and the attribution value.
 * @param {string[]} rawHeaders flat [name, value, ...]
 * @param {string} attributionHeader lowercase
 * @param {boolean} keepConnection keep Connection/Upgrade (upgrade replay)
 * @returns {{ forwarded: string[], attribution: string|null }}
 */
function splitHeaders(rawHeaders, attributionHeader, keepConnection) {
  /** @type {string[]} */
  const forwarded = [];
  /** @type {string|null} */
  let attribution = null;
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const value = rawHeaders[i + 1];
    const lower = name.toLowerCase();
    if (lower === attributionHeader) {
      if (attribution === null)
        attribution = value.slice(0, MAX_ATTRIBUTION_CHARS);
      continue;
    }
    if (lower === 'proxy-connection' || lower === 'proxy-authorization')
      continue;
    if (!keepConnection && (lower === 'connection' || lower === 'keep-alive'))
      continue;
    forwarded.push(name, value);
  }
  return { forwarded, attribution };
}

/**
 * Parse an absolute-form `http://host:port/path` request target.
 * @param {string} target
 * @returns {{ host: string, port: number, path: string } | null}
 */
function parseAbsoluteTarget(target) {
  if (!/^http:\/\//i.test(target)) return null;
  let u;
  try {
    u = new URL(target);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  const port = u.port ? Number(u.port) : 80;
  return {
    host: canonicalHost(u.hostname),
    port,
    path: `${u.pathname}${u.search}`,
  };
}

/**
 * Parse a CONNECT authority `host:port` / `[v6]:port`.
 * @param {string} target
 * @returns {{ host: string, port: number } | null}
 */
function parseAuthority(target) {
  const m = /^(\[[0-9a-fA-F:.%a-zA-Z]+\]|[^:/@\s?#]+):(\d{1,5})$/.exec(target);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < 1 || port > 65535) return null;
  try {
    return { host: canonicalHost(new URL(`http://${m[1]}`).hostname), port };
  } catch {
    return null;
  }
}

/**
 * @param {{ host: string, port: number } | null} route
 * @returns {route is { host: string, port: number }}
 */
function isSafeRoute(route) {
  return (
    !!route &&
    typeof route.host === 'string' &&
    LOOPBACK_HOSTS.has(route.host) &&
    Number.isInteger(route.port) &&
    route.port >= 1 &&
    route.port <= 65535
  );
}

/**
 * Create a resolving forward proxy.
 * @param {GatewayOptions} options
 * @returns {GatewayProxy}
 */
export function createGatewayProxy(options) {
  const {
    name,
    resolver,
    route,
    decide,
    attributionHeader = 'x-s03-lease',
    timeoutMs = 5000,
    maxHeaderBytes = 16384,
    maxEntries = 2000,
  } = options;
  const attrName = attributionHeader.toLowerCase();

  /** @type {GatewayLogEntry[]} */
  const log = [];
  let logTruncated = false;
  let seq = 0;
  let closed = false;
  /** @type {Promise<void>|null} */
  let closePromise = null;
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set();

  /** @param {import('node:net').Socket} socket */
  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(timeoutMs, () => socket.destroy());
    if (closed) socket.destroy();
  };

  /**
   * @param {Omit<GatewayLogEntry, 'seq'|'gateway'|'at'>} entry
   */
  const record = (entry) => {
    seq += 1;
    if (log.length >= maxEntries) {
      logTruncated = true;
      return;
    }
    log.push({ seq, gateway: name, ...entry, at: Date.now() });
  };

  /**
   * Resolve, classify, decide, route. Logs exactly one entry for the outcome.
   * @param {GatewayKind} kind
   * @param {string} host
   * @param {number} port
   * @param {string|null} attribution
   * @param {string} method
   * @param {string} target
   * @returns {{ ok: true, route: { host: string, port: number } } | { ok: false, status: number, tag: string, reason: string }}
   */
  const evaluate = (kind, host, port, attribution, method, target) => {
    const base = { kind, host, port, attribution };
    /** @type {{ address: string, index: number }} */
    let resolved;
    try {
      resolved = resolver.resolve(host);
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String(err.code)
          : 'ERROR';
      if (code === 'ENOTFOUND') {
        record({
          ...base,
          address: null,
          addressClass: null,
          lookupIndex: -1,
          decision: 'nxdomain',
          reason: 'nxdomain',
        });
        return { ok: false, status: 502, tag: 'nxdomain', reason: 'nxdomain' };
      }
      record({
        ...base,
        address: null,
        addressClass: null,
        lookupIndex: -1,
        decision: 'error',
        reason: `resolver-error:${code}`,
      });
      return { ok: false, status: 502, tag: 'error', reason: 'resolver-error' };
    }
    const { address, index } = resolved;
    const addressClass = classifyAddress(address);

    /** @type {Decision} */
    let verdict;
    try {
      verdict = decide({
        kind,
        host,
        port,
        address,
        addressClass,
        attribution,
        method,
        target: target.slice(0, 512),
      });
    } catch {
      verdict = { allow: false, reason: 'decide-threw' };
    }
    const common = { ...base, address, addressClass, lookupIndex: index };
    if (!verdict || !verdict.allow) {
      const reason = verdict && verdict.reason ? verdict.reason : 'denied';
      record({ ...common, decision: 'deny', reason });
      return { ok: false, status: 403, tag: 'denied', reason };
    }

    let target_route = null;
    try {
      target_route = route(address, port);
    } catch {
      target_route = null;
    }
    if (!isSafeRoute(target_route)) {
      record({ ...common, decision: 'unroutable', reason: 'unroutable' });
      return {
        ok: false,
        status: 502,
        tag: 'unroutable',
        reason: 'unroutable',
      };
    }
    record({ ...common, decision: 'allow', reason: verdict.reason });
    return { ok: true, route: target_route };
  };

  /**
   * @param {GatewayKind} kind
   * @param {string} host
   * @param {number} port
   * @param {string} reason
   */
  const recordDialError = (kind, host, port, reason) => {
    record({
      kind,
      host,
      port,
      address: null,
      addressClass: null,
      lookupIndex: -1,
      attribution: null,
      decision: 'error',
      reason,
    });
  };

  /**
   * @param {import('node:http').ServerResponse} res
   * @param {{ status: number, tag: string, reason: string }} fail
   */
  const respondHttpFailure = (res, fail) => {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    /** @type {Record<string, string>} */
    const headers = {
      'x-s03-gateway': fail.tag,
      'content-type': 'text/plain; charset=utf-8',
      connection: 'close',
    };
    if (fail.tag === 'denied') {
      headers['x-s03-gateway-reason'] = headerSafe(fail.reason);
      headers['access-control-allow-origin'] = '*';
    }
    const body = `s03 gateway ${fail.tag}: ${headerSafe(fail.reason)}\n`;
    res.writeHead(fail.status, headers);
    res.end(body);
  };

  /**
   * Write a raw failure response to a socket, then close it.
   * @param {import('node:net').Socket} socket
   * @param {{ status: number, tag: string, reason: string }} fail
   */
  const respondRawFailure = (socket, fail) => {
    const text =
      fail.status === 403
        ? 'Forbidden'
        : fail.status === 400
          ? 'Bad Request'
          : 'Bad Gateway';
    let head = `HTTP/1.1 ${fail.status} ${text}\r\nx-s03-gateway: ${fail.tag}\r\n`;
    if (fail.tag === 'denied') {
      head += `x-s03-gateway-reason: ${headerSafe(fail.reason)}\r\naccess-control-allow-origin: *\r\n`;
    }
    head += 'content-length: 0\r\nconnection: close\r\n\r\n';
    if (socket.writable) socket.end(head);
    else socket.destroy();
  };

  /**
   * Pipe two sockets together; closing or erroring one closes the other.
   * @param {import('node:net').Socket} a
   * @param {import('node:net').Socket} b
   */
  const bridge = (a, b) => {
    a.on('close', () => b.destroy());
    b.on('close', () => a.destroy());
    a.on('error', () => b.destroy());
    b.on('error', () => a.destroy());
    a.pipe(b);
    b.pipe(a);
  };

  /**
   * Dial a validated loopback route.
   * @param {{ host: string, port: number }} r
   * @returns {import('node:net').Socket}
   */
  const dial = (r) => {
    const up = net.connect({ host: r.host, port: r.port });
    track(up);
    return up;
  };

  /** @type {import('node:http').RequestListener} */
  const onRequest = (req, res) => {
    const target = req.url ?? '';
    const parsed = parseAbsoluteTarget(target);
    if (!parsed) {
      req.resume();
      res.writeHead(400, {
        'content-type': 'text/plain; charset=utf-8',
        connection: 'close',
      });
      res.end('s03 gateway: absolute-form http:// request target required\n');
      return;
    }
    const { forwarded, attribution } = splitHeaders(
      req.rawHeaders,
      attrName,
      false,
    );
    const outcome = evaluate(
      'http',
      parsed.host,
      parsed.port,
      attribution,
      req.method ?? 'GET',
      target,
    );
    if (!outcome.ok) {
      req.resume();
      respondHttpFailure(res, outcome);
      return;
    }

    const upstream = http.request({
      host: outcome.route.host,
      port: outcome.route.port,
      method: req.method,
      path: parsed.path,
      headers: forwarded,
      agent: false,
      setHost: false,
    });
    upstream.on('socket', track);
    upstream.on('response', (upRes) => {
      /** @type {string[]} */
      const out = [];
      for (let i = 0; i + 1 < upRes.rawHeaders.length; i += 2) {
        const lower = upRes.rawHeaders[i].toLowerCase();
        if (
          lower === 'connection' ||
          lower === 'keep-alive' ||
          lower === 'transfer-encoding'
        )
          continue;
        out.push(upRes.rawHeaders[i], upRes.rawHeaders[i + 1]);
      }
      res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, out);
      upRes.on('error', () => res.destroy());
      upRes.pipe(res);
    });
    upstream.on('error', () => {
      recordDialError('http', parsed.host, parsed.port, 'upstream-error');
      respondHttpFailure(res, {
        status: 502,
        tag: 'error',
        reason: 'upstream-error',
      });
    });
    res.on('close', () => {
      if (!upstream.destroyed) upstream.destroy();
    });
    req.on('error', () => upstream.destroy());
    req.pipe(upstream);
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   */
  const onConnect = (req, socket, head) => {
    socket.pause();
    socket.setTimeout(timeoutMs, () => socket.destroy());
    const parsed = parseAuthority(req.url ?? '');
    if (!parsed) {
      respondRawFailure(socket, {
        status: 400,
        tag: 'bad-request',
        reason: 'bad-connect-target',
      });
      return;
    }
    const { attribution } = splitHeaders(req.rawHeaders, attrName, true);
    const outcome = evaluate(
      'connect',
      parsed.host,
      parsed.port,
      attribution,
      'CONNECT',
      req.url ?? '',
    );
    if (!outcome.ok) {
      respondRawFailure(socket, outcome);
      return;
    }
    const up = dial(outcome.route);
    up.once('connect', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) up.write(head);
      bridge(socket, up);
      socket.resume();
    });
    up.once('error', () => {
      recordDialError('connect', parsed.host, parsed.port, 'upstream-error');
      if (socket.writable)
        respondRawFailure(socket, {
          status: 502,
          tag: 'error',
          reason: 'upstream-error',
        });
    });
  };

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:net').Socket} socket
   * @param {Buffer} head
   */
  const onUpgrade = (req, socket, head) => {
    socket.pause();
    socket.setTimeout(timeoutMs, () => socket.destroy());
    const target = req.url ?? '';
    const parsed = parseAbsoluteTarget(target);
    if (!parsed) {
      respondRawFailure(socket, {
        status: 400,
        tag: 'bad-request',
        reason: 'absolute-form-required',
      });
      return;
    }
    const { forwarded, attribution } = splitHeaders(
      req.rawHeaders,
      attrName,
      true,
    );
    const outcome = evaluate(
      'upgrade',
      parsed.host,
      parsed.port,
      attribution,
      req.method ?? 'GET',
      target,
    );
    if (!outcome.ok) {
      respondRawFailure(socket, outcome);
      return;
    }
    const up = dial(outcome.route);
    up.once('connect', () => {
      let replay = `${req.method} ${parsed.path} HTTP/1.1\r\n`;
      for (let i = 0; i + 1 < forwarded.length; i += 2)
        replay += `${forwarded[i]}: ${forwarded[i + 1]}\r\n`;
      replay += '\r\n';
      up.write(replay);
      if (head && head.length > 0) up.write(head);
      bridge(socket, up);
      socket.resume();
    });
    up.once('error', () => {
      recordDialError('upgrade', parsed.host, parsed.port, 'upstream-error');
      if (socket.writable)
        respondRawFailure(socket, {
          status: 502,
          tag: 'error',
          reason: 'upstream-error',
        });
    });
  };

  const server = http.createServer(
    { maxHeaderSize: maxHeaderBytes, headersTimeout: timeoutMs },
    onRequest,
  );
  server.timeout = timeoutMs;
  server.keepAliveTimeout = 1000;
  server.on('connection', track);
  server.on('connect', onConnect);
  server.on('upgrade', onUpgrade);
  server.on('clientError', (err, socket) => {
    const code =
      err && typeof err === 'object' && 'code' in err ? err.code : '';
    const status =
      code === 'HPE_HEADER_OVERFLOW'
        ? '431 Request Header Fields Too Large'
        : '400 Bad Request';
    if (socket.writable)
      socket.end(
        `HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
      );
    else socket.destroy();
  });
  server.on('error', () => {});

  return {
    log,
    get logTruncated() {
      return logTruncated;
    },
    address() {
      return server.address();
    },
    async listen(port, host) {
      if (!LOOPBACK_HOSTS.has(host)) {
        throw new Error(
          `gateway may only listen on 127.0.0.1 or ::1, got ${JSON.stringify(host)}`,
        );
      }
      if (closed) throw new Error('gateway is closed');
      await new Promise((resolve, reject) => {
        const onError = (/** @type {Error} */ err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
          server.off('error', onError);
          resolve(undefined);
        });
      });
      const addr = server.address();
      if (!addr || typeof addr === 'string')
        throw new Error('gateway has no address');
      return { port: addr.port };
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        if (!server.listening) {
          resolve(undefined);
          return;
        }
        server.close(() => resolve(undefined));
        server.closeAllConnections();
      });
      return closePromise;
    },
  };
}

/**
 * @param {string} origin
 * @returns {{ host: string, port: number } | null}
 */
function originHostPort(origin) {
  let u;
  try {
    u = new URL(origin);
  } catch {
    return null;
  }
  /** @type {Record<string, number>} */
  const defaults = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };
  const fallback = defaults[u.protocol];
  if (fallback === undefined) return null;
  return {
    host: canonicalHost(u.hostname),
    port: u.port ? Number(u.port) : fallback,
  };
}

/**
 * Convenience decide(ctx) factory.
 *  - denies host+port (scheme-agnostic) matching a denied origin;
 *  - allows host+port matching an exception origin only when the resolved
 *    address is loopback;
 *  - otherwise allows only allowed address classes.
 * @param {{ exceptionOrigins?: string[], deniedOrigins?: string[] }} [options]
 * @returns {(ctx: DecideContext) => Decision}
 */
export function defaultDecide({
  exceptionOrigins = [],
  deniedOrigins = [],
} = {}) {
  const denied = deniedOrigins.map(originHostPort).filter((x) => x !== null);
  const excepted = exceptionOrigins
    .map(originHostPort)
    .filter((x) => x !== null);
  return (ctx) => {
    const host = canonicalHost(ctx.host);
    const matches = (/** @type {{ host: string, port: number }} */ o) =>
      o.host === host && o.port === ctx.port;
    if (denied.some(matches)) return { allow: false, reason: 'denied-origin' };
    if (excepted.some(matches) && ctx.addressClass === 'loopback') {
      return { allow: true, reason: 'fixture-origin-exception' };
    }
    return {
      allow: isAllowedAddressClass(ctx.addressClass),
      reason: `address-class:${ctx.addressClass}`,
    };
  };
}

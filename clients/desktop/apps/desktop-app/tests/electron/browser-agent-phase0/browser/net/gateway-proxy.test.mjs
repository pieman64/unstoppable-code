// @ts-check
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';
import {
  createGatewayProxy,
  createSyntheticResolver,
  defaultDecide,
} from './gateway-proxy.mjs';

const T = { timeout: 10_000 };

/**
 * @typedef {{ url: string, headers: http.IncomingHttpHeaders, method: string|undefined }} Hit
 */

/**
 * A tiny loopback HTTP listener that records hits and supports upgrades (echo).
 * @param {string} label
 */
async function startListener(label) {
  /** @type {Hit[]} */
  const hits = [];
  /** @type {Set<net.Socket>} */
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    hits.push({ url: req.url ?? '', headers: req.headers, method: req.method });
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`${label}:${req.url}`);
  });
  server.on('upgrade', (req, socket) => {
    hits.push({ url: req.url ?? '', headers: req.headers, method: req.method });
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n',
    );
    socket.on('data', (d) => socket.write(d));
    socket.on('error', () => {});
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const addr = server.address();
  assert(addr && typeof addr !== 'string');
  return {
    hits,
    port: addr.port,
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    },
  };
}

/**
 * Issue an absolute-form request through the proxy.
 * @param {number} proxyPort
 * @param {string} absoluteUrl
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function proxied(proxyPort, absoluteUrl, headers = {}) {
  // Like a browser, send Host = the target authority (Node would default it to the proxy's).
  const targetHost = absoluteUrl.startsWith('http://')
    ? new URL(absoluteUrl).host
    : undefined;
  const allHeaders = targetHost ? { host: targetHost, ...headers } : headers;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path: absoluteUrl,
        headers: allHeaders,
        agent: false,
        timeout: 5000,
      },
      (res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('client timeout')));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Read from a raw socket until the predicate passes or the socket ends.
 * @param {net.Socket} socket
 * @param {(buf: string) => boolean} done
 * @returns {Promise<string>}
 */
function readUntil(socket, done) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`readUntil timed out; got ${JSON.stringify(buf)}`));
    }, 5000);
    const onData = (/** @type {Buffer} */ d) => {
      buf += d.toString('utf8');
      if (done(buf)) {
        cleanup();
        resolve(buf);
      }
    };
    const onEnd = () => {
      cleanup();
      resolve(buf);
    };
    const onError = (/** @type {Error} */ e) => {
      cleanup();
      if (buf) resolve(buf);
      else reject(e);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('close', onEnd);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('end', onEnd);
    socket.on('close', onEnd);
    socket.on('error', onError);
  });
}

/** @param {number} port */
function connectRaw(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => resolve(s));
    s.once('error', reject);
  }).then((s) => /** @type {net.Socket} */ (s));
}

/**
 * Build a full fixture: listeners, resolver, gateway.
 * @param {{ exceptionOrigins?: (localPort: number) => string[], deniedOrigins?: (localPort: number) => string[], name?: string, gateway?: Partial<Parameters<typeof createGatewayProxy>[0]> }} [opts]
 */
async function makeFixture(opts = {}) {
  const publicL = await startListener('public');
  const localL = await startListener('local');
  const resolver = createSyntheticResolver({
    'rebind.s03.test': ['203.0.113.20', '127.0.0.1'],
    'public.s03.test': ['203.0.113.10'],
    'local.s03.test': ['127.0.0.1'],
    'meta.s03.test': ['169.254.169.254'],
  });
  const gateway = createGatewayProxy({
    name: opts.name ?? 'gw-test',
    resolver,
    route: (address, port) => {
      if (address.startsWith('203.0.113.'))
        return { host: '127.0.0.1', port: publicL.port };
      if (address === '127.0.0.1' && port === localL.port)
        return { host: '127.0.0.1', port: localL.port };
      return null;
    },
    decide: defaultDecide({
      exceptionOrigins: opts.exceptionOrigins?.(localL.port) ?? [],
      deniedOrigins: opts.deniedOrigins?.(localL.port) ?? [],
    }),
    timeoutMs: 3000,
    ...opts.gateway,
  });
  const { port } = await gateway.listen(0, '127.0.0.1');
  return {
    publicL,
    localL,
    resolver,
    gateway,
    proxyPort: port,
    async close() {
      await gateway.close();
      await publicL.close();
      await localL.close();
    },
  };
}

describe('createSyntheticResolver', () => {
  test(
    'sequence, repeat-last, literals, nxdomain, case, trailing dot',
    T,
    () => {
      const r = createSyntheticResolver({
        'Rebind.S03.test': ['203.0.113.20', '127.0.0.1'],
      });
      assert.deepEqual(r.resolve('rebind.s03.test'), {
        address: '203.0.113.20',
        index: 0,
      });
      assert.deepEqual(r.resolve('REBIND.s03.test.'), {
        address: '127.0.0.1',
        index: 1,
      });
      assert.deepEqual(r.resolve('rebind.s03.test'), {
        address: '127.0.0.1',
        index: 1,
      });
      assert.deepEqual(r.resolve('10.1.2.3'), {
        address: '10.1.2.3',
        index: -1,
      });
      assert.deepEqual(r.resolve('[::1]'), { address: '::1', index: -1 });
      assert.throws(
        () => r.resolve('nope.s03.test'),
        (/** @type {any} */ e) => e.code === 'ENOTFOUND',
      );
      assert.equal(r.lookups.length, 6);
      assert.deepEqual(r.lookups[5], {
        host: 'nope.s03.test',
        address: null,
        index: -1,
        error: 'ENOTFOUND',
      });
    },
  );
});

describe('gateway basics', () => {
  /** @type {Awaited<ReturnType<typeof makeFixture>>} */
  let fx;
  before(async () => {
    fx = await makeFixture();
  });
  after(async () => {
    await fx.close();
  });

  test('listen only accepts loopback hosts', T, async () => {
    const gw = createGatewayProxy({
      name: 'x',
      resolver: createSyntheticResolver({}),
      route: () => null,
      decide: () => ({ allow: false, reason: 'x' }),
    });
    await assert.rejects(() => gw.listen(0, '0.0.0.0'));
    await assert.rejects(() => gw.listen(0, 'example.com'));
    await gw.close();
    await gw.close(); // idempotent
  });

  test(
    'DNS rebinding: first lookup public is allowed, second lookup loopback is denied with no local hit',
    T,
    async () => {
      const first = await proxied(
        fx.proxyPort,
        `http://rebind.s03.test:${fx.localL.port}/hit/a`,
      );
      assert.equal(first.status, 200);
      assert.equal(first.body, 'public:/hit/a');
      assert.equal(fx.publicL.hits.length, 1);
      assert.equal(fx.publicL.hits[0].url, '/hit/a');
      // Host header is preserved end to end.
      assert.equal(
        fx.publicL.hits[0].headers.host,
        `rebind.s03.test:${fx.localL.port}`,
      );

      const second = await proxied(
        fx.proxyPort,
        `http://rebind.s03.test:${fx.localL.port}/hit/b`,
      );
      assert.equal(second.status, 403);
      assert.equal(second.headers['x-s03-gateway'], 'denied');
      assert.equal(
        second.headers['x-s03-gateway-reason'],
        'address-class:loopback',
      );
      assert.equal(second.headers['access-control-allow-origin'], '*');
      assert.equal(
        fx.localL.hits.length,
        0,
        'local listener must record no hit',
      );
      assert.equal(fx.publicL.hits.length, 1);

      const entries = fx.gateway.log.filter(
        (e) => e.host === 'rebind.s03.test',
      );
      assert.equal(entries.length, 2);
      assert.equal(entries[0].decision, 'allow');
      assert.equal(entries[0].address, '203.0.113.20');
      assert.equal(entries[0].addressClass, 'synthetic-public');
      assert.equal(entries[0].lookupIndex, 0);
      assert.equal(entries[1].decision, 'deny');
      assert.equal(entries[1].address, '127.0.0.1');
      assert.equal(entries[1].addressClass, 'loopback');
      assert.equal(entries[1].lookupIndex, 1);
      assert.equal(entries[1].gateway, 'gw-test');
      assert.equal(entries[1].kind, 'http');
      assert.equal(entries[1].port, fx.localL.port);
      assert.ok(entries[1].seq > entries[0].seq);
    },
  );

  test(
    'literal 127.0.0.1 and named-loopback are denied without a hit',
    T,
    async () => {
      const before = fx.localL.hits.length;
      const literal = await proxied(
        fx.proxyPort,
        `http://127.0.0.1:${fx.localL.port}/lit`,
      );
      assert.equal(literal.status, 403);
      assert.equal(
        literal.headers['x-s03-gateway-reason'],
        'address-class:loopback',
      );
      const named = await proxied(
        fx.proxyPort,
        `http://local.s03.test:${fx.localL.port}/named`,
      );
      assert.equal(named.status, 403);
      const meta = await proxied(fx.proxyPort, 'http://meta.s03.test/latest');
      assert.equal(meta.status, 403);
      assert.equal(
        meta.headers['x-s03-gateway-reason'],
        'address-class:metadata',
      );
      const mapped = await proxied(
        fx.proxyPort,
        `http://[::ffff:127.0.0.1]:${fx.localL.port}/m`,
      );
      assert.equal(mapped.status, 403);
      assert.equal(fx.localL.hits.length, before);
    },
  );

  test('unknown name -> 502 nxdomain, zero hits anywhere', T, async () => {
    const pubBefore = fx.publicL.hits.length;
    const locBefore = fx.localL.hits.length;
    const res = await proxied(fx.proxyPort, 'http://unknown.s03.test/x');
    assert.equal(res.status, 502);
    assert.equal(res.headers['x-s03-gateway'], 'nxdomain');
    assert.equal(fx.publicL.hits.length, pubBefore);
    assert.equal(fx.localL.hits.length, locBefore);
    const entry = fx.gateway.log.findLast((e) => e.host === 'unknown.s03.test');
    assert.equal(entry?.decision, 'nxdomain');
    assert.equal(entry?.address, null);
  });

  test(
    'attribution header is captured, capped, and stripped before upstream',
    T,
    async () => {
      const res = await proxied(fx.proxyPort, 'http://public.s03.test/attr', {
        'x-s03-lease': 'lease-abc',
        'proxy-connection': 'keep-alive',
        'proxy-authorization': 'Basic Zm9vOmJhcg==',
        'x-keep-me': 'yes',
      });
      assert.equal(res.status, 200);
      const hit = fx.publicL.hits.findLast((h) => h.url === '/attr');
      assert.ok(hit);
      assert.equal(hit.headers['x-s03-lease'], undefined);
      assert.equal(hit.headers['proxy-connection'], undefined);
      assert.equal(hit.headers['proxy-authorization'], undefined);
      assert.equal(hit.headers['x-keep-me'], 'yes');
      assert.equal(hit.headers.host, 'public.s03.test');
      const entry = fx.gateway.log.findLast(
        (e) => e.host === 'public.s03.test',
      );
      assert.equal(entry?.attribution, 'lease-abc');
      assert.equal(entry?.decision, 'allow');

      await proxied(fx.proxyPort, 'http://public.s03.test/attr2', {
        'x-s03-lease': 'x'.repeat(500),
      });
      const long = fx.gateway.log.findLast((e) => e.host === 'public.s03.test');
      assert.equal(long?.attribution?.length, 128);
    },
  );

  test('attribution is recorded on denied requests too', T, async () => {
    await proxied(fx.proxyPort, `http://127.0.0.1:${fx.localL.port}/d`, {
      'x-s03-lease': 'lease-denied',
    });
    const entry = fx.gateway.log.findLast((e) => e.host === '127.0.0.1');
    assert.equal(entry?.decision, 'deny');
    assert.equal(entry?.attribution, 'lease-denied');
  });

  test('origin-form request to the proxy -> 400', T, async () => {
    const res = await proxied(fx.proxyPort, '/just/a/path');
    assert.equal(res.status, 400);
  });

  test('POST body is streamed to the upstream', T, async () => {
    const body = 'hello-body-'.repeat(50);
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: fx.proxyPort,
          method: 'POST',
          path: 'http://public.s03.test/post',
          agent: false,
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    assert.equal(status, 200);
    const hit = fx.publicL.hits.findLast((h) => h.url === '/post');
    assert.equal(hit?.method, 'POST');
    assert.equal(hit?.headers['content-length'], String(body.length));
  });

  test(
    'CONNECT allowed: tunnel reaches the public listener; attribution recorded',
    T,
    async () => {
      const s = await connectRaw(fx.proxyPort);
      s.write(
        'CONNECT public.s03.test:80 HTTP/1.1\r\nHost: public.s03.test:80\r\nx-s03-lease: lease-connect\r\n\r\n',
      );
      const head = await readUntil(s, (b) => b.includes('\r\n\r\n'));
      assert.match(head, /^HTTP\/1\.1 200 Connection Established/);
      s.write(
        'GET /tunnel HTTP/1.1\r\nHost: public.s03.test\r\nConnection: close\r\n\r\n',
      );
      const resp = await readUntil(s, (b) => b.includes('public:/tunnel'));
      assert.match(resp, /200 OK/);
      assert.match(resp, /public:\/tunnel/);
      s.destroy();
      const entry = fx.gateway.log.findLast(
        (e) => e.kind === 'connect' && e.host === 'public.s03.test',
      );
      assert.equal(entry?.decision, 'allow');
      assert.equal(entry?.attribution, 'lease-connect');
    },
  );

  test('CONNECT denied: 403, connection closed, no local hit', T, async () => {
    const before = fx.localL.hits.length;
    const s = await connectRaw(fx.proxyPort);
    s.write(
      `CONNECT local.s03.test:${fx.localL.port} HTTP/1.1\r\nHost: x\r\n\r\n`,
    );
    const resp = await readUntil(s, () => false); // read until the gateway closes
    assert.match(resp, /^HTTP\/1\.1 403 Forbidden/);
    assert.match(resp, /x-s03-gateway: denied/i);
    assert.match(resp, /x-s03-gateway-reason: address-class:loopback/i);
    s.destroy();
    assert.equal(fx.localL.hits.length, before);
    const entry = fx.gateway.log.findLast(
      (e) => e.kind === 'connect' && e.host === 'local.s03.test',
    );
    assert.equal(entry?.decision, 'deny');
  });

  test('CONNECT with a malformed target -> 400', T, async () => {
    const s = await connectRaw(fx.proxyPort);
    s.write('CONNECT no-port-here HTTP/1.1\r\nHost: x\r\n\r\n');
    const resp = await readUntil(s, () => false);
    assert.match(resp, /^HTTP\/1\.1 400 Bad Request/);
    s.destroy();
  });

  test(
    'upgrade allowed through an absolute-form request; headers replayed, attribution stripped',
    T,
    async () => {
      const result = await new Promise((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: fx.proxyPort,
          path: 'http://public.s03.test/ws',
          headers: {
            Connection: 'Upgrade',
            Upgrade: 'websocket',
            'x-s03-lease': 'lease-ws',
          },
          agent: false,
        });
        const timer = setTimeout(
          () => req.destroy(new Error('upgrade timeout')),
          5000,
        );
        req.on('upgrade', (res, socket) => {
          socket.on('data', (d) => {
            clearTimeout(timer);
            socket.destroy();
            resolve({ status: res.statusCode, echo: d.toString('utf8') });
          });
          socket.write('ping');
        });
        req.on('response', () =>
          reject(new Error('expected upgrade, got plain response')),
        );
        req.on('error', reject);
        req.end();
      });
      assert.deepEqual(result, { status: 101, echo: 'ping' });
      const hit = fx.publicL.hits.findLast((h) => h.url === '/ws');
      assert.ok(hit);
      assert.equal(hit.headers['x-s03-lease'], undefined);
      assert.equal(hit.headers.upgrade, 'websocket');
      const entry = fx.gateway.log.findLast((e) => e.kind === 'upgrade');
      assert.equal(entry?.decision, 'allow');
      assert.equal(entry?.attribution, 'lease-ws');
    },
  );

  test('upgrade denied for a loopback address: 403, no hit', T, async () => {
    const before = fx.localL.hits.length;
    const status = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1',
        port: fx.proxyPort,
        path: `http://local.s03.test:${fx.localL.port}/ws`,
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
        agent: false,
      });
      req.on('upgrade', () => reject(new Error('must not upgrade')));
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.equal(fx.localL.hits.length, before);
  });

  test('oversized headers are rejected', T, async () => {
    const small = await makeFixture({
      name: 'gw-small',
      gateway: { maxHeaderBytes: 1024 },
    });
    try {
      const s = await connectRaw(small.proxyPort);
      s.write(
        `GET http://public.s03.test/ HTTP/1.1\r\nHost: public.s03.test\r\nx-big: ${'a'.repeat(4000)}\r\n\r\n`,
      );
      const resp = await readUntil(s, () => false);
      assert.match(resp, /^HTTP\/1\.1 431/);
      s.destroy();
      assert.equal(small.publicL.hits.length, 0);
    } finally {
      await small.close();
    }
  });
});

describe('exception origins', () => {
  test(
    'exact host:port with loopback address is allowed; other ports and names are not',
    T,
    async () => {
      const fx = await makeFixture({
        exceptionOrigins: (p) => [`http://127.0.0.1:${p}`],
      });
      try {
        const ok = await proxied(
          fx.proxyPort,
          `http://127.0.0.1:${fx.localL.port}/fixture`,
        );
        assert.equal(ok.status, 200);
        assert.equal(ok.body, 'local:/fixture');
        assert.equal(fx.localL.hits.length, 1);
        const entry = fx.gateway.log.findLast((e) => e.host === '127.0.0.1');
        assert.equal(entry?.decision, 'allow');
        assert.equal(entry?.reason, 'fixture-origin-exception');

        // Same address through a different name is a different host: not excepted.
        const named = await proxied(
          fx.proxyPort,
          `http://local.s03.test:${fx.localL.port}/n`,
        );
        assert.equal(named.status, 403);
        // Rebinding name targeting the excepted port: second lookup is loopback but host differs.
        await proxied(
          fx.proxyPort,
          `http://rebind.s03.test:${fx.localL.port}/r1`,
        );
        const rebound = await proxied(
          fx.proxyPort,
          `http://rebind.s03.test:${fx.localL.port}/r2`,
        );
        assert.equal(rebound.status, 403);
        // Different port on the same literal host is not excepted (and unroutable anyway).
        const otherPort = await proxied(
          fx.proxyPort,
          `http://127.0.0.1:${fx.localL.port + 1}/p`,
        );
        assert.equal(otherPort.status, 403);
        assert.equal(fx.localL.hits.length, 1);
      } finally {
        await fx.close();
      }
    },
  );

  test(
    'deniedOrigins take precedence over an exception (scheme-agnostic)',
    T,
    async () => {
      const fx = await makeFixture({
        exceptionOrigins: (p) => [`http://127.0.0.1:${p}`],
        deniedOrigins: (p) => [`ws://127.0.0.1:${p}`],
      });
      try {
        const res = await proxied(
          fx.proxyPort,
          `http://127.0.0.1:${fx.localL.port}/x`,
        );
        assert.equal(res.status, 403);
        assert.equal(res.headers['x-s03-gateway-reason'], 'denied-origin');
        assert.equal(fx.localL.hits.length, 0);
      } finally {
        await fx.close();
      }
    },
  );

  test('denied origin blocks a public address by host+port', T, async () => {
    const fx = await makeFixture({
      deniedOrigins: () => ['http://public.s03.test:80'],
    });
    try {
      const res = await proxied(fx.proxyPort, 'http://public.s03.test/x');
      assert.equal(res.status, 403);
      assert.equal(res.headers['x-s03-gateway-reason'], 'denied-origin');
      assert.equal(fx.publicL.hits.length, 0);
    } finally {
      await fx.close();
    }
  });
});

describe('unroutable', () => {
  test('a route to a non-loopback host is never dialled', T, async () => {
    const publicL = await startListener('public');
    /** @type {Array<unknown>} */
    const routeCalls = [];
    const resolver = createSyntheticResolver({
      'public.s03.test': ['203.0.113.10'],
      'null.s03.test': ['203.0.113.11'],
      'bad-port.s03.test': ['203.0.113.12'],
    });
    const gateway = createGatewayProxy({
      name: 'gw-unroutable',
      resolver,
      route: (address, port) => {
        routeCalls.push([address, port]);
        if (address === '203.0.113.10')
          return { host: '10.255.255.1', port: 80 }; // would be a real dial
        if (address === '203.0.113.11') return null;
        // @ts-expect-error deliberately invalid route port
        return { host: '127.0.0.1', port: 0 };
      },
      decide: () => ({ allow: true, reason: 'test-allow-all' }),
      timeoutMs: 1000,
    });
    const { port } = await gateway.listen(0, '127.0.0.1');
    try {
      const started = Date.now();
      for (const host of [
        'public.s03.test',
        'null.s03.test',
        'bad-port.s03.test',
      ]) {
        const res = await proxied(port, `http://${host}/x`);
        assert.equal(res.status, 502, host);
        assert.equal(res.headers['x-s03-gateway'], 'unroutable', host);
      }
      // A real dial to 10.255.255.1 would hang until a timeout; unroutable answers immediately.
      assert.ok(
        Date.now() - started < 900,
        'unroutable must fail fast, without dialling',
      );
      assert.equal(
        gateway.log.filter((e) => e.decision === 'unroutable').length,
        3,
      );
      assert.equal(gateway.log.filter((e) => e.decision === 'allow').length, 0);

      const s = await connectRaw(port);
      s.write('CONNECT public.s03.test:443 HTTP/1.1\r\nHost: x\r\n\r\n');
      const resp = await readUntil(s, () => false);
      assert.match(resp, /^HTTP\/1\.1 502/);
      s.destroy();
      assert.equal(publicL.hits.length, 0);
    } finally {
      await gateway.close();
      await publicL.close();
    }
  });
});

describe('log cap and close', () => {
  test('log is capped at maxEntries and flags truncation', T, async () => {
    const fx = await makeFixture({ gateway: { maxEntries: 2 } });
    try {
      for (let i = 0; i < 4; i++)
        await proxied(fx.proxyPort, `http://public.s03.test/cap${i}`);
      assert.equal(fx.gateway.log.length, 2);
      assert.equal(fx.gateway.logTruncated, true);
      assert.equal(fx.gateway.log[0].seq, 1);
      assert.equal(fx.gateway.log[1].seq, 2);
    } finally {
      await fx.close();
    }
  });

  test(
    'close() destroys live tunnels, is idempotent, and refuses new connections',
    T,
    async () => {
      const fx = await makeFixture();
      const s = await connectRaw(fx.proxyPort);
      s.write('CONNECT public.s03.test:80 HTTP/1.1\r\nHost: x\r\n\r\n');
      await readUntil(s, (b) => b.includes('\r\n\r\n'));
      const closed = new Promise((resolve) =>
        s.once('close', () => resolve(undefined)),
      );
      const { port } =
        fx.gateway.address() && typeof fx.gateway.address() !== 'string'
          ? /** @type {net.AddressInfo} */ (fx.gateway.address())
          : { port: 0 };
      await Promise.all([fx.gateway.close(), fx.gateway.close()]);
      await closed; // the tunnel client socket was destroyed by close()
      await assert.rejects(() => connectRaw(port));
      await fx.publicL.close();
      await fx.localL.close();
    },
  );
});

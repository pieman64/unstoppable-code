import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createCanaryServer } from './canary-server.mjs';

/**
 * @param {string} origin
 * @param {{ method?: string, path: string, headers?: Record<string, string>, body?: string }} options
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function request(origin, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      origin + path,
      { method, headers, agent: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('canary server', () => {
  const server = createCanaryServer({ role: 'local-canary' });
  /** @type {string} */
  let origin;
  before(async () => {
    ({ origin } = await server.listen(0, '127.0.0.1'));
  });
  after(() => server.close());

  it('exposes its role and a loopback origin', () => {
    assert.equal(server.role, 'local-canary');
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('serves /hit/<nonce> with canary body and CORS, recording the hit', async () => {
    server.reset();
    const res = await request(origin, { path: '/hit/abc_DEF-1' });
    assert.equal(res.status, 200);
    assert.equal(res.body, 'canary:local-canary:abc_DEF-1');
    assert.match(String(res.headers['content-type']), /^text\/plain/);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.equal(res.headers['cache-control'], 'no-store');
    const hits = server.hitsFor('abc_DEF-1');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].role, 'local-canary');
    assert.equal(hits[0].method, 'GET');
    assert.equal(hits[0].path, '/hit/abc_DEF-1');
    assert.equal(hits[0].via, 'http');
    assert.equal(hits[0].host, origin.replace('http://', ''));
    assert.equal(typeof hits[0].at, 'number');
    assert.equal(typeof hits[0].seq, 'number');
  });

  it('accepts POST and HEAD on /hit/<nonce>', async () => {
    server.reset();
    const post = await request(origin, {
      method: 'POST',
      path: '/hit/p1',
      body: 'payload',
    });
    assert.equal(post.status, 200);
    const head = await request(origin, { method: 'HEAD', path: '/hit/h1' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.deepEqual(
      server.hits().map((h) => [h.method, h.nonce]),
      [
        ['POST', 'p1'],
        ['HEAD', 'h1'],
      ],
    );
  });

  it('answers OPTIONS preflight with 204 and permissive CORS, and records it', async () => {
    server.reset();
    const res = await request(origin, {
      method: 'OPTIONS',
      path: '/hit/pre1',
      headers: {
        Origin: 'http://example.invalid',
        'Access-Control-Request-Method': 'POST',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    assert.match(String(res.headers['access-control-allow-methods']), /POST/);
    assert.equal(server.hitsFor('pre1')[0].method, 'OPTIONS');
  });

  it('serves /hit/<nonce>.js as javascript', async () => {
    const res = await request(origin, { path: '/hit/w1.js' });
    assert.equal(res.status, 200);
    assert.match(
      String(res.headers['content-type']),
      /^application\/javascript/,
    );
    assert.equal(res.body, "self.__s03CanaryLoaded = 'local-canary';");
    assert.equal(server.hitsFor('w1').length, 1);
  });

  it('parses ?n=<nonce> and records 404s (valid and invalid nonces)', async () => {
    server.reset();
    const res = await request(origin, { path: '/nope?n=q-1' });
    assert.equal(res.status, 404);
    assert.equal(server.hitsFor('q-1').length, 1);
    await request(origin, { path: '/nope2?n=bad%20nonce!' });
    await request(origin, { path: '/hit/bad.nonce' });
    await request(origin, { path: `/hit/${'a'.repeat(65)}` });
    const hits = server.hits();
    assert.equal(hits.length, 4);
    assert.deepEqual(
      hits.map((h) => h.nonce),
      ['q-1', null, null, null],
    );
    assert.deepEqual(
      hits.map((h) => h.path),
      ['/nope', '/nope2', '/hit/bad.nonce', `/hit/${'a'.repeat(65)}`],
    );
  });

  it('serves downloads with attachment headers and 16 synthetic bytes', async () => {
    const res = await request(origin, { path: '/download/dl_9.bin' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(
      res.headers['content-disposition'],
      'attachment; filename="s03-dl_9.bin"',
    );
    assert.equal(Buffer.byteLength(res.body, 'latin1'), 16);
    assert.equal(res.headers['content-length'], '16');
    assert.equal(server.hitsFor('dl_9').length, 1);
  });

  it('serves /__probe/hits as JSON including earlier hits', async () => {
    server.reset();
    await request(origin, { path: '/hit/j1' });
    const res = await request(origin, { path: '/__probe/hits' });
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /^application\/json/);
    assert.equal(res.headers['access-control-allow-origin'], '*');
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.role, 'local-canary');
    assert.ok(
      parsed.hits.some((h) => h.nonce === 'j1' && h.path === '/hit/j1'),
    );
  });

  it('validates and issues redirects', async () => {
    const target = 'http://127.0.0.1:1/hit/r1';
    for (const code of [301, 302, 303, 307, 308]) {
      const res = await request(origin, {
        path: `/redirect?to=${encodeURIComponent(target)}&code=${code}`,
      });
      assert.equal(res.status, code);
      assert.equal(res.headers.location, target);
    }
    const dflt = await request(origin, {
      path: `/redirect?to=${encodeURIComponent(target)}`,
    });
    assert.equal(dflt.status, 302);
    const ws = await request(origin, {
      path: `/redirect?to=${encodeURIComponent('ws://127.0.0.1:1/ws/x')}`,
    });
    assert.equal(ws.status, 302);

    const bad = [
      '/redirect',
      '/redirect?to=',
      `/redirect?to=${encodeURIComponent('javascript:alert(1)')}`,
      `/redirect?to=${encodeURIComponent('file:///etc/hosts')}`,
      `/redirect?to=${encodeURIComponent('not a url')}`,
      `/redirect?to=${encodeURIComponent('http://x.invalid/' + 'a'.repeat(2050))}`,
      `/redirect?to=${encodeURIComponent(target)}&code=200`,
      `/redirect?to=${encodeURIComponent(target)}&code=abc`,
    ];
    for (const path of bad) {
      const res = await request(origin, { path });
      assert.equal(res.status, 400, path.slice(0, 60));
      assert.equal(res.headers.location, undefined);
    }
  });

  it('404s everything else and rejects unsupported methods on known routes', async () => {
    assert.equal((await request(origin, { path: '/' })).status, 404);
    assert.equal((await request(origin, { path: '/etc/passwd' })).status, 404);
    assert.equal((await request(origin, { path: '/ws/x1' })).status, 404); // no upgrade
    assert.equal(
      (await request(origin, { method: 'PUT', path: '/hit/x2' })).status,
      405,
    );
    assert.equal(server.hitsFor('x2').length, 1);
  });

  it('rejects over-cap request bodies', async () => {
    const res = await request(origin, {
      method: 'POST',
      path: '/hit/big',
      body: 'x'.repeat(200 * 1024),
    }).catch((err) => ({ status: -1, err }));
    // Either a clean 413 or a reset connection is acceptable; it must not be 200.
    assert.notEqual(res.status, 200);
  });

  it('completes a minimal RFC6455 handshake and sends one text frame', async () => {
    server.reset();
    const port = Number(new URL(origin).port);
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    const { head, frame, closeFrame } = await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      let buf = Buffer.alloc(0);
      let headText = null;
      let frame = null;
      const fail = setTimeout(() => {
        socket.destroy();
        reject(new Error('websocket test timeout'));
      }, 6000);
      socket.on('connect', () => {
        socket.write(
          `GET /ws/wsn1 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (headText === null) {
          const end = buf.indexOf('\r\n\r\n');
          if (end === -1) return;
          headText = buf.subarray(0, end).toString('latin1');
          buf = buf.subarray(end + 4);
        }
        if (frame === null && buf.length >= 2 && buf.length >= 2 + buf[1]) {
          frame = buf.subarray(0, 2 + buf[1]);
          buf = buf.subarray(2 + buf[1]);
        }
        if (frame !== null && buf.length >= 4) {
          clearTimeout(fail);
          socket.destroy();
          resolve({ head: headText, frame, closeFrame: buf.subarray(0, 4) });
        }
      });
      socket.on('error', reject);
    });
    assert.match(head, /^HTTP\/1\.1 101 /);
    assert.match(head, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/i);
    assert.equal(frame[0], 0x81); // FIN + text, unmasked
    assert.equal(
      frame.subarray(2).toString('utf8'),
      'canary:local-canary:wsn1',
    );
    assert.deepEqual([...closeFrame], [0x88, 0x02, 0x03, 0xe8]); // server close after ~2 s
    const hits = server.hitsFor('wsn1');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].via, 'websocket');
    assert.equal(hits[0].path, '/ws/wsn1');
  });

  it('rejects malformed or misrouted upgrades but still records them', async () => {
    server.reset();
    const port = Number(new URL(origin).port);
    /** @param {string} path @param {string} extra */
    const upgrade = (path, extra) =>
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        let out = '';
        socket.on('connect', () =>
          socket.write(
            `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${extra}\r\n`,
          ),
        );
        socket.on('data', (c) => (out += c.toString('latin1')));
        socket.on('close', () => resolve(out));
        socket.on('error', reject);
      });
    const noKey = await upgrade('/ws/bad1', 'Sec-WebSocket-Version: 13\r\n');
    assert.match(noKey, /^HTTP\/1\.1 400 /);
    const wrongPath = await upgrade(
      '/elsewhere?n=bad2',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n',
    );
    assert.match(wrongPath, /^HTTP\/1\.1 404 /);
    assert.equal(server.hitsFor('bad1')[0].via, 'websocket');
    assert.equal(server.hitsFor('bad2')[0].via, 'websocket');
  });

  it('caps the hit log at 5000 entries', async () => {
    server.reset();
    const port = Number(new URL(origin).port);
    // Fast sequential keep-alive requests.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      for (let i = 0; i < 5010; i += 1) {
        await new Promise((resolve, reject) => {
          http
            .get(
              { host: '127.0.0.1', port, path: `/hit/c${i}`, agent },
              (res) => {
                res.resume();
                res.on('end', resolve);
              },
            )
            .on('error', reject);
        });
      }
    } finally {
      agent.destroy();
    }
    const hits = server.hits();
    assert.equal(hits.length, 5000);
    assert.equal(hits[0].nonce, 'c10');
    assert.equal(hits.at(-1)?.nonce, 'c5009');
  });
});

describe('canary server lifecycle', () => {
  it('rejects invalid roles', () => {
    assert.throws(() => createCanaryServer({ role: '' }), TypeError);
    assert.throws(() => createCanaryServer({ role: 'has space' }), TypeError);
  });

  it('refuses non-loopback hosts', async () => {
    const server = createCanaryServer({ role: 'x' });
    for (const host of [
      '0.0.0.0',
      '::',
      '192.168.1.5',
      '10.0.0.1',
      'localhost',
      'example.com',
      '',
    ]) {
      await assert.rejects(server.listen(0, host), /loopback|explicit/, host);
    }
    await server.close();
  });

  it('close() is idempotent, destroys open sockets, and blocks re-listen', async () => {
    const server = createCanaryServer({ role: 'y' });
    const { port } = await server.listen(0, '127.0.0.1');
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise((resolve) => socket.on('connect', resolve));
    const closed = new Promise((resolve) => socket.on('close', resolve));
    await Promise.all([server.close(), server.close()]);
    await closed;
    await server.close();
    await assert.rejects(server.listen(0, '127.0.0.1'), /closed/);
  });

  it('close() also destroys an in-flight websocket and its timers', async () => {
    const server = createCanaryServer({ role: 'z' });
    const { port } = await server.listen(0, '127.0.0.1');
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise((resolve) => socket.on('connect', resolve));
    const gotFrame = new Promise((resolve) => socket.once('data', resolve));
    socket.write(
      `GET /ws/life HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    );
    await gotFrame;
    const closed = new Promise((resolve) => socket.on('close', resolve));
    await server.close();
    await closed;
  });

  it('supports IPv6 loopback when available', async (t) => {
    const server = createCanaryServer({ role: 'v6' });
    try {
      const { origin } = await server.listen(0, '::1');
      assert.match(origin, /^http:\/\/\[::1\]:\d+$/);
    } catch (err) {
      t.skip(`IPv6 loopback unavailable: ${err.code ?? err.message}`);
    } finally {
      await server.close();
    }
  });
});

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import vm from 'node:vm';
import { VECTOR_IDS, createVectorServer, safeJson } from './vector-server.mjs';

/**
 * @param {string} origin
 * @param {{ method?: string, path: string }} options
 * @returns {Promise<{ status: number, headers: http.IncomingHttpHeaders, body: string }>}
 */
function request(origin, { method = 'GET', path }) {
  return new Promise((resolve, reject) => {
    const req = http.request(origin + path, { method, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('latin1'),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/** @param {string} html */
function extractScript(html) {
  const match = /<script>\n([\s\S]*)\n<\/script><\/body><\/html>$/.exec(html);
  assert.ok(match, 'page has exactly one trailing inline script');
  return match[1];
}

/**
 * Execute a vector page script in a stubbed vm context (no browser involved).
 * @param {string} html
 * @param {Record<string, unknown>} [stubs]
 */
function runPage(html, stubs = {}) {
  const dataset = {};
  const appended = [];
  const makeElement = (tag) => ({
    tag,
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    click() {},
    submit() {},
    appendChild() {},
  });
  const ctx = {
    document: {
      documentElement: { dataset },
      body: { appendChild: (n) => appended.push(n) },
      createElement: makeElement,
    },
    setTimeout,
    clearTimeout,
    Promise,
    encodeURIComponent,
    navigator: {},
    addEventListener() {},
    ...stubs,
  };
  ctx.window = ctx;
  vm.runInNewContext(extractScript(html), ctx);
  return { ctx, dataset, appended };
}

/** Normalise objects created inside a vm context so deepEqual ignores realms. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const nextTick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('vector server', () => {
  const server = createVectorServer();
  /** @type {string} */
  let origin;
  before(async () => {
    ({ origin } = await server.listen(0, '127.0.0.1'));
  });
  after(() => server.close());

  const page = (id, query = '') =>
    request(origin, { path: `/s03/vector/${id}?${query}` });
  const enc = encodeURIComponent;

  it('lists the expected vector ids', () => {
    assert.deepEqual(
      [...VECTOR_IDS],
      [
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
      ],
    );
  });

  for (const id of VECTOR_IDS) {
    it(`serves the ${id} vector as HTML that compiles and reports pending then done`, async () => {
      const target = 'http://127.0.0.1:9/hit/abc';
      const res = await page(id, `target=${enc(target)}&n=n1`);
      assert.equal(res.status, 200);
      assert.match(String(res.headers['content-type']), /^text\/html/);
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.ok(
        res.body.includes(safeJson(target)),
        'embeds the JSON-escaped target',
      );
      assert.ok(res.body.includes(`vectorId":"${id}"`));
      assert.equal(res.body.split('</script>').length - 1, 1);
      const script = extractScript(res.body);
      assert.doesNotThrow(
        () => new vm.Script(script, { filename: `${id}.js` }),
      );
      assert.ok(script.includes("state: 'pending'"));
      assert.ok(script.includes("state: 'done'"));
      assert.ok(script.includes('dataset.s03State'));
    });
  }

  it('escapes hostile targets so they cannot break out of the script', async () => {
    const hostile =
      '</script><script>alert(1)</script><img src=x onerror=alert(2)>"\'\u2028&';
    for (const id of VECTOR_IDS) {
      const res = await page(id, `target=${enc(hostile)}&n=n2`);
      assert.equal(res.status, 200);
      assert.ok(!res.body.includes('</script><script>'), id);
      assert.ok(!res.body.includes('<img'), id);
      assert.equal(res.body.split('</script>').length - 1, 1, id);
      assert.ok(
        res.body.includes('\\u003c/script\\u003e\\u003cscript\\u003ealert(1)'),
        id,
      );
      // The escaped JSON round-trips to the original string.
      const cfgLine = /var cfg = (.*);/.exec(res.body);
      assert.equal(JSON.parse(cfgLine[1]).target, hostile, id);
    }
  });

  it('rejects invalid nonces, oversized targets, and missing parameters with 400', async () => {
    const t = `target=${enc('http://127.0.0.1:9/')}`;
    assert.equal((await page('fetch', `${t}&n=bad%20nonce`)).status, 400);
    assert.equal((await page('fetch', `${t}&n=${'a'.repeat(65)}`)).status, 400);
    assert.equal((await page('fetch', `${t}&n=`)).status, 400);
    assert.equal((await page('fetch', t)).status, 400);
    assert.equal((await page('fetch', 'n=ok')).status, 400);
    assert.equal(
      (
        await page(
          'fetch',
          `target=${enc(`http://x/${'a'.repeat(2048)}`)}&n=ok`,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await page(
          'fetch',
          `target=${enc(`http://x/${'a'.repeat(2000)}`)}&n=ok`,
        )
      ).status,
      200,
    );
    assert.equal((await page('fetch', `${t}&n=ok&deadline=5`)).status, 400);
    assert.equal((await page('fetch', `${t}&n=ok&deadline=99999`)).status, 400);
    assert.equal((await page('fetch', `${t}&n=ok&manual=2`)).status, 400);
    assert.equal(
      (await page('fetch', `${t}&n=ok&only=notifications`)).status,
      400,
    );
    assert.equal((await page('permissions', 'n=ok&only=bogus')).status, 400);
  });

  it('allows target-less pages only for file-chooser, permissions, and device-chooser', async () => {
    for (const id of ['file-chooser', 'permissions', 'device-chooser']) {
      assert.equal((await page(id, 'n=ok')).status, 200, id);
    }
    assert.equal((await page('websocket', 'n=ok')).status, 400);
  });

  it('404s unknown vectors, unknown paths, and anything outside /s03/', async () => {
    assert.equal((await page('nonesuch', 'target=x&n=a')).status, 404);
    assert.equal((await request(origin, { path: '/' })).status, 404);
    assert.equal((await request(origin, { path: '/etc/passwd' })).status, 404);
    assert.equal((await request(origin, { path: '/s03/' })).status, 404);
    assert.equal((await request(origin, { path: '/s03/vector/' })).status, 404);
    assert.equal(
      (await request(origin, { path: '/s03/%2e%2e/secret' })).status,
      404,
    );
    assert.equal(
      (await request(origin, { path: '/s03/worker/other.js' })).status,
      404,
    );
    assert.equal(
      (await request(origin, { path: '/s03/sw-scope/n1/other' })).status,
      404,
    );
  });

  it('rejects non-GET methods on pages', async () => {
    assert.equal(
      (
        await request(origin, {
          method: 'POST',
          path: '/s03/vector/fetch?target=x&n=a',
        })
      ).status,
      405,
    );
    assert.equal(
      (await request(origin, { method: 'HEAD', path: '/s03/blank' })).status,
      200,
    );
  });

  it('serves worker and service-worker scripts as JavaScript', async () => {
    const q = `target=${enc('ws://127.0.0.1:9/ws/x')}&n=s1`;
    for (const path of [
      '/s03/worker/dedicated.js',
      '/s03/worker/shared.js',
      '/s03/sw.js',
      '/s03/sw-intercept.js',
    ]) {
      const res = await request(origin, { path: `${path}?${q}` });
      assert.equal(res.status, 200, path);
      assert.match(
        String(res.headers['content-type']),
        /^application\/javascript/,
        path,
      );
      assert.doesNotThrow(
        () => new vm.Script(res.body, { filename: path }),
        path,
      );
      assert.equal(
        (await request(origin, { path })).status,
        400,
        `${path} without target`,
      );
    }
    const sw = await request(origin, { path: `/s03/sw.js?${q}` });
    assert.ok(sw.body.includes("addEventListener('activate'"));
    assert.ok(sw.body.includes('event.waitUntil'));
    assert.ok(sw.body.includes("includeUncontrolled: true, type: 'window'"));
    const intercept = await request(origin, {
      path: `/s03/sw-intercept.js?${q}`,
    });
    assert.ok(intercept.body.includes("addEventListener('fetch'"));
    assert.ok(intercept.body.includes('respondWith(fetch(target'));
  });

  it('serves blank, nav-result, scope page, and proxy fallback', async () => {
    const blank = await request(origin, { path: '/s03/blank' });
    assert.equal(blank.status, 200);
    assert.match(blank.body, /<html>/);

    const nav = await request(origin, { path: '/s03/nav-result?n=nav1' });
    assert.equal(nav.status, 200);
    const { ctx, dataset } = runPage(nav.body);
    assert.deepEqual(plain(ctx.window.__s03Result), {
      vectorId: 'nav-result',
      nonce: 'nav1',
      state: 'done',
      outcome: 'navigated',
      detail: '',
    });
    assert.equal(dataset.s03State, 'done');
    assert.equal(
      (await request(origin, { path: '/s03/nav-result' })).status,
      400,
    );
    assert.equal(
      (await request(origin, { path: '/s03/nav-result?n=a%20b' })).status,
      400,
    );

    const scope = await request(origin, { path: '/s03/sw-scope/nn_1/page' });
    assert.equal(scope.status, 200);
    assert.match(scope.body, /fetch\('\.\/proxy'/);
    assert.ok(scope.body.includes('"nn_1"'));
    assert.doesNotThrow(() => new vm.Script(extractScript(scope.body)));
    const proxy = await request(origin, { path: '/s03/sw-scope/nn_1/proxy' });
    assert.equal(proxy.status, 404); // reached only when the SW is not intercepting
    assert.equal(proxy.body, 'sw-not-intercepting');
  });

  it('serves synthetic downloads as attachments', async () => {
    const res = await request(origin, { path: '/s03/download/d_1.bin' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.equal(
      res.headers['content-disposition'],
      'attachment; filename="s03-d_1.bin"',
    );
    assert.equal(res.headers['content-length'], '16');
  });

  it('issues validated redirects at /s03/redirect', async () => {
    const to = 'http://127.0.0.1:9/hit/r1';
    const ok = await request(origin, {
      path: `/s03/redirect?to=${enc(to)}&code=307`,
    });
    assert.equal(ok.status, 307);
    assert.equal(ok.headers.location, to);
    assert.equal(
      (await request(origin, { path: `/s03/redirect?to=${enc(to)}` })).status,
      302,
    );
    assert.equal(
      (await request(origin, { path: `/s03/redirect?to=${enc('ftp://x/')}` }))
        .status,
      400,
    );
    assert.equal(
      (await request(origin, { path: `/s03/redirect?to=${enc(to)}&code=200` }))
        .status,
      400,
    );
    assert.equal(
      (await request(origin, { path: '/s03/redirect' })).status,
      400,
    );
    assert.equal(
      (
        await request(origin, {
          path: `/s03/redirect?to=${enc(`http://x/${'a'.repeat(2050)}`)}`,
        })
      ).status,
      400,
    );
  });

  it('records requests (method, path, nonce) without the target', async () => {
    server.reset();
    await page(
      'fetch',
      `target=${enc('http://127.0.0.1:9/secret-ish')}&n=log1`,
    );
    await request(origin, { path: '/nope' });
    const log = server.requests();
    assert.deepEqual(
      log.map((r) => [r.method, r.path, r.nonce]),
      [
        ['GET', '/s03/vector/fetch', 'log1'],
        ['GET', '/nope', null],
      ],
    );
    assert.ok(!JSON.stringify(log).includes('secret-ish'));
  });

  describe('manual=1 (armed) pages', () => {
    it('contain the arming path for every vector', async () => {
      for (const id of VECTOR_IDS) {
        const res = await page(
          id,
          `target=${enc('http://127.0.0.1:9/')}&n=m1&manual=1`,
        );
        assert.equal(res.status, 200, id);
        const script = extractScript(res.body);
        assert.ok(script.includes('"manual":true'), id);
        assert.ok(script.includes('window.__s03Run = function'), id);
        assert.ok(script.includes("state: 'armed'"), id);
        assert.ok(script.includes("setState('armed')"), id);
        assert.doesNotThrow(() => new vm.Script(script), id);
      }
      const auto = await page(
        'fetch',
        `target=${enc('http://127.0.0.1:9/')}&n=m1&manual=0`,
      );
      assert.ok(auto.body.includes('"manual":false'));
    });

    it('arms without running, runs once on __s03Run(), and starts the deadline then', async () => {
      const res = await page(
        'fetch',
        `target=${enc('http://127.0.0.1:9/')}&n=m2&manual=1&deadline=100`,
      );
      const calls = [];
      const { ctx, dataset } = runPage(res.body, {
        fetch: (url, init) => {
          calls.push([url, init.mode]);
          return new Promise(() => {}); // never settles: the deadline must end it
        },
      });
      assert.deepEqual(plain(ctx.window.__s03Result), {
        vectorId: 'fetch',
        nonce: 'm2',
        state: 'armed',
      });
      assert.equal(dataset.s03State, 'armed');
      assert.equal(calls.length, 0);
      await nextTick(150); // would already be past the deadline if it had started at load
      assert.equal(ctx.window.__s03Result.state, 'armed');

      ctx.window.__s03Run();
      assert.equal(ctx.window.__s03Result.state, 'pending');
      assert.equal(dataset.s03State, 'pending');
      assert.equal(calls.length, 1);
      ctx.window.__s03Run(); // idempotent
      assert.equal(calls.length, 1);
      await nextTick(200);
      assert.equal(ctx.window.__s03Result.state, 'done');
      assert.equal(ctx.window.__s03Result.outcome, 'timeout');
      assert.equal(dataset.s03State, 'done');
      ctx.window.__s03Run();
      assert.equal(calls.length, 1);
    });

    it('auto pages run immediately and expose the same idempotent __s03Run', async () => {
      const res = await page(
        'fetch',
        `target=${enc('http://127.0.0.1:9/x')}&n=a1`,
      );
      let count = 0;
      const { ctx, dataset } = runPage(res.body, {
        fetch: () => {
          count += 1;
          return Promise.resolve({ status: 200 });
        },
      });
      assert.equal(count, 1);
      assert.equal(dataset.s03State, 'pending');
      assert.deepEqual(plain(ctx.window.__s03Result), {
        vectorId: 'fetch',
        nonce: 'a1',
        state: 'pending',
      });
      await nextTick();
      assert.equal(ctx.window.__s03Result.outcome, 'resolved:200');
      ctx.window.__s03Run();
      assert.equal(count, 1);
    });
  });

  describe('page behaviour under stubs', () => {
    it('fetch and xhr-post map resolutions and rejections to outcome strings', async () => {
      const t = `target=${enc('http://127.0.0.1:9/x')}&n=f1`;
      const inits = [];
      let res = await page('fetch', t);
      let run = runPage(res.body, {
        fetch: (_u, init) => (
          inits.push(init),
          Promise.resolve({ status: 204 })
        ),
      });
      await nextTick();
      assert.equal(run.ctx.window.__s03Result.outcome, 'resolved:204');
      assert.deepEqual(plain(inits[0]), { mode: 'cors', cache: 'no-store' });

      res = await page('xhr-post', t);
      run = runPage(res.body, {
        fetch: (_u, init) => (
          inits.push(init),
          Promise.reject(
            Object.assign(new Error('Failed to fetch'), { name: 'TypeError' }),
          )
        ),
      });
      await nextTick();
      assert.equal(run.ctx.window.__s03Result.outcome, 'rejected:TypeError');
      assert.equal(inits[1].method, 'POST');
      assert.equal(inits[1].body, 'x');
    });

    it('websocket reports message / error / open-without-message', async () => {
      const t = `target=${enc('ws://127.0.0.1:9/ws/x')}&n=w1`;
      const res = await page('websocket', t);
      for (const [trigger, expected] of [
        [(ws) => ws.onmessage({ data: 'SHOULD-NOT-APPEAR' }), 'message'],
        [(ws) => ws.onerror(), 'error'],
        [(ws) => ws.onclose({ code: 1006 }), 'close:1006'],
      ]) {
        let instance;
        function FakeWebSocket(url) {
          instance = { url, close() {} };
          return instance;
        }
        const run = runPage(res.body, { WebSocket: FakeWebSocket });
        assert.equal(instance.url, 'ws://127.0.0.1:9/ws/x');
        trigger(instance);
        assert.equal(run.ctx.window.__s03Result.outcome, expected);
        assert.ok(
          !JSON.stringify(run.ctx.window.__s03Result).includes(
            'SHOULD-NOT-APPEAR',
          ),
        );
      }
    });

    it('permissions: sequential outcomes are joined and clipboard content is dropped', async () => {
      const res = await page('permissions', 'n=p1');
      const secret = 'CLIPBOARD-SECRET-TEXT';
      const { ctx } = runPage(res.body, {
        Notification: { requestPermission: () => Promise.resolve('denied') },
        navigator: {
          permissions: { query: () => Promise.resolve({ state: 'prompt' }) },
          geolocation: { getCurrentPosition: (_ok, fail) => fail({ code: 1 }) },
          clipboard: { readText: () => Promise.resolve(secret) },
          mediaDevices: {
            getUserMedia: () =>
              Promise.reject(
                Object.assign(new Error('nope'), { name: 'NotAllowedError' }),
              ),
          },
        },
      });
      await nextTick(50);
      const result = ctx.window.__s03Result;
      assert.equal(result.state, 'done');
      assert.equal(
        result.outcome,
        'notifications:denied|geo-query:prompt|geo:error:1|clipboard:resolved-content-discarded|media:rejected:NotAllowedError',
      );
      assert.ok(!JSON.stringify(result).includes(secret));
    });

    it('permissions: granted media stops its tracks; only=notifications runs one step', async () => {
      const res = await page('permissions', 'n=p2');
      let stopped = 0;
      const stream = {
        getTracks: () => [
          { stop: () => (stopped += 1) },
          { stop: () => (stopped += 1) },
        ],
      };
      const { ctx } = runPage(res.body, {
        Notification: { requestPermission: () => Promise.resolve('granted') },
        navigator: {
          permissions: { query: () => Promise.resolve({ state: 'granted' }) },
          geolocation: {
            getCurrentPosition: (ok) =>
              ok({ coords: { latitude: 1, longitude: 2 } }),
          },
          clipboard: {
            readText: () =>
              Promise.reject(
                Object.assign(new Error('x'), { name: 'NotAllowedError' }),
              ),
          },
          mediaDevices: { getUserMedia: () => Promise.resolve(stream) },
        },
      });
      await nextTick(50);
      assert.equal(
        ctx.window.__s03Result.outcome,
        'notifications:granted|geo-query:granted|geo:granted|clipboard:rejected:NotAllowedError|media:granted',
      );
      assert.equal(stopped, 2);
      assert.ok(!JSON.stringify(ctx.window.__s03Result).includes('latitude'));

      const only = await page('permissions', 'n=p3&only=notifications');
      assert.ok(only.body.includes('"only":["notifications"]'));
      const control = runPage(only.body, {
        Notification: { requestPermission: () => Promise.resolve('default') },
      });
      await nextTick(20);
      assert.equal(
        control.ctx.window.__s03Result.outcome,
        'notifications:default',
      );
    });

    it('permissions: a hung call times out per call (1.5 s) and is reported', async () => {
      const res = await page(
        'permissions',
        'n=p4&only=notifications&deadline=3000',
      );
      const { ctx } = runPage(res.body, {
        Notification: { requestPermission: () => new Promise(() => {}) },
      });
      await nextTick(1700);
      assert.equal(ctx.window.__s03Result.outcome, 'notifications:timeout');
    });

    it('permissions: the page deadline reports partial results with a trailing timeout', async () => {
      const res = await page('permissions', 'n=p5&deadline=200');
      const { ctx } = runPage(res.body, {
        Notification: { requestPermission: () => Promise.resolve('denied') },
        navigator: { permissions: { query: () => new Promise(() => {}) } },
      });
      await nextTick(300);
      assert.equal(
        ctx.window.__s03Result.outcome,
        'notifications:denied|timeout',
      );
    });

    it('file-chooser never reads files and times out when nothing happens', async () => {
      const res = await page('file-chooser', 'n=fc1&deadline=100');
      let input;
      const { ctx } = runPage(res.body, {
        document: {
          documentElement: { dataset: {} },
          body: { appendChild() {} },
          createElement() {
            input = {
              listeners: {},
              files: { length: 2 },
              addEventListener(t, f) {
                this.listeners[t] = f;
              },
              click() {},
            };
            return input;
          },
        },
      });
      assert.equal(input.type, 'file');
      assert.equal(input.id, 's03-file');
      input.listeners.change();
      assert.equal(ctx.window.__s03Result.outcome, 'change:2');
      assert.ok(
        !res.body.includes('.files[') &&
          !res.body.includes('FileReader') &&
          !res.body.includes('.files.item'),
      );

      const res2 = await page('file-chooser', 'n=fc2&deadline=100');
      const run2 = runPage(res2.body, {
        document: {
          documentElement: { dataset: {} },
          body: { appendChild() {} },
          createElement: () => ({ addEventListener() {}, click() {} }),
        },
      });
      await nextTick(150);
      assert.equal(run2.ctx.window.__s03Result.outcome, 'timeout');
    });

    it('popup-window-open reports the window.open result', async () => {
      const res = await page(
        'popup-window-open',
        `target=${enc('http://127.0.0.1:9/p')}&n=po1&manual=1`,
      );
      const calls = [];
      const { ctx } = runPage(res.body, {
        open: (url, name) => (calls.push([url, name]), null),
      });
      assert.equal(calls.length, 0);
      ctx.window.__s03Run();
      assert.deepEqual(calls, [['http://127.0.0.1:9/p', '_blank']]);
      assert.equal(ctx.window.__s03Result.outcome, 'returned-null');
    });

    it('device-chooser reports unavailable without navigator.usb', async () => {
      const res = await page('device-chooser', 'n=dc1');
      const { ctx } = runPage(res.body);
      assert.equal(ctx.window.__s03Result.outcome, 'usb:unavailable');
    });

    it('service-worker vectors register with the nonce-scoped path and report failures', async () => {
      for (const id of ['service-worker', 'service-worker-intercept']) {
        const res = await page(
          id,
          `target=${enc('http://127.0.0.1:9/x')}&n=sw1`,
        );
        const calls = [];
        const { ctx } = runPage(res.body, {
          navigator: {
            serviceWorker: {
              register: (url, opts) => (
                calls.push([url, opts]),
                Promise.reject(
                  Object.assign(new Error('x'), { name: 'SecurityError' }),
                )
              ),
            },
          },
        });
        await nextTick();
        assert.equal(calls[0][1].scope, '/s03/sw-scope/sw1/');
        assert.match(
          calls[0][0],
          id === 'service-worker'
            ? /^\/s03\/sw\.js\?target=/
            : /^\/s03\/sw-intercept\.js\?target=/,
        );
        assert.equal(
          ctx.window.__s03Result.outcome,
          'register-rejected:SecurityError',
          id,
        );
      }
    });
  });
});

describe('vector server lifecycle', () => {
  it('refuses non-loopback hosts', async () => {
    const server = createVectorServer();
    for (const host of [
      '0.0.0.0',
      '::',
      '192.168.1.5',
      'localhost',
      'example.com',
      '',
    ]) {
      await assert.rejects(server.listen(0, host), /loopback|explicit/, host);
    }
    await server.close();
  });

  it('close() is idempotent and destroys open sockets', async () => {
    const server = createVectorServer();
    const { port, origin } = await server.listen(0, '127.0.0.1');
    assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const socket = net.connect({ host: '127.0.0.1', port });
    await new Promise((resolve) => socket.on('connect', resolve));
    const closed = new Promise((resolve) => socket.on('close', resolve));
    await Promise.all([server.close(), server.close()]);
    await closed;
    await server.close();
    await assert.rejects(server.listen(0, '127.0.0.1'), /closed/);
  });
});

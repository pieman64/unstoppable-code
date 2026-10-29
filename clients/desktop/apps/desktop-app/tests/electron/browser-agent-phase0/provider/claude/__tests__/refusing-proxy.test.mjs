import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import {
  NO_PROXY_VALUE,
  describeTarget,
  startRefusingProxy,
  summarizeProxyAttempts,
} from '../refusing-proxy.mjs';

test('targets are described without credentials or query strings', () => {
  assert.deepEqual(describeTarget('api.example.invalid:443'), {
    host: 'api.example.invalid',
    port: '443',
    path: null,
    loopback: false,
  });
  const absolute = describeTarget(
    'http://user:secret@api.example.invalid/v1/x?token=abc',
  );
  assert.equal(absolute.host, 'api.example.invalid');
  assert.equal(absolute.path, '/v1/x');
  assert.ok(
    !JSON.stringify(absolute).includes('secret') &&
      !JSON.stringify(absolute).includes('abc'),
  );
  assert.equal(describeTarget('127.0.0.1:9').loopback, true);
  assert.equal(describeTarget('localhost:1').loopback, true);
  assert.equal(NO_PROXY_VALUE, '127.0.0.1,localhost');
});

test('the proxy records CONNECT and absolute-URL requests and answers 403 to both', async () => {
  const proxy = await startRefusingProxy();
  try {
    assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const connectStatus = await new Promise((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1', () =>
        socket.write(
          'CONNECT api.example.invalid:443 HTTP/1.1\r\nHost: api.example.invalid:443\r\n\r\n',
        ),
      );
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('close', () => resolve(data.split('\r\n')[0]));
      socket.on('error', reject);
    });
    assert.equal(connectStatus, 'HTTP/1.1 403 Forbidden');
    const httpStatus = await new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: proxy.port,
          method: 'POST',
          path: 'http://telemetry.example.invalid/v1/event?k=v',
          headers: { host: 'telemetry.example.invalid' },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        },
      );
      request.on('error', reject);
      request.end('body');
    });
    assert.equal(httpStatus, 403);
    const attempts = proxy.attempts();
    assert.equal(attempts.length, 2);
    assert.deepEqual(
      attempts.map((attempt) => [attempt.kind, attempt.host]),
      [
        ['connect', 'api.example.invalid'],
        ['http', 'telemetry.example.invalid'],
      ],
    );
    const summary = proxy.summary();
    assert.equal(summary.total, 2);
    assert.equal(summary.external, 2);
    assert.equal(summary.byHost['api.example.invalid:443'].count, 1);
  } finally {
    await proxy.close();
  }
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = net.connect(proxy.port, '127.0.0.1', resolve);
      socket.on('error', reject);
    }),
  );
});

test('a loopback target arriving at the proxy means NO_PROXY was not honored', () => {
  const summary = summarizeProxyAttempts([
    { kind: 'http', host: '127.0.0.1', port: '5000', loopback: true },
  ]);
  assert.equal(summary.external, 0);
  assert.equal(summary.loopbackViaProxy, 1);
});

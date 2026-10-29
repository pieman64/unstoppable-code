// A loopback HTTP proxy that refuses everything. Passed to the provider as
// HTTP(S)_PROXY with NO_PROXY=127.0.0.1,localhost, so any non-loopback attempt
// is recorded by target and answered 403. It never forwards and never reads a
// request body.
import http from 'node:http';

export const NO_PROXY_VALUE = '127.0.0.1,localhost';
const MAX_TARGET = 256;

function isLoopbackHost(host) {
  const bare = host.startsWith('[') ? host.slice(1, host.indexOf(']')) : host;
  return bare === 'localhost' || bare === '::1' || bare.startsWith('127.');
}

/** Host, port and credential-free path of a CONNECT authority or absolute URL. */
export function describeTarget(raw) {
  const text = String(raw ?? '').slice(0, MAX_TARGET);
  try {
    const url = text.includes('://')
      ? new URL(text)
      : new URL(`http://${text}`);
    return {
      host: url.hostname,
      port: url.port || null,
      path: text.includes('://') ? url.pathname : null,
      loopback: isLoopbackHost(url.hostname),
    };
  } catch {
    return {
      host: null,
      port: null,
      path: null,
      loopback: false,
      unparsed: true,
    };
  }
}

/** Group recorded attempts by host for the report. */
export function summarizeProxyAttempts(attempts) {
  const byHost = {};
  for (const attempt of attempts) {
    const key = `${attempt.host ?? '(unparsed)'}${attempt.port ? `:${attempt.port}` : ''}`;
    byHost[key] ??= { count: 0, loopback: attempt.loopback, kinds: {} };
    byHost[key].count += 1;
    byHost[key].kinds[attempt.kind] =
      (byHost[key].kinds[attempt.kind] ?? 0) + 1;
  }
  return {
    total: attempts.length,
    external: attempts.filter((attempt) => !attempt.loopback).length,
    loopbackViaProxy: attempts.filter((attempt) => attempt.loopback).length,
    byHost,
  };
}

/**
 * @returns {Promise<{ port: number, url: string, attempts: () => object[], summary: () => object, close: () => Promise<void> }>}
 */
export async function startRefusingProxy() {
  const attempts = [];
  const sockets = new Set();
  const record = (kind, raw, method) =>
    attempts.push({
      kind,
      method: method ?? null,
      at: Date.now(),
      ...describeTarget(raw),
    });
  const server = http.createServer((request, response) => {
    record('http', request.url, request.method);
    request.resume();
    response.writeHead(403, {
      'content-type': 'text/plain',
      connection: 'close',
    });
    response.end('Refused by the browser-agent probe proxy.\n');
  });
  server.on('connect', (request, socket) => {
    record('connect', request.url, 'CONNECT');
    socket.on('error', () => {});
    socket.end(
      'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
    );
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Refusing proxy has no port');
  let closing = null;
  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    attempts: () => attempts.map((attempt) => ({ ...attempt })),
    summary: () => summarizeProxyAttempts(attempts),
    close() {
      closing ??= new Promise((resolve) => {
        server.close(() => resolve());
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

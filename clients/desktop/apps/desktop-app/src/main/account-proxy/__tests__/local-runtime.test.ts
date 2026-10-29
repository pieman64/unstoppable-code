import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c } from 'tar';

let root = '';
jest.mock('../../lib/paths', () => ({
  getAccountProxyLocalDir: (): string => join(root, 'local'),
  getAccountProxyLocalRuntimeDir: (): string => join(root, 'local', 'runtime'),
}));

// The sanitized client has no private host runtime catalog.
jest.mock('../runtime-metadata', (): typeof RuntimeMetadata => ({
  ...jest.requireActual<typeof RuntimeMetadata>('../runtime-metadata'),
  getAccountProxyRuntimeArtifact: (): undefined => undefined,
}));

import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type * as RuntimeMetadata from '../runtime-metadata';
import {
  getLocalAccountProxyPort,
  getLocalAccountProxyRuntime,
  pickLocalAccountProxyPort,
  onLocalAccountProxyChanged,
  resetLocalAccountProxyForTests,
  setLocalAccountProxyDepsForTests,
  shutdownLocalAccountProxy,
  startLocalAccountProxy,
  stopLocalAccountProxy,
} from '../local-runtime';

const EXECUTABLE =
  process.platform === 'win32' ? 'cli-proxy-api.exe' : 'cli-proxy-api';

/**
 * Stands in for CLIProxyAPI: reads the config it is given, hashes a
 * plaintext management key the way the real proxy does, answers /healthz and
 * a key-checked management route, and records the environment it saw.
 */
const FAKE_PROXY = `
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const configPath = process.argv[process.argv.indexOf('--config') + 1];
let config = fs.readFileSync(configPath, 'utf8');
const value = (key) => JSON.parse(new RegExp('^\\\\s*' + key + ': (.*)$', 'm').exec(config)[1]);
const port = Number(/^\\s*port: (\\d+)$/m.exec(config)[1]);
const secret = value('secret-key');
let accepted = secret;
if (!secret.startsWith('$2a$')) {
  fs.appendFileSync(path.join(path.dirname(configPath), 'plaintext-starts.log'), 'x\\n');
  config = config.replace(JSON.stringify(secret), JSON.stringify('$2a$10$' + 'h'.repeat(53)));
  fs.writeFileSync(configPath, config);
  fs.writeFileSync(path.join(path.dirname(configPath), 'plain.txt'), secret);
} else {
  accepted = fs.readFileSync(path.join(path.dirname(configPath), 'plain.txt'), 'utf8');
}
fs.writeFileSync(path.join(path.dirname(configPath), 'env.json'), JSON.stringify(Object.keys(process.env)));
fs.writeFileSync(path.join(path.dirname(configPath), 'args.json'), JSON.stringify(process.argv.slice(2)));
// Stands in for a proxy whose bind failed but that has not exited yet.
if (fs.existsSync(path.join(path.dirname(configPath), 'no-listen'))) { setInterval(() => undefined, 1000); return; }
const failOnce = path.join(path.dirname(configPath), 'fail-once');
if (fs.existsSync(failOnce)) { fs.unlinkSync(failOnce); process.stderr.write('bind: address already in use\\n'); process.exit(3); }
if (fs.existsSync(path.join(path.dirname(configPath), 'fail'))) { process.stderr.write('bind: address already in use\\n'); process.exit(3); }
http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (req.url.startsWith('/v8/management/')) {
    res.writeHead(req.headers.authorization === 'Bearer ' + accepted ? 200 : 401);
    res.end('{}');
    return;
  }
  res.writeHead(404); res.end();
}).listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
`;

interface Release {
  readonly server: Server;
  /** Holds the download open until released, to stop mid-download. */
  hold: Promise<void> | null;
  url: string;
  readonly archive: Buffer;
  readonly executableSha256: string;
  requests: number;
}

async function serveRelease(): Promise<Release> {
  const staging = join(root, 'staging');
  await mkdir(staging, { recursive: true });
  const executable = `#!${process.execPath}\n${FAKE_PROXY}`;
  await writeFile(join(staging, EXECUTABLE), executable, { mode: 0o700 });
  await writeFile(join(staging, 'README.md'), 'readme');
  await c({ cwd: staging, file: join(root, 'release.tgz'), gzip: true }, [
    EXECUTABLE,
    'README.md',
  ]);
  const archive = await readFile(join(root, 'release.tgz'));
  const release: Release = {
    hold: null,
    server: createServer((_request, response) => {
      release.requests += 1;
      response.writeHead(200);
      void (release.hold ?? Promise.resolve()).then(() =>
        response.end(archive),
      );
    }),
    url: '',
    archive,
    executableSha256: createHash('sha256').update(executable).digest('hex'),
    requests: 0,
  };
  await new Promise<void>((resolve) =>
    release.server.listen(0, '127.0.0.1', resolve),
  );
  const address = release.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  release.url = `http://127.0.0.1:${String(port)}/release.tgz`;
  return release;
}

const LAUNCH = {
  managementKey: 'mk-local-secret',
  clientKey: 'canopy-local-client',
  preferredPort: null,
  routingStrategy: null,
} as const;

let release: Release;

/**
 * Resolves once a start has asked the test release server for the archive,
 * so a stop lands while the download is in flight however slow the host is.
 */
async function downloadStarted(): Promise<void> {
  while (release.requests === 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const releaseArtifact = (): RuntimeMetadata.AccountProxyRuntimeArtifact => ({
  version: '8.0.28',
  url: release.url,
  archive: 'tgz',
  archiveBytes: release.archive.length,
  integrity: `sha512-${createHash('sha512').update(release.archive).digest('base64')}`,
  executableSha256: release.executableSha256,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'account-proxy-local-'));
  resetLocalAccountProxyForTests();
  release = await serveRelease();
  setLocalAccountProxyDepsForTests({
    allowLoopbackDownload: true,
    artifact: releaseArtifact,
  });
});

afterEach(async () => {
  await shutdownLocalAccountProxy();
  delete process.env.ANTHROPIC_API_KEY;
  await new Promise<void>((resolve) => release.server.close(() => resolve()));
  resetLocalAccountProxyForTests();
  await rm(root, { recursive: true, force: true });
});

const describeUnix = process.platform === 'win32' ? describe.skip : describe;

describeUnix('local account proxy runtime', () => {
  it('reports a release that is not downloaded yet', async () => {
    await expect(getLocalAccountProxyRuntime(true)).resolves.toMatchObject({
      phase: 'not-installed',
      version: '8.0.28',
      port: null,
      startWithApp: true,
    });
  });

  it('reports no runtime where no release is published', async () => {
    setLocalAccountProxyDepsForTests({ artifact: () => undefined });
    await expect(getLocalAccountProxyRuntime(false)).resolves.toMatchObject({
      phase: 'unsupported',
      version: null,
    });
    await expect(startLocalAccountProxy(LAUNCH)).rejects.toMatchObject({
      code: 'local-unsupported',
    });
  });

  it('downloads, configures, and starts the proxy on a loopback port', async () => {
    const steps: string[] = [];
    onLocalAccountProxyChanged(() => {
      void getLocalAccountProxyRuntime(true).then((runtime) =>
        steps.push(runtime.phase),
      );
    });
    const port = await startLocalAccountProxy(LAUNCH);
    expect(release.requests).toBe(1);
    await expect(getLocalAccountProxyRuntime(true)).resolves.toMatchObject({
      phase: 'running',
      port,
    });
    const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(health.status).toBe(200);
    const config = await readFile(join(root, 'local', 'config.yaml'), 'utf8');
    expect(config).toContain('host: "127.0.0.1"');
    expect(config).toContain(`port: ${String(port)}`);
    expect(config).toMatch(/discovery:\n\s+enabled: false/);
    expect(config).toContain('allow-remote: false');
    expect(config).toContain('disable-control-panel: true');
    expect(config).toContain(`- "${LAUNCH.clientKey}"`);
    expect(config).toContain('session-affinity: true');
    expect(config).toContain('usage-statistics-enabled: false');
    expect(config).toContain(
      `auth-dir: ${JSON.stringify(join(root, 'local', 'auths'))}`,
    );
    expect((await stat(join(root, 'local', 'config.yaml'))).mode & 0o777).toBe(
      0o600,
    );
    expect((await stat(join(root, 'local', 'auths'))).mode & 0o777).toBe(0o700);
    expect(steps).toContain('installing');
  });

  it('keeps provider keys and other app secrets out of the proxy environment', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak';
    await startLocalAccountProxy(LAUNCH);
    const env: unknown = JSON.parse(
      await readFile(join(root, 'local', 'env.json'), 'utf8'),
    );
    expect(env).not.toContain('ANTHROPIC_API_KEY');
    expect(env).not.toContain('PATH');
    const args: unknown = JSON.parse(
      await readFile(join(root, 'local', 'args.json'), 'utf8'),
    );
    expect(args).toEqual([
      '--config',
      join(root, 'local', 'config.yaml'),
      '--local-model',
    ]);
  });

  it('writes the plaintext management key only until the proxy hashes it', async () => {
    await startLocalAccountProxy(LAUNCH);
    await stopLocalAccountProxy();
    const port = await startLocalAccountProxy(LAUNCH);
    const config = await readFile(join(root, 'local', 'config.yaml'), 'utf8');
    expect(config).not.toContain(LAUNCH.managementKey);
    expect(config).toMatch(/secret-key: "\$2a\$10\$h{53}"/);
    const management = await fetch(
      `http://127.0.0.1:${String(port)}/v8/management/config`,
      { headers: { authorization: `Bearer ${LAUNCH.managementKey}` } },
    );
    expect(management.status).toBe(200);
    // Downloaded once; the second start used the installed release.
    expect(release.requests).toBe(1);
  });

  it('writes the chosen account order into the config on every start', async () => {
    await startLocalAccountProxy(LAUNCH);
    expect(
      await readFile(join(root, 'local', 'config.yaml'), 'utf8'),
    ).not.toContain('strategy:');
    await stopLocalAccountProxy();
    await startLocalAccountProxy({ ...LAUNCH, routingStrategy: 'fill-first' });
    expect(await readFile(join(root, 'local', 'config.yaml'), 'utf8')).toMatch(
      /routing:\n {2}strategy: "fill-first"\n {2}session-affinity: true/,
    );
  });

  it('writes a new key in plaintext when the key changes', async () => {
    await startLocalAccountProxy(LAUNCH);
    await stopLocalAccountProxy();
    await startLocalAccountProxy({ ...LAUNCH, managementKey: 'mk-rotated' });
    const config = await readFile(join(root, 'local', 'config.yaml'), 'utf8');
    // The fake proxy hashed the new key on start, as the real one does.
    expect(config).not.toContain('mk-rotated');
    expect(await readFile(join(root, 'local', 'plain.txt'), 'utf8')).toBe(
      'mk-rotated',
    );
  });

  it('keeps the port sessions already know when it is free', async () => {
    const first = await startLocalAccountProxy(LAUNCH);
    await stopLocalAccountProxy();
    await expect(
      startLocalAccountProxy({ ...LAUNCH, preferredPort: first }),
    ).resolves.toBe(first);
  });

  it('moves to another port when the last one is taken', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, '127.0.0.1', resolve),
    );
    const address = blocker.address();
    const taken = typeof address === 'object' && address ? address.port : 0;
    try {
      const port = await startLocalAccountProxy({
        ...LAUNCH,
        preferredPort: taken,
      });
      expect(port).not.toBe(taken);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });

  it('stops the proxy and reports it stopped', async () => {
    const port = await startLocalAccountProxy(LAUNCH);
    await stopLocalAccountProxy();
    await expect(getLocalAccountProxyRuntime(true)).resolves.toMatchObject({
      phase: 'stopped',
      port: null,
    });
    await expect(
      fetch(`http://127.0.0.1:${String(port)}/healthz`),
    ).rejects.toThrow();
  });

  it('reports why the proxy did not start', async () => {
    await mkdir(join(root, 'local'), { recursive: true });
    await writeFile(join(root, 'local', 'fail'), '');
    const failure = startLocalAccountProxy(LAUNCH);
    await expect(failure).rejects.toThrow('address already in use');
    await expect(failure).rejects.toMatchObject({ code: 'local-failed' });
    const runtime = await getLocalAccountProxyRuntime(true);
    expect(runtime.phase).toBe('error');
    expect(runtime.message).toContain('did not start');
  });

  it('starts nothing that was still queued when the app quit', async () => {
    const start = startLocalAccountProxy(LAUNCH);
    await shutdownLocalAccountProxy();
    await expect(start).rejects.toBeDefined();
    expect(release.requests).toBe(0);
    await expect(getLocalAccountProxyRuntime(true)).resolves.toMatchObject({
      port: null,
    });
  });

  it('does not report a proxy that exited while it answered as running', async () => {
    let killed = false;
    setLocalAccountProxyDepsForTests({
      allowLoopbackDownload: true,
      artifact: releaseArtifact,
      fetch: async (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (killed || !url.endsWith('/healthz')) return fetch(input, init);
        killed = true;
        // The proxy answers, then exits before the answer is read.
        const record = JSON.parse(
          await readFile(join(root, 'local', 'process.json'), 'utf8'),
        ) as { pid: number };
        process.kill(record.pid, 'SIGKILL');
        for (let tries = 0; tries < 100; tries++) {
          try {
            process.kill(record.pid, 0);
          } catch {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response('ok', { status: 200 });
      },
    });
    await expect(startLocalAccountProxy(LAUNCH)).rejects.toMatchObject({
      code: 'local-failed',
    });
    await expect(getLocalAccountProxyRuntime(true)).resolves.toMatchObject({
      port: null,
    });
    expect((await getLocalAccountProxyRuntime(true)).phase).not.toBe('running');
  });

  it('starts again on another port when it loses the port it was given', async () => {
    const first = await startLocalAccountProxy(LAUNCH);
    await stopLocalAccountProxy();
    await writeFile(join(root, 'local', 'fail-once'), '');
    const port = await startLocalAccountProxy({
      ...LAUNCH,
      preferredPort: first,
    });
    expect(port).not.toBe(first);
    const health = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    expect(health.status).toBe(200);
  });

  it('never writes the plaintext key again after clean stops', async () => {
    for (let run = 0; run < 3; run++) {
      await startLocalAccountProxy(LAUNCH);
      await stopLocalAccountProxy();
    }
    const log = await readFile(
      join(root, 'local', 'plaintext-starts.log'),
      'utf8',
    );
    expect(log.trim().split('\n')).toHaveLength(1);
  });

  it('restarts the proxy when its keys change', async () => {
    await startLocalAccountProxy(LAUNCH);
    const port = await startLocalAccountProxy({
      ...LAUNCH,
      managementKey: 'mk-replaced',
    });
    const management = await fetch(
      `http://127.0.0.1:${String(port)}/v8/management/config`,
      { headers: { authorization: 'Bearer mk-replaced' } },
    );
    expect(management.status).toBe(200);
  });

  it('stops the proxy it started when it cannot record it', async () => {
    // A directory where the process record goes makes writing it fail.
    await mkdir(join(root, 'local', 'process.json'), { recursive: true });
    await expect(startLocalAccountProxy(LAUNCH)).rejects.toBeDefined();
    const config = await readFile(join(root, 'local', 'config.yaml'), 'utf8');
    const port = /^\s*port: (\d+)$/m.exec(config)?.[1] ?? '0';
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(
      fetch(`http://127.0.0.1:${port}/healthz`),
    ).rejects.toBeDefined();
  });

  it('takes a port whose probe times out as free', async () => {
    // On Windows a closed loopback port is refused only after SYN retries,
    // so the probe times out instead of being refused.
    let probes = 0;
    setLocalAccountProxyDepsForTests({
      connect: () => {
        probes += 1;
        const socket = Object.assign(new EventEmitter(), {
          setTimeout: (_ms: number, onTimeout: () => void) => {
            setImmediate(onTimeout);
            return socket;
          },
          destroy: () => socket,
        });
        return socket as unknown as Socket;
      },
    });
    await expect(pickLocalAccountProxyPort()).resolves.toEqual(
      expect.any(Number),
    );
    expect(probes).toBe(1);
  });

  it('tells listeners the port is gone before quitting stops the proxy', async () => {
    const port = await startLocalAccountProxy(LAUNCH);
    const seen: Array<{ port: number | null }> = [];
    onLocalAccountProxyChanged(() => {
      seen.push({ port: getLocalAccountProxyPort() });
    });
    await shutdownLocalAccountProxy();
    expect(seen[0]?.port).toBeNull();
    await expect(
      fetch(`http://127.0.0.1:${String(port)}/healthz`),
    ).rejects.toBeDefined();
  });

  it('tells listeners the old port is gone before restarting with new keys', async () => {
    await startLocalAccountProxy(LAUNCH);
    const record = JSON.parse(
      await readFile(join(root, 'local', 'process.json'), 'utf8'),
    ) as { pid: number };
    const alive = (): boolean => {
      try {
        process.kill(record.pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const seen: Array<{ port: number | null; oldAlive: boolean }> = [];
    onLocalAccountProxyChanged(() => {
      seen.push({ port: getLocalAccountProxyPort(), oldAlive: alive() });
    });
    await startLocalAccountProxy({
      ...LAUNCH,
      clientKey: 'canopy-other-client',
    });
    // Heard while the old proxy still held its port.
    expect(seen[0]).toEqual({ port: null, oldAlive: true });
  });

  it('cancels every start queued before a stop', async () => {
    let release_: () => void = () => undefined;
    release.hold = new Promise((resolve) => {
      release_ = resolve;
    });
    const first = startLocalAccountProxy(LAUNCH).catch(() => 'cancelled');
    const second = startLocalAccountProxy(LAUNCH).catch(() => 'cancelled');
    await downloadStarted();
    const stop = stopLocalAccountProxy();
    release_();
    release.hold = null;
    await expect(first).resolves.toBe('cancelled');
    await expect(second).resolves.toBe('cancelled');
    await stop;
    expect(release.requests).toBe(1);
    await expect(getLocalAccountProxyRuntime(true)).resolves.toMatchObject({
      port: null,
    });
  });

  it('does not take another listener on its port for the proxy', async () => {
    await mkdir(join(root, 'local'), { recursive: true });
    await writeFile(join(root, 'local', 'no-listen'), '');
    const requested: string[] = [];
    setLocalAccountProxyDepsForTests({
      allowLoopbackDownload: true,
      artifact: releaseArtifact,
      // Something else answers on the port while the proxy has not bound it.
      fetch: (input, init) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        requested.push(new URL(url).pathname);
        // The release download goes through as usual.
        if (!url.endsWith('/healthz')) return fetch(input, init);
        return Promise.resolve(new Response('ok', { status: 200 }));
      },
    });
    await expect(startLocalAccountProxy(LAUNCH)).rejects.toMatchObject({
      code: 'local-failed',
    });
    expect(requested).toContain('/healthz');
    const runtime = await getLocalAccountProxyRuntime(true);
    expect(runtime.phase).not.toBe('running');
    expect(runtime.port).toBeNull();
  });

  it('stops a start that is still downloading', async () => {
    let release_: () => void = () => undefined;
    release.hold = new Promise((resolve) => {
      release_ = resolve;
    });
    const start = startLocalAccountProxy(LAUNCH);
    await downloadStarted();
    const stop = stopLocalAccountProxy();
    release_();
    await expect(start).rejects.toBeDefined();
    await stop;
    await expect(getLocalAccountProxyRuntime(true)).resolves.toMatchObject({
      phase: 'not-installed',
    });
  });

  it('quitting during a start leaves no proxy running', async () => {
    let release_: () => void = () => undefined;
    release.hold = new Promise((resolve) => {
      release_ = resolve;
    });
    const start = startLocalAccountProxy(LAUNCH).catch(() => null);
    await downloadStarted();
    const quit = shutdownLocalAccountProxy();
    release_();
    await quit;
    expect(await start).toBeNull();
    await expect(
      readFile(join(root, 'local', 'process.json'), 'utf8'),
    ).rejects.toThrow();
  });

  it('refuses a download whose checksum does not match', async () => {
    setLocalAccountProxyDepsForTests({
      allowLoopbackDownload: true,
      artifact: () => ({
        version: '8.0.28',
        url: release.url,
        archive: 'tgz',
        archiveBytes: release.archive.length,
        integrity: `sha512-${Buffer.alloc(64).toString('base64')}`,
        executableSha256: release.executableSha256,
      }),
    });
    const failure = startLocalAccountProxy(LAUNCH);
    await expect(failure).rejects.toThrow('checksum');
    await expect(failure).rejects.toMatchObject({ code: 'local-failed' });
  });

  it('stops a proxy a crashed launch left running, then starts its own', async () => {
    const port = await startLocalAccountProxy(LAUNCH);
    // Forget the child as a crash would, leaving the process and its record.
    resetLocalAccountProxyForTests();
    setLocalAccountProxyDepsForTests({
      allowLoopbackDownload: true,
      artifact: () => ({
        version: '8.0.28',
        url: release.url,
        archive: 'tgz',
        archiveBytes: release.archive.length,
        integrity: `sha512-${createHash('sha512').update(release.archive).digest('base64')}`,
        executableSha256: release.executableSha256,
      }),
    });
    await expect(
      startLocalAccountProxy({ ...LAUNCH, preferredPort: port }),
    ).resolves.toBe(port);
  });

  it('neither signals nor sends a key to a process that is not this proxy', async () => {
    const kill = jest.fn();
    const seen: string[] = [];
    const other = createServer((request, response) => {
      seen.push(request.headers.authorization ?? '');
      response.writeHead(200);
      response.end('{}');
    });
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const address = other.address();
    const otherPort = typeof address === 'object' && address ? address.port : 0;
    try {
      await mkdir(join(root, 'local'), { recursive: true });
      // A record whose process id now belongs to another program.
      await writeFile(
        join(root, 'local', 'process.json'),
        JSON.stringify({
          pid: process.pid,
          port: otherPort,
          managementKeyFingerprint: 'stale',
        }),
      );
      setLocalAccountProxyDepsForTests({
        allowLoopbackDownload: true,
        kill,
        artifact: () => ({
          version: '8.0.28',
          url: release.url,
          archive: 'tgz',
          archiveBytes: release.archive.length,
          integrity: `sha512-${createHash('sha512').update(release.archive).digest('base64')}`,
          executableSha256: release.executableSha256,
        }),
      });
      await startLocalAccountProxy(LAUNCH);
      expect(kill).not.toHaveBeenCalled();
      expect(seen).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => other.close(() => resolve()));
    }
  });
});

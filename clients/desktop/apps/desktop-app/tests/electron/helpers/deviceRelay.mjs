import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../..',
);
const relayDir = path.join(repoRoot, 'apps/device-relay');
const relayEntry = path.join(relayDir, 'dist/main.cjs');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function buildRelay() {
  // The JS API: after a normal install, bin/esbuild is a native binary.
  buildSync({
    absWorkingDir: relayDir,
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'cjs',
    outfile: relayEntry,
    logLevel: 'error',
  });
}

async function waitForHealth(url, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Device relay exited with code ${child.exitCode}`);
    }
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Device relay did not become healthy');
}

/**
 * Runs the real `apps/device-relay` service on a loopback port for a
 * device-to-device remote access spec. Pair it with the mock server's
 * `cloud.deviceRelay` scenario so desktops get tokens it accepts.
 */
export async function startDeviceRelay() {
  buildRelay();
  if (!existsSync(relayEntry)) throw new Error('Device relay bundle missing');
  const port = await freePort();
  const secret = randomBytes(32).toString('hex');
  const output = [];
  const httpUrl = `http://127.0.0.1:${port}`;
  let child = null;

  const spawnRelay = async () => {
    const next = spawn(process.execPath, [relayEntry], {
      env: {
        ...process.env,
        PORT: String(port),
        DEVICE_RELAY_TOKEN_SECRET: secret,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    next.stdout.on('data', (chunk) => output.push(String(chunk)));
    next.stderr.on('data', (chunk) => output.push(String(chunk)));
    child = next;
    await waitForHealth(httpUrl, next);
  };

  const stopRelay = async () => {
    const current = child;
    if (!current || current.exitCode !== null) return;
    current.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        current.kill('SIGKILL');
        resolve();
      }, 5_000);
      current.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  await spawnRelay();
  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    secret,
    output: () => output.join(''),
    /** Kills the relay and starts it again on the same port and secret. */
    async restart(downtimeMs = 0) {
      await stopRelay();
      if (downtimeMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, downtimeMs));
      }
      await spawnRelay();
    },
    stop: stopRelay,
  };
}

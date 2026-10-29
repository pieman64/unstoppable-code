import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { resetScenarios } from '../electron/seeders/index.mjs';
import { SUPERVISOR_GRACE_MS } from './process-tree-supervisor.mjs';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../../..');
const serverEntry = path.join(
  repoRoot,
  'apps/desktop-app/tests/electron/mock-server/start.mjs',
);
const supervisorEntry = path.join(currentDir, 'process-tree-supervisor.mjs');

// The Playwright suite owns 4011 and tears that server down when its command
// exits. Performance verification runs as a subsequent command, so reusing
// 4011 creates a race where the suite can terminate the server after this
// runner's health check. Keep performance ownership on a separate origin.
export const PERFORMANCE_MOCK_BASE_URL = (
  process.env.CANOPY_PERFORMANCE_MOCK_BASE_URL ?? 'http://127.0.0.1:4012'
).replace(/\/+$/, '');

async function isHealthy() {
  try {
    const response = await fetch(`${PERFORMANCE_MOCK_BASE_URL}/healthz`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    delay(SUPERVISOR_GRACE_MS + 1_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
}

export async function resetOwnedMockServer(
  child,
  reset = () => resetScenarios(PERFORMANCE_MOCK_BASE_URL),
) {
  try {
    await reset();
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

export async function ensureMockServer() {
  if (await isHealthy()) {
    await resetScenarios(PERFORMANCE_MOCK_BASE_URL);
    return { reused: true, stop: async () => undefined };
  }

  const child = spawn(process.execPath, [supervisorEntry, serverEntry], {
    detached: true,
    cwd: repoRoot,
    env: {
      ...process.env,
      CANOPY_E2E_OWNER_PID: String(process.pid),
      CANOPY_E2E_MOCK_BASE_URL: PERFORMANCE_MOCK_BASE_URL,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errorOutput = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    errorOutput = `${errorOutput}${chunk}`.slice(-8_000);
  });

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Desktop performance mock server exited (${child.exitCode}): ${errorOutput}`,
      );
    }
    if (await isHealthy()) {
      await resetOwnedMockServer(child);
      return { reused: false, stop: () => stopChild(child) };
    }
    await delay(100);
  }

  await stopChild(child);
  throw new Error(
    `Timed out starting the desktop performance mock server: ${errorOutput}`,
  );
}

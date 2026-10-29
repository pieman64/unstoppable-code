import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { _electron as electron, expect, test } from '@playwright/test';

const workerPath = fileURLToPath(
  new URL(
    '../../../../out-e2e/main/claude-process-host-worker.js',
    import.meta.url,
  ),
);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

test('Windows Claude host shutdown reaps descendants before the utility exits', async () => {
  test.skip(
    process.platform !== 'win32',
    'Windows job-object teardown ordering',
  );
  // Exercise the production utility without the unrelated app UI and shutdown
  // services. No BrowserWindow is created, so this run is always headless.
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CHROME_CRASHPAD_PIPE_NAME;
  const electronApp = await electron.launch({
    executablePath: electronPath,
    args: [
      fileURLToPath(
        new URL(
          './fixtures/claude-process-host-shutdown-main.mjs',
          import.meta.url,
        ),
      ),
    ],
    env,
  });
  const pids = [];
  try {
    const rootScript = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true, stdio: 'ignore', windowsHide: true,
      });
      child.once('spawn', () => process.stdout.write(JSON.stringify({ root: process.pid, descendant: child.pid }) + '\\n'));
      setInterval(() => {}, 1000);
    `;
    const owned = await electronApp.evaluate(
      async ({ utilityProcess }, { workerPath, nodePath, cwd, rootScript }) => {
        const host = utilityProcess.fork(workerPath, [], { stdio: 'pipe' });
        globalThis.shutdownTestHost = host;
        return await new Promise((resolve, reject) => {
          let output = '';
          host.on('message', (message) => {
            if (message.type === 'error') reject(new Error(message.message));
            if (message.type !== 'stdout') return;
            output += Buffer.from(message.dataBase64, 'base64').toString();
            if (output.includes('\n')) resolve(JSON.parse(output.trim()));
          });
          const env = { ...process.env };
          delete env.CHROME_CRASHPAD_PIPE_NAME;
          host.postMessage({
            type: 'spawn',
            requestId: 'owned-tree',
            command: nodePath,
            args: ['-e', rootScript],
            cwd,
            env,
            captureStderr: false,
          });
        });
      },
      {
        workerPath,
        nodePath: process.execPath,
        cwd: path.dirname(workerPath),
        rootScript,
      },
    );
    pids.push(owned.root, owned.descendant);
    expect(pids.every(isAlive)).toBe(true);
    const result = await electronApp.evaluate(async () => {
      const host = globalThis.shutdownTestHost;
      return await new Promise((resolve) => {
        let acknowledged = false;
        host.on('message', (message) => {
          if (message.type === 'shutdown-complete') acknowledged = true;
        });
        host.once('exit', (code) => resolve({ code, acknowledged }));
        host.postMessage({ type: 'shutdown' });
      });
    });
    expect(result).toEqual({ code: 0, acknowledged: true });
    await expect.poll(() => pids.filter(isAlive)).toEqual([]);
  } finally {
    for (const pid of pids.filter(isAlive)) {
      await new Promise((resolve) => {
        execFile(
          'taskkill',
          ['/pid', String(pid), '/t', '/f'],
          { windowsHide: true },
          resolve,
        );
      });
    }
    await electronApp.close();
  }
});

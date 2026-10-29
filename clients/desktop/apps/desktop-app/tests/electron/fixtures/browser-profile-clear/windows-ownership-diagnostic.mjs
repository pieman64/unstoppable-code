// CI diagnostic for the Windows process-ownership gate. No guard is bypassed.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildWindowsProcessTreeListScript } from '../../../performance/process-tree-supervisor.mjs';

if (process.platform !== 'win32') process.exit(0);
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  windowsHide: true,
  stdio: 'ignore',
});
const samples = [];
try {
  for (const timeout of [5000, 30000]) {
    const started = performance.now();
    const sample = { timeout, childPid: child.pid };
    try {
      const { stdout, stderr } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          buildWindowsProcessTreeListScript(),
        ],
        { windowsHide: true, encoding: 'utf8', timeout },
      );
      sample.childRows = stdout
        .split('\n')
        .filter((line) => line.trim().startsWith(`${child.pid}\t`));
      sample.stderr = stderr.slice(0, 4000);
      sample.rowCount = stdout.split('\n').length;
    } catch (error) {
      sample.error = {
        code: error.code,
        signal: error.signal,
        killed: error.killed,
        message: error.message,
        stderr: error.stderr?.slice(0, 4000),
      };
    }
    sample.durationMs = performance.now() - started;
    samples.push(sample);
  }
} finally {
  child.kill();
}
const output = path.resolve(
  '.playwright/browser-profiles/phase-3/windows-ownership-diagnostic.json',
);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ samples }, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ samples })}\n`);

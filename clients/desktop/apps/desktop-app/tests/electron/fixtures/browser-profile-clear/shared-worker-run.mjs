// Run through run-guarded-dev-script.mjs --suite e2e. Not app UI coverage.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const root = await mkdtemp(path.join(tmpdir(), 'browser-profile-clear-'));
const output = path.resolve(
  process.argv[2] ??
    '.playwright/browser-profiles/phase-3/native-shared-workers.json',
);
const evidencePath = path.join(root, 'result.json');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(
  process.env.PROFILE_CLEAR_ELECTRON ?? require('electron'),
  [
    '--use-mock-keychain',
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'shared-workers.cjs',
    ),
    root,
    evidencePath,
  ],
  { env, stdio: ['ignore', 'pipe', 'pipe'] },
);
let log = '';
const append = (chunk) => {
  log = (log + chunk.toString()).slice(-32768);
};
child.stdout.on('data', append);
child.stderr.on('data', append);
const timeout = setTimeout(() => {
  if (process.platform === 'win32')
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
    }).on('error', () => child.kill());
  else child.kill('SIGKILL');
}, 90000);
try {
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  const evidence = JSON.parse(
    await readFile(evidencePath, 'utf8').catch(
      () => '{"error":"No native result"}',
    ),
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(
    output,
    `${JSON.stringify({ ...evidence, exitCode, log }, null, 2)}\n`,
  );
  if (exitCode !== 0 || !evidence.passed) process.exitCode = 1;
  process.stdout.write(
    `${JSON.stringify({
      output,
      passed: evidence.passed ?? false,
      error: evidence.error,
    })}\n`,
  );
} finally {
  clearTimeout(timeout);
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}

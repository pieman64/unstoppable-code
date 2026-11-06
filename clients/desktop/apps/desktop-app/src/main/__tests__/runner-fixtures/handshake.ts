export const HANDSHAKE_SOURCE = String.raw`
// IPC readiness proves the whole tree exists before cancellation or drain.
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const mode = process.argv[2];
if (mode === 'tree') {
  let child;
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
    if (child?.exitCode !== null) process.exit(0);
  });
  child = spawn(process.execPath, [__filename, 'branch'], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', (grandchildPid) => {
    process.stdout.write('tree:' + [process.pid, child.pid, grandchildPid].join(',') + '\n');
  });
  child.on('exit', () => {
    if (stopping) process.exit(0);
  });
} else if (mode === 'branch') {
  let child;
  let stopping = false;
  process.on('SIGTERM', () => {
    stopping = true;
    if (child?.exitCode !== null) process.exit(0);
  });
  child = spawn(process.execPath, [__filename, 'leaf'], {
    env: process.env,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  child.on('message', () => process.send(child.pid));
  child.on('exit', () => {
    if (stopping) process.exit(0);
  });
} else if (mode === 'leaf') {
  // Keep the leaf alive without a timer until the real group signal arrives.
  fs.watch(process.env.RUNNER_FIXTURE_ROOT, () => {});
  process.on('SIGTERM', () => process.exit(0));
  process.send('ready');
}
`;

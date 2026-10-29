// Owned lifecycle for a provider probe child: its own process group, a hard
// deadline, descendant tracking (native binaries may start their own process
// groups), sampled socket egress, and a post-exit leak sweep.
import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { KILL_GRACE_MS } from './constants.mjs';

const MAX_TAIL = 64 * 1024;

function run(file, args, timeoutMs = 5_000) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        resolve(error && !stdout ? '' : String(stdout));
      },
    );
  });
}

/** Snapshot of every process: `{ pid, ppid, pgid, command }[]`. */
export async function listProcesses() {
  const snapshotPath = process.env.BROWSER_AGENT_PROBE_PROCESS_SNAPSHOT;
  if (snapshotPath) {
    // ps is a privileged executable on macOS and cannot run inside seatbelt.
    // Consume only a fresh parent-owned snapshot of this probe's descendants.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
        if (
          snapshot.rootPid !== process.pid ||
          Date.now() - snapshot.sampledAt > 5000 ||
          !Array.isArray(snapshot.processes)
        )
          throw new Error('Stale or mismatched parent process snapshot');
        return snapshot.processes;
      } catch (error) {
        if (attempt === 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  const text = await run('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,command=']);
  const out = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match)
      out.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        command: match[4],
      });
  }
  return out;
}

/** Every transitive descendant of `rootPid` in a process snapshot. */
export function descendantsOf(processes, rootPid) {
  const children = new Map();
  for (const proc of processes) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc);
  }
  const out = [];
  const queue = [rootPid];
  while (queue.length) {
    for (const child of children.get(queue.shift()) ?? []) {
      out.push(child);
      queue.push(child.pid);
    }
  }
  return out;
}

/**
 * Parse `lsof -nP -i` output into connections with a remote endpoint.
 * Listening sockets and unconnected UDP have no `->` and are ignored.
 */
export function parseLsofConnections(text) {
  const out = [];
  for (const line of text.split('\n').slice(1)) {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 9) continue;
    const name = columns.slice(8).join(' ');
    const arrow = name.indexOf('->');
    if (arrow < 0) continue;
    const remote = name.slice(arrow + 2).replace(/\s*\(.*\)$/, '');
    const host = remote.startsWith('[')
      ? remote.slice(1, remote.indexOf(']'))
      : remote.slice(0, remote.lastIndexOf(':'));
    out.push({
      command: columns[0],
      pid: Number(columns[1]),
      protocol: columns[7],
      remote,
      loopback: isLoopbackHost(host),
    });
  }
  return out;
}

export function isLoopbackHost(host) {
  return (
    host === '127.0.0.1' ||
    host === '::1' ||
    host === 'localhost' ||
    host.startsWith('127.')
  );
}

/**
 * Run a probe child under `node --import tsx` with an owned process group.
 *
 * @param {{ script: string, env: Record<string,string>, deadlineMs: number, stdoutPath: string, stderrPath: string, sampleMs?: number, networkIsolation?: boolean }} options
 */
export async function runProbeChild({
  script,
  env,
  deadlineMs,
  stdoutPath,
  stderrPath,
  sampleMs = 1_000,
  networkIsolation = false,
  credentialIsolation = false,
  credentialHome = process.env.HOME,
}) {
  const started = Date.now();
  if (
    networkIsolation &&
    (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec'))
  )
    throw new Error(
      'Native provider probing requires the qualified macOS loopback sandbox.',
    );
  const policy =
    '(version 1) (allow default) (deny network-outbound) (allow network-outbound (remote ip "localhost:*"))' +
    (credentialIsolation
      ? ' (deny mach-lookup (global-name-regex #"^com[.]apple[.]securityd")) (deny file-read* (subpath (param "HOST_KEYCHAINS")) (subpath "/Library/Keychains"))'
      : '');
  if (credentialIsolation && !networkIsolation)
    throw new Error('Credential isolation requires the native sandbox');
  const sandboxParameters = credentialIsolation
    ? [
        '-D',
        `HOST_KEYCHAINS=${path.join(credentialHome, 'Library', 'Keychains')}`,
      ]
    : [];
  const nodeArgs = ['--import', import.meta.resolve('tsx'), script];
  const child = spawn(
    networkIsolation ? '/usr/bin/sandbox-exec' : process.execPath,
    networkIsolation
      ? ['-p', policy, ...sandboxParameters, process.execPath, ...nodeArgs]
      : nodeArgs,
    {
      cwd: env.HOME,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const stdoutFile = createWriteStream(stdoutPath);
  const stderrFile = createWriteStream(stderrPath);
  let stdoutTail = '';
  let stderrTail = '';
  child.stdout.on('data', (chunk) => {
    stdoutFile.write(chunk);
    stdoutTail = (stdoutTail + chunk).slice(-MAX_TAIL);
  });
  child.stderr.on('data', (chunk) => {
    stderrFile.write(chunk);
    stderrTail = (stderrTail + chunk).slice(-MAX_TAIL);
  });

  /** pid -> { pid, pgid, command, firstSeenMs } */
  const seen = new Map();
  const egress = [];
  let sampling = false;
  async function sample() {
    if (sampling || child.exitCode !== null || child.pid === undefined) return;
    sampling = true;
    try {
      const processes = await listProcesses();
      const tree = [
        ...processes.filter((proc) => proc.pid === child.pid),
        ...descendantsOf(processes, child.pid),
      ];
      if (env.BROWSER_AGENT_PROBE_PROCESS_SNAPSHOT) {
        const snapshotPath = env.BROWSER_AGENT_PROBE_PROCESS_SNAPSHOT;
        const temporary = `${snapshotPath}.next`;
        await writeFile(
          temporary,
          JSON.stringify({
            rootPid: child.pid,
            sampledAt: Date.now(),
            processes: tree,
          }),
          { mode: 0o600 },
        );
        await rename(temporary, snapshotPath);
      }
      for (const proc of tree) {
        if (!seen.has(proc.pid))
          seen.set(proc.pid, { ...proc, firstSeenMs: Date.now() - started });
      }
      if (tree.length > 0) {
        const text = await run('/usr/sbin/lsof', [
          '-nP',
          '-a',
          '-i',
          '-p',
          tree.map((proc) => proc.pid).join(','),
        ]);
        for (const connection of parseLsofConnections(text)) {
          if (!connection.loopback)
            egress.push({ ...connection, atMs: Date.now() - started });
        }
      }
    } finally {
      sampling = false;
    }
  }
  const sampler = setInterval(() => void sample(), sampleMs);
  void sample();

  let timedOut = false;
  const killGroup = (signal) => {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Group already gone.
    }
  };
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup('SIGTERM');
    setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS).unref();
  }, deadlineMs);

  const { code, signal } = await new Promise((resolve) => {
    child.once('exit', (exitCode, exitSignal) =>
      resolve({ code: exitCode, signal: exitSignal }),
    );
  });
  clearTimeout(deadline);
  clearInterval(sampler);
  await Promise.all([
    new Promise((resolve) => stdoutFile.end(resolve)),
    new Promise((resolve) => stderrFile.end(resolve)),
  ]);
  // Report survivors first (sweepLeaks kills them), then clear the child's
  // own group as a final safety net.
  const leaks = await sweepLeaks(
    [...seen.values()].filter((proc) => proc.pid !== child.pid),
  );
  killGroup('SIGKILL');
  return {
    exitCode: code,
    signal,
    timedOut,
    durationMs: Date.now() - started,
    pid: child.pid,
    networkIsolation: networkIsolation
      ? {
          mechanism: 'macOS sandbox-exec',
          outbound: 'loopback-only',
          credentialIsolation,
          policy,
        }
      : null,
    trackedProcesses: [...seen.values()].map(
      ({ pid, pgid, command, firstSeenMs }) => ({
        pid,
        pgid,
        command: command.slice(0, 300),
        firstSeenMs,
      }),
    ),
    nonLoopbackConnections: egress,
    egressMethod: `lsof sampled every ${sampleMs} ms over the tracked process tree (not proof of absence)`,
    leaks,
    stdoutTail,
    stderrTail,
  };
}

/**
 * After the child exits, any tracked descendant still alive with the same
 * command is a leak. Leaks are killed and reported.
 */
export async function sweepLeaks(tracked, settleMs = 1_500) {
  if (tracked.length === 0) return [];
  await new Promise((resolve) => setTimeout(resolve, settleMs));
  const alive = new Map(
    (await listProcesses()).map((proc) => [proc.pid, proc]),
  );
  const leaks = [];
  for (const proc of tracked) {
    const now = alive.get(proc.pid);
    if (!now || now.command !== proc.command) continue;
    leaks.push({
      pid: proc.pid,
      pgid: now.pgid,
      command: now.command.slice(0, 300),
    });
    try {
      process.kill(proc.pid, 'SIGKILL');
    } catch {
      // Exited between the snapshot and the kill.
    }
  }
  return leaks;
}

/** Ports the child reported as listening must refuse connections after exit. */
export async function checkPortsClosed(ports) {
  const results = [];
  for (const port of ports) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.setTimeout(1_000);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });
    });
    results.push({ port, open });
  }
  return results;
}

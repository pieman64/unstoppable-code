import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';

/*
 * A test composition of offline W5 maintenance (CAN-3797 Q9): the real
 * `runW5Maintenance` in its own Node process, with a cold dedicated
 * commit-log host on the E2E build's worker bundle. Like the production
 * maintenance composition (Q10), it never registers as a host. Modes:
 *   diagnose <root>  print `diagnosed`, or `refused:<reason>` and exit 3
 *   repair <root>    capture a backup, restore it, print `restored:<commitId>`
 *   hold <root>      as repair, but print `held` and hang at the restore's
 *                    commit, holding maintenance until killed
 */
const SOURCE = `
import { join } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import { W5CommitLogHost } from './apps/desktop-app/src/main/w5-commit-log/commit-log-host';
import { captureW5Backup } from './apps/desktop-app/src/main/lib/w5-backup';
import {
  runW5Maintenance,
  W5MaintenanceRefusedError,
} from './apps/desktop-app/src/main/lib/w5-maintenance';

const [mode, dataRoot, workerEntry] = process.argv.slice(2);
const platform = hostPlatformServices(
  createPlatformEndpointServices(hostPlatformOperatingSystem()),
);
// Resolves once flushed: pipe writes are asynchronous on macOS, and
// process.exit() drops a pending one.
const write = (stream, text) =>
  new Promise((resolve) => stream.write(text + '\\n', () => resolve()));
const say = (line) => write(process.stdout, line);
const coldHost = () =>
  new W5CommitLogHost({
    dbPath: join(dataRoot, 'w5', 'commit-log.sqlite'),
    root: join(dataRoot, 'workspaces'),
    workerEntry,
  });
// Interruption point: the restore's one commit never reaches the worker.
const holdingAtCommit = (host) =>
  new Proxy(host, {
    get(target, key) {
      if (key === 'commit')
        return () => {
          say('held');
          // The pending commit alone would let the event loop drain.
          setInterval(() => undefined, 60_000);
          return new Promise(() => undefined);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

async function main() {
  if (mode === 'diagnose') {
    await runW5Maintenance(
      { host: coldHost(), dataRoot, platform },
      { source: 'offline_maintenance', mode: 'diagnose' },
    );
    await say('diagnosed');
    return;
  }
  if (mode !== 'repair' && mode !== 'hold') throw new Error('unknown mode ' + mode);
  const capture = coldHost();
  const backupPath = await captureW5Backup({ host: capture, dataRoot });
  await capture.shutdown();
  const host = mode === 'hold' ? holdingAtCommit(coldHost()) : coldHost();
  const result = await runW5Maintenance(
    { host, dataRoot, platform },
    { source: 'offline_maintenance', mode: 'restore', backupPath },
  );
  await say('restored:' + result.commitId);
  await host.shutdown();
}

main().then(
  () => process.exit(0),
  async (error) => {
    if (error instanceof W5MaintenanceRefusedError) {
      await say('refused:' + error.reason);
      process.exit(3);
    }
    await write(
      process.stderr,
      String(error && error.stack ? error.stack : error),
    );
    process.exit(1);
  },
);
`;

/** Bundles the composition into `directory`; returns a runner for it. */
export async function buildW5MaintenanceComposition({
  directory,
  repoRoot,
  workerEntry,
}) {
  const outfile = path.join(directory, 'w5-maintenance-composition.cjs');
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  );
  await build({
    stdin: { contents: SOURCE, resolveDir: repoRoot, loader: 'ts' },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    logLevel: 'error',
    define: {
      __CANOPY_CURSOR_CLI__: JSON.stringify(packageJson['cursor-cli'] ?? null),
      __CANOPY_E2E__: 'false',
      __CANOPY_RELEASE_FLAVOR__: JSON.stringify('internal'),
      __CANOPY_CLOUD_BASE_URL__: JSON.stringify(''),
      __CANOPY_CLI_LINUX_ARM64_DEVELOPMENT__: 'false',
    },
  });
  const running = new Set();
  return {
    /**
     * Starts one maintenance run. `line` resolves with its first stdout line
     * (or rejects when it exits without one); `exited` with its exit code.
     */
    start(mode, dataRoot) {
      const child = spawn(
        process.execPath,
        [outfile, mode, dataRoot, workerEntry],
        {
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      running.add(child);
      let output = '';
      let errors = '';
      child.stderr.on('data', (chunk) => {
        errors += String(chunk);
      });
      const exited = new Promise((resolve) =>
        child.once('exit', (code, signal) => {
          running.delete(child);
          resolve(code ?? signal);
        }),
      );
      const line = new Promise((resolve, reject) => {
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
          const end = output.indexOf('\n');
          if (end >= 0) resolve(output.slice(0, end));
        });
        // `close`, not `exit`: stdout and stderr are complete only once closed.
        child.once('close', (code) => {
          if (!output.includes('\n'))
            reject(
              new Error(
                `maintenance ${mode} exited ${String(code)}: ${errors}`,
              ),
            );
        });
      });
      // Observed by callers that wait on `exited` only.
      line.catch(() => undefined);
      return {
        child,
        line,
        exited,
        async kill() {
          if (child.exitCode === null && child.signalCode === null)
            child.kill('SIGKILL');
          await exited;
        },
      };
    },
    /** Runs to completion: the first line and the exit code. */
    async run(mode, dataRoot) {
      const started = this.start(mode, dataRoot);
      const [line, code] = await Promise.all([
        started.line.catch((error) => String(error.message)),
        started.exited,
      ]);
      return { line, code };
    },
    async killAll() {
      await Promise.all(
        Array.from(running, async (child) => {
          child.kill('SIGKILL');
          await new Promise((resolve) => child.once('exit', resolve));
        }),
      );
    },
  };
}

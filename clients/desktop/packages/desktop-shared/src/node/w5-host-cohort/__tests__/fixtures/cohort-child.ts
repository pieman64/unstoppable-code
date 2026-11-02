/*
 * A real cohort process for host-cohort-processes.test.ts, run with
 * `node --import tsx`. Modes:
 *   register <root> <hostKind>  register, print `admitted`, hold until killed
 *   register-hang <root>        publish, print `checking` in the check, hang
 *   acquire <root>              hold maintenance exclusion until killed
 *   spawn-detached <root>       start the real create-worktree action as a
 *                               detached child, print its PID once it
 *                               registered, then exit
 * A refusal prints `refused:<reason>` and exits 3.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  createPlatformEndpointServices,
  hostPlatformOperatingSystem,
  hostPlatformServices,
} from '@canopy/core-platform';
import {
  acquireW5MaintenanceExclusion,
  registerW5Host,
  W5HostCohortRefusedError,
  type W5HostKind,
} from '../..';

const CREATE_WORKTREE_ACTION = resolve(
  __dirname,
  '../../../../builtin-actions/create-worktree/index.ts',
);
const [mode = '', root = '', kind = 'cli'] = process.argv.slice(2);
const platform = hostPlatformServices(
  createPlatformEndpointServices(hostPlatformOperatingSystem()),
);
const hold = (): void => {
  setInterval(() => undefined, 60_000);
};
const hostKind = (value: string): W5HostKind =>
  value === 'create-worktree' ? 'create-worktree' : 'cli';

async function main(): Promise<void> {
  if (mode === 'register') {
    await registerW5Host({ dataRoot: root, hostKind: hostKind(kind) });
    process.stdout.write('admitted\n');
    hold();
  } else if (mode === 'register-hang') {
    await registerW5Host({
      dataRoot: root,
      hostKind: 'cli',
      inspect: () => {
        process.stdout.write('checking\n');
        return new Promise(() => undefined);
      },
    });
  } else if (mode === 'acquire') {
    const self = await platform.supervision.inspectProcess({
      pid: process.pid,
    });
    if (self.state !== 'running') throw new Error('identity unprovable');
    await acquireW5MaintenanceExclusion({
      dataRoot: root,
      owner: { pid: process.pid, startIdentity: self.startIdentity },
      inspect: (pid, signal) =>
        platform.supervision.inspectProcess({ pid, signal }),
      secureFiles: platform.secureFiles,
    });
    process.stdout.write('held\n');
    hold();
  } else if (mode === 'spawn-detached') {
    const hosts = join(root, 'runtime', 'hosts');
    const before = new Set(existsSync(hosts) ? readdirSync(hosts) : []);
    // The real action entry; the keep-alive holds it after its step fails on
    // the unknown project, as a long create-worktree run would.
    const keepAlive = join(root, 'keep-alive.cjs');
    writeFileSync(keepAlive, 'setInterval(() => undefined, 60_000);\n');
    const child = spawn(
      process.execPath,
      [...process.execArgv, '--require', keepAlive, CREATE_WORKTREE_ACTION],
      {
        detached: true,
        stdio: 'ignore',
        env: {
          ...process.env,
          CANOPY_DATA_DIR: root,
          CANOPY_OUTPUT: join(root, 'create-worktree-output.txt'),
          INPUT_WORKSPACE_ID: 'fixture-missing-project',
        },
      },
    );
    child.unref();
    const deadline = Date.now() + 20_000;
    while (
      Date.now() < deadline &&
      !(
        existsSync(hosts) &&
        readdirSync(hosts).some(
          (name) => !before.has(name) && !name.startsWith('.'),
        )
      )
    )
      await new Promise((resolve) => setTimeout(resolve, 20));
    process.stdout.write(`${child.pid ?? ''}\n`);
  } else throw new Error(`unknown mode ${mode}`);
}

main().catch((error: unknown) => {
  if (error instanceof W5HostCohortRefusedError) {
    process.stdout.write(`refused:${error.reason}\n`);
    process.exit(3);
  }
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});

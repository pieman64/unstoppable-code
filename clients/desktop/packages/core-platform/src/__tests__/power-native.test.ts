import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { PlatformPowerAssertion } from '@canopy/core-runtime';
import { hostPlatformOperatingSystem } from '../platform-services';
import { createPowerServices } from '../power';
import {
  DARWIN_POWER_HELPER,
  HOLD_COMMAND,
  linuxPowerHelper,
  type PowerHelper,
} from '../power/helper';

// Native power evidence (CAN-5066) on the host OS. darwin reads the
// assertion from pmset; linux reads systemd-logind's inhibitor list, where a
// runner without polkit authority sees the helper refused and reports it as
// lost; win32 needs the prebuilt owned-child addon (CANOPY_OWNED_CHILD_ADDON,
// required when CANOPY_OWNED_CHILD_ACCEPTANCE=1) and checks that Windows
// accepted and cleared the execution state.

/** stdout of a short read-only command. */
function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { encoding: 'utf8' },
      (error: Error | null, stdout: string): void => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}
const os = hostPlatformOperatingSystem();
const ROOT = path.resolve(__dirname, '../../../..');
const NAME = `Canopy power test ${process.pid}`;

const forOs = (target: typeof os): typeof describe =>
  os === target ? describe : describe.skip;

function evidence(line: string): void {
  process.stderr.write(`[power evidence] ${line}\n`);
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` until it returns true, for at most `ms`. */
async function eventually(
  check: () => Promise<boolean>,
  ms = 5_000,
): Promise<boolean> {
  for (const start = Date.now(); Date.now() - start < ms; await delay(100))
    if (await check()) return true;
  return check();
}

// A host that starts the helper exactly as the adapter does, holds its stdin,
// prints the helper's PID, then idles until it is killed.
const HOST = `
const { spawn } = require('node:child_process');
const [file, ...args] = JSON.parse(process.argv[1]);
const child = spawn(file, args, {
  stdio: ['pipe', 'inherit', 'ignore'],
  detached: true,
  env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' },
});
process.stdout.write(child.pid + '\\n');
setInterval(() => {}, 1000);
`;

/**
 * Kills a host holding the helper and reports whether the assertion ended:
 * the crash case, where no release runs. `null` when the helper never held.
 */
async function assertionEndsWithCrashedHost(
  helper: PowerHelper,
  present: () => Promise<boolean>,
): Promise<boolean | null> {
  const command = helper.command('Power crash test');
  if (command === null) throw new Error('helper unavailable');
  const host = spawn(
    process.execPath,
    [
      '-e',
      HOST,
      JSON.stringify([command.executable, ...command.args, ...HOLD_COMMAND]),
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  let output = '';
  host.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  let helperPid = 0;
  try {
    const held = await eventually(() => {
      helperPid = Number(output.split('\n')[0]) || 0;
      return Promise.resolve(output.includes('held\n'));
    });
    if (!held || !(await eventually(present))) return null;
    host.kill('SIGKILL');
    return await eventually(async () => !(await present()));
  } finally {
    host.kill('SIGKILL');
    try {
      if (helperPid > 0) process.kill(-helperPid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function acquire(
  power: ReturnType<typeof createPowerServices>,
): PlatformPowerAssertion {
  const result = power.preventSystemSleep({ reason: 'Power contract test' });
  if (result.kind !== 'acquired')
    throw new Error(`Power was ${result.kind}: ${result.reason}`);
  return result.assertion;
}

forOs('darwin')('darwin power assertions', () => {
  /** PIDs of caffeinate processes holding an idle-sleep assertion. */
  async function caffeinatePids(): Promise<Set<string>> {
    const stdout = await run('/usr/bin/pmset', ['-g', 'assertions']);
    const pids = new Set<string>();
    const assertion =
      /pid (\d+)\(caffeinate\): [^\n]*PreventUserIdleSystemSleep/g;
    for (
      let match = assertion.exec(stdout);
      match !== null;
      match = assertion.exec(stdout)
    ) {
      const pid: string | undefined = match[1];
      if (pid !== undefined) pids.add(pid);
    }
    return pids;
  }

  it('holds an idle-sleep assertion until released', async () => {
    const before = await caffeinatePids();
    const assertion = acquire(createPowerServices('darwin'));
    await expect(assertion.held).resolves.toBe(true);

    // caffeinate asserts from a forked child as it execs the command.
    let added: string[] = [];
    for (let attempt = 0; attempt < 30 && added.length === 0; attempt += 1) {
      if (attempt > 0) await delay(100);
      const during = await caffeinatePids();
      added = Array.from(during).filter((pid) => !before.has(pid));
    }
    evidence(`darwin caffeinate assertion pids ${added.join(',')}`);
    expect(added).toHaveLength(1);

    await assertion.release();
    await expect(assertion.ended).resolves.toEqual({ kind: 'released' });
    const after = await caffeinatePids();
    expect(after.has(added[0] ?? '')).toBe(false);
  });

  it('drops the assertion when its host crashes', async () => {
    const before = await caffeinatePids();
    const present = async (): Promise<boolean> =>
      Array.from(await caffeinatePids()).some((pid) => !before.has(pid));

    const ended = await assertionEndsWithCrashedHost(
      DARWIN_POWER_HELPER,
      present,
    );

    evidence(`darwin assertion ended with crashed host: ${String(ended)}`);
    expect(ended).toBe(true);
  });
});

forOs('linux')('linux logind inhibitors', () => {
  async function inhibitorListed(): Promise<boolean> {
    const stdout = await run('systemd-inhibit', ['--list', '--no-pager']);
    return stdout.includes(NAME);
  }

  const inhibit = ['/usr/bin/systemd-inhibit', '/bin/systemd-inhibit'].some(
    (file) => existsSync(file),
  );

  (inhibit ? it : it.skip)(
    'holds a sleep inhibitor until released, or reports the refusal as lost',
    async () => {
      const assertion = acquire(
        createPowerServices('linux', { applicationName: NAME }),
      );
      if (!(await assertion.held)) {
        const end = await assertion.ended;
        evidence(`linux inhibitor refused: ${JSON.stringify(end)}`);
        expect(end.kind).toBe('lost');
        expect(end.kind === 'lost' ? end.reason : '').toMatch(
          /^Sleep helper exited \(code \d+\)\.$/,
        );
        return;
      }

      expect(await inhibitorListed()).toBe(true);
      evidence('linux inhibitor listed while held');
      await assertion.release();
      await expect(assertion.ended).resolves.toEqual({ kind: 'released' });
      expect(await inhibitorListed()).toBe(false);

      const crashed = await assertionEndsWithCrashedHost(
        linuxPowerHelper({ applicationName: NAME, exists: existsSync }),
        inhibitorListed,
      );
      evidence(`linux inhibitor ended with crashed host: ${String(crashed)}`);
      expect(crashed).toBe(true);
    },
  );
});

forOs('win32')('win32 execution state', () => {
  const configured = process.env.CANOPY_OWNED_CHILD_ADDON;
  const addon = configured ? path.resolve(ROOT, configured) : undefined;
  const present = addon !== undefined && existsSync(addon);
  if (!present && process.env.CANOPY_OWNED_CHILD_ACCEPTANCE === '1')
    throw new Error('Power acceptance requires CANOPY_OWNED_CHILD_ADDON');

  (present ? it : it.skip)(
    'sets and clears the execution state through the owned-child addon',
    async () => {
      const power = createPowerServices('win32', { ownedChildPath: addon });
      const first = acquire(power);
      const second = acquire(power);
      expect(first.isHeld()).toBe(true);
      await first.release();
      await second.release();
      await expect(second.ended).resolves.toEqual({ kind: 'released' });
      evidence('win32 execution state set and cleared');
    },
  );

  it('is unavailable when the addon is not staged', () => {
    expect(
      createPowerServices('win32').preventSystemSleep({ reason: 'r' }),
    ).toEqual({
      kind: 'unavailable',
      reason: 'Power execution state is unavailable on this host.',
    });
  });
});

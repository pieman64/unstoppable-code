import { spawn } from 'node:child_process';
import type * as Runtime from '@canopy/core-runtime';
import { killProcessTree } from '../supervision/kill-tree';
import { createProcessInspector } from '../supervision/inspect';
import {
  NODE_SUPERVISION,
  type SupervisionOperations as Ops,
} from '../supervision/shared';

type Signal = Parameters<Ops['kill']>[1];
type Request = Partial<Record<keyof Runtime.PlatformKillTreeRequest, unknown>>;
type Outcome = [result: unknown, kills: [number, Signal][], runs: unknown[][]];
/** `group` fails kill(-pid), `probe` fails kill(pid, 0), `run` replaces taskkill. */
interface Faults {
  group?: Error | null;
  probe?: Error | null;
  run?: () => Promise<string>;
  root?: string;
}
const ROOT = 'C:\\Windows';
const SELF = 7;
const err = (code: string | number): Error =>
  Object.assign(new Error(String(code)), { code });

/** Stops PID 42 against recording fakes; a rejection settles to its message. */
async function stop(
  os: Runtime.PlatformOperatingSystem,
  overrides: Request = {},
  faults: Faults = {},
): Promise<Outcome> {
  const kills: Outcome[1] = [];
  const runs: Outcome[2] = [];
  const ops: Ops = {
    run: (...args) => (runs.push(args), faults.run?.() ?? Promise.resolve('')),
    kill: (pid, signal) => {
      kills.push([pid, signal]);
      const failure = pid < 0 ? faults.group : faults.probe;
      if (failure) throw failure;
    },
    readText: () => Promise.reject(new Error('unused')),
    systemRoot: () => faults.root ?? ROOT,
    selfPid: SELF,
  };
  const request: Runtime.PlatformKillTreeRequest = { pid: 42, mode: 'force' };
  Object.assign(request, overrides);
  const result = await killProcessTree(os, request, ops).catch(
    // Structural: AbortSignal's DOMException is not a Jest-realm Error.
    (error: unknown): unknown => Reflect.get(Object(error), 'message') ?? error,
  );
  return [result, kills, runs];
}

describe.each(['darwin', 'linux', 'win32'] as const)('%s validation', (os) => {
  it.each([0, -1, 1, 1.5, 2 ** 53, SELF])('rejects PID %p', async (pid) => {
    const [result, ...effects] = await stop(os, { pid });
    expect(result).toMatch('Invalid supervised PID');
    expect(effects).toEqual([[], []]);
  });

  it('rejects an unknown mode or a pre-aborted signal without effects', async () => {
    const invalid = await stop(os, { mode: 'gentle' });
    expect(invalid).toEqual(['Invalid stop mode', [], []]);
    const aborted = await stop(os, { signal: AbortSignal.abort() });
    expect(aborted).toEqual(['This operation was aborted', [], []]);
  });
});

describe.each(['darwin', 'linux'] as const)('%s process group', (os) => {
  it.each([
    ['graceful', 'SIGTERM'],
    ['force', 'SIGKILL'],
  ] as const)('%s signals only the group with %s', async (mode, signal) => {
    const outcome = await stop(os, { mode });
    expect(outcome).toEqual([{ kind: 'signaled', mode }, [[-42, signal]], []]);
  });

  const probed: [number, Signal][] = [[-42, 'SIGKILL'], [42, 0]]; // prettier-ignore
  const LEADER = 'PID 42 is not a process group leader';
  it.each([
    ['absent PID', err('ESRCH'), err('ESRCH'), { kind: 'absent' }, probed],
    ['live PID', err('ESRCH'), null, LEADER, probed],
    ['EPERM PID', err('ESRCH'), err('EPERM'), LEADER, probed],
    ['probe failure', err('ESRCH'), err('EINVAL'), 'EINVAL', probed],
    ['group EPERM', err('EPERM'), null, 'EPERM', [[-42, 'SIGKILL']]],
  ])('%s: no bare-PID signal', async (_, group, probe, expected, kills) => {
    const outcome = await stop(os, {}, { group, probe });
    expect(outcome).toEqual([expected, kills, []]);
  });
});

describe('win32 taskkill', () => {
  it.each(['graceful', 'force'] as const)(
    '%s forces the tree',
    async (mode) => {
      const { signal } = new AbortController();
      const [result, kills, runs] = await stop('win32', { mode, signal });
      expect(result).toEqual({ kind: 'signaled', mode: 'force' });
      expect(kills).toEqual([]);
      const args = ['/pid', '42', '/t', '/f'];
      const taskkill = 'C:\\Windows\\System32\\taskkill.exe';
      expect(runs).toEqual([[taskkill, args, signal, { SystemRoot: ROOT }]]);
      expect(runs[0]?.[2]).toBe(signal);
    },
  );

  it.each([
    ['absent PID', err('ESRCH'), { kind: 'absent' }],
    ['live PID', null, '128'],
    ['EPERM PID', err('EPERM'), '128'],
    ['probe failure', err('EINVAL'), 'EINVAL'],
  ])('command failure with %s', async (_, probe, expected) => {
    const run = (): Promise<string> => Promise.reject(err(128));
    const [result, kills] = await stop('win32', {}, { probe, run });
    expect([result, kills]).toEqual([expected, [[42, 0]]]);
  });

  it.each([true, false])(
    'abort during taskkill rejects (command failed: %p)',
    async (failed) => {
      const controller = new AbortController();
      const run = (): Promise<string> => {
        controller.abort();
        return failed ? Promise.reject(err(1)) : Promise.resolve('');
      };
      const { signal } = controller;
      const faults = { probe: err('ESRCH'), run };
      const [result, kills] = await stop('win32', { signal }, faults);
      expect([result, kills]).toEqual(['This operation was aborted', []]);
    },
  );

  it('rejects a relative SystemRoot before running', async () => {
    const outcome = await stop('win32', {}, { root: 'Windows' });
    expect(outcome).toEqual(['SystemRoot is not absolute', [], []]);
  });
});

const posixIt = process.platform === 'win32' ? it.skip : it;
posixIt('natively kills an owned child and grandchild group', async () => {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux';
  const inspect = createProcessInspector(os, NODE_SUPERVISION);
  const child = spawn('/bin/sh', ['-c', 'sleep 20 & echo ready; wait'], {
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  // 'close' waits for every stdout writer, so it also proves the grandchild exited.
  let closed = false;
  const close = new Promise<NodeJS.Signals | null>((resolve) =>
    child.once('close', (_code, signal) => ((closed = true), resolve(signal))),
  );
  const pid = child.pid ?? 0;
  try {
    await new Promise((resolve) => child.stdout.once('data', resolve));
    child.stdout.resume();
    const self = await inspect({ pid: process.pid });
    expect(self.state === 'running' && self.startIdentity).toMatch(
      `${os}:v1:${process.pid}:`,
    );
    await expect(inspect({ pid: process.pid })).resolves.toEqual(self);
    const observed = await inspect({ pid });
    expect(observed).toMatchObject({ state: 'running' });
    expect(observed).not.toEqual(self);
    const request = { pid, mode: 'force' } as const;
    const stopped = killProcessTree(os, request, NODE_SUPERVISION);
    await expect(stopped).resolves.toEqual({ kind: 'signaled', mode: 'force' });
    expect(await close).toBe('SIGKILL');
    await expect(inspect({ pid })).resolves.toEqual({ state: 'absent' });
  } finally {
    // An open stdout pipe means a group member still holds the group ID.
    if (!closed && pid > 1) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
});

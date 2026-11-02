import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let mockDataDir: string;

jest.mock('../lib/paths', () => ({
  getClaudeProcessPidsFilePath: (): string =>
    `${mockDataDir}/claude-process-pids.json`,
}));

import {
  enableClaudeProcessPidPersistence,
  flushClaudeProcessPidPersistenceForTests,
  isSameHostedClaudeProcess,
  parseElapsedSeconds,
  parsePsIdentity,
  reapStaleClaudeProcesses,
  registerHostedClaudeProcess,
  resetClaudeProcessRegistryForTests,
  unregisterHostedClaudeProcess,
  type ClaudeProcessIdentityOps,
  type HostedClaudeProcessRecord,
  type ObservedProcessIdentity,
} from '../agents/claude-process-registry';

const pidsFile = (): string => join(mockDataDir, 'claude-process-pids.json');

async function readPersisted(): Promise<unknown> {
  return JSON.parse(await readFile(pidsFile(), 'utf8'));
}

async function plant(records: HostedClaudeProcessRecord[]): Promise<void> {
  await writeFile(
    pidsFile(),
    JSON.stringify({ version: 1, processes: records }),
    'utf8',
  );
}

function record(
  overrides: Partial<HostedClaudeProcessRecord> = {},
): HostedClaudeProcessRecord {
  return {
    pid: 4242,
    startedAtMs: 1_000_000,
    executable: '/Applications/Canopy.app/Contents/Resources/bin/claude',
    sessionKey: 'project/worktree/chat',
    sessionInstanceId: 'instance-1',
    ...overrides,
  };
}

function fakeOps(
  identities: Record<number, { commandLine: string; startedAtMs: number }>,
): ClaudeProcessIdentityOps & {
  readProcessIdentity: jest.Mock<
    Promise<ObservedProcessIdentity | null>,
    [number]
  >;
  killProcessTree: jest.Mock<Promise<void>, [number]>;
} {
  return {
    readProcessIdentity: jest.fn<
      Promise<ObservedProcessIdentity | null>,
      [number]
    >((pid) => Promise.resolve(identities[pid] ?? null)),
    killProcessTree: jest.fn<Promise<void>, [number]>(() => Promise.resolve()),
  };
}

type ResolveIdentity = (identity: ObservedProcessIdentity) => void;

/**
 * Hold each identity probe open. The returned function resolves with the
 * probe's resolver once the sweep probes `pid`, and rejects if the sweep
 * finishes first.
 */
function holdProbes(
  ops: ReturnType<typeof fakeOps>,
): (pid: number, sweep: Promise<unknown>) => Promise<ResolveIdentity> {
  const probes = new Map<number, ResolveIdentity>();
  const waiters = new Map<number, (probe: ResolveIdentity) => void>();
  ops.readProcessIdentity.mockImplementation(
    (pid) =>
      new Promise((resolve) => {
        probes.set(pid, resolve);
        waiters.get(pid)?.(resolve);
      }),
  );
  return (pid, sweep) =>
    Promise.race([
      new Promise<ResolveIdentity>((resolve) => {
        const probe = probes.get(pid);
        if (probe) resolve(probe);
        else waiters.set(pid, resolve);
      }),
      sweep.then(() => {
        throw new Error(`The sweep finished without probing ${pid}.`);
      }),
    ]);
}

describe('Claude process registry', () => {
  beforeEach(async () => {
    resetClaudeProcessRegistryForTests();
    mockDataDir = await mkdtemp(join(tmpdir(), 'claude-process-pids-'));
  });

  afterEach(async () => {
    await flushClaudeProcessPidPersistenceForTests();
    resetClaudeProcessRegistryForTests();
    await rm(mockDataDir, { recursive: true, force: true });
  });

  it('persists only non-secret identity once enabled, and drops exited PIDs', async () => {
    enableClaudeProcessPidPersistence();
    registerHostedClaudeProcess(record({ pid: 11 }));
    registerHostedClaudeProcess(record({ pid: 7, sessionKey: undefined }));
    await flushClaudeProcessPidPersistenceForTests();

    expect(await readPersisted()).toEqual({
      version: 1,
      processes: [
        {
          pid: 7,
          startedAtMs: 1_000_000,
          executable: '/Applications/Canopy.app/Contents/Resources/bin/claude',
          sessionInstanceId: 'instance-1',
        },
        expect.objectContaining({
          pid: 11,
          sessionKey: 'project/worktree/chat',
        }),
      ],
    });

    unregisterHostedClaudeProcess(11);
    await flushClaudeProcessPidPersistenceForTests();
    expect(await readPersisted()).toEqual({
      version: 1,
      processes: [expect.objectContaining({ pid: 7 })],
    });
  });

  it("returns a reaped delegated run's parent chat and delegation id", async () => {
    await plant([
      record({
        pid: 151,
        sessionInstanceId: undefined,
        delegationId: 'delegation-1',
      }),
    ]);
    const ops = fakeOps({
      151: { commandLine: record().executable, startedAtMs: 1_000_000 },
    });

    expect(await reapStaleClaudeProcesses(ops)).toEqual([
      {
        pid: 151,
        startedAtMs: 1_000_000,
        executable: record().executable,
        sessionKey: 'project/worktree/chat',
        delegationId: 'delegation-1',
      },
    ]);
  });

  it('writes nothing before persistence is enabled', async () => {
    registerHostedClaudeProcess(record());
    await flushClaudeProcessPidPersistenceForTests();
    await expect(readFile(pidsFile(), 'utf8')).rejects.toThrow();
  });

  it('reaps a survivor whose start time and executable match, and spares reused PIDs', async () => {
    const executable = record().executable;
    await plant([
      record({ pid: 101 }),
      // Same PID number, but the live process started an hour later.
      record({ pid: 102 }),
      // Started at the recorded time, but runs another executable.
      record({ pid: 103 }),
      // No longer running.
      record({ pid: 104 }),
    ]);
    const ops = fakeOps({
      101: {
        commandLine: `${executable} --output-format stream-json`,
        startedAtMs: 1_000_900,
      },
      102: {
        commandLine: `${executable} --output-format stream-json`,
        startedAtMs: 1_000_000 + 3_600_000,
      },
      103: { commandLine: '/usr/bin/vim notes.txt', startedAtMs: 1_000_000 },
    });
    enableClaudeProcessPidPersistence();

    const reaped = await reapStaleClaudeProcesses(ops);

    expect(reaped.map((entry) => entry.pid)).toEqual([101]);
    expect(reaped[0]).toMatchObject({
      sessionKey: 'project/worktree/chat',
      sessionInstanceId: 'instance-1',
    });
    expect(ops.killProcessTree.mock.calls).toEqual([[101]]);
    expect(await readPersisted()).toEqual({ version: 1, processes: [] });
  });

  it("reads the previous run's file before this run's first spawn rewrites it", async () => {
    await plant([record({ pid: 201 })]);
    enableClaudeProcessPidPersistence();
    // A chat spawns before the sweep runs.
    registerHostedClaudeProcess(record({ pid: 202, startedAtMs: 5_000_000 }));
    await flushClaudeProcessPidPersistenceForTests();
    const ops = fakeOps({
      201: { commandLine: record().executable, startedAtMs: 1_000_000 },
      202: { commandLine: record().executable, startedAtMs: 5_000_000 },
    });

    const reaped = await reapStaleClaudeProcesses(ops);

    expect(reaped.map((entry) => entry.pid)).toEqual([201]);
    expect(ops.killProcessTree.mock.calls).toEqual([[201]]);
    expect(await readPersisted()).toEqual({
      version: 1,
      processes: [expect.objectContaining({ pid: 202 })],
    });
  });

  it('never kills a PID this run is tracking', async () => {
    await plant([record({ pid: 301 })]);
    enableClaudeProcessPidPersistence();
    registerHostedClaudeProcess(record({ pid: 301, startedAtMs: 1_000_000 }));
    const ops = fakeOps({
      301: { commandLine: record().executable, startedAtMs: 1_000_000 },
    });

    expect(await reapStaleClaudeProcesses(ops)).toEqual([]);
    expect(ops.readProcessIdentity).not.toHaveBeenCalled();
  });

  it('spares a PID this run registers while its identity probe is pending', async () => {
    await plant([record({ pid: 4242 }), record({ pid: 4243 })]);
    enableClaudeProcessPidPersistence();
    const ops = fakeOps({});
    const probeStarted = holdProbes(ops);
    const replacement = record({
      pid: 4242,
      startedAtMs: 9_000_000,
      sessionInstanceId: 'instance-2',
    });

    const sweep = reapStaleClaudeProcesses(ops);
    const resolveFirst = await probeStarted(4242, sweep);
    // The stale CLI exits and this run's host reuses its PID mid-probe.
    registerHostedClaudeProcess(replacement);
    resolveFirst({ commandLine: record().executable, startedAtMs: 1_000_000 });
    const resolveNext = await probeStarted(4243, sweep);
    // A registration and an exit while a later probe is pending.
    registerHostedClaudeProcess(record({ pid: 5000, startedAtMs: 9_000_000 }));
    unregisterHostedClaudeProcess(5000);
    registerHostedClaudeProcess(record({ pid: 5001, startedAtMs: 9_000_000 }));
    resolveNext({ commandLine: record().executable, startedAtMs: 1_000_000 });

    const reaped = await sweep;

    expect(reaped.map((entry) => entry.pid)).toEqual([4243]);
    expect(ops.killProcessTree.mock.calls).toEqual([[4243]]);
    // The rewrite keeps this run's registrations made during the sweep.
    expect(await readPersisted()).toEqual({
      version: 1,
      processes: [
        expect.objectContaining({ pid: 4242, sessionInstanceId: 'instance-2' }),
        expect.objectContaining({ pid: 5001 }),
      ],
    });
  });

  it('spares a PID this run registers and releases while its identity probe is pending', async () => {
    await plant([record({ pid: 4242 })]);
    enableClaudeProcessPidPersistence();
    const ops = fakeOps({});
    const probeStarted = holdProbes(ops);

    const sweep = reapStaleClaudeProcesses(ops);
    const resolveProbe = await probeStarted(4242, sweep);
    // The probe saw the stale CLI; it then exited, and a short-lived CLI of
    // this run held its PID. The PID may now belong to anything.
    registerHostedClaudeProcess(record({ pid: 4242, startedAtMs: 9_000_000 }));
    unregisterHostedClaudeProcess(4242);
    resolveProbe({ commandLine: record().executable, startedAtMs: 1_000_000 });

    expect(await sweep).toEqual([]);
    expect(ops.killProcessTree).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', null],
    ['unparseable', 'not json'],
    ['the wrong shape', JSON.stringify({ version: 1, pids: [1, 2] })],
    [
      'invalid entries',
      JSON.stringify({
        version: 1,
        processes: [
          { pid: -1, startedAtMs: 1, executable: '/x' },
          { pid: 1.5, startedAtMs: 1, executable: '/x' },
          { pid: 5, startedAtMs: 'soon', executable: '/x' },
          { pid: 6, startedAtMs: 1, executable: '' },
        ],
      }),
    ],
  ])('reaps nothing from a %s file', async (_label, contents) => {
    if (contents !== null) await writeFile(pidsFile(), contents, 'utf8');
    const ops = fakeOps({});

    expect(await reapStaleClaudeProcesses(ops)).toEqual([]);
    expect(ops.readProcessIdentity).not.toHaveBeenCalled();
  });

  it('spares a PID whose identity probe throws', async () => {
    await plant([record({ pid: 401 })]);
    const ops = fakeOps({});
    ops.readProcessIdentity.mockImplementation(() =>
      Promise.reject(new Error('ps')),
    );

    expect(await reapStaleClaudeProcesses(ops)).toEqual([]);
    expect(ops.killProcessTree).not.toHaveBeenCalled();
  });

  describe('identity', () => {
    const exe =
      '/Applications/Canopy (Internal).app/Contents/Resources/bin/claude';

    it.each([
      ['the bare executable', exe, 0, true],
      ['the executable with arguments', `${exe} --print`, 0, true],
      ['a start time at the tolerance edge', exe, 5_000, true],
      ['a start time just past the tolerance', exe, 5_001, false],
      ['a start time before the record', exe, -5_001, false],
      ['a path that only shares a prefix', `${exe}-helper --print`, 0, false],
      ['another executable', '/bin/sleep 30', 0, false],
    ])('POSIX: %s', (_label, commandLine, offsetMs, expected) => {
      expect(
        isSameHostedClaudeProcess(
          record({ executable: exe }),
          { commandLine, startedAtMs: 1_000_000 + offsetMs },
          'darwin',
        ),
      ).toBe(expected);
    });

    it('compares a quoted Windows command line case-insensitively', () => {
      const windowsExe =
        'C:\\Program Files\\Canopy\\resources\\bin\\claude.exe';
      expect(
        isSameHostedClaudeProcess(
          record({ executable: windowsExe }),
          {
            commandLine: `"${windowsExe.toUpperCase()}" --print`,
            startedAtMs: 1_000_000,
          },
          'win32',
        ),
      ).toBe(true);
      expect(
        isSameHostedClaudeProcess(
          record({ executable: windowsExe }),
          { commandLine: `"${windowsExe}" --print`, startedAtMs: 1_000_000 },
          'darwin',
        ),
      ).toBe(false);
    });

    it.each([
      ['00:07', 7],
      ['12:34', 754],
      ['01:02:03', 3_723],
      ['2-03:04:05', 183_845],
      ['', null],
      ['7', null],
      ['1:2:3:4', null],
    ])('parses elapsed time %p', (etime, seconds) => {
      expect(parseElapsedSeconds(etime)).toBe(seconds);
    });

    it('splits ps output into start-time bounds and a command line', () => {
      expect(parsePsIdentity(`  01:05 ${exe} --print\n`, 100_000)).toEqual({
        commandLine: `${exe} --print`,
        startedAtMs: 35_000,
        earliestStartedAtMs: 34_000,
      });
      expect(parsePsIdentity('', 100_000)).toBeNull();
      expect(parsePsIdentity('01:05\n', 100_000)).toBeNull();
    });

    it('widens, not shifts, the start-time bounds by the probe latency', () => {
      // Spawned at 1_000_000; a swap-bound ps measured 2 seconds of elapsed
      // time at 1_002_500, and returned 8 seconds later.
      const observed = parsePsIdentity(`00:02 ${exe}\n`, 1_002_000, 1_010_500);
      if (!observed) throw new Error('Expected an identity.');
      expect(observed).toMatchObject({
        startedAtMs: 1_008_500,
        earliestStartedAtMs: 999_000,
      });
      expect(
        isSameHostedClaudeProcess(
          record({ executable: exe, startedAtMs: 1_000_000 }),
          observed,
          'darwin',
        ),
      ).toBe(true);
      // Measuring "now" only after the probe would have put the start 8.5
      // seconds late and spared this orphan.
      expect(
        isSameHostedClaudeProcess(
          record({ executable: exe, startedAtMs: 1_000_000 }),
          { commandLine: exe, startedAtMs: 1_010_500 - 2_000 },
          'darwin',
        ),
      ).toBe(false);
      expect(
        isSameHostedClaudeProcess(
          record({ executable: exe, startedAtMs: 1_000_000 - 3_600_000 }),
          observed,
          'darwin',
        ),
      ).toBe(false);
    });
  });

  const posixIt = process.platform === 'win32' ? it.skip : it;

  describe('with real processes', () => {
    const children: ChildProcess[] = [];

    afterEach(() => {
      for (const child of children.splice(0)) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }
    });

    function spawnOrphan(): { child: ChildProcess; startedAtMs: number } {
      const startedAtMs = Date.now();
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        { detached: true, stdio: 'ignore' },
      );
      children.push(child);
      return { child, startedAtMs };
    }

    posixIt(
      'the startup sweep reaps a planted orphan and spares a reused PID',
      async () => {
        const orphan = spawnOrphan();
        const bystander = spawnOrphan();
        if (orphan.child.pid === undefined || bystander.child.pid === undefined)
          throw new Error('Expected spawned PIDs.');
        // Let ps see both processes running.
        await new Promise((resolve) => setTimeout(resolve, 300));
        await plant([
          {
            pid: orphan.child.pid,
            startedAtMs: orphan.startedAtMs,
            executable: process.execPath,
            sessionKey: 'project/worktree/chat',
          },
          // A previous run's CLI had this PID an hour ago; it is now reused.
          {
            pid: bystander.child.pid,
            startedAtMs: bystander.startedAtMs - 3_600_000,
            executable: process.execPath,
          },
        ]);
        const orphanExit = once(orphan.child, 'exit');
        enableClaudeProcessPidPersistence();

        const reaped = await reapStaleClaudeProcesses();

        expect(reaped.map((entry) => entry.pid)).toEqual([orphan.child.pid]);
        await expect(orphanExit).resolves.toEqual([null, 'SIGKILL']);
        expect(bystander.child.exitCode).toBeNull();
        expect(bystander.child.signalCode).toBeNull();
        expect(() => process.kill(bystander.child.pid ?? 0, 0)).not.toThrow();
      },
      15_000,
    );
  });
});

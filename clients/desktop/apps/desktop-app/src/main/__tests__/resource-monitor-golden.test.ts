import type * as NodeOs from 'node:os';
import type * as CorePlatform from '@canopy/core-platform';
import type { ProcessTableOperations } from '@canopy/core-platform';
import type { CoreExecutionStatus } from '@canopy/protocol/canopy-core';
import linuxTerminalProc from './fixtures/linux-terminal-proc.json';

// Golden capture (CAN-4135): the snapshots, admission refusals, diagnostics
// and registration lifecycle of the in-process resource monitor, pinned
// before execution accounting moved to core. The process table and Electron
// metrics are the only stubbed inputs; pipeline executions are counted by the
// real execution registry.

const getAppMetricsMock = jest.fn();
const execFileMock = jest.fn<
  void,
  [string, string[], unknown, ExecFileCallback]
>();
const recordAppDiagnosticMock = jest.fn();
const getChatTurnConcurrencySnapshotMock = jest.fn();
const mockOsTotalmem = jest.fn((): number => 64 * 1024 * 1024 * 1024);
const mockOsCpus = jest.fn((): NodeOs.CpuInfo[] => cpus(1));
const mockLinuxOperations: Partial<ProcessTableOperations> = {};

jest.mock('@canopy/core-platform', () => {
  const actual: typeof CorePlatform = jest.requireActual(
    '@canopy/core-platform',
  );
  return {
    ...actual,
    createProcessTableReader: (
      platform: Parameters<typeof actual.createProcessTableReader>[0],
    ): ReturnType<typeof actual.createProcessTableReader> =>
      actual.createProcessTableReader(
        platform,
        platform === 'linux' ? mockLinuxOperations : undefined,
      ),
  };
});

function cpus(count: number): NodeOs.CpuInfo[] {
  return Array.from({ length: count }, () => ({
    model: 'test',
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }));
}

jest.mock('electron', () => ({
  app: {
    get getAppMetrics(): typeof getAppMetricsMock {
      return getAppMetricsMock;
    },
  },
}));

jest.mock('node:child_process', () => ({
  get execFile(): typeof execFileMock {
    return execFileMock;
  },
}));

jest.mock('node:os', () => {
  const actual: typeof NodeOs = jest.requireActual('node:os');
  return {
    ...actual,
    get totalmem(): typeof mockOsTotalmem {
      return mockOsTotalmem;
    },
    get cpus(): typeof mockOsCpus {
      return mockOsCpus;
    },
  };
});

jest.mock('../observability', () => ({
  getObservabilityService: (): {
    recordAppDiagnostic: typeof recordAppDiagnosticMock;
  } => ({ recordAppDiagnostic: recordAppDiagnosticMock }),
}));

jest.mock('../agents/session-manager', () => ({
  get getChatTurnConcurrencySnapshot(): typeof getChatTurnConcurrencySnapshotMock {
    return getChatTurnConcurrencySnapshotMock;
  },
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: (): unknown => ({
    admin: (): unknown => ({
      getResourceSnapshots: (): unknown[] => [],
      suspendIdleWorkersForMemoryPressure: (): number => 0,
    }),
  }),
}));

const mockDaemon: {
  status: CoreExecutionStatus | null;
  listeners: Set<(status: CoreExecutionStatus | null) => void>;
} = { status: null, listeners: new Set() };

jest.mock('../canopy-runtime/daemon-execution-status', () => ({
  getDaemonExecutionStatus: (): unknown => ({
    current: (): CoreExecutionStatus | null => mockDaemon.status,
    subscribe: (
      listener: (status: CoreExecutionStatus | null) => void,
    ): (() => void) => {
      mockDaemon.listeners.add(listener);
      return (): void => {
        mockDaemon.listeners.delete(listener);
      };
    },
    reattach: (): void => undefined,
  }),
}));

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  failDesktopOperation: jest.fn(),
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

import {
  ResourceGuardError,
  ResourceMonitorService,
} from '../resource-monitor/service';
import {
  releaseExecutionReservation,
  tryReserveExecution,
} from '../pipelines/pipeline-execution-registry';
import {
  getPerformanceLimits,
  resetPerformanceLimitsForTests,
  updatePerformanceLimits,
  type PerformanceLimits,
} from '../lib/performance-limits';

type ExecFileCallback = (error: Error | null, stdout: string) => void;

const MIB = 1024 * 1024;
const APP = process.pid;

function setPlatform(value: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { configurable: true, value });
  return (): void => {
    if (descriptor) Object.defineProperty(process, 'platform', descriptor);
  };
}

function processTables(outputs: readonly string[]): void {
  let index = 0;
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      cb: ExecFileCallback,
    ) => {
      const output = outputs[Math.min(index, outputs.length - 1)] ?? '';
      index += 1;
      cb(null, output);
    },
  );
}

function limits(update: Partial<PerformanceLimits>): void {
  updatePerformanceLimits({ ...getPerformanceLimits(), ...update });
}

/** Replaces the app PID and sample time so the capture is host-independent. */
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (key === 'sampledAt' || key === 'startedAt') return [key, '<time>'];
      if (entry === APP) return [key, '<app>'];
      if (typeof entry === 'string' && entry.includes(String(APP)))
        return [key, entry.replace(String(APP), '<app>')];
      return [key, normalize(entry)];
    }),
  );
}

function appMetric(mib: number): unknown {
  return {
    pid: APP,
    type: 'Browser',
    cpu: { percentCPUUsage: 1 },
    memory: { workingSetSize: mib * 1024 },
  };
}

function diagnostics(): unknown[] {
  return recordAppDiagnosticMock.mock.calls.map(([record]: [unknown]) =>
    normalize(record),
  );
}

function registerExecutionWork(service: ResourceMonitorService): void {
  service.registerWorkItem({
    id: 'pipeline-execution:exec-1',
    groupId: 'pipelines',
    kind: 'pipeline-execution',
    label: 'Release',
    startedAt: '2026-10-28T00:00:00.000Z',
    metadata: {
      type: 'pipeline',
      pipeline: { executionId: 'exec-1', pipelineName: 'Release' },
    },
  });
  service.registerProcess({
    id: 'pipeline-step:exec-1:build',
    groupId: 'pipelines',
    kind: 'pipeline-step',
    label: 'build / compile',
    pid: 200,
    processGroupId: 200,
    startedAt: '2026-10-28T00:00:01.000Z',
    metadata: {
      type: 'pipeline',
      pipeline: { executionId: 'exec-1', jobId: 'build', stepId: 'compile' },
    },
  });
  service.registerProcess({
    id: 'script:test',
    groupId: 'scripts',
    kind: 'script',
    label: 'test',
    pid: 300,
    startedAt: '2026-10-28T00:00:02.000Z',
    metadata: { type: 'generic' },
  });
  service.registerProcess({
    id: 'terminal:one',
    groupId: 'terminal',
    kind: 'terminal',
    label: 'zsh',
    pid: 400,
    startedAt: '2026-10-28T00:00:03.000Z',
  });
}

describe('resource monitor golden (CAN-4135)', () => {
  const reserved: string[] = [];

  beforeEach(() => {
    jest.clearAllMocks();
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        cb: ExecFileCallback,
      ) => cb(new Error('process table unavailable'), ''),
    );
    resetPerformanceLimitsForTests();
    getChatTurnConcurrencySnapshotMock.mockReturnValue({
      activeTurns: 0,
      pendingMessages: 0,
    });
    getAppMetricsMock.mockReturnValue([]);
    mockOsTotalmem.mockReturnValue(64 * 1024 * 1024 * 1024);
    mockOsCpus.mockReturnValue(cpus(1));
  });

  afterEach(() => {
    for (const id of reserved.splice(0)) releaseExecutionReservation(id);
    mockDaemon.status = null;
    mockDaemon.listeners.clear();
    for (const key of Object.keys(mockLinuxOperations)) {
      Reflect.deleteProperty(mockLinuxOperations, key);
    }
    resetPerformanceLimitsForTests();
  });

  it('samples registered execution work, provider descendants and app metrics on macOS', async () => {
    const restore = setPlatform('darwin');
    processTables([
      `${APP} 1 ${APP} 1.0 262144 /Applications/Canopy.app --secret\n` +
        `200 ${APP} 200 4.0 10240 /usr/bin/node build.js --token x\n` +
        `201 200 200 2.0 20480 /bin/sh -c compile\n` +
        `202 1 200 1.0 1024 /usr/bin/reparented\n` +
        `300 ${APP} 300 3.0 4096 /usr/local/bin/pnpm test\n` +
        `400 ${APP} 400 0.5 2048 /bin/zsh -l\n` +
        `500 ${APP} 500 6.0 8192 /usr/local/bin/claude --resume\n` +
        `501 ${APP} 501 7.0 4096 /usr/local/bin/codex app-server\n` +
        `502 ${APP} 502 0.0 1024 /usr/bin/git status\n`,
    ]);
    getAppMetricsMock.mockReturnValue([
      {
        pid: APP,
        type: 'Browser',
        cpu: { percentCPUUsage: 5 },
        memory: { workingSetSize: 262144 },
      },
      {
        pid: 900,
        type: 'Tab',
        cpu: { percentCPUUsage: 2 },
        memory: { workingSetSize: 65536 },
      },
    ]);
    const service = new ResourceMonitorService();
    registerExecutionWork(service);
    const snapshot = await service.sampleNow();
    service.dispose();
    restore();

    expect(normalize(snapshot)).toMatchSnapshot();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,pcpu=,rss=,command='],
      expect.anything(),
      expect.any(Function),
    );
  });

  it('derives Windows CPU from consecutive process tables', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-10-28T00:00:00.000Z'));
    const restore = setPlatform('win32');
    mockOsCpus.mockReturnValue(cpus(4));
    const table = (cpu200: number, cpu201: number): string =>
      JSON.stringify([
        {
          ProcessId: APP,
          ParentProcessId: 1,
          CpuTime100ns: 10_000_000,
          WorkingSetSize: 256 * MIB,
          Name: 'Canopy.exe',
          CommandLine: 'C:\\Canopy\\Canopy.exe',
        },
        {
          ProcessId: 200,
          ParentProcessId: APP,
          CpuTime100ns: cpu200,
          WorkingSetSize: 10 * MIB,
          Name: 'node.exe',
          CommandLine: 'node.exe script.js',
        },
        {
          ProcessId: 201,
          ParentProcessId: 200,
          CpuTime100ns: cpu201,
          WorkingSetSize: 20 * MIB,
          Name: 'codex.exe',
          CommandLine: 'codex.exe',
        },
        {
          ProcessId: 202,
          ParentProcessId: APP,
          CpuTime100ns: 0,
          WorkingSetSize: 5 * MIB,
          Name: 'claude.exe',
          CommandLine: 'claude.exe',
        },
      ]);
    processTables([
      table(100_000_000, 50_000_000),
      table(140_000_000, 58_000_000),
    ]);
    try {
      const service = new ResourceMonitorService();
      service.registerProcess({
        id: 'script:test',
        groupId: 'scripts',
        kind: 'script',
        label: 'test',
        pid: 200,
        processGroupId: 200,
        startedAt: '2026-10-28T00:00:00.000Z',
        metadata: { type: 'generic' },
      });
      const first = await service.sampleNow();
      jest.setSystemTime(new Date('2026-10-28T00:00:02.000Z'));
      const second = await service.sampleNow();
      service.dispose();
      expect(normalize({ first, second })).toMatchSnapshot();
      expect(execFileMock).toHaveBeenCalledWith(
        'powershell.exe',
        expect.any(Array),
        expect.anything(),
        expect.any(Function),
      );
    } finally {
      restore();
      jest.useRealTimers();
    }
  });

  it('accounts for a Linux PTY shell and its foreground child from recorded procfs samples', async () => {
    // Acceptance 5 on Ubuntu 26.04.1: bash owns the terminal, while the
    // CPU-bound Python child is in a different foreground process group.
    const fixture = linuxTerminalProc;
    const restore = setPlatform('linux');
    const auxv = new Uint8Array(32);
    const auxvView = new DataView(auxv.buffer);
    auxvView.setUint32(0, 6, true); // AT_PAGESZ
    auxvView.setUint32(8, fixture.pageBytes, true);
    let sampleIndex = 0;
    let current = fixture.samples[0];
    Object.assign(mockLinuxOperations, {
      listDirectory: (): Promise<string[]> => {
        const sample = fixture.samples[sampleIndex];
        if (!sample) throw new Error('Missing recorded procfs sample');
        current = sample;
        sampleIndex += 1;
        return Promise.resolve(
          current.rows.map((row) => row.stat.split(' ')[0] ?? ''),
        );
      },
      readText: (path: string): Promise<string> => {
        const match = /^\/proc\/(\d+)\/(stat|cmdline)$/.exec(path);
        const row = match
          ? current.rows.find((entry) => entry.stat.startsWith(`${match[1]} (`))
          : undefined;
        if (!match || !row)
          throw new Error(`Missing recorded procfs file: ${path}`);
        return Promise.resolve(
          match[2] === 'stat'
            ? row.stat
            : Buffer.from(row.cmdlineBase64, 'base64').toString('utf8'),
        );
      },
      readBytes: (): Promise<Uint8Array> => Promise.resolve(auxv),
      logicalCpuCount: (): number => fixture.logicalCpuCount,
      now: (): number => current.sampledAtMs,
    } satisfies Partial<ProcessTableOperations>);
    mockOsCpus.mockReturnValue(cpus(fixture.logicalCpuCount));
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date(fixture.samples[0].sampledAtMs));
      const service = new ResourceMonitorService();
      try {
        service.registerProcess({
          id: 'terminal:recorded-bash',
          groupId: 'terminal',
          kind: 'terminal',
          label: 'bash',
          pid: fixture.shellPid,
          processGroupId: fixture.shellPid,
        });
        const first = await service.sampleNow();
        jest.setSystemTime(new Date(fixture.samples[1].sampledAtMs));
        const second = await service.sampleNow();
        const terminal = second.groups.find((group) => group.id === 'terminal');
        const shell = terminal?.items.find(
          (item) => item.id === 'terminal:recorded-bash',
        );
        const python = shell?.children?.[0];
        // Python gained 100 user ticks in 1006 ms on six logical CPUs.
        const elapsedSeconds =
          (fixture.samples[1].sampledAtMs - fixture.samples[0].sampledAtMs) /
          1000;
        const expectedCpu =
          (100 /
            fixture.clockTicks /
            elapsedSeconds /
            fixture.logicalCpuCount) *
          100;
        const expectedRss = (1330 + 2605) * fixture.pageBytes;

        expect(
          first.groups.find((group) => group.id === 'terminal'),
        ).toMatchObject({
          cpuPercent: 0,
          memoryRssBytes: expectedRss,
          processCount: 2,
        });
        expect(second.error).toBeUndefined();
        expect(shell).toMatchObject({
          pid: fixture.shellPid,
          processGroupId: fixture.shellPid,
          status: 'running',
          memoryRssBytes: expectedRss,
          processCount: 2,
        });
        expect(python).toMatchObject({
          pid: 5573,
          ppid: fixture.shellPid,
          processGroupId: 5573,
          label: 'python3',
          memoryRssBytes: 2605 * fixture.pageBytes,
          processCount: 1,
        });
        expect(python?.cpuPercent).toBeCloseTo(expectedCpu, 8);
        expect(shell?.cpuPercent).toBeCloseTo(expectedCpu, 8);
        expect(terminal?.cpuPercent).toBeCloseTo(expectedCpu, 8);
        expect(second.cpuPercent).toBeCloseTo(expectedCpu, 8);
        expect(second.memoryRssBytes).toBe(expectedRss);
        expect(second.processCount).toBe(2);
        expect(second.groups.flatMap((group) => group.items)).toHaveLength(1);
        expect(execFileMock).not.toHaveBeenCalled();
      } finally {
        service.dispose();
      }
    } finally {
      jest.useRealTimers();
      restore();
    }
  });

  it('reports pressure unknown when no process table is available', async () => {
    const restore = setPlatform('darwin');
    getAppMetricsMock.mockReturnValue([
      {
        pid: APP,
        type: 'Browser',
        cpu: { percentCPUUsage: 3 },
        memory: { workingSetSize: 1024 },
      },
    ]);
    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    service.dispose();
    restore();

    expect(normalize(snapshot)).toMatchSnapshot();
  });

  it('escalates memory pressure and records each rise once', async () => {
    const restore = setPlatform('darwin');
    limits({
      memoryPressureWarningThresholdBytes: 100 * MIB,
      memoryPressureCriticalThresholdBytes: 200 * MIB,
    });
    processTables([`${APP} 1 ${APP} 1.0 1024 /Applications/Canopy.app\n`]);
    for (const mib of [50, 150, 150, 250, 50, 150]) {
      getAppMetricsMock.mockReturnValueOnce([appMetric(mib)]);
    }
    const service = new ResourceMonitorService();
    const levels: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      levels.push((await service.sampleNow()).pressure.level);
    }
    service.dispose();
    restore();

    expect(levels).toEqual([
      'ok',
      'warning',
      'warning',
      'critical',
      'ok',
      'warning',
    ]);
    expect(
      diagnostics().map((record) =>
        typeof record === 'object' && record !== null && 'kind' in record
          ? record.kind
          : null,
      ),
    ).toEqual([
      'resource_pressure_warning',
      'resource_pressure_critical',
      'resource_pressure_warning',
    ]);
  });

  it('admits pipeline starts up to the cap counted from tracked and pending executions', () => {
    limits({ maxActivePipelineExecutions: 2 });
    for (const id of ['exec-a']) {
      expect(tryReserveExecution(id)).toBe(true);
      reserved.push(id);
    }
    const service = new ResourceMonitorService();

    const pending = service.reservePipelineExecutionStart();
    let refusal: unknown;
    try {
      service.reservePipelineExecutionStart();
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ResourceGuardError);
    expect(refusal).toMatchObject({
      code: 'resource-guard-blocked',
      name: 'ResourceGuardError',
      message:
        'Canopy is already running 2 workflow executions. Wait for one to finish before starting another workflow.',
    });

    pending.release();
    pending.release();
    const next = service.reservePipelineExecutionStart();
    next.release();
    expect(() => service.assertCanStartPipelineExecution()).not.toThrow();

    releaseExecutionReservation('exec-a');
    reserved.splice(0);
    expect(diagnostics()).toEqual([
      expect.objectContaining({
        kind: 'resource_guard_blocked_pipeline',
        activePipelineExecutionCount: 0,
        activeChatTurnCount: 0,
        pressureLevel: 'unknown',
      }),
    ]);
  });

  it('refuses new chat and pipeline work while memory is critical and the guard is on', async () => {
    const restore = setPlatform('darwin');
    limits({
      memoryPressureWarningThresholdBytes: 100 * MIB,
      memoryPressureCriticalThresholdBytes: 200 * MIB,
      memoryPressureGuardEnabled: true,
    });
    processTables([`${APP} 1 ${APP} 1.0 1024 /Applications/Canopy.app\n`]);
    getAppMetricsMock.mockReturnValue([appMetric(300)]);
    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    restore();

    expect(snapshot.guards.pipelines.blocked).toBe(true);
    expect(snapshot.guards.chatTurns.blocked).toBe(true);
    expect(() => service.reservePipelineExecutionStart()).toThrow(
      'Canopy is under high memory pressure. Stop an active chat or workflow execution before starting another workflow.',
    );
    await expect(service.reserveChatTurnStart()).rejects.toThrow(
      'Canopy is under high memory pressure. Wait for active work to finish before starting another chat.',
    );

    limits({ memoryPressureGuardEnabled: false });
    service.reservePipelineExecutionStart().release();
    (await service.reserveChatTurnStart()).release();
    service.dispose();
  });

  it('counts a daemon this app did not launch toward the memory guard (CAN-5695)', async () => {
    const restore = setPlatform('darwin');
    limits({
      memoryPressureWarningThresholdBytes: 100 * MIB,
      memoryPressureCriticalThresholdBytes: 200 * MIB,
      memoryPressureGuardEnabled: true,
    });
    processTables([`${APP} 1 ${APP} 1.0 1024 /Applications/Canopy.app\n`]);
    getAppMetricsMock.mockReturnValue([appMetric(150)]);
    const service = new ResourceMonitorService();
    service.start(() => null);
    expect((await service.sampleNow()).guards.pipelines.blocked).toBe(false);

    // A daemon the CLI started: outside Electron's process tree.
    const daemonStatus = (sampledAt: string): CoreExecutionStatus => ({
      sampledAt,
      cpuPercent: 1,
      memoryRssBytes: 100 * MIB,
      processCount: 1,
      pressure: {
        level: 'ok',
        reasons: [],
        warningMemoryBytes: 2048 * MIB,
        criticalMemoryBytes: 4096 * MIB,
      },
      groups: [
        {
          id: 'app',
          label: 'Background service',
          cpuPercent: 1,
          memoryRssBytes: 100 * MIB,
          processCount: 1,
          items: [
            {
              id: 'core-daemon',
              kind: 'other',
              groupId: 'app',
              label: 'canopy-daemon',
              pid: 9_000,
              cpuPercent: 1,
              memoryRssBytes: 100 * MIB,
              processCount: 1,
              status: 'running',
            },
          ],
        },
      ],
      families: {
        pipeline: { active: 0, pending: 0, maxActive: null, blocked: false },
        script: { active: 0, pending: 0, maxActive: null, blocked: false },
        terminal: { active: 1, pending: 0, maxActive: null, blocked: false },
        codeGraph: { active: 0, pending: 0, maxActive: null, blocked: false },
      },
      memoryGuardBlocked: false,
    });
    const publish = (status: CoreExecutionStatus | null): void => {
      mockDaemon.status = status;
      for (const listener of mockDaemon.listeners) listener(status);
    };

    publish(daemonStatus(new Date().toISOString()));
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.getSnapshot().pressure.level).toBe('critical');
    expect(service.getSnapshot().guards.pipelines.blocked).toBe(true);
    expect(service.getSnapshot().guards.chatTurns.blocked).toBe(true);
    expect(() => service.reservePipelineExecutionStart()).toThrow(
      'Canopy is under high memory pressure. Stop an active chat or workflow execution before starting another workflow.',
    );
    await expect(service.reserveChatTurnStart()).rejects.toThrow(
      'Canopy is under high memory pressure. Wait for active work to finish before starting another chat.',
    );
    expect((await service.sampleNow()).guards.pipelines.blocked).toBe(true);

    // Unreachable or dropped: admission reads this app's own accounting.
    publish(null);
    service.reservePipelineExecutionStart().release();
    (await service.reserveChatTurnStart()).release();

    // A stale status (the daemon went idle) is left out too.
    publish(daemonStatus(new Date(Date.now() - 60_000).toISOString()));
    service.reservePipelineExecutionStart().release();
    expect((await service.sampleNow()).guards.pipelines.blocked).toBe(false);
    service.dispose();
    restore();
  });

  it('counts chat turns and pending chat starts against the chat cap', async () => {
    limits({ maxActiveChatTurns: 2 });
    getChatTurnConcurrencySnapshotMock.mockReturnValue({
      activeTurns: 1,
      pendingMessages: 0,
    });
    const service = new ResourceMonitorService();
    const pending = await service.reserveChatTurnStart();
    await expect(service.reserveChatTurnStart()).rejects.toMatchObject({
      code: 'resource-guard-blocked',
      message:
        'Canopy is already running 2 chat turns. Wait for one to finish before starting another.',
    });
    pending.release();
    (await service.reserveChatTurnStart()).release();
    service.dispose();
    expect(diagnostics()).toEqual([
      expect.objectContaining({ kind: 'resource_guard_blocked_chat' }),
    ]);
  });

  it('projects guard counts and drops unregistered work from the next sample', async () => {
    const restore = setPlatform('darwin');
    limits({ maxActivePipelineExecutions: 3, maxActiveChatTurns: 4 });
    expect(tryReserveExecution('exec-b')).toBe(true);
    reserved.push('exec-b');
    processTables([`${APP} 1 ${APP} 1.0 1024 /Applications/Canopy.app\n`]);
    const service = new ResourceMonitorService();
    const handle = service.registerProcess({
      id: 'terminal:two',
      groupId: 'terminal',
      kind: 'terminal',
      label: 'bash',
      pid: 401,
    });
    handle.update({ label: 'bash (renamed)', id: 'ignored' });
    const before = await service.sampleNow();
    handle.unregister();
    handle.unregister();
    const after = await service.sampleNow();
    service.dispose();
    restore();

    expect(normalize(before.guards)).toEqual({
      chatTurns: {
        activeTurns: 0,
        pendingMessages: 0,
        maxConcurrentTurns: 4,
        blocked: false,
      },
      pipelines: {
        activeExecutions: 1,
        maxConcurrentExecutions: 3,
        blocked: false,
      },
      codexPools: { activeConnections: 0, liveProcesses: 0, activeTurns: 0 },
    });
    expect(
      before.groups
        .find((group) => group.id === 'terminal')
        ?.items.map((item) => [item.id, item.label, item.status]),
    ).toEqual([['terminal:two', 'bash (renamed)', 'unknown']]);
    expect(
      after.groups.find((group) => group.id === 'terminal'),
    ).toBeUndefined();
  });
});

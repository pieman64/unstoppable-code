import type * as NodeOs from 'node:os';

const getAppMetricsMock = jest.fn();
const execFileMock = jest.fn();
const recordAppDiagnosticMock = jest.fn();
const getChatTurnConcurrencySnapshotMock = jest.fn();
const getActivePipelineExecutionCountMock = jest.fn();
const getCodexAppServerPoolResourceSnapshotsMock = jest.fn();
const suspendIdleCodexAppServerPoolConnectionsForMemoryPressureMock = jest.fn();
const mockOsFreemem = jest.fn((): number => 16 * 1024 * 1024 * 1024);
const mockOsTotalmem = jest.fn((): number => 64 * 1024 * 1024 * 1024);
const makeCpuInfo = (): NodeOs.CpuInfo => ({
  model: 'test',
  speed: 0,
  times: {
    user: 0,
    nice: 0,
    sys: 0,
    idle: 0,
    irq: 0,
  },
});
const mockOsCpus = jest.fn((): NodeOs.CpuInfo[] => [makeCpuInfo()]);
const TEST_GIB = 1024 * 1024 * 1024;

jest.mock('electron', () => ({
  app: {
    getAppMetrics: getAppMetricsMock,
  },
}));

jest.mock('node:child_process', () => ({
  execFile: execFileMock,
}));

jest.mock('node:os', () => {
  const actual: typeof NodeOs = jest.requireActual('node:os');
  return {
    ...actual,
    freemem: mockOsFreemem,
    totalmem: mockOsTotalmem,
    cpus: mockOsCpus,
  };
});

jest.mock(
  '../observability',
  (): {
    getObservabilityService: () => {
      recordAppDiagnostic: typeof recordAppDiagnosticMock;
    };
  } => ({
    getObservabilityService: () => ({
      recordAppDiagnostic: recordAppDiagnosticMock,
    }),
  }),
);

jest.mock('../agents/session-manager', () => ({
  getChatTurnConcurrencySnapshot: getChatTurnConcurrencySnapshotMock,
}));

jest.mock('../pipelines/pipeline-execution-registry', () => ({
  getActivePipelineExecutionCount: getActivePipelineExecutionCountMock,
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    admin: jest.fn(() => ({
      getResourceSnapshots: getCodexAppServerPoolResourceSnapshotsMock,
      suspendIdleWorkersForMemoryPressure:
        suspendIdleCodexAppServerPoolConnectionsForMemoryPressureMock,
    })),
  })),
}));

jest.mock(
  '@canopy/desktop-instrumentation',
  (): {
    createDesktopInstrumentationOperationKey: (value: string) => string;
  } => ({
    createDesktopInstrumentationOperationKey: (value: string) =>
      `hashed:${value}`,
  }),
);

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  failDesktopOperation: jest.fn(),
  startDesktopOperation: jest.fn(),
  succeedDesktopOperation: jest.fn(),
}));

import {
  ResourceGuardError,
  ResourceMonitorService,
  parseMacProcessTable,
  parseWindowsProcessTable,
} from '../resource-monitor/service';
import {
  failDesktopOperation,
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import {
  getPerformanceLimits,
  type PerformanceLimits,
  resetPerformanceLimitsForTests,
  updatePerformanceLimits,
} from '../lib/performance-limits';

type ExecFileCallback = (
  error: Error | null,
  stdout: string,
  stderr: string,
) => void;

interface ExecFileOptions {
  maxBuffer?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function matchingContext(context: Record<string, unknown>): unknown {
  return expect.objectContaining(context);
}

function isCriticalPressureDiagnosticCall(call: unknown[]): boolean {
  const entry = call[0];
  return isRecord(entry) && entry.kind === 'resource_pressure_critical';
}

function setProcessPlatform(value: NodeJS.Platform): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value,
  });
  return (): void => {
    if (descriptor) {
      Object.defineProperty(process, 'platform', descriptor);
    }
  };
}

function installProcessTable(output: string): void {
  execFileMock.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: ExecFileOptions,
      callback: ExecFileCallback,
    ): void => {
      callback(null, output, '');
    },
  );
}

function installProcessTableSequence(outputs: string[]): void {
  let index = 0;
  execFileMock.mockImplementation(
    (
      _command: string,
      _args: string[],
      _options: ExecFileOptions,
      callback: ExecFileCallback,
    ): void => {
      const output = outputs[Math.min(index, outputs.length - 1)] ?? '';
      index += 1;
      callback(null, output, '');
    },
  );
}

function updateTestPerformanceLimits(update: Partial<PerformanceLimits>): void {
  updatePerformanceLimits({
    ...getPerformanceLimits(),
    ...update,
  });
}

describe('ResourceMonitorService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    execFileMock.mockReset();
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: ExecFileOptions,
        callback: ExecFileCallback,
      ): void => {
        callback(new Error('process table unavailable'), '', '');
      },
    );
    process.env = { ...originalEnv };
    resetPerformanceLimitsForTests();
    getChatTurnConcurrencySnapshotMock.mockReturnValue({
      activeTurns: 0,
      pendingMessages: 0,
    });
    getActivePipelineExecutionCountMock.mockReturnValue(0);
    getCodexAppServerPoolResourceSnapshotsMock.mockReturnValue([]);
    suspendIdleCodexAppServerPoolConnectionsForMemoryPressureMock.mockReturnValue(
      0,
    );
    mockOsFreemem.mockReturnValue(16 * 1024 * 1024 * 1024);
    mockOsTotalmem.mockReturnValue(64 * 1024 * 1024 * 1024);
    mockOsCpus.mockReturnValue([makeCpuInfo()]);
    getAppMetricsMock.mockReturnValue([]);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetPerformanceLimitsForTests();
    jest.restoreAllMocks();
  });

  it('parses macOS ps rows, converts RSS to bytes, and sanitizes commands', () => {
    const rows = parseMacProcessTable(
      '200 100 200 2.5 128 /usr/local/bin/node --token secret\n',
    );

    expect(rows.get(200)).toEqual({
      pid: 200,
      ppid: 100,
      pgid: 200,
      cpuPercent: 2.5,
      memoryRssBytes: 128 * 1024,
      command: 'node',
    });
  });

  it('normalizes macOS CPU by logical CPU count', () => {
    mockOsCpus.mockReturnValue(Array.from({ length: 8 }, makeCpuInfo));

    const rows = parseMacProcessTable(
      '200 100 200 400.0 128 /usr/local/bin/node --token secret\n',
    );

    expect(rows.get(200)?.cpuPercent).toBe(50);
  });

  it('parses Windows process rows and derives CPU from previous samples', () => {
    mockOsCpus.mockReturnValue(Array.from({ length: 4 }, makeCpuInfo));
    const first = parseWindowsProcessTable(
      JSON.stringify([
        {
          ProcessId: 200,
          ParentProcessId: 100,
          CpuTime100ns: 100_000_000,
          WorkingSetSize: 128 * 1024 * 1024,
          Name: 'node.exe',
          CommandLine: 'C:\\Program Files\\nodejs\\node.exe --token secret',
        },
      ]),
      new Map(),
      1_000,
    );

    const second = parseWindowsProcessTable(
      JSON.stringify([
        {
          ProcessId: 200,
          ParentProcessId: 100,
          CpuTime100ns: 140_000_000,
          WorkingSetSize: 129 * 1024 * 1024,
          Name: 'node.exe',
          CommandLine: 'C:\\Program Files\\nodejs\\node.exe --token secret',
        },
      ]),
      first.cpuSamples,
      3_000,
    );

    expect(first.rows.get(200)).toEqual(
      expect.objectContaining({
        pid: 200,
        ppid: 100,
        pgid: 200,
        cpuPercent: 0,
        memoryRssBytes: 128 * 1024 * 1024,
        command: 'node.exe',
      }),
    );
    expect(second.rows.get(200)).toEqual(
      expect.objectContaining({
        cpuPercent: 50,
        memoryRssBytes: 129 * 1024 * 1024,
      }),
    );
  });

  it('rejects empty Windows process table output', () => {
    expect(() => parseWindowsProcessTable(' \n ', new Map(), 1_000)).toThrow(
      'Windows process table output was empty',
    );
  });

  it('aggregates registered process descendants', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Applications/Canopy --secret\n` +
        '200 123 200 2.0 10 /usr/bin/node --token secret\n' +
        '201 200 200 3.0 20 /bin/sh -c secret\n',
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 7 },
        memory: { workingSetSize: 512 },
      },
    ]);

    const service = new ResourceMonitorService();
    service.registerProcess({
      id: 'pipeline-step:test',
      groupId: 'pipelines',
      kind: 'pipeline-step',
      label: 'job / step',
      pid: 200,
      metadata: {
        type: 'pipeline',
        pipeline: {
          executionId: 'exec-1',
          jobId: 'job',
          stepId: 'step',
        },
      },
    });
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    const pipelines = snapshot.groups.find((group) => group.id === 'pipelines');
    expect(pipelines?.memoryRssBytes).toBe((10 + 20) * 1024);
    expect(pipelines?.cpuPercent).toBe(5);
    expect(execFileMock).toHaveBeenCalledWith(
      '/bin/ps',
      ['-axo', 'pid=,ppid=,pgid=,pcpu=,rss=,command='],
      expect.objectContaining({ maxBuffer: 8 * 1024 * 1024 }),
      expect.any(Function),
    );
  });

  it('measures managed process completion duration from registration time', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-27T12:00:00.000Z'));

    try {
      const service = new ResourceMonitorService();
      const handle = service.registerProcess({
        id: 'codex-app-server-pool:default',
        groupId: 'codex',
        kind: 'codex-app-server-pool',
        label: 'Codex app-server',
        startedAt: '2026-05-27T11:59:00.000Z',
        metadata: {
          type: 'codex-pool',
          codexPool: {
            poolKeyLabel: 'Default pool',
            pooled: true,
            clientCount: 0,
            activeTurnCount: 0,
            initialized: false,
          },
        },
      });

      expect(startDesktopOperation).toHaveBeenCalledWith(
        'canopy.managed_process',
        expect.objectContaining({
          operationKey:
            'hashed:managed-process:codex-app-server-pool:default:1779883200000',
        }),
      );

      jest.setSystemTime(new Date('2026-05-27T12:00:01.000Z'));
      handle.update({
        startedAt: '2026-05-27T12:00:00.750Z',
      });

      jest.setSystemTime(new Date('2026-05-27T12:00:02.000Z'));
      handle.unregister();

      expect(succeedDesktopOperation).toHaveBeenCalledWith(
        'canopy.managed_process',
        expect.objectContaining({
          operationKey:
            'hashed:managed-process:codex-app-server-pool:default:1779883200000',
          context: matchingContext({
            duration_ms: 2_000,
            status: 'completed',
          }),
        }),
      );

      service.dispose();
    } finally {
      jest.useRealTimers();
    }
  });

  it('closes active managed process operations as abandoned on dispose', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-27T12:00:00.000Z'));

    try {
      const service = new ResourceMonitorService();
      const handle = service.registerProcess({
        id: 'codex-app-server-pool:default',
        groupId: 'codex',
        kind: 'codex-app-server-pool',
        label: 'Codex app-server',
        metadata: {
          type: 'codex-pool',
          codexPool: {
            poolKeyLabel: 'Default pool',
            pooled: true,
            clientCount: 1,
            activeTurnCount: 1,
            initialized: true,
          },
        },
      });

      jest.setSystemTime(new Date('2026-05-27T12:00:03.500Z'));
      service.dispose();

      expect(failDesktopOperation).toHaveBeenCalledWith(
        'canopy.managed_process',
        'abandoned',
        expect.objectContaining({
          operationKey:
            'hashed:managed-process:codex-app-server-pool:default:1779883200000',
          context: matchingContext({
            duration_ms: 3_500,
            status: 'abandoned',
          }),
        }),
      );

      handle.unregister();
      expect(succeedDesktopOperation).not.toHaveBeenCalledWith(
        'canopy.managed_process',
        expect.objectContaining({
          operationKey:
            'hashed:managed-process:codex-app-server-pool:default:1779883200000',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('attributes reparented pipeline process-group members to the pipeline step', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Applications/Canopy --secret\n` +
        '200 123 200 2.0 10 /usr/bin/node --token secret\n' +
        '202 1 200 4.0 40 /usr/local/bin/claude --token secret\n',
    );
    getAppMetricsMock.mockReturnValue([]);

    const service = new ResourceMonitorService();
    service.registerProcess({
      id: 'pipeline-step:test',
      groupId: 'pipelines',
      kind: 'pipeline-step',
      label: 'job / step',
      pid: 200,
      processGroupId: 200,
      metadata: {
        type: 'pipeline',
        pipeline: {
          executionId: 'exec-1',
          jobId: 'job',
          stepId: 'step',
        },
      },
    });
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    const pipelines = snapshot.groups.find((group) => group.id === 'pipelines');
    const other = snapshot.groups.find((group) => group.id === 'other');
    expect(pipelines?.memoryRssBytes).toBe((10 + 40) * 1024);
    expect(pipelines?.cpuPercent).toBe(6);
    expect(other?.items.some((item) => item.pid === 202)).not.toBe(true);
  });

  it('uses Electron app metrics as a successful partial snapshot on Windows', async () => {
    const restorePlatform = setProcessPlatform('win32');
    mockOsCpus.mockReturnValue(Array.from({ length: 4 }, makeCpuInfo));
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: ExecFileOptions,
        callback: ExecFileCallback,
      ): void => {
        callback(new Error('powershell unavailable'), '', '');
      },
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 40 },
        memory: { workingSetSize: 1024 },
      },
    ]);

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    expect(execFileMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        '-NoProfile',
        '-Command',
        expect.stringContaining('[int]$_.ProcessId -ne $PID'),
      ]),
      expect.objectContaining({
        maxBuffer: 8 * 1024 * 1024,
        timeout: 15_000,
        windowsHide: true,
      }),
      expect.any(Function),
    );
    const firstExecFileCall = execFileMock.mock.calls[0] as
      | [string, string[], ExecFileOptions, ExecFileCallback]
      | undefined;
    const powershellArgs = firstExecFileCall?.[1] ?? [];
    const powershellScript = powershellArgs[powershellArgs.length - 1];
    expect(powershellScript).toContain("$ErrorActionPreference = 'Stop'");
    expect(powershellScript).toContain(
      'Get-CimInstance Win32_Process -ErrorAction Stop',
    );
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.cpuPercent).toBe(40);
    expect(snapshot.memoryRssBytes).toBe(1024 * 1024);
    expect(snapshot.pressure.level).toBe('unknown');
    expect(snapshot.pressure.reasons).toContain(
      'process-table sampling unavailable',
    );
    expect(snapshot.groups.find((group) => group.id === 'app')?.items).toEqual([
      expect.objectContaining({
        kind: 'electron-main',
        label: 'Electron main',
        pid: process.pid,
      }),
    ]);
  });

  it('treats empty Windows process table output as unavailable', async () => {
    const restorePlatform = setProcessPlatform('win32');
    installProcessTable(' \n ');
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 20 },
        memory: { workingSetSize: 512 },
      },
    ]);

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    expect(snapshot.error).toBeUndefined();
    expect(snapshot.cpuPercent).toBe(20);
    expect(snapshot.memoryRssBytes).toBe(512 * 1024);
    expect(snapshot.pressure.reasons).toContain(
      'process-table sampling unavailable',
    );
    expect(snapshot.groups.find((group) => group.id === 'app')?.items).toEqual([
      expect.objectContaining({
        kind: 'electron-main',
        pid: process.pid,
      }),
    ]);
  });

  it('samples Windows process table memory, descendants, and CPU deltas', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-27T12:00:00.000Z'));
    const restorePlatform = setProcessPlatform('win32');
    mockOsCpus.mockReturnValue(Array.from({ length: 4 }, makeCpuInfo));
    installProcessTableSequence([
      JSON.stringify([
        {
          ProcessId: process.pid,
          ParentProcessId: 1,
          CpuTime100ns: 10_000_000,
          WorkingSetSize: 256 * 1024 * 1024,
          Name: 'Canopy.exe',
          CommandLine: 'C:\\Canopy\\Canopy.exe',
        },
        {
          ProcessId: 200,
          ParentProcessId: process.pid,
          CpuTime100ns: 100_000_000,
          WorkingSetSize: 10 * 1024 * 1024,
          Name: 'node.exe',
          CommandLine: 'C:\\Program Files\\nodejs\\node.exe script.js',
        },
        {
          ProcessId: 201,
          ParentProcessId: 200,
          CpuTime100ns: 50_000_000,
          WorkingSetSize: 20 * 1024 * 1024,
          Name: 'codex.exe',
          CommandLine: 'C:\\Users\\user\\AppData\\codex.exe',
        },
      ]),
      JSON.stringify([
        {
          ProcessId: process.pid,
          ParentProcessId: 1,
          CpuTime100ns: 10_000_000,
          WorkingSetSize: 256 * 1024 * 1024,
          Name: 'Canopy.exe',
          CommandLine: 'C:\\Canopy\\Canopy.exe',
        },
        {
          ProcessId: 200,
          ParentProcessId: process.pid,
          CpuTime100ns: 140_000_000,
          WorkingSetSize: 11 * 1024 * 1024,
          Name: 'node.exe',
          CommandLine: 'C:\\Program Files\\nodejs\\node.exe script.js',
        },
        {
          ProcessId: 201,
          ParentProcessId: 200,
          CpuTime100ns: 58_000_000,
          WorkingSetSize: 21 * 1024 * 1024,
          Name: 'codex.exe',
          CommandLine: 'C:\\Users\\user\\AppData\\codex.exe',
        },
      ]),
    ]);
    getAppMetricsMock.mockReturnValue([]);

    try {
      const service = new ResourceMonitorService();
      service.registerProcess({
        id: 'script:test',
        groupId: 'scripts',
        kind: 'script',
        label: 'test script',
        pid: 200,
        processGroupId: 200,
        metadata: { type: 'generic' },
      });

      const first = await service.sampleNow();
      jest.setSystemTime(new Date('2026-05-27T12:00:02.000Z'));
      const second = await service.sampleNow();
      service.dispose();

      const firstScripts = first.groups.find((group) => group.id === 'scripts');
      const secondScripts = second.groups.find(
        (group) => group.id === 'scripts',
      );
      const child = secondScripts?.items[0]?.children?.find(
        (item) => item.pid === 201,
      );

      expect(firstScripts?.cpuPercent).toBe(0);
      expect(secondScripts?.memoryRssBytes).toBe(32 * 1024 * 1024);
      expect(secondScripts?.processCount).toBe(2);
      expect(secondScripts?.cpuPercent).toBe(60);
      expect(child).toEqual(
        expect.objectContaining({
          label: 'codex.exe',
          cpuPercent: 10,
          memoryRssBytes: 21 * 1024 * 1024,
        }),
      );
    } finally {
      restorePlatform();
      jest.useRealTimers();
    }
  });

  it('attributes registered browser renderer metrics to the Browser group without duplicate App rows', async () => {
    const restorePlatform = setProcessPlatform('win32');
    getAppMetricsMock.mockReturnValue([
      {
        pid: 200,
        type: 'Renderer',
        cpu: { percentCPUUsage: 10 },
        memory: { workingSetSize: 512 },
      },
    ]);

    const service = new ResourceMonitorService();
    service.registerProcess({
      id: 'browser:browser-1',
      groupId: 'browser',
      kind: 'in-app-browser',
      label: 'Test page',
      pid: 200,
      metadata: {
        type: 'browser',
        browser: {
          projectId: 'project-1',
          worktreeId: 'worktree-1',
          browserId: 'browser-1',
          title: 'Test page',
          displayUrl: 'localhost:3000',
          visible: true,
          status: 'ready',
        },
      },
    });

    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    const browser = snapshot.groups.find((group) => group.id === 'browser');
    const app = snapshot.groups.find((group) => group.id === 'app');

    expect(browser?.label).toBe('Browser');
    expect(browser?.processCount).toBe(1);
    expect(browser?.memoryRssBytes).toBe(512 * 1024);
    expect(browser?.items).toEqual([
      expect.objectContaining({
        id: 'browser:browser-1',
        kind: 'in-app-browser',
        groupId: 'browser',
        label: 'Test page',
        pid: 200,
      }),
    ]);
    expect(browser?.items[0]?.metadata?.type).toBe('browser');
    expect(app?.items.some((item) => item.pid === 200)).not.toBe(true);
    expect(snapshot.memoryRssBytes).toBe(512 * 1024);
    expect(snapshot.processCount).toBe(1);
  });

  it('normalizes Electron CPU metrics over 100 by logical CPU count', async () => {
    const restorePlatform = setProcessPlatform('win32');
    mockOsCpus.mockReturnValue(Array.from({ length: 4 }, makeCpuInfo));
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 160 },
        memory: { workingSetSize: 1024 },
      },
    ]);

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    expect(snapshot.cpuPercent).toBe(40);
    expect(
      snapshot.groups.find((group) => group.id === 'app')?.cpuPercent,
    ).toBe(40);
  });

  it('does not double count nested pipeline rollup resources in totals', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Applications/Canopy --secret\n` +
        `200 ${String(process.pid)} 200 2.0 10 /usr/bin/node --token secret\n` +
        '201 200 200 3.0 20 /usr/local/bin/claude --token secret\n',
    );
    getAppMetricsMock.mockReturnValue([]);

    const service = new ResourceMonitorService();
    service.registerWorkItem({
      id: 'pipeline-execution:exec-1',
      groupId: 'pipelines',
      kind: 'pipeline-execution',
      label: 'Review pipeline',
      metadata: {
        type: 'pipeline',
        pipeline: {
          executionId: 'exec-1',
          pipelineId: 'review-pipeline',
          pipelineName: 'Review pipeline',
        },
      },
    });
    service.registerProcess({
      id: 'pipeline-step:exec-1:review:agent:1:200',
      groupId: 'pipelines',
      kind: 'pipeline-step',
      label: 'review / agent',
      pid: 200,
      processGroupId: 200,
      metadata: {
        type: 'pipeline',
        pipeline: {
          executionId: 'exec-1',
          pipelineId: 'review-pipeline',
          pipelineName: 'Review pipeline',
          jobId: 'review',
          stepId: 'agent',
          attempt: 1,
        },
      },
    });
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    const pipelines = snapshot.groups.find((group) => group.id === 'pipelines');
    const execution = pipelines?.items.find(
      (item) => item.kind === 'pipeline-execution',
    );
    const step = execution?.children?.find(
      (item) => item.kind === 'pipeline-step',
    );
    const subprocess = step?.children?.find((item) => item.pid === 201);

    expect(execution?.memoryRssBytes).toBe((10 + 20) * 1024);
    expect(step?.memoryRssBytes).toBe((10 + 20) * 1024);
    expect(subprocess?.memoryRssBytes).toBe(20 * 1024);
    expect(pipelines?.memoryRssBytes).toBe((10 + 20) * 1024);
    expect(pipelines?.cpuPercent).toBe(5);
    expect(pipelines?.processCount).toBe(2);
    expect(snapshot.memoryRssBytes).toBe((10 + 20) * 1024);
    expect(snapshot.cpuPercent).toBe(5);
    expect(snapshot.processCount).toBe(2);
  });

  it('classifies unregistered claude descendants into the Claude group', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Applications/Canopy --secret\n` +
        `200 ${String(process.pid)} 200 2.0 10 /usr/local/bin/claude --token secret\n` +
        `201 ${String(process.pid)} 201 3.0 20 /usr/bin/node --token secret\n`,
    );
    getAppMetricsMock.mockReturnValue([]);

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    const claude = snapshot.groups.find((group) => group.id === 'claude');
    const other = snapshot.groups.find((group) => group.id === 'other');
    expect(claude?.label).toBe('Claude');
    expect(claude?.processCount).toBe(1);
    expect(claude?.items[0]).toEqual(
      expect.objectContaining({
        id: 'claude:200',
        kind: 'chat-provider',
        groupId: 'claude',
        label: 'claude',
        pid: 200,
      }),
    );
    expect(other?.processCount).toBe(1);
    expect(other?.items[0]?.pid).toBe(201);
  });

  it('classifies unregistered Windows .exe provider descendants into provider groups', async () => {
    const restorePlatform = setProcessPlatform('win32');
    installProcessTable(
      JSON.stringify([
        {
          ProcessId: process.pid,
          ParentProcessId: 1,
          CpuTime100ns: 10_000_000,
          WorkingSetSize: 256 * 1024 * 1024,
          Name: 'Canopy.exe',
          CommandLine: 'C:\\Canopy\\Canopy.exe',
        },
        {
          ProcessId: 200,
          ParentProcessId: process.pid,
          CpuTime100ns: 20_000_000,
          WorkingSetSize: 10 * 1024 * 1024,
          Name: 'codex.exe',
          CommandLine: 'C:\\Users\\user\\AppData\\codex.exe',
        },
        {
          ProcessId: 201,
          ParentProcessId: process.pid,
          CpuTime100ns: 30_000_000,
          WorkingSetSize: 20 * 1024 * 1024,
          Name: 'claude.exe',
          CommandLine: 'C:\\Users\\user\\AppData\\claude.exe',
        },
        {
          ProcessId: 202,
          ParentProcessId: process.pid,
          CpuTime100ns: 40_000_000,
          WorkingSetSize: 30 * 1024 * 1024,
          Name: 'node.exe',
          CommandLine: 'C:\\Program Files\\nodejs\\node.exe script.js',
        },
      ]),
    );
    getAppMetricsMock.mockReturnValue([]);

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    const codex = snapshot.groups.find((group) => group.id === 'codex');
    const claude = snapshot.groups.find((group) => group.id === 'claude');
    const other = snapshot.groups.find((group) => group.id === 'other');

    expect(codex?.items[0]).toEqual(
      expect.objectContaining({
        id: 'codex:200',
        kind: 'chat-provider',
        groupId: 'codex',
        label: 'codex.exe',
        pid: 200,
      }),
    );
    expect(claude?.items[0]).toEqual(
      expect.objectContaining({
        id: 'claude:201',
        kind: 'chat-provider',
        groupId: 'claude',
        label: 'claude.exe',
        pid: 201,
      }),
    );
    expect(other?.processCount).toBe(1);
    expect(other?.items[0]?.pid).toBe(202);
  });

  it('classifies unregistered codex descendants into the Codex group', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Applications/Canopy --secret\n` +
        `200 ${String(process.pid)} 200 2.0 10 /usr/local/bin/codex --model gpt-5\n` +
        `201 ${String(process.pid)} 201 3.0 20 /usr/bin/node --token secret\n`,
    );
    getAppMetricsMock.mockReturnValue([]);

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    const codex = snapshot.groups.find((group) => group.id === 'codex');
    const other = snapshot.groups.find((group) => group.id === 'other');
    expect(codex?.label).toBe('Codex');
    expect(codex?.processCount).toBe(1);
    expect(codex?.items[0]).toEqual(
      expect.objectContaining({
        id: 'codex:200',
        kind: 'chat-provider',
        groupId: 'codex',
        label: 'codex',
        pid: 200,
      }),
    );
    expect(other?.processCount).toBe(1);
    expect(other?.items[0]?.pid).toBe(201);
  });

  it('hides Codex app-server pools without a running process from resource list items', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Applications/Canopy --secret\n` +
        `200 ${String(process.pid)} 200 2.0 10 /usr/local/bin/codex app-server\n`,
    );
    getAppMetricsMock.mockReturnValue([]);
    getCodexAppServerPoolResourceSnapshotsMock.mockReturnValue([
      {
        poolKey: 'default',
        poolKeyLabel: 'Default pool',
        pooled: true,
        clientCount: 1,
        activeTurnCount: 0,
      },
    ]);

    const service = new ResourceMonitorService();
    service.registerProcess({
      id: 'codex-app-server-pool:default',
      groupId: 'codex',
      kind: 'codex-app-server-pool',
      label: 'Codex app-server',
      metadata: {
        type: 'codex-pool',
        codexPool: {
          poolKeyLabel: 'Default pool',
          pooled: true,
          clientCount: 1,
          activeTurnCount: 0,
          initialized: false,
        },
      },
    });
    service.registerProcess({
      id: 'codex-app-server-pool:env:abcdef123456',
      groupId: 'codex',
      kind: 'codex-app-server-pool',
      label: 'Codex app-server (env pool abcdef12)',
      pid: 200,
      metadata: {
        type: 'codex-pool',
        codexPool: {
          poolKeyLabel: 'Env pool abcdef12',
          pooled: true,
          clientCount: 1,
          activeTurnCount: 0,
          initialized: true,
        },
      },
    });

    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    const codex = snapshot.groups.find((group) => group.id === 'codex');
    expect(codex?.items).toEqual([
      expect.objectContaining({
        id: 'codex-app-server-pool:env:abcdef123456',
        pid: 200,
      }),
    ]);
    expect(snapshot.guards.codexPools.activeConnections).toBe(1);
  });

  it('throws ResourceGuardError when chat concurrency is blocked', async () => {
    updateTestPerformanceLimits({
      maxActiveChatTurns: 1,
      maxActivePipelineExecutions: 5,
    });
    getChatTurnConcurrencySnapshotMock.mockReturnValue({
      activeTurns: 1,
      pendingMessages: 0,
    });
    const service = new ResourceMonitorService();

    await expect(service.assertCanStartChatTurn()).rejects.toThrow(
      ResourceGuardError,
    );
    await expect(service.assertCanStartChatTurn()).rejects.toThrow(
      'Canopy is already running 1 chat turns. Wait for one to finish before starting another.',
    );
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'resource_guard_blocked_chat',
      }),
    );
  });

  it('counts in-flight chat start reservations before sessions are queued', async () => {
    updateTestPerformanceLimits({
      maxActiveChatTurns: 1,
      maxActivePipelineExecutions: 5,
    });
    const service = new ResourceMonitorService();

    const reservation = await service.reserveChatTurnStart();

    await expect(service.reserveChatTurnStart()).rejects.toThrow(
      'Canopy is already running 1 chat turns. Wait for one to finish before starting another.',
    );
    reservation.release();
    const nextReservation = await service.reserveChatTurnStart();
    nextReservation.release();
  });

  it('counts in-flight pipeline start reservations before executions are tracked', () => {
    updateTestPerformanceLimits({
      maxActiveChatTurns: 10,
      maxActivePipelineExecutions: 1,
    });
    const service = new ResourceMonitorService();

    const reservation = service.reservePipelineExecutionStart();

    expect(() => service.reservePipelineExecutionStart()).toThrow(
      ResourceGuardError,
    );
    expect(() => service.reservePipelineExecutionStart()).toThrow(
      'Canopy is already running 1 pipeline executions. Wait for one to finish before starting another pipeline.',
    );
    reservation.release();
    const nextReservation = service.reservePipelineExecutionStart();
    nextReservation.release();
    expect(recordAppDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'resource_guard_blocked_pipeline',
      }),
    );
  });

  it('blocks pipeline starts when tracked executions are at the configured limit', () => {
    updateTestPerformanceLimits({
      maxActiveChatTurns: 10,
      maxActivePipelineExecutions: 2,
    });
    getActivePipelineExecutionCountMock.mockReturnValue(2);
    const service = new ResourceMonitorService();

    expect(() => service.reservePipelineExecutionStart()).toThrow(
      'Canopy is already running 2 pipeline executions. Wait for one to finish before starting another pipeline.',
    );
  });

  it('allows disabling chat and pipeline concurrency caps', async () => {
    updateTestPerformanceLimits({
      maxActiveChatTurns: null,
      maxActivePipelineExecutions: null,
    });
    getChatTurnConcurrencySnapshotMock.mockReturnValue({
      activeTurns: 100,
      pendingMessages: 100,
    });
    getActivePipelineExecutionCountMock.mockReturnValue(100);
    const service = new ResourceMonitorService();

    const chatReservation = await service.reserveChatTurnStart();
    const pipelineReservation = service.reservePipelineExecutionStart();

    chatReservation.release();
    pipelineReservation.release();
  });

  it('records critical pressure once and throttles idle Codex pool suspension sweeps', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    updateTestPerformanceLimits({
      memoryPressureGuardEnabled: true,
      memoryPressureWarningThresholdBytes: 1,
      memoryPressureCriticalThresholdBytes: 2,
    });
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Canopy\n`,
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 1 },
        memory: { workingSetSize: 256 },
      },
    ]);
    suspendIdleCodexAppServerPoolConnectionsForMemoryPressureMock.mockReturnValue(
      3,
    );

    const service = new ResourceMonitorService();
    await service.sampleNow();
    await service.sampleNow();
    restorePlatform();

    expect(
      suspendIdleCodexAppServerPoolConnectionsForMemoryPressureMock,
    ).toHaveBeenCalledTimes(1);
    const criticalCall: unknown = recordAppDiagnosticMock.mock.calls.find(
      isCriticalPressureDiagnosticCall,
    );
    if (!Array.isArray(criticalCall) || !isRecord(criticalCall[0])) {
      throw new TypeError('Expected a critical resource-pressure diagnostic');
    }
    expect(criticalCall[0]).toMatchObject({
      kind: 'resource_pressure_critical',
      suspendedCodexPoolCount: 3,
    });
    for (const field of [
      'mainHeapUsedBytes',
      'mainHeapTotalBytes',
      'mainHeapLimitBytes',
      'mainRssBytes',
      'mainExternalBytes',
      'mainArrayBufferBytes',
    ] as const) {
      expect(typeof criticalCall[0][field]).toBe('number');
    }
    expect(
      recordAppDiagnosticMock.mock.calls.filter(
        isCriticalPressureDiagnosticCall,
      ),
    ).toHaveLength(1);
  });

  it('caches thresholds until performance limits change', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    updateTestPerformanceLimits({
      memoryPressureWarningThresholdBytes: 1_000_000,
      memoryPressureCriticalThresholdBytes: 2_000_000,
    });
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 1 /Canopy\n`,
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 1 },
        memory: { workingSetSize: 1 },
      },
    ]);
    mockOsTotalmem.mockClear();

    const service = new ResourceMonitorService();
    await service.sampleNow();
    await service.sampleNow();

    expect(mockOsTotalmem).toHaveBeenCalledTimes(1);

    updateTestPerformanceLimits({
      memoryPressureWarningThresholdBytes: 2_000_000,
      memoryPressureCriticalThresholdBytes: 3_000_000,
    });
    await service.sampleNow();
    service.dispose();
    restorePlatform();

    expect(mockOsTotalmem).toHaveBeenCalledTimes(2);
  });

  it('uses 2 GiB warning and 4 GiB critical defaults for Canopy memory pressure', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Canopy\n`,
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 1 },
        memory: { workingSetSize: 3 * 1024 * 1024 },
      },
    ]);

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    expect(snapshot.pressure.warningMemoryBytes).toBe(2 * TEST_GIB);
    expect(snapshot.pressure.criticalMemoryBytes).toBe(4 * TEST_GIB);
    expect(snapshot.pressure.level).toBe('warning');
    expect(snapshot.pressure.reasons).toContain('Canopy memory usage elevated');
  });

  it('does not escalate pressure when only system free memory is low', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    updateTestPerformanceLimits({
      memoryPressureWarningThresholdBytes: 1_000_000,
      memoryPressureCriticalThresholdBytes: 2_000_000,
    });
    process.env.CANOPY_RESOURCE_WARNING_FREE_RATIO = '0.9';
    process.env.CANOPY_RESOURCE_CRITICAL_FREE_RATIO = '0.8';
    mockOsFreemem.mockReturnValue(1);
    mockOsTotalmem.mockReturnValue(100);
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 1 /Canopy\n`,
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 1 },
        memory: { workingSetSize: 1 },
      },
    ]);

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    const chatReservation = await service.reserveChatTurnStart();
    const pipelineReservation = service.reservePipelineExecutionStart();
    chatReservation.release();
    pipelineReservation.release();
    service.dispose();
    restorePlatform();

    expect(snapshot.pressure.level).toBe('ok');
    expect(snapshot.pressure.reasons).toEqual([]);
    expect(snapshot.guards.chatTurns.blocked).toBe(false);
    expect(snapshot.guards.pipelines.blocked).toBe(false);
  });

  it('blocks start guards when Canopy memory reaches the critical threshold', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    updateTestPerformanceLimits({
      memoryPressureGuardEnabled: true,
      memoryPressureWarningThresholdBytes: 1,
      memoryPressureCriticalThresholdBytes: 2,
    });
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Canopy\n`,
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 1 },
        memory: { workingSetSize: 256 },
      },
    ]);

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();

    await expect(service.reserveChatTurnStart()).rejects.toThrow(
      'Canopy is under high memory pressure. Wait for active work to finish before starting another chat.',
    );
    expect(() => service.reservePipelineExecutionStart()).toThrow(
      'Canopy is under high memory pressure. Stop an active chat or pipeline execution before starting another pipeline.',
    );
    service.dispose();
    restorePlatform();

    expect(snapshot.pressure.level).toBe('critical');
    expect(snapshot.pressure.reasons).toContain('Canopy memory usage critical');
    expect(snapshot.guards.chatTurns.blocked).toBe(true);
    expect(snapshot.guards.pipelines.blocked).toBe(true);
  });

  it('does not block starts when the memory pressure guard is disabled, but still suspends idle pools', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    updateTestPerformanceLimits({
      memoryPressureGuardEnabled: false,
      bypassCodexAppServerIdleTimeoutUnderCriticalPressure: true,
      memoryPressureWarningThresholdBytes: 1,
      memoryPressureCriticalThresholdBytes: 2,
    });
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Canopy\n`,
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 1 },
        memory: { workingSetSize: 256 },
      },
    ]);
    suspendIdleCodexAppServerPoolConnectionsForMemoryPressureMock.mockReturnValue(
      2,
    );

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    const chatReservation = await service.reserveChatTurnStart();
    const pipelineReservation = service.reservePipelineExecutionStart();

    chatReservation.release();
    pipelineReservation.release();
    service.dispose();
    restorePlatform();

    expect(snapshot.pressure.level).toBe('critical');
    expect(snapshot.guards.chatTurns.blocked).toBe(false);
    expect(snapshot.guards.pipelines.blocked).toBe(false);
    // Suspending an idle pooled codex process is non-destructive (it respawns
    // on next use), so reclaiming memory at critical pressure is not gated on
    // the new-work guard preference.
    expect(
      suspendIdleCodexAppServerPoolConnectionsForMemoryPressureMock,
    ).toHaveBeenCalledTimes(1);
  });

  it('keeps idle Codex pools running at critical pressure when timeout bypass is disabled', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    updateTestPerformanceLimits({
      memoryPressureGuardEnabled: false,
      bypassCodexAppServerIdleTimeoutUnderCriticalPressure: false,
      memoryPressureWarningThresholdBytes: 1,
      memoryPressureCriticalThresholdBytes: 2,
    });
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Canopy\n`,
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 1 },
        memory: { workingSetSize: 256 },
      },
    ]);

    const service = new ResourceMonitorService();
    const snapshot = await service.sampleNow();
    service.dispose();
    restorePlatform();

    expect(snapshot.pressure.level).toBe('critical');
    expect(
      suspendIdleCodexAppServerPoolConnectionsForMemoryPressureMock,
    ).not.toHaveBeenCalled();
  });

  it('skips renderer broadcasts while consecutive snapshots are materially unchanged', async () => {
    const restorePlatform = setProcessPlatform('darwin');
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 1.0 256 /Canopy\n`,
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 1 },
        memory: { workingSetSize: 256 },
      },
    ]);
    const sendMock = jest.fn();
    const fakeWindow = {
      isDestroyed: (): boolean => false,
      isFocused: (): boolean => true,
      webContents: {
        isDestroyed: (): boolean => false,
        send: sendMock,
      },
    };

    const service = new ResourceMonitorService();
    // NODE_ENV=test short-circuits the sampling loop, but `start` still wires
    // the window getter used by `broadcast`.
    service.start(() => fakeWindow);
    await service.sampleNow();
    await service.sampleNow();
    // Second identical snapshot is suppressed.
    expect(sendMock).toHaveBeenCalledTimes(1);

    // A materially different sample (CPU/RSS beyond the signature buckets)
    // broadcasts again.
    installProcessTable(
      `${String(process.pid)} 1 ${String(process.pid)} 50.0 262144 /Canopy\n`,
    );
    getAppMetricsMock.mockReturnValue([
      {
        pid: process.pid,
        type: 'Browser',
        cpu: { percentCPUUsage: 50 },
        memory: { workingSetSize: 262144 },
      },
    ]);
    await service.sampleNow();
    expect(sendMock).toHaveBeenCalledTimes(2);

    service.dispose();
    restorePlatform();
  });
});

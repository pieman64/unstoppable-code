import {
  IPC_CHANNELS,
  type CanopyApi,
  type CreateMemoryReportResult,
  type MemoryDiagnosticsStatus,
} from '@canopy/desktop-shared/types';

type IpcRendererListener = (event: unknown, data: unknown) => void;

const exposed = new Map<string, unknown>();
const mockExposeInMainWorld = jest.fn<void, [string, unknown]>(
  (key: string, value: unknown): void => {
    exposed.set(key, value);
  },
);
const mockInvoke = jest.fn<Promise<unknown>, [string, ...unknown[]]>();
const mockOn = jest.fn<void, [string, IpcRendererListener]>();
const mockRemoveListener = jest.fn<void, [string, IpcRendererListener]>();
const mockSendSync = jest.fn<{ ollama: [] }, []>(() => ({ ollama: [] }));

jest.mock('@canopy/desktop-instrumentation/electron/preload', () => ({}));
jest.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: mockExposeInMainWorld,
  },
  ipcRenderer: {
    invoke: mockInvoke,
    on: mockOn,
    removeListener: mockRemoveListener,
    sendSync: mockSendSync,
  },
}));
jest.mock('@electron-toolkit/preload', () => ({
  electronAPI: {},
}));
jest.mock(
  '../api/bundles-api',
  (): { createBundlesAPI: () => Record<string, never> } => ({
    createBundlesAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/pipelines-api',
  (): { createPipelinesAPI: () => Record<string, never> } => ({
    createPipelinesAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/plugins-api',
  (): { createPluginsAPI: () => Record<string, never> } => ({
    createPluginsAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/mcp-servers-api',
  (): { createMcpServersAPI: () => Record<string, never> } => ({
    createMcpServersAPI: (): Record<string, never> => ({}),
  }),
);
jest.mock(
  '../api/skills-api',
  (): { createSkillsAPI: () => Record<string, never> } => ({
    createSkillsAPI: (): Record<string, never> => ({}),
  }),
);

function isCanopyApi(value: unknown): value is CanopyApi {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('memoryDiagnostics' in value)
  ) {
    return false;
  }
  const memoryDiagnostics = value.memoryDiagnostics;
  return (
    typeof memoryDiagnostics === 'object' &&
    memoryDiagnostics !== null &&
    'getStatus' in memoryDiagnostics &&
    typeof memoryDiagnostics.getStatus === 'function' &&
    'createReport' in memoryDiagnostics &&
    typeof memoryDiagnostics.createReport === 'function' &&
    'revealReport' in memoryDiagnostics &&
    typeof memoryDiagnostics.revealReport === 'function'
  );
}

function loadApi(): CanopyApi {
  exposed.clear();
  jest.isolateModules((): void => {
    Object.defineProperty(process, 'contextIsolated', {
      configurable: true,
      value: true,
    });
    jest.requireActual('../index');
  });
  const api: unknown = exposed.get('api');
  if (!isCanopyApi(api)) {
    throw new Error('preload API was not exposed');
  }
  return api;
}

describe('preload memoryDiagnostics API', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInvoke.mockReset();
  });

  it('invokes each channel with its expected arguments and returns the results', async () => {
    const status: MemoryDiagnosticsStatus = {
      enabled: true,
      samplingActive: true,
      samplingUnavailableReason: null,
      mainHeapUsedBytes: 1024,
      mainHeapLimitBytes: 4096,
      rendererCount: 2,
      estimatedReportSeconds: 4,
      reportInProgress: false,
      lastReport: null,
    };
    const report: CreateMemoryReportResult = {
      ok: true,
      report: {
        reportId: 'report-20261021T163000Z',
        kind: 'report',
        createdAt: '2026-10-21T16:30:00.000Z',
        fileCount: 3,
        totalBytes: 1024,
        durationMs: 1500,
        samplingIncluded: true,
      },
    };
    mockInvoke
      .mockResolvedValueOnce(status)
      .mockResolvedValueOnce(report)
      .mockResolvedValueOnce(false);

    const api = loadApi().memoryDiagnostics;

    await expect(api.getStatus()).resolves.toEqual(status);
    await expect(api.createReport()).resolves.toEqual(report);
    await expect(api.revealReport('report-20261021T163000Z')).resolves.toBe(
      false,
    );

    expect(mockInvoke.mock.calls).toStrictEqual([
      [IPC_CHANNELS.memoryDiagnosticsGetStatus],
      [IPC_CHANNELS.memoryDiagnosticsCreateReport],
      [IPC_CHANNELS.memoryDiagnosticsRevealReport, 'report-20261021T163000Z'],
    ]);
  });
});

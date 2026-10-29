import {
  IPC_CHANNELS,
  type CreateMemoryReportResult,
  type MemoryDiagnosticsStatus,
} from '@canopy/desktop-shared/types';

interface FakeIpcEvent {
  sender: { id: number };
}

type CapturedHandler = (event: FakeIpcEvent, reportId?: unknown) => unknown;

const handlers = new Map<string, CapturedHandler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: CapturedHandler): void => {
    handlers.set(channel, handler);
  },
}));

const mockGetStatus = jest.fn<Promise<MemoryDiagnosticsStatus>, []>();
const mockCreateReport = jest.fn<Promise<CreateMemoryReportResult>, []>();
const mockResolveReportPath = jest.fn<string | null, [string]>();
const mockService = {
  getStatus: mockGetStatus,
  createReport: mockCreateReport,
  resolveReportPath: mockResolveReportPath,
};
jest.mock('../../memory-diagnostics', () => ({
  getMemoryDiagnosticsService: (): typeof mockService => mockService,
}));

const mockShowItemInFolder = jest.fn<void, [string]>();
jest.mock('electron', () => ({
  shell: {
    showItemInFolder: (path: string): void => mockShowItemInFolder(path),
  },
}));

import { registerMemoryDiagnosticsHandlers } from '../memory-diagnostics';

const event: FakeIpcEvent = { sender: { id: 7 } };

function handler(channel: string): CapturedHandler {
  const registered = handlers.get(channel);
  if (registered === undefined) throw new Error(`No handler for ${channel}`);
  return registered;
}

function invoke(channel: string, reportId?: unknown): Promise<unknown> {
  return Promise.resolve(handler(channel)(event, reportId));
}

describe('memory diagnostics IPC', () => {
  beforeEach(() => {
    handlers.clear();
    jest.clearAllMocks();
    mockResolveReportPath.mockReturnValue(null);
    registerMemoryDiagnosticsHandlers();
  });

  it('forwards status and report service results directly', async () => {
    const status: MemoryDiagnosticsStatus = {
      enabled: false,
      samplingActive: false,
      samplingUnavailableReason: null,
      mainHeapUsedBytes: 12,
      mainHeapLimitBytes: 34,
      rendererCount: 0,
      estimatedReportSeconds: 0,
      reportInProgress: false,
      lastReport: null,
    };
    const report: CreateMemoryReportResult = {
      ok: false,
      reason: 'disabled',
      message: 'Enable memory diagnostics before creating a report.',
    };
    const statusResult = Promise.resolve(status);
    const reportResult = Promise.resolve(report);
    mockGetStatus.mockReturnValue(statusResult);
    mockCreateReport.mockReturnValue(reportResult);

    const returnedStatus = handler(IPC_CHANNELS.memoryDiagnosticsGetStatus)(
      event,
    );
    const returnedReport = handler(IPC_CHANNELS.memoryDiagnosticsCreateReport)(
      event,
    );
    expect(returnedStatus).toBe(statusResult);
    expect(returnedReport).toBe(reportResult);
    await expect(Promise.resolve(returnedStatus)).resolves.toBe(status);
    await expect(Promise.resolve(returnedReport)).resolves.toBe(report);
    expect(mockGetStatus).toHaveBeenCalledTimes(1);
    expect(mockCreateReport).toHaveBeenCalledTimes(1);
  });

  it('keeps a deferred report invocation pending and invokes the service once', async () => {
    const report: CreateMemoryReportResult = {
      ok: false,
      reason: 'failed',
      message: 'The report could not be created.',
    };
    let completeReport: (result: CreateMemoryReportResult) => void = () => {
      throw new Error('Report was not deferred');
    };
    mockCreateReport.mockReturnValue(
      new Promise<CreateMemoryReportResult>((resolve) => {
        completeReport = resolve;
      }),
    );

    let settled = false;
    const invocation = Promise.resolve(
      handler(IPC_CHANNELS.memoryDiagnosticsCreateReport)(event),
    );
    void invocation.then(() => {
      settled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    expect(mockCreateReport).toHaveBeenCalledTimes(1);

    completeReport(report);
    await expect(invocation).resolves.toBe(report);
    expect(mockCreateReport).toHaveBeenCalledTimes(1);
  });

  it('reveals only the resolved path for a valid service report id', () => {
    const reportId = 'report-20261021T162619Z';
    const resolvedPath = '/tmp/canopy-memory-reports/report-20261021T162619Z';
    mockResolveReportPath.mockReturnValue(resolvedPath);

    expect(
      handler(IPC_CHANNELS.memoryDiagnosticsRevealReport)(event, reportId),
    ).toBe(true);

    expect(mockResolveReportPath).toHaveBeenCalledWith(reportId);
    expect(mockShowItemInFolder).toHaveBeenCalledWith(resolvedPath);
  });

  it.each([null, undefined, 17, {}, ['report-20261021T162619Z']])(
    'returns false for a non-string report id (%p)',
    async (reportId) => {
      await expect(
        invoke(IPC_CHANNELS.memoryDiagnosticsRevealReport, reportId),
      ).resolves.toBe(false);
      expect(mockResolveReportPath).not.toHaveBeenCalled();
      expect(mockShowItemInFolder).not.toHaveBeenCalled();
    },
  );

  it.each([
    '../report-20261021T162619Z',
    '/tmp/report-20261021T162619Z',
    'C:\\reports\\report-20261021T162619Z',
  ])(
    'rejects a path-like report id before the service (%s)',
    async (reportId) => {
      await expect(
        invoke(IPC_CHANNELS.memoryDiagnosticsRevealReport, reportId),
      ).resolves.toBe(false);
      expect(mockResolveReportPath).not.toHaveBeenCalled();
      expect(mockShowItemInFolder).not.toHaveBeenCalled();
    },
  );

  it('rejects a wrong-case report id before the service', async () => {
    const reportId = 'report-20261021t162619z';

    await expect(
      invoke(IPC_CHANNELS.memoryDiagnosticsRevealReport, reportId),
    ).resolves.toBe(false);

    expect(mockResolveReportPath).not.toHaveBeenCalled();
    expect(mockShowItemInFolder).not.toHaveBeenCalled();
  });

  it('does not pass an overlong ID to the service', async () => {
    const reportId = `report-${'1'.repeat(64)}`;

    await expect(
      invoke(IPC_CHANNELS.memoryDiagnosticsRevealReport, reportId),
    ).resolves.toBe(false);

    expect(mockResolveReportPath).not.toHaveBeenCalled();
    expect(mockShowItemInFolder).not.toHaveBeenCalled();
  });

  it('returns false for an unknown safe id without showing anything', async () => {
    const reportId = 'report-00000000T000000Z';
    mockResolveReportPath.mockReturnValue(null);

    await expect(
      invoke(IPC_CHANNELS.memoryDiagnosticsRevealReport, reportId),
    ).resolves.toBe(false);

    expect(mockResolveReportPath).toHaveBeenCalledWith(reportId);
    expect(mockShowItemInFolder).not.toHaveBeenCalled();
  });
});

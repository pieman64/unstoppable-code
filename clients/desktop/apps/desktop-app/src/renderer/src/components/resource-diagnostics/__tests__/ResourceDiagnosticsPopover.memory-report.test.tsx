/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  MemoryDiagnosticsStatus,
  MemoryReportSummary,
} from '@canopy/desktop-shared/types';
import { useMemoryReportStore } from '@/stores/memoryReportStore';
import { ResourceDiagnosticsPopover } from '../ResourceDiagnosticsPopover';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const report: MemoryReportSummary = {
  reportId: 'report-20261026T180004Z',
  kind: 'report',
  createdAt: '2026-10-26T18:00:04.949Z',
  fileCount: 5,
  totalBytes: 1024,
  durationMs: 100,
  samplingIncluded: true,
};

function status(
  overrides: Partial<MemoryDiagnosticsStatus>,
): MemoryDiagnosticsStatus {
  return {
    enabled: true,
    samplingActive: true,
    samplingUnavailableReason: null,
    mainHeapUsedBytes: 1,
    mainHeapLimitBytes: 2,
    rendererCount: 1,
    estimatedReportSeconds: 4,
    reportInProgress: false,
    lastReport: null,
    ...overrides,
  };
}

const getStatus = jest.fn<Promise<MemoryDiagnosticsStatus>, []>();
const revealReport = jest.fn<Promise<boolean>, [string]>();

let container: HTMLDivElement;
let root: Root;
let onClose: jest.Mock<void, []>;

async function renderPopover(
  diagnostics: MemoryDiagnosticsStatus,
): Promise<void> {
  getStatus.mockResolvedValue(diagnostics);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  onClose = jest.fn<void, []>();
  await act(async (): Promise<void> => {
    root.render(
      <ResourceDiagnosticsPopover
        snapshot={null}
        error={null}
        onClose={onClose}
      />,
    );
    await Promise.resolve();
  });
}

function footer(): HTMLElement | null {
  return container.querySelector(
    '[data-testid="resource-diagnostics-popover-memory-report"]',
  );
}

function button(testId: string): HTMLButtonElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Button ${testId} was not rendered`);
  }
  return element;
}

beforeEach(() => {
  useMemoryReportStore.setState({
    flow: { phase: 'idle' },
    lastReport: null,
    checking: false,
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { memoryDiagnostics: { getStatus, revealReport } },
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.clearAllMocks();
  Reflect.deleteProperty(window, 'api');
});

describe('ResourceDiagnosticsPopover memory report footer', () => {
  it('stays hidden while memory diagnostics are off', async () => {
    await renderPopover(status({ enabled: false, lastReport: report }));

    expect(footer()).toBeNull();
  });

  it('starts a report from the app-wide flow and closes the popover', async () => {
    await renderPopover(status({}));

    expect(footer()?.textContent).toContain('Memory report');
    expect(
      button('resource-diagnostics-popover-create-report').getAttribute(
        'aria-label',
      ),
    ).toBe('Create memory report');
    expect(
      container.querySelector(
        '[data-testid="resource-diagnostics-popover-open-report"]',
      ),
    ).toBeNull();

    await act(async (): Promise<void> => {
      button('resource-diagnostics-popover-create-report').click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(useMemoryReportStore.getState().flow).toEqual({
      phase: 'confirming',
      estimate: 'about 4 seconds',
    });
  });

  it('opens the newest report folder and reports a missing one in place', async () => {
    await renderPopover(status({ lastReport: report }));
    revealReport.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await act(async (): Promise<void> => {
      button('resource-diagnostics-popover-open-report').click();
      await Promise.resolve();
    });
    expect(revealReport).toHaveBeenCalledWith(report.reportId);
    expect(footer()?.querySelector('[role="alert"]')).toBeNull();

    await act(async (): Promise<void> => {
      button('resource-diagnostics-popover-open-report').click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(footer()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't open the folder",
    );
  });

  it('disables report creation while a report is under way', async () => {
    await renderPopover(status({ lastReport: report }));

    act(() => {
      useMemoryReportStore.setState({
        flow: { phase: 'generating', estimate: null },
      });
    });

    expect(button('resource-diagnostics-popover-create-report').disabled).toBe(
      true,
    );
    expect(button('resource-diagnostics-popover-open-report').disabled).toBe(
      false,
    );
  });
});

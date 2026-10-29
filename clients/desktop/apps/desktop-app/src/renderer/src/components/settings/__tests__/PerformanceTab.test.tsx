/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CreateMemoryReportFailureReason,
  CreateMemoryReportResult,
  MemoryDiagnosticsStatus,
  MemoryReportSummary,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import {
  CANOPY_PREFERENCES_UPDATED_EVENT,
  emitPreferencesUpdated,
  subscribePreferencesUpdated,
} from '@/lib/preferences-events';
import { makeTestPreferences } from '@/test-utils/preferences';
import { PerformanceTab } from '../PerformanceTab';

interface MockWindowApi {
  loadPreferences: jest.Mock<Promise<PreferencesData>, []>;
  savePreferences: jest.Mock<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >;
  memoryDiagnostics: {
    getStatus: jest.Mock<Promise<MemoryDiagnosticsStatus>, []>;
    createReport: jest.Mock<Promise<CreateMemoryReportResult>, []>;
    revealReport: jest.Mock<Promise<boolean>, [string]>;
  };
}

function makeMemoryDiagnosticsStatus(
  overrides: Partial<MemoryDiagnosticsStatus> = {},
): MemoryDiagnosticsStatus {
  return {
    enabled: false,
    samplingActive: false,
    samplingUnavailableReason: null,
    mainHeapUsedBytes: 1024,
    mainHeapLimitBytes: 2048,
    rendererCount: 1,
    estimatedReportSeconds: 20,
    reportInProgress: false,
    lastReport: null,
    ...overrides,
  };
}

function makeMemoryReport(
  overrides: Partial<MemoryReportSummary> = {},
): MemoryReportSummary {
  return {
    reportId: 'private-report-id',
    kind: 'report',
    createdAt: '2026-10-21T12:00:00.000Z',
    fileCount: 3,
    totalBytes: 3 * 1024 * 1024,
    durationMs: 100,
    samplingIncluded: false,
    ...overrides,
  };
}

function installMockWindowApi(): MockWindowApi {
  const api: MockWindowApi = {
    loadPreferences: jest.fn<Promise<PreferencesData>, []>(),
    savePreferences: jest.fn<
      Promise<PreferencesData>,
      [Partial<PreferencesData>]
    >(),
    memoryDiagnostics: {
      getStatus: jest
        .fn<Promise<MemoryDiagnosticsStatus>, []>()
        .mockResolvedValue(makeMemoryDiagnosticsStatus()),
      createReport: jest
        .fn<Promise<CreateMemoryReportResult>, []>()
        .mockResolvedValue({
          ok: false,
          reason: 'failed',
          message: 'raw report failure details',
        }),
      revealReport: jest
        .fn<Promise<boolean>, [string]>()
        .mockResolvedValue(true),
    },
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  });
  return api;
}

function setWindowPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(window, 'platform', {
    configurable: true,
    value: platform,
  });
}

/**
 * Shared mirror of the inline `onChange` body used by the diagnostics toggle in
 * `PerformanceTab`. Keeping it in the test file makes the contract explicit:
 * persist with `savePreferences({ showDiagnosticsPill })`, then broadcast the
 * normalized response through `emitPreferencesUpdated(...)`.
 */
async function persistDiagnosticsToggle(nextValue: boolean): Promise<void> {
  const prefs = await window.api.savePreferences({
    showDiagnosticsPill: nextValue,
  });
  emitPreferencesUpdated(prefs);
}

describe('PerformanceTab diagnostics toggle', () => {
  let originalApiDescriptor: PropertyDescriptor | undefined;
  let originalPlatformDescriptor: PropertyDescriptor | undefined;
  let originalActEnvironmentDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'platform',
    );
    originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'IS_REACT_ACT_ENVIRONMENT',
    );
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(window, 'platform', originalPlatformDescriptor);
    } else {
      Reflect.deleteProperty(window, 'platform');
    }
    if (originalActEnvironmentDescriptor) {
      Object.defineProperty(
        globalThis,
        'IS_REACT_ACT_ENVIRONMENT',
        originalActEnvironmentDescriptor,
      );
    } else {
      Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  });

  it('persists the new value with the only changed field', async () => {
    const api = installMockWindowApi();
    api.savePreferences.mockResolvedValueOnce(
      makeTestPreferences({ showDiagnosticsPill: false }),
    );

    await persistDiagnosticsToggle(false);

    expect(api.savePreferences).toHaveBeenCalledTimes(1);
    const lastCall = api.savePreferences.mock.calls[0]?.[0];
    expect(lastCall).toEqual({ showDiagnosticsPill: false });
  });

  it('broadcasts the normalized preferences through emitPreferencesUpdated', async () => {
    const api = installMockWindowApi();
    const persisted = makeTestPreferences({ showDiagnosticsPill: true });
    api.savePreferences.mockResolvedValueOnce(persisted);

    const received: PreferencesData[] = [];
    const unsubscribe = subscribePreferencesUpdated((next) => {
      received.push(next);
    });

    await persistDiagnosticsToggle(true);

    unsubscribe();

    expect(received).toEqual([persisted]);
  });

  it('uses the documented preferences event channel', () => {
    expect(CANOPY_PREFERENCES_UPDATED_EVENT).toBe('canopy:preferences-updated');
  });

  it('successive toggles emit the latest preferences each time', async () => {
    const api = installMockWindowApi();
    const off = makeTestPreferences({ showDiagnosticsPill: false });
    const on = makeTestPreferences({ showDiagnosticsPill: true });
    api.savePreferences.mockResolvedValueOnce(off).mockResolvedValueOnce(on);

    const received: PreferencesData[] = [];
    const unsubscribe = subscribePreferencesUpdated((next) => {
      received.push(next);
    });

    await persistDiagnosticsToggle(false);
    await persistDiagnosticsToggle(true);

    unsubscribe();

    expect(received).toEqual([off, on]);
    expect(api.savePreferences.mock.calls.map((args) => args[0])).toEqual([
      { showDiagnosticsPill: false },
      { showDiagnosticsPill: true },
    ]);
  });

  it('persists and broadcasts diagnostics toggle changes from the rendered tab', async () => {
    const api = installMockWindowApi();
    const loaded = makeTestPreferences({ showDiagnosticsPill: true });
    const persisted = makeTestPreferences({ showDiagnosticsPill: false });
    api.loadPreferences.mockResolvedValueOnce(loaded);
    api.savePreferences.mockResolvedValueOnce(persisted);
    const received: PreferencesData[] = [];
    const unsubscribe = subscribePreferencesUpdated((next) => {
      received.push(next);
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      await act(async (): Promise<void> => {
        root.render(<PerformanceTab />);
        await Promise.resolve();
      });

      const toggle = findDiagnosticsToggle(container);
      expect(isOn(toggle)).toBe(true);

      await act(async (): Promise<void> => {
        toggle.click();
        await Promise.resolve();
      });

      expect(api.savePreferences).toHaveBeenCalledWith({
        showDiagnosticsPill: false,
      });
      expect(received).toEqual([persisted]);
    } finally {
      unsubscribe();
      act((): void => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('renders the keep-awake toggle on macOS, Windows, and Linux', async () => {
    const api = installMockWindowApi();
    api.loadPreferences.mockResolvedValue(
      makeTestPreferences({ keepSystemAwakeWhileAgentsActive: true }),
    );
    setWindowPlatform('darwin');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      await act(async (): Promise<void> => {
        root.render(<PerformanceTab />);
        await Promise.resolve();
      });

      expect(isOn(findKeepAwakeToggle(container))).toBe(true);
    } finally {
      act((): void => {
        root.unmount();
      });
      container.remove();
    }

    const api2 = installMockWindowApi();
    api2.loadPreferences.mockResolvedValue(makeTestPreferences());
    setWindowPlatform('win32');
    const container2 = document.createElement('div');
    document.body.appendChild(container2);
    const root2: Root = createRoot(container2);
    try {
      await act(async (): Promise<void> => {
        root2.render(<PerformanceTab />);
        await Promise.resolve();
      });

      expect(isOn(findKeepAwakeToggle(container2))).toBe(true);
    } finally {
      act((): void => {
        root2.unmount();
      });
      container2.remove();
    }

    const api3 = installMockWindowApi();
    api3.loadPreferences.mockResolvedValue(makeTestPreferences());
    setWindowPlatform('linux');
    const container3 = document.createElement('div');
    document.body.appendChild(container3);
    const root3: Root = createRoot(container3);
    try {
      await act(async (): Promise<void> => {
        root3.render(<PerformanceTab />);
        await Promise.resolve();
      });

      expect(isOn(findKeepAwakeToggle(container3))).toBe(true);
    } finally {
      act((): void => {
        root3.unmount();
      });
      container3.remove();
    }
  });

  it('saves only the keep-awake field when toggled', async () => {
    const api = installMockWindowApi();
    api.loadPreferences.mockResolvedValue(
      makeTestPreferences({ keepSystemAwakeWhileAgentsActive: true }),
    );
    api.savePreferences.mockResolvedValue(
      makeTestPreferences({ keepSystemAwakeWhileAgentsActive: false }),
    );
    setWindowPlatform('darwin');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      await act(async (): Promise<void> => {
        root.render(<PerformanceTab />);
        await Promise.resolve();
      });

      await act(async (): Promise<void> => {
        findKeepAwakeToggle(container).click();
        await Promise.resolve();
      });

      expect(api.savePreferences).toHaveBeenCalledWith({
        keepSystemAwakeWhileAgentsActive: false,
      });
    } finally {
      act((): void => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('defaults the critical-pressure Codex idle-timeout bypass on and saves only that field', async () => {
    const api = installMockWindowApi();
    api.loadPreferences.mockResolvedValue(
      makeTestPreferences({
        bypassCodexAppServerIdleTimeoutUnderCriticalPressure: true,
      }),
    );
    api.savePreferences.mockResolvedValue(
      makeTestPreferences({
        bypassCodexAppServerIdleTimeoutUnderCriticalPressure: false,
      }),
    );
    setWindowPlatform('darwin');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      await act(async (): Promise<void> => {
        root.render(<PerformanceTab />);
        await Promise.resolve();
      });

      const toggle = findCriticalPressureIdleBypassToggle(container);
      expect(isOn(toggle)).toBe(true);
      expect(container.textContent).toContain(
        'Codex app servers are closed more aggressively under critical memory pressure',
      );

      await act(async (): Promise<void> => {
        toggle.click();
        await Promise.resolve();
      });

      expect(api.savePreferences).toHaveBeenCalledWith({
        bypassCodexAppServerIdleTimeoutUnderCriticalPressure: false,
      });
    } finally {
      act((): void => {
        root.unmount();
      });
      container.remove();
    }
  });

  it('refreshes preferences after a failed keep-awake save', async () => {
    const api = installMockWindowApi();
    api.loadPreferences
      .mockResolvedValueOnce(
        makeTestPreferences({ keepSystemAwakeWhileAgentsActive: true }),
      )
      .mockResolvedValueOnce(
        makeTestPreferences({ keepSystemAwakeWhileAgentsActive: true }),
      );
    api.savePreferences.mockRejectedValueOnce(new Error('write failed'));
    setWindowPlatform('darwin');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    try {
      await act(async (): Promise<void> => {
        root.render(<PerformanceTab />);
        await Promise.resolve();
      });

      const toggle = findKeepAwakeToggle(container);
      expect(isOn(toggle)).toBe(true);

      await act(async (): Promise<void> => {
        toggle.click();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(api.loadPreferences).toHaveBeenCalledTimes(2);
      expect(isOn(findKeepAwakeToggle(container))).toBe(true);
    } finally {
      act((): void => {
        root.unmount();
      });
      container.remove();
    }
  });
});

describe('PerformanceTab memory diagnostics', () => {
  let originalApiDescriptor: PropertyDescriptor | undefined;
  let originalPlatformDescriptor: PropertyDescriptor | undefined;
  let originalActEnvironmentDescriptor: PropertyDescriptor | undefined;
  let api: MockWindowApi;
  let container: HTMLDivElement | null;
  let root: Root | null;

  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
      window,
      'platform',
    );
    originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'IS_REACT_ACT_ENVIRONMENT',
    );
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    });
    setWindowPlatform('darwin');
    api = installMockWindowApi();
    container = null;
    root = null;
  });

  afterEach(() => {
    if (root !== null) {
      const mountedRoot = root;
      act((): void => {
        mountedRoot.unmount();
      });
      root = null;
    }
    container?.remove();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
    if (originalPlatformDescriptor) {
      Object.defineProperty(window, 'platform', originalPlatformDescriptor);
    } else {
      Reflect.deleteProperty(window, 'platform');
    }
    if (originalActEnvironmentDescriptor) {
      Object.defineProperty(
        globalThis,
        'IS_REACT_ACT_ENVIRONMENT',
        originalActEnvironmentDescriptor,
      );
    } else {
      Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT');
    }
  });

  async function renderTab(
    preferences: PreferencesData = makeTestPreferences(),
  ): Promise<HTMLDivElement> {
    if (root !== null) {
      const previousRoot = root;
      act((): void => {
        previousRoot.unmount();
      });
      root = null;
    }
    container?.remove();
    const nextContainer = document.createElement('div');
    document.body.appendChild(nextContainer);
    container = nextContainer;
    const nextRoot = createRoot(nextContainer);
    root = nextRoot;
    api.loadPreferences.mockResolvedValueOnce(preferences);
    await act(async (): Promise<void> => {
      nextRoot.render(<PerformanceTab />);
      await flushPromises();
    });
    return nextContainer;
  }

  async function renderAndOpenDialog(): Promise<HTMLDivElement> {
    api.memoryDiagnostics.getStatus
      .mockResolvedValueOnce(makeMemoryDiagnosticsStatus())
      .mockResolvedValueOnce(makeMemoryDiagnosticsStatus({ enabled: true }));
    const tab = await renderTab(
      makeTestPreferences({ memoryDiagnosticsEnabled: true }),
    );
    await act(async (): Promise<void> => {
      findButton(tab, 'settings-create-memory-report').click();
      await flushPromises();
    });
    return tab;
  }

  it('saves only the memory diagnostics preference and broadcasts the response', async () => {
    const persisted = makeTestPreferences({ memoryDiagnosticsEnabled: true });
    api.savePreferences.mockResolvedValueOnce(persisted);
    const received: PreferencesData[] = [];
    const unsubscribe = subscribePreferencesUpdated((next) => {
      received.push(next);
    });
    const tab = await renderTab();

    await act(async (): Promise<void> => {
      findSwitch(
        tab,
        'settings-memory-diagnostics',
        'Memory diagnostics toggle',
      ).click();
      await flushPromises();
    });

    unsubscribe();
    expect(api.savePreferences).toHaveBeenCalledTimes(1);
    expect(api.savePreferences).toHaveBeenCalledWith({
      memoryDiagnosticsEnabled: true,
    });
    expect(received).toEqual([persisted]);
    expect(api.memoryDiagnostics.getStatus).toHaveBeenCalledTimes(1);
  });

  it('disables report creation while the preference is off and enables it while on', async () => {
    const offTab = await renderTab(
      makeTestPreferences({ memoryDiagnosticsEnabled: false }),
    );
    expect(findButton(offTab, 'settings-create-memory-report').disabled).toBe(
      true,
    );

    const onTab = await renderTab(
      makeTestPreferences({ memoryDiagnosticsEnabled: true }),
    );
    expect(findButton(onTab, 'settings-create-memory-report').disabled).toBe(
      false,
    );
  });

  it('keeps report creation disabled until turning diagnostics on has saved', async () => {
    // Main enables the service only when the save commits, so a report
    // requested sooner would be refused as disabled.
    const save = deferred<PreferencesData>();
    api.savePreferences.mockReturnValueOnce(save.promise);
    const tab = await renderTab(
      makeTestPreferences({ memoryDiagnosticsEnabled: false }),
    );

    await act(async (): Promise<void> => {
      findSwitch(
        tab,
        'settings-memory-diagnostics',
        'Memory diagnostics toggle',
      ).click();
      await flushPromises();
    });

    expect(
      isOn(
        findSwitch(
          tab,
          'settings-memory-diagnostics',
          'Memory diagnostics toggle',
        ),
      ),
    ).toBe(true);
    expect(findButton(tab, 'settings-create-memory-report').disabled).toBe(
      true,
    );
    expect(tab.textContent).not.toContain(
      'Turn on Memory diagnostics to create a report',
    );

    await act(async (): Promise<void> => {
      save.resolve(makeTestPreferences({ memoryDiagnosticsEnabled: true }));
      await flushPromises();
    });

    expect(findButton(tab, 'settings-create-memory-report').disabled).toBe(
      false,
    );
  });

  it('opens a fresh confirmation with the estimate and report-content warning', async () => {
    const tab = await renderAndOpenDialog();

    expect(api.memoryDiagnostics.getStatus).toHaveBeenCalledTimes(2);
    expect(
      document.body.querySelector(
        '[data-testid="settings-memory-report-dialog"]',
      ),
    ).not.toBeNull();
    expect(document.body.textContent).toContain('about 20 seconds');
    expect(document.body.textContent).toContain(
      'Reports can contain chat and file content, so share them only with people you trust.',
    );
    expect(
      tab.querySelector('[data-testid="settings-memory-report-dialog"]'),
    ).toBeNull();
  });

  it('closes the confirmation on cancel without creating a report', async () => {
    await renderAndOpenDialog();
    await act(async (): Promise<void> => {
      findButtonByText(document, 'Cancel').click();
      await flushPromises();
    });

    expect(
      document.body.querySelector(
        '[data-testid="settings-memory-report-dialog"]',
      ),
    ).toBeNull();
    expect(api.memoryDiagnostics.createReport).not.toHaveBeenCalled();
  });

  it('shows a busy disabled create button while the report is pending', async () => {
    const pending = deferred<CreateMemoryReportResult>();
    api.memoryDiagnostics.createReport.mockReturnValueOnce(pending.promise);
    const tab = await renderAndOpenDialog();

    await act(async (): Promise<void> => {
      findButton(document, 'settings-memory-report-confirm').click();
      await Promise.resolve();
    });

    const createButton = findButton(tab, 'settings-create-memory-report');
    expect(createButton.textContent).toContain('Creating report…');
    expect(createButton.disabled).toBe(true);
    expect(createButton.getAttribute('aria-busy')).toBe('true');

    await act(async (): Promise<void> => {
      pending.resolve({
        ok: false,
        reason: 'failed',
        message: 'private detail',
      });
      await flushPromises();
    });
  });

  it('shows a successful report size and reveals it with the platform label', async () => {
    const report = makeMemoryReport();
    api.memoryDiagnostics.createReport.mockResolvedValueOnce({
      ok: true,
      report,
    });
    const tab = await renderAndOpenDialog();

    await act(async (): Promise<void> => {
      findButton(document, 'settings-memory-report-confirm').click();
      await flushPromises();
    });

    expect(
      tab.querySelector('[data-testid="settings-memory-report-result"]')
        ?.textContent,
    ).toContain('3.0 MB');
    const revealButton = findButton(tab, 'settings-memory-report-reveal');
    expect(revealButton.textContent).toBe('Show in Finder');
    expect(tab.textContent).not.toContain(report.reportId);

    await act(async (): Promise<void> => {
      revealButton.click();
      await flushPromises();
    });

    expect(api.memoryDiagnostics.revealReport).toHaveBeenCalledWith(
      report.reportId,
    );
  });

  it.each([
    {
      reason: 'disabled',
      sentence:
        "Couldn't create the report because memory diagnostics are off. Turn on Memory diagnostics and try again.",
    },
    {
      reason: 'in-progress',
      sentence:
        "Couldn't start a report because another one is still being saved. Wait for it to finish, then try again.",
    },
    {
      reason: 'insufficient-disk',
      sentence:
        "Couldn't create the report because there isn't enough free disk space. Free up some space and try again.",
    },
    {
      reason: 'failed',
      sentence: "Couldn't create the memory report. Try again.",
    },
  ] satisfies ReadonlyArray<{
    readonly reason: CreateMemoryReportFailureReason;
    readonly sentence: string;
  }>)(
    'shows the $reason failure without backend details',
    async ({ reason, sentence }) => {
      api.memoryDiagnostics.createReport.mockResolvedValueOnce({
        ok: false,
        reason,
        message: 'private backend details',
      });
      const tab = await renderAndOpenDialog();

      await act(async (): Promise<void> => {
        findButton(document, 'settings-memory-report-confirm').click();
        await flushPromises();
      });

      const result = tab.querySelector(
        '[data-testid="settings-memory-report-result"]',
      );
      expect(result?.textContent).toContain(sentence);
      expect(result?.textContent).not.toContain('private backend details');
      expect(result?.getAttribute('role')).toBeNull();
      expect(result?.querySelector('[role="alert"]')).not.toBeNull();
    },
  );

  it('maps a rejected report request to the failed sentence', async () => {
    api.memoryDiagnostics.createReport.mockRejectedValueOnce(
      new Error('private backend details'),
    );
    const tab = await renderAndOpenDialog();

    await act(async (): Promise<void> => {
      findButton(document, 'settings-memory-report-confirm').click();
      await flushPromises();
    });

    const result = tab.querySelector(
      '[data-testid="settings-memory-report-result"]',
    );
    expect(result?.textContent).toContain(
      "Couldn't create the memory report. Try again.",
    );
    expect(result?.textContent).not.toContain('private backend details');
  });

  it('shows the mount-time last report and reveal action while diagnostics are off', async () => {
    const report = makeMemoryReport({ kind: 'auto' });
    api.memoryDiagnostics.getStatus.mockResolvedValueOnce(
      makeMemoryDiagnosticsStatus({ lastReport: report }),
    );
    const tab = await renderTab(
      makeTestPreferences({ memoryDiagnosticsEnabled: false }),
    );

    expect(api.memoryDiagnostics.getStatus).toHaveBeenCalledTimes(1);
    expect(
      tab.querySelector('[data-testid="settings-memory-report-result"]')
        ?.textContent,
    ).toContain('Last automatic snapshot');
    expect(findButton(tab, 'settings-memory-report-reveal').textContent).toBe(
      'Show in Finder',
    );
    expect(tab.textContent).not.toContain(report.reportId);
  });

  it('reports an in-progress snapshot without opening the dialog', async () => {
    api.memoryDiagnostics.getStatus
      .mockResolvedValueOnce(makeMemoryDiagnosticsStatus())
      .mockResolvedValueOnce(
        makeMemoryDiagnosticsStatus({ enabled: true, reportInProgress: true }),
      );
    const tab = await renderTab(
      makeTestPreferences({ memoryDiagnosticsEnabled: true }),
    );

    await act(async (): Promise<void> => {
      findButton(tab, 'settings-create-memory-report').click();
      await flushPromises();
    });

    expect(
      document.body.querySelector(
        '[data-testid="settings-memory-report-dialog"]',
      ),
    ).toBeNull();
    expect(
      tab.querySelector('[data-testid="settings-memory-report-result"]')
        ?.textContent,
    ).toContain(
      "Couldn't start a report because another one is still being saved. Wait for it to finish, then try again.",
    );
  });

  it('opens the fallback confirmation when the fresh status read fails', async () => {
    api.memoryDiagnostics.getStatus
      .mockResolvedValueOnce(makeMemoryDiagnosticsStatus())
      .mockRejectedValueOnce(new Error('private status details'));
    const tab = await renderTab(
      makeTestPreferences({ memoryDiagnosticsEnabled: true }),
    );

    await act(async (): Promise<void> => {
      findButton(tab, 'settings-create-memory-report').click();
      await flushPromises();
    });

    expect(
      document.body.querySelector(
        '[data-testid="settings-memory-report-dialog"]',
      ),
    ).not.toBeNull();
    expect(document.body.textContent).toContain(
      'Canopy will stop responding until the report is saved.',
    );
    expect(document.body.textContent).not.toContain('private status details');
  });
});

/** The settings are switches: `role="switch"` buttons with `aria-checked`. */
function findSwitch(
  container: HTMLElement,
  testId: string,
  name: string,
): HTMLButtonElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (
    !(element instanceof HTMLButtonElement) ||
    element.getAttribute('role') !== 'switch'
  ) {
    throw new Error(`${name} was not rendered`);
  }
  return element;
}

function isOn(toggle: HTMLButtonElement): boolean {
  return toggle.getAttribute('aria-checked') === 'true';
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function findButton(container: ParentNode, testId: string): HTMLButtonElement {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error(`Button ${testId} was not rendered`);
  }
  return element;
}

function findButtonByText(
  container: ParentNode,
  text: string,
): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (element) => element.textContent?.trim() === text,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button ${text} was not rendered`);
  }
  return button;
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: (value) => resolvePromise(value) };
}

function findDiagnosticsToggle(container: HTMLElement): HTMLButtonElement {
  return findSwitch(
    container,
    'settings-show-diagnostics-pill',
    'Diagnostics toggle',
  );
}

function findKeepAwakeToggle(container: HTMLElement): HTMLButtonElement {
  return findSwitch(
    container,
    'settings-keep-system-awake',
    'Keep-awake toggle',
  );
}

function findCriticalPressureIdleBypassToggle(
  container: HTMLElement,
): HTMLButtonElement {
  return findSwitch(
    container,
    'settings-bypass-codex-idle-timeout-under-critical-pressure',
    'Critical-pressure idle-timeout bypass',
  );
}

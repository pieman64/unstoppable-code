/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CodeGraphUiSummary,
  CodeGraphUiSummaryResponse,
} from '@canopy/desktop-shared/types';
import { CodeGraphSummaryPanel } from '../CodeGraphSummaryPanel';

const mockReportUiState = jest.fn<void, [string | null, unknown]>();
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (key: string | null, value: unknown): void => {
    mockReportUiState(key, value);
  },
}));

/**
 * Optional browser-safe snapshot readiness fields a summary may carry. They
 * are attached structurally (never as a direct object literal) so these
 * fixtures stay assignable to the existing summary type.
 */
interface SnapshotReadinessFields {
  snapshotState?: 'missing' | 'summary-pending' | 'readable' | 'read-error';
  buildState?: 'idle' | 'queued' | 'running';
  readFailure?:
    | 'queue-timeout'
    | 'execution-timeout'
    | 'busy'
    | 'worker-exit'
    | 'canceled'
    | 'invalid-response'
    | 'database-error';
}

function withSnapshot(
  base: CodeGraphUiSummary,
  fields: SnapshotReadinessFields,
): CodeGraphUiSummary & SnapshotReadinessFields {
  return { ...base, ...fields };
}

const ZERO_TOTALS: CodeGraphUiSummary['totals'] = {
  fileCount: 0,
  symbolCount: 0,
  edgeCount: 0,
  unresolvedEdgeCount: 0,
  filesWithErrors: 0,
  communityCount: 0,
  flowCount: 0,
};

function summary(
  overrides: Partial<CodeGraphUiSummary> = {},
): CodeGraphUiSummary {
  return {
    scope: 'worktree',
    enabled: true,
    state: 'ready',
    repositories: [],
    totals: {
      fileCount: 1234,
      symbolCount: 5678,
      edgeCount: 9012,
      unresolvedEdgeCount: 3,
      filesWithErrors: 1,
      communityCount: 4,
      flowCount: 2,
    },
    lastBuildAt: 1_700_000_000_000,
    ...overrides,
  };
}

interface PanelProps {
  load: jest.Mock<Promise<CodeGraphUiSummaryResponse>, []>;
  build: jest.Mock<Promise<CodeGraphUiSummaryResponse>, []>;
  onOpenSettings: jest.Mock<void, []>;
  externalBuilding?: boolean;
  reloadToken?: number;
  advisorContext?: {
    scope: 'worktree' | 'workspace-shadow';
    workspaceId: string;
    worktreeId?: string;
  };
}

async function render(
  props: PanelProps,
): Promise<{ container: HTMLElement; cleanup: () => void }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<CodeGraphSummaryPanel {...props} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function baseProps(
  load: PanelProps['load'],
  build: PanelProps['build'] = jest.fn<
    Promise<CodeGraphUiSummaryResponse>,
    []
  >(),
): PanelProps {
  return { load, build, onOpenSettings: jest.fn<void, []>() };
}

describe('CodeGraphSummaryPanel', () => {
  it('shows the disabled callout and opens Code Graph settings', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(summary({ enabled: false, state: 'missing' }));
    const props = baseProps(load);
    const { container, cleanup } = await render(props);

    expect(
      container.querySelector(
        '[data-testid="code-graph-summary-disabled-callout"]',
      ),
    ).not.toBeNull();
    const openButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-summary-open-settings"]',
    );
    expect(openButton?.textContent).toBe('Open Code Graph settings');
    act(() => openButton?.click());
    expect(props.onOpenSettings).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('renders retained data read-only when disabled with a prior graph', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(summary({ enabled: false, state: 'stale' }));
    const { container, cleanup } = await render(baseProps(load));
    expect(
      container.querySelector('[data-testid="code-graph-summary-details"]'),
    ).not.toBeNull();
    // No build action while disabled.
    expect(
      container.querySelector('[data-testid="code-graph-summary-build"]'),
    ).toBeNull();
    cleanup();
  });

  it('offers Generate for a missing graph and triggers the build', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(summary({ state: 'missing' }));
    const build = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(summary({ state: 'ready' }));
    const { container, cleanup } = await render(baseProps(load, build));

    const buildButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-summary-build"]',
    );
    expect(buildButton?.textContent).toContain('Generate Code Graph');
    act(() => buildButton?.click());
    await flush();
    expect(build).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('renders metric cards and an Update action for a ready graph', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(summary({ state: 'ready' }));
    const { container, cleanup } = await render(baseProps(load));
    expect(
      container.querySelector('[data-testid="code-graph-metric-files"]')
        ?.textContent,
    ).toContain('1,234');
    expect(
      container.querySelector('[data-testid="code-graph-summary-build"]')
        ?.textContent,
    ).toContain('Update Code Graph');
    cleanup();
  });

  it('preserves the summary and shows an inline error on build failure', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(summary({ state: 'ready' }));
    const build = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue({
        ok: false,
        code: 'internal',
        message: 'build blew up',
      });
    const { container, cleanup } = await render(baseProps(load, build));
    const buildButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="code-graph-summary-build"]',
    );
    act(() => buildButton?.click());
    await flush();
    expect(
      container.querySelector('[data-testid="code-graph-summary-build-error"]')
        ?.textContent,
    ).toContain('build blew up');
    // Summary preserved.
    expect(
      container.querySelector('[data-testid="code-graph-summary-details"]'),
    ).not.toBeNull();
    cleanup();
  });

  it('shows an error callout with retry when the load fails', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue({ ok: false, code: 'internal', message: 'nope' });
    const { container, cleanup } = await render(baseProps(load));
    expect(
      container.querySelector('[data-testid="code-graph-summary-retry"]'),
    ).not.toBeNull();
    cleanup();
  });

  it('preserves a structured error summary and offers regeneration', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(
        summary({ state: 'error', message: 'The graph could not be read.' }),
      );
    const { container, cleanup } = await render(baseProps(load));

    expect(
      container.querySelector('[data-testid="code-graph-summary-message"]')
        ?.textContent,
    ).toContain('The graph could not be read.');
    expect(
      container.querySelector('[data-testid="code-graph-summary-retry"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="code-graph-summary-build"]')
        ?.textContent,
    ).toContain('Update Code Graph');
    cleanup();
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function mount(props: PanelProps): Promise<{
  container: HTMLElement;
  rerender: (next: PanelProps) => Promise<void>;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(<CodeGraphSummaryPanel {...props} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    rerender: async (next: PanelProps): Promise<void> => {
      await act(async () => {
        root.render(<CodeGraphSummaryPanel {...next} />);
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const METRIC_TEST_IDS = [
  'code-graph-metric-files',
  'code-graph-metric-symbols',
  'code-graph-metric-edges',
  'code-graph-metric-repositories',
];

function expectNoMetricCards(container: HTMLElement): void {
  for (const testId of METRIC_TEST_IDS) {
    expect(container.querySelector(`[data-testid="${testId}"]`)).toBeNull();
  }
  const text = container.textContent ?? '';
  expect(text).not.toContain('Unresolved edges');
  expect(text).not.toContain('Files with errors');
}

function lastAdvisorPayload(): unknown {
  const calls = mockReportUiState.mock.calls.filter(
    ([key]) => key === 'codeGraph.detailPanel',
  );
  return calls[calls.length - 1]?.[1];
}

describe('CodeGraphSummaryPanel unmeasured and retained counts', () => {
  beforeEach(() => {
    mockReportUiState.mockClear();
  });

  it.each<[string, CodeGraphUiSummaryResponse]>([
    [
      'a summary-pending snapshot',
      withSnapshot(summary({ state: 'ready', totals: ZERO_TOTALS }), {
        snapshotState: 'summary-pending',
        buildState: 'queued',
      }),
    ],
    [
      'a legacy structured error summary',
      summary({ state: 'error', message: 'The graph could not be read.' }),
    ],
    [
      'a read-error snapshot with a failure reason',
      withSnapshot(
        summary({ state: 'error', message: 'The graph could not be read.' }),
        {
          snapshotState: 'read-error',
          readFailure: 'busy',
          buildState: 'idle',
        },
      ),
    ],
  ])(
    'hides unmeasured counts instead of showing graph metrics for %s',
    async (_case, response) => {
      const load = jest
        .fn<Promise<CodeGraphUiSummaryResponse>, []>()
        .mockResolvedValue(response);
      const { container, cleanup } = await render(baseProps(load));

      expect(
        container.querySelector('[data-testid="code-graph-summary"]'),
      ).not.toBeNull();
      expectNoMetricCards(container);
      const text = container.textContent ?? '';
      // Unmeasured counts are neither zero metrics nor the legacy totals.
      expect(text).not.toContain('1,234');
      expect(text).not.toContain('5,678');
      // A pending or unreadable graph is not reported as never generated.
      expect(text).not.toContain('No Code Graph has been generated yet.');
      // Internal failure tokens never become user-visible copy.
      expect(text).not.toContain('summary-pending');
      expect(text).not.toContain('read-error');
      cleanup();
    },
  );

  it.each<['queued' | 'running', boolean]>([
    ['queued', false],
    ['running', true],
  ])(
    'keeps readable retained counts visible while the source build is %s',
    async (buildState, externalBuilding) => {
      const load = jest
        .fn<Promise<CodeGraphUiSummaryResponse>, []>()
        .mockResolvedValue(
          withSnapshot(summary({ state: 'stale' }), {
            snapshotState: 'readable',
            buildState,
          }),
        );
      const { container, cleanup } = await render({
        ...baseProps(load),
        externalBuilding,
      });

      expect(
        container.querySelector('[data-testid="code-graph-metric-files"]')
          ?.textContent,
      ).toContain('1,234');
      expect(
        container.querySelector('[data-testid="code-graph-metric-symbols"]')
          ?.textContent,
      ).toContain('5,678');
      cleanup();
    },
  );

  it('reloads and shows fresh counts once an external build ends', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValueOnce(summary({ state: 'stale' }))
      .mockResolvedValueOnce(
        summary({
          state: 'ready',
          totals: { ...summary().totals, fileCount: 2000 },
        }),
      );
    const props: PanelProps = { ...baseProps(load), externalBuilding: true };
    const { container, rerender, cleanup } = await mount(props);
    // A build started elsewhere blocks starting another one here.
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="code-graph-summary-build"]',
      )?.disabled,
    ).toBe(true);

    await rerender({ ...props, externalBuilding: false });
    await flush();
    expect(load).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="code-graph-metric-files"]')
        ?.textContent,
    ).toContain('2,000');
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="code-graph-summary-build"]',
      )?.disabled,
    ).toBe(false);
    cleanup();
  });

  it('keeps retained counts on screen while the reload after an external build is pending', async () => {
    const reload = deferred<CodeGraphUiSummaryResponse>();
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValueOnce(
        withSnapshot(summary({ state: 'stale' }), {
          snapshotState: 'readable',
          buildState: 'running',
        }),
      )
      .mockReturnValueOnce(reload.promise);
    const props: PanelProps = { ...baseProps(load), externalBuilding: true };
    const { container, rerender, cleanup } = await mount(props);

    await rerender({ ...props, externalBuilding: false });
    expect(load).toHaveBeenCalledTimes(2);
    // The refresh is in flight: the retained graph stays in place instead of
    // blanking to the loading state.
    expect(
      container.querySelector('[data-testid="code-graph-summary-loading"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="code-graph-metric-files"]')
        ?.textContent,
    ).toContain('1,234');
    cleanup();
  });

  it.each<[string, () => Promise<CodeGraphUiSummaryResponse>, string]>([
    [
      'a safe error envelope',
      (): Promise<CodeGraphUiSummaryResponse> =>
        Promise.resolve({
          ok: false,
          code: 'internal',
          message: 'Could not read the Code Graph. Try again.',
        }),
      'Could not read the Code Graph. Try again.',
    ],
    [
      'a rejected read',
      (): Promise<CodeGraphUiSummaryResponse> =>
        Promise.reject(new Error('worker exited')),
      'Could not load the Code Graph summary.',
    ],
    [
      'a read-error snapshot',
      (): Promise<CodeGraphUiSummaryResponse> =>
        Promise.resolve(
          withSnapshot(
            summary({
              state: 'error',
              message: 'The graph could not be read.',
            }),
            {
              snapshotState: 'read-error',
              readFailure: 'execution-timeout',
              buildState: 'idle',
            },
          ),
        ),
      'The graph could not be read.',
    ],
  ])(
    'shows the failure and stops presenting retained counts when a reload returns %s',
    async (_case, failingRead, failureCopy) => {
      const load = jest
        .fn<Promise<CodeGraphUiSummaryResponse>, []>()
        .mockResolvedValueOnce(
          withSnapshot(summary({ state: 'ready' }), {
            snapshotState: 'readable',
            buildState: 'idle',
          }),
        )
        .mockImplementationOnce(failingRead);
      const props: PanelProps = { ...baseProps(load), reloadToken: 1 };
      const { container, rerender, cleanup } = await mount(props);
      expect(
        container.querySelector('[data-testid="code-graph-metric-files"]')
          ?.textContent,
      ).toContain('1,234');

      await rerender({ ...props, reloadToken: 2 });
      await flush();
      expect(load).toHaveBeenCalledTimes(2);
      const text = container.textContent ?? '';
      expect(text).toContain(failureCopy);
      // Counts from the earlier read are not presented as the current graph.
      expectNoMetricCards(container);
      expect(text).not.toContain('1,234');
      expect(text).not.toContain('execution-timeout');
      expect(text).not.toContain('worker exited');
      cleanup();
    },
  );

  it('keeps retained counts on screen while a host reload is in flight', async () => {
    const reload = deferred<CodeGraphUiSummaryResponse>();
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValueOnce(
        withSnapshot(summary({ state: 'ready' }), {
          snapshotState: 'readable',
          buildState: 'idle',
        }),
      )
      .mockReturnValueOnce(reload.promise);
    const props: PanelProps = { ...baseProps(load), reloadToken: 1 };
    const { container, rerender, cleanup } = await mount(props);

    await rerender({ ...props, reloadToken: 2 });
    expect(load).toHaveBeenCalledTimes(2);
    expect(
      container.querySelector('[data-testid="code-graph-summary-loading"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="code-graph-metric-files"]')
        ?.textContent,
    ).toContain('1,234');
    cleanup();
  });

  it('shows a safe load failure without metrics or internal failure tokens', async () => {
    const failure = {
      ok: false as const,
      code: 'internal' as const,
      message: 'Could not read the Code Graph. Try again.',
      detail: { readFailure: 'queue-timeout' },
    };
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(failure);
    const { container, cleanup } = await render(baseProps(load));

    expect(
      container.querySelector('[data-testid="code-graph-summary-error"]')
        ?.textContent,
    ).toContain('Could not read the Code Graph. Try again.');
    expect(
      container.querySelector('[data-testid="code-graph-summary-retry"]'),
    ).not.toBeNull();
    expectNoMetricCards(container);
    expect(container.textContent ?? '').not.toContain('queue-timeout');
    cleanup();
  });
});

describe('CodeGraphSummaryPanel App Advisor readiness metadata', () => {
  beforeEach(() => {
    mockReportUiState.mockClear();
  });

  const advisorContext: NonNullable<PanelProps['advisorContext']> = {
    scope: 'worktree',
    workspaceId: 'workspace-1',
    worktreeId: 'worktree-1',
  };

  // Ownership and operational status only. Graph counts, repository names,
  // Git heads, messages, and filesystem paths never reach App Advisor.
  const SAFE_ADVISOR_KEYS = [
    'scope',
    'workspaceId',
    'worktreeId',
    'phase',
    'state',
    'enabled',
    'building',
    'repositoryCount',
    'loadErrorVisible',
    'buildErrorVisible',
    'snapshotState',
    'buildState',
    'readFailure',
  ];

  function expectSafeAdvisorPayload(payload: unknown): void {
    expect(payload).toEqual(expect.any(Object));
    if (typeof payload !== 'object' || payload === null) {
      throw new Error('Expected an App Advisor payload object.');
    }
    const keys = Object.keys(payload);
    for (const key of keys) {
      expect(SAFE_ADVISOR_KEYS).toContain(key);
    }
    const serialized = JSON.stringify(payload);
    for (const unsafe of [
      'fileCount',
      'symbolCount',
      'totals',
      '1234',
      '5678',
      'main-repo',
      'abcdef1',
      '/Users/',
      'The graph could not be read.',
    ]) {
      expect(serialized).not.toContain(unsafe);
    }
  }

  const repository: CodeGraphUiSummary['repositories'][number] = {
    repoId: 'main-repo',
    name: 'main-repo',
    state: 'ready',
    ...summary().totals,
    lastBuildAt: 1_700_000_000_000,
    gitHead: 'abcdef1234567',
  };

  it('reports nothing when the host supplies no ownership context', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(summary());
    const { cleanup } = await render(baseProps(load));
    expect(lastAdvisorPayload()).toBeNull();
    cleanup();
  });

  it('reports ownership and status for a loaded graph without graph details', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(
        summary({
          state: 'ready',
          repositories: [repository],
          message: 'The graph could not be read.',
        }),
      );
    const { cleanup } = await render({ ...baseProps(load), advisorContext });
    const payload = lastAdvisorPayload();
    expect(payload).toMatchObject({
      ...advisorContext,
      phase: 'loaded',
      state: 'ready',
      enabled: true,
      building: false,
      repositoryCount: 1,
      loadErrorVisible: false,
      buildErrorVisible: false,
    });
    expectSafeAdvisorPayload(payload);
    cleanup();
  });

  it('reports a visible load failure without the failure text', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue({
        ok: false,
        code: 'internal',
        message: 'The graph could not be read.',
      });
    const { cleanup } = await render({ ...baseProps(load), advisorContext });
    const payload = lastAdvisorPayload();
    expect(payload).toMatchObject({
      phase: 'error',
      loadErrorVisible: true,
      buildErrorVisible: false,
    });
    expectSafeAdvisorPayload(payload);
    cleanup();
  });

  it('reports building and then a visible build failure', async () => {
    const pendingBuild = deferred<CodeGraphUiSummaryResponse>();
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(summary({ state: 'ready' }));
    const build = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockReturnValue(pendingBuild.promise);
    const { container, cleanup } = await render({
      ...baseProps(load, build),
      advisorContext,
    });
    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="code-graph-summary-build"]',
        )
        ?.click(),
    );
    await flush();
    expect(lastAdvisorPayload()).toMatchObject({ building: true });

    await act(async () => {
      pendingBuild.resolve({
        ok: false,
        code: 'internal',
        message: 'The graph could not be read.',
      });
      await Promise.resolve();
    });
    await flush();
    const payload = lastAdvisorPayload();
    expect(payload).toMatchObject({
      building: false,
      buildErrorVisible: true,
    });
    expectSafeAdvisorPayload(payload);
    cleanup();
  });

  it.each<[string, CodeGraphUiSummaryResponse, Record<string, unknown>]>([
    [
      'a read-error snapshot',
      withSnapshot(
        summary({ state: 'error', message: 'The graph could not be read.' }),
        {
          snapshotState: 'read-error',
          readFailure: 'busy',
          buildState: 'idle',
        },
      ),
      { snapshotState: 'read-error', readFailure: 'busy', buildState: 'idle' },
    ],
    [
      'a readable snapshot during a source build',
      withSnapshot(summary({ state: 'stale' }), {
        snapshotState: 'readable',
        buildState: 'running',
      }),
      { snapshotState: 'readable', buildState: 'running' },
    ],
  ])(
    'reports snapshot readiness without graph counts for %s',
    async (_case, response, expected) => {
      const load = jest
        .fn<Promise<CodeGraphUiSummaryResponse>, []>()
        .mockResolvedValue(response);
      const { cleanup } = await render({ ...baseProps(load), advisorContext });

      const payload = lastAdvisorPayload();
      expect(payload).toMatchObject({
        ...advisorContext,
        phase: 'loaded',
        ...expected,
      });
      expectSafeAdvisorPayload(payload);
      cleanup();
    },
  );
});

describe('CodeGraphSummaryPanel IPC envelope recovery', () => {
  const pending: CodeGraphUiSummaryResponse = {
    ok: false,
    code: 'unavailable',
    snapshotState: 'summary-pending',
    buildState: 'idle',
    lastBuildAt: 1_700_000_000_000,
    message: 'The retained Code Graph summary is not ready. Try again.',
  };
  const unreadable: CodeGraphUiSummaryResponse = {
    ok: false,
    code: 'internal',
    snapshotState: 'read-error',
    readFailure: 'database-error',
    buildState: 'idle',
    lastBuildAt: null,
    message: 'The retained Code Graph could not be read. Try again.',
  };

  beforeEach(() => {
    mockReportUiState.mockClear();
  });

  it('renders IPC pending as neutral status without invented metrics and retries to measured counts', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(summary());
    const { container, cleanup } = await render({
      ...baseProps(load),
      advisorContext: { scope: 'worktree', workspaceId: 'workspace-1' },
    });
    try {
      const notice = container.querySelector(
        '[data-testid="code-graph-summary-pending"]',
      );
      expect(notice?.getAttribute('role')).toBe('status');
      expect(notice?.getAttribute('data-notice-intent')).toBe('neutral');
      expect(notice?.textContent).toContain(
        'Code Graph details are being prepared. Try again.',
      );
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expectNoMetricCards(container);
      expect(container.textContent).not.toContain('Never');
      expect(container.textContent).not.toContain(
        'No Code Graph has been generated yet.',
      );
      expect(container.textContent).not.toContain('not enabled');
      expect(
        container.querySelector('[data-testid="code-graph-summary-build"]'),
      ).toBeNull();
      expect(lastAdvisorPayload()).toMatchObject({
        snapshotState: 'summary-pending',
        loadErrorVisible: false,
      });
      expect(lastAdvisorPayload()).not.toHaveProperty('enabled');
      expect(lastAdvisorPayload()).not.toHaveProperty('repositoryCount');
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="code-graph-summary-retry"]',
          )
          ?.click(),
      );
      await flush();
      expect(load).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector('[data-testid="code-graph-metric-files"]')
          ?.textContent,
      ).toContain('1,234');
      expect(
        container.querySelector('[data-testid="code-graph-summary-pending"]'),
      ).toBeNull();
    } finally {
      cleanup();
    }
  });

  it.each<[NonNullable<CodeGraphUiSummary['readFailure']>, string]>([
    ['database-error', 'Could not read the Code Graph. Try again.'],
    ['worker-exit', 'Could not read the Code Graph. Try again.'],
    ['canceled', 'Could not read the Code Graph. Try again.'],
    ['invalid-response', 'Could not read the Code Graph. Try again.'],
    ['busy', 'Code Graph is busy. Try again in a moment.'],
    ['queue-timeout', 'Code Graph is busy. Try again in a moment.'],
    ['execution-timeout', 'Code Graph is busy. Try again in a moment.'],
  ])(
    'offers IPC %s recovery through the injected build',
    async (readFailure, copy) => {
      const load = jest
        .fn<Promise<CodeGraphUiSummaryResponse>, []>()
        .mockResolvedValue({
          ...unreadable,
          readFailure,
          message: '/private/graph.sqlite: backend detail',
        });
      const result = deferred<CodeGraphUiSummaryResponse>();
      const build = jest
        .fn<Promise<CodeGraphUiSummaryResponse>, []>()
        .mockReturnValue(result.promise);
      const { container, cleanup } = await render({
        ...baseProps(load, build),
        advisorContext: { scope: 'worktree', workspaceId: 'workspace-1' },
      });
      try {
        expect(container.textContent).toContain(copy);
        expect(container.textContent).not.toContain('/private/graph.sqlite');
        if (readFailure !== 'busy') {
          expect(container.textContent).not.toContain(readFailure);
        }
        expectNoMetricCards(container);
        const rebuild = container.querySelector<HTMLButtonElement>(
          '[data-testid="code-graph-summary-build"]',
        );
        expect(rebuild?.textContent).toBe('Update Code Graph');
        expect(rebuild?.disabled).toBe(false);
        act(() => rebuild?.click());
        await flush();
        expect(build).toHaveBeenCalledTimes(1);
        expect(rebuild?.disabled).toBe(true);
        expect(rebuild?.textContent).toContain('Updating Code Graph');
        expect(
          container.querySelector<HTMLButtonElement>(
            '[data-testid="code-graph-summary-retry"]',
          )?.disabled,
        ).toBe(true);
        expectNoMetricCards(container);
        await act(async () => {
          result.resolve(summary());
          await Promise.resolve();
        });
        await flush();
        expect(
          container.querySelector('[data-testid="code-graph-metric-files"]')
            ?.textContent,
        ).toContain('1,234');
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(lastAdvisorPayload()).not.toHaveProperty('readFailure');
        expect(lastAdvisorPayload()).not.toHaveProperty('snapshotState');
        expect(lastAdvisorPayload()).toMatchObject({
          phase: 'loaded',
          loadErrorVisible: false,
          buildErrorVisible: false,
        });
      } finally {
        cleanup();
      }
    },
  );

  it('keeps a classified build failure visible and allows a subsequent recovery', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(unreadable);
    const build = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValueOnce({
        ...unreadable,
        readFailure: 'busy',
        message: '/private/graph.sqlite: locked',
      })
      .mockResolvedValueOnce(summary());
    const { container, cleanup } = await render(baseProps(load, build));
    try {
      const clickBuild = (): void => {
        act(() =>
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="code-graph-summary-build"]',
            )
            ?.click(),
        );
      };
      clickBuild();
      await flush();
      expect(build).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector(
          '[data-testid="code-graph-summary-build-error"]',
        )?.textContent,
      ).toContain('Code Graph is busy. Try again in a moment.');
      expect(container.textContent).not.toContain('/private/graph.sqlite');
      expectNoMetricCards(container);
      clickBuild();
      await flush();
      expect(build).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(
        container.querySelector('[data-testid="code-graph-metric-files"]')
          ?.textContent,
      ).toContain('1,234');
    } finally {
      cleanup();
    }
  });

  it.each([pending, unreadable])(
    'clears retained counts after an IPC failed-read envelope',
    async (response) => {
      const load = jest
        .fn<Promise<CodeGraphUiSummaryResponse>, []>()
        .mockResolvedValueOnce(summary())
        .mockResolvedValueOnce(response);
      const props = { ...baseProps(load), reloadToken: 1 };
      const { container, rerender, cleanup } = await mount(props);
      try {
        expect(container.textContent).toContain('1,234');
        await rerender({ ...props, reloadToken: 2 });
        await flush();
        expectNoMetricCards(container);
        expect(container.textContent).not.toContain('1,234');
        expect(container.textContent).not.toContain('5,678');
      } finally {
        cleanup();
      }
    },
  );

  it('does not turn an unavailable IPC envelope into permission to build', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue({
        ok: false,
        code: 'unavailable',
        message: 'Code graph tools are not available for this project.',
      });
    const build = jest.fn<Promise<CodeGraphUiSummaryResponse>, []>();
    const { container, cleanup } = await render(baseProps(load, build));
    try {
      expect(container.textContent).toContain(
        'Code graph tools are not available for this project.',
      );
      expectNoMetricCards(container);
      expect(
        container.querySelector('[data-testid="code-graph-summary-build"]'),
      ).toBeNull();
      expect(build).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('preserves the authoritative unavailable response when recovery is prohibited', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(unreadable);
    const build = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue({
        ok: false,
        code: 'unavailable',
        message: 'Code graph tools are not available for this project.',
      });
    const { container, cleanup } = await render(baseProps(load, build));
    try {
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="code-graph-summary-build"]',
          )
          ?.click(),
      );
      await flush();
      expect(build).toHaveBeenCalledTimes(1);
      expect(
        container.querySelector(
          '[data-testid="code-graph-summary-build-error"]',
        )?.textContent,
      ).toBe('Code graph tools are not available for this project.');
      expectNoMetricCards(container);
    } finally {
      cleanup();
    }
  });
});

describe('CodeGraphSummaryPanel successful publication fences older reads', () => {
  it.each<CodeGraphUiSummaryResponse>([
    summary(),
    {
      ok: false,
      code: 'internal',
      snapshotState: 'read-error',
      readFailure: 'database-error',
      buildState: 'idle',
      lastBuildAt: null,
      message: 'The retained Code Graph could not be read. Try again.',
    },
  ])(
    'does not replace a successful build with an older in-flight read',
    async (olderResponse) => {
      const olderRead = deferred<CodeGraphUiSummaryResponse>();
      const load = jest
        .fn<Promise<CodeGraphUiSummaryResponse>, []>()
        .mockResolvedValueOnce(summary())
        .mockReturnValueOnce(olderRead.promise);
      const build = jest
        .fn<Promise<CodeGraphUiSummaryResponse>, []>()
        .mockResolvedValue(
          summary({ totals: { ...summary().totals, fileCount: 2000 } }),
        );
      const props = { ...baseProps(load, build), reloadToken: 1 };
      const { container, rerender, cleanup } = await mount(props);
      try {
        // The view intentionally retains readable counts and its Update action
        // while the host reload is in flight. That read predates publication.
        await rerender({ ...props, reloadToken: 2 });
        expect(load).toHaveBeenCalledTimes(2);
        act(() =>
          container
            .querySelector<HTMLButtonElement>(
              '[data-testid="code-graph-summary-build"]',
            )
            ?.click(),
        );
        await flush();
        expect(build).toHaveBeenCalledTimes(1);
        expect(
          container.querySelector('[data-testid="code-graph-metric-files"]')
            ?.textContent,
        ).toContain('2,000');
        await act(async () => {
          olderRead.resolve(olderResponse);
          await Promise.resolve();
        });
        await flush();
        // RED: the current runLoad id is unchanged by a successful build, so
        // either stale counts or an obsolete failed-read envelope wins here.
        expect(
          container.querySelector('[data-testid="code-graph-metric-files"]')
            ?.textContent,
        ).toContain('2,000');
        expect(container.querySelector('[role="alert"]')).toBeNull();
      } finally {
        cleanup();
      }
    },
  );

  it('still accepts a read initiated after publication', async () => {
    const load = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValueOnce(summary())
      .mockResolvedValueOnce(
        summary({ totals: { ...summary().totals, fileCount: 3000 } }),
      );
    const build = jest
      .fn<Promise<CodeGraphUiSummaryResponse>, []>()
      .mockResolvedValue(
        summary({ totals: { ...summary().totals, fileCount: 2000 } }),
      );
    const props = { ...baseProps(load, build), reloadToken: 1 };
    const { container, rerender, cleanup } = await mount(props);
    try {
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="code-graph-summary-build"]',
          )
          ?.click(),
      );
      await flush();
      expect(build).toHaveBeenCalledTimes(1);
      await rerender({ ...props, reloadToken: 2 });
      await flush();
      expect(load).toHaveBeenCalledTimes(2);
      expect(
        container.querySelector('[data-testid="code-graph-metric-files"]')
          ?.textContent,
      ).toContain('3,000');
    } finally {
      cleanup();
    }
  });
});

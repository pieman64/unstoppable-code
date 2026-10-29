/**
 * @jest-environment jsdom
 */
jest.mock('../AnsiOutput', () => ({
  AnsiOutput: (): null => null,
}));
jest.mock('../../chat/TranscriptViewer', () => ({
  TranscriptViewer: (): null => null,
}));
jest.mock('../PipelineReportModal', () => ({
  PipelineReportModal: (): null => null,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ExecutionSummary,
  PipelineAdvisorReport,
  PipelineAdvisorSnapshot,
} from '@canopy/desktop-shared/types/pipeline';
import { AdvisorEtaBadge } from '../AdvisorEtaBadge';
import {
  AdvisorActionControl,
  AdvisorCompactStatus,
  AdvisorHeaderAction,
  AdvisorSection,
} from '../details/PipelineAdvisorDetail';
import {
  computeAdvisorPreviewPosition,
  formatAdvisorEta,
  formatAdvisorEtaForModal,
} from '../PipelineAdvisorEta';

describe('Pipeline Advisor activity and detail UI', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-05-13T00:01:00.000Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('renders no activity ETA badge without an advisor snapshot', () => {
    const html = renderToStaticMarkup(<AdvisorEtaBadge />);

    expect(html).toBe('');
  });

  it('shows advisor ETA and opens the health/inefficiency preview on focus', () => {
    const snapshot = createSnapshot({
      lastError: {
        message: 'SDK timeout',
        at: '2026-05-13T00:02:00.000Z',
        retryable: true,
        consecutiveFailures: 1,
      },
    });
    const rendered = renderBadge(snapshot);

    try {
      expect(formatAdvisorEta(snapshot)).toBe('ETA ~12m');
      expect(rendered.container.textContent).toContain('ETA ~12m');
      expect(rendered.container.textContent).toContain('!');
      const badge = rendered.container.querySelector(
        '[aria-label="Pipeline Advisor ETA"]',
      );
      if (!(badge instanceof HTMLElement)) {
        throw new Error('Advisor ETA badge not found');
      }

      act(() => {
        badge.focus();
      });

      const tooltip = document.body.querySelector('[role="tooltip"]');
      if (!(tooltip instanceof HTMLElement)) {
        throw new Error('Advisor preview tooltip not found');
      }
      expect(rendered.container.contains(tooltip)).toBe(false);
      expect(tooltip.textContent).toContain('Pipeline Advisor');
      expect(tooltip.textContent).toContain('Health');
      expect(tooltip.textContent).toContain('Healthy enough');
      expect(tooltip.textContent).toContain('ETA');
      expect(tooltip.textContent).toContain('Warning: Slow job');
      expect(
        Array.from(tooltip.querySelectorAll('code')).map(
          (node) => node.textContent,
        ),
      ).toEqual(expect.arrayContaining(['worker logs', 'Slow job']));
      expect(tooltip.textContent).toContain(
        'Advisor update failed: SDK timeout',
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('renders the non-interactive advisor ETA badge without tab stop or preview behavior', () => {
    const rendered = renderBadge(createSnapshot(), undefined, false);

    try {
      const badge = rendered.container.querySelector(
        '[aria-label="Pipeline Advisor ETA"]',
      );
      if (!(badge instanceof HTMLElement)) {
        throw new Error('Advisor ETA badge not found');
      }

      expect(badge.getAttribute('tabindex')).toBeNull();

      act(() => {
        badge.focus();
      });
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

      act(() => {
        badge.parentElement?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });

  it('renders the activity ETA badge on the shared pipeline-row status badge standard', () => {
    // Geometry every status badge in the pipeline row shares (see
    // `statusBadgeClassName` in @canopy/ui-shared): 20px pill, 3xs label,
    // hairline ring. `border-<color>` utilities are inert under the unlayered
    // base border rule (CAN-2734) and raw palette literals wash out in light
    // mode, so neither may appear.
    const geometry = [
      'h-5',
      'rounded-full',
      'text-3xs',
      'ring-[length:var(--border-hairline)]',
    ];
    const forbidden = /(^|\s)border(-|\s|$)|\b(sky|violet|amber|rose)-/;
    const active = renderBadge(createSnapshot(), 'running');
    const stale = renderBadge(
      createSnapshot({
        lastError: {
          message: 'SDK timeout',
          at: '2026-05-13T00:02:00.000Z',
          retryable: true,
          consecutiveFailures: 1,
        },
      }),
      'running',
    );

    try {
      const activeBadge = active.container.querySelector(
        '[aria-label="Pipeline Advisor ETA"]',
      );
      const staleBadge = stale.container.querySelector(
        '[aria-label="Pipeline Advisor ETA"]',
      );
      expect(activeBadge).not.toBeNull();
      expect(staleBadge).not.toBeNull();
      for (const badge of [activeBadge, staleBadge]) {
        const classes = (badge?.className ?? '').split(/\s+/);
        for (const token of geometry) {
          expect(classes).toContain(token);
        }
        expect(badge?.className ?? '').not.toMatch(forbidden);
      }
      expect(activeBadge?.className).toContain('bg-info-subtle');
      expect(activeBadge?.className).toContain('fg-info');
      expect(activeBadge?.className).toContain('ring-fg-info/20');
      expect(staleBadge?.className).toContain('bg-warning-subtle');
      expect(staleBadge?.className).toContain('fg-warning');
      expect(staleBadge?.className).toContain('ring-line-attention/30');
      // Icons inside a status badge are 12px.
      const icon = activeBadge?.querySelector('svg');
      expect(icon?.getAttribute('class')).toContain('h-3');
      expect(icon?.getAttribute('class')).toContain('w-3');
    } finally {
      active.cleanup();
      stale.cleanup();
    }
  });

  it('does not show starting copy for failed or stale terminal advisor snapshots', () => {
    const failedSnapshot = createSnapshot({
      latestReport: undefined,
      reports: [],
      status: 'failed',
      lastError: {
        message: 'Schema rejected',
        at: '2026-05-13T00:03:00.000Z',
        retryable: true,
        consecutiveFailures: 1,
      },
    });
    const terminalStartingSnapshot = createSnapshot({
      latestReport: undefined,
      reports: [],
      status: 'starting',
    });

    expect(formatAdvisorEta(failedSnapshot)).toBe('Update failed');
    expect(formatAdvisorEta(terminalStartingSnapshot, 'cancelled')).toBe(
      'Advisor pending',
    );
    const rendered = renderBadge(failedSnapshot);
    const terminalRendered = renderBadge(terminalStartingSnapshot, 'cancelled');
    const compactTerminalRendered = renderMetadataControl(
      <AdvisorCompactStatus
        snapshot={terminalStartingSnapshot}
        pipelineStatus="cancelled"
      />,
    );

    try {
      expect(rendered.container.textContent).toContain('Update failed');
      expect(rendered.container.textContent).not.toContain('Advisor starting');
      expect(terminalRendered.container.textContent).toContain(
        'Advisor pending',
      );
      expect(terminalRendered.container.textContent).not.toContain(
        'Advisor starting',
      );
      expect(compactTerminalRendered.container.textContent).toContain(
        'Advisor pending',
      );
      expect(
        compactTerminalRendered.container.querySelector(
          '[data-testid="pipeline-detail-advisor-running-spinner"]',
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
      terminalRendered.cleanup();
      compactTerminalRendered.cleanup();
    }
  });

  it('keeps the advisor preview inside the viewport', () => {
    expect(
      computeAdvisorPreviewPosition({
        anchorRect: {
          top: 570,
          bottom: 590,
          left: 760,
          right: 792,
        },
        popoverWidth: 280,
        popoverHeight: 120,
        viewportWidth: 800,
        viewportHeight: 600,
      }),
    ).toEqual({ top: 446, left: 512 });
  });

  it('formats PipelineExecutionDetailModal advisor ETA metadata and section content', () => {
    const snapshot = createSnapshot();
    const sectionHtml = renderToStaticMarkup(
      <AdvisorSection snapshot={snapshot} />,
    );

    expect(formatAdvisorEtaForModal()).toBe('No advisor');
    expect(formatAdvisorEtaForModal(snapshot)).toBe('ETA ~12m');
    expect(sectionHtml).toContain('Healthy enough');
    expect(sectionHtml).toContain('<code');
    expect(sectionHtml).toContain('worker logs');
    expect(sectionHtml).toContain('Worker logs show');
    expect(sectionHtml).toContain('progress');
    expect(sectionHtml).toContain('Slow job');
    expect(sectionHtml).toContain('Split the');
    expect(sectionHtml).toContain('work');
    expect(sectionHtml).toContain('Pipeline');
    expect(sectionHtml).toContain('summary');
    expect(sectionHtml).toContain('Keep');
    expect(sectionHtml).toContain('monitoring');
    expect(sectionHtml).not.toContain('pipeline-advisor-report-selector');
  });

  it('ages ETA displays relative to when the advisor report was generated', () => {
    const snapshot = createSnapshot();
    const laterTime = new Date('2026-05-13T00:06:00.000Z').getTime();

    expect(formatAdvisorEta(snapshot, undefined, laterTime)).toBe('ETA ~7m');
    expect(formatAdvisorEtaForModal(snapshot, undefined, laterTime)).toBe(
      'ETA ~7m',
    );
    expect(
      renderToStaticMarkup(<AdvisorSection snapshot={snapshot} />),
    ).toContain('ETA ~12m');
  });

  it('shows Pending instead of ETA on terminal pipelines until the final advisor report completes', () => {
    const pendingSnapshot = createSnapshot();
    const completeSnapshot = createSnapshot({
      latestReport: createReport({
        eta: {
          status: 'complete',
          confidence: 'high',
          rationale: 'Pipeline finished.',
        },
      }),
    });

    expect(formatAdvisorEta(pendingSnapshot, 'success')).toBe('Pending');
    expect(formatAdvisorEtaForModal(pendingSnapshot, 'success')).toBe(
      'Pending',
    );
    expect(formatAdvisorEta(completeSnapshot, 'success')).toBe('Complete');
    expect(formatAdvisorEtaForModal(completeSnapshot, 'success')).toBe(
      'Complete',
    );
    expect(
      formatAdvisorEta({ ...completeSnapshot, status: 'starting' }, 'running'),
    ).toBe('Advisor starting');
    expect(
      formatAdvisorEtaForModal(
        { ...completeSnapshot, status: 'running' },
        'running',
      ),
    ).toBe('Advisor running');

    const rendered = renderBadge(pendingSnapshot, 'success');
    const metadataRendered = renderMetadataControl(
      <AdvisorCompactStatus
        snapshot={pendingSnapshot}
        pipelineStatus="success"
      />,
    );
    const completeSectionRendered = renderMetadataControl(
      <AdvisorSection
        snapshot={completeSnapshot}
        pipelineStatus="running"
        running={false}
        onRun={jest.fn()}
      />,
    );
    const completeStatusRendered = renderMetadataControl(
      <AdvisorCompactStatus
        snapshot={completeSnapshot}
        pipelineStatus="running"
      />,
    );

    try {
      expect(rendered.container.textContent).toContain('Pending');
      expect(rendered.container.textContent).not.toContain('ETA');
      expect(metadataRendered.container.textContent).toContain('Pending');
      expect(metadataRendered.container.textContent).not.toContain('ETA');
      expect(completeStatusRendered.container.textContent).toContain(
        'Complete',
      );
      expect(
        completeSectionRendered.container.querySelector(
          '[data-testid="pipeline-detail-refresh-advisor"]',
        ),
      ).toBeNull();
      expect(
        renderToStaticMarkup(<AdvisorSection snapshot={completeSnapshot} />),
      ).not.toContain('ETA');
    } finally {
      rendered.cleanup();
      metadataRendered.cleanup();
      completeSectionRendered.cleanup();
      completeStatusRendered.cleanup();
    }
  });

  it('updates the rendered activity ETA as time passes', () => {
    const rendered = renderBadge(createSnapshot());

    try {
      expect(rendered.container.textContent).toContain('ETA ~12m');
      act(() => {
        jest.advanceTimersByTime(5 * 60 * 1000);
      });
      expect(rendered.container.textContent).toContain('ETA ~7m');
    } finally {
      rendered.cleanup();
    }
  });

  it('renders historical Pipeline Advisor reports with latest selected by default', () => {
    const initialReport = createReportWithSummary({
      reportId: 'report-initial',
      kind: 'initial',
      generatedAt: '2026-05-13T00:05:00.000Z',
      healthSummary: 'Initial health report',
      summary: 'Initial advisor summary',
    });
    const middleReport = createReportWithSummary({
      reportId: 'report-middle',
      generatedAt: '2026-05-13T00:35:00.000Z',
      healthSummary: 'Middle health report',
      summary: 'Middle advisor summary',
    });
    const latestReport = createReportWithSummary({
      reportId: 'report-latest',
      generatedAt: '2026-05-13T02:00:00.000Z',
      healthSummary: 'Latest health report',
      summary: 'Latest advisor summary',
    });
    const rendered = renderMetadataControl(
      <AdvisorSection
        snapshot={createSnapshot({
          reports: [initialReport, middleReport, latestReport],
          latestReport,
        })}
        startedAt="2026-05-13T00:05:00.000Z"
      />,
    );

    try {
      const select = rendered.container.querySelector(
        '[data-testid="pipeline-advisor-report-selector"]',
      );
      if (!(select instanceof HTMLSelectElement)) {
        throw new Error('Advisor report history selector not found');
      }
      expect(select.options[select.selectedIndex]?.textContent).toBe('Latest');
      expect(
        Array.from(select.options).map((option) => option.textContent),
      ).toEqual(['Initial', '+30m', 'Latest']);
      expect(rendered.container.textContent).toContain('Latest health report');
      expect(rendered.container.textContent).not.toContain(
        'Middle health report',
      );

      const middleOption = Array.from(select.options).find(
        (option) => option.textContent === '+30m',
      );
      if (!middleOption) {
        throw new Error('Middle advisor report option not found');
      }
      act(() => {
        select.value = middleOption.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });

      expect(rendered.container.textContent).toContain('Middle health report');
      expect(rendered.container.textContent).not.toContain(
        'Latest health report',
      );
    } finally {
      rendered.cleanup();
    }
  });

  it('labels advisor history from the persisted pipeline start time after restart', () => {
    const initialReport = createReportWithSummary({
      reportId: 'report-initial',
      kind: 'initial',
      generatedAt: '2026-05-13T00:05:00.000Z',
      healthSummary: 'Initial health report',
      summary: 'Initial advisor summary',
    });
    const middleReport = createReportWithSummary({
      reportId: 'report-middle',
      generatedAt: '2026-05-13T00:35:00.000Z',
      healthSummary: 'Middle health report',
      summary: 'Middle advisor summary',
    });
    const latestReport = createReportWithSummary({
      reportId: 'report-latest',
      generatedAt: '2026-05-13T02:00:00.000Z',
      healthSummary: 'Latest health report',
      summary: 'Latest advisor summary',
    });
    const rendered = renderMetadataControl(
      <AdvisorSection
        snapshot={createSnapshot({
          pipelineStartedAt: '2026-05-13T00:00:00.000Z',
          reports: [initialReport, middleReport, latestReport],
          latestReport,
        })}
      />,
    );

    try {
      const select = rendered.container.querySelector(
        '[data-testid="pipeline-advisor-report-selector"]',
      );
      if (!(select instanceof HTMLSelectElement)) {
        throw new Error('Advisor report history selector not found');
      }

      expect(
        Array.from(select.options).map((option) => option.textContent),
      ).toEqual(['Initial', '+35m', 'Latest']);
    } finally {
      rendered.cleanup();
    }
  });

  it('renders Pipeline Advisor refresh controls and busy indicators in detail metadata', () => {
    const onRun = jest.fn();
    const onCompactRun = jest.fn();
    const snapshot = createSnapshot();
    const refreshRendered = renderMetadataControl(
      <AdvisorHeaderAction
        snapshot={snapshot}
        pipelineStatus="running"
        running={false}
        onRun={onRun}
      />,
    );
    const compactRefreshRendered = renderMetadataControl(
      <AdvisorCompactStatus
        snapshot={snapshot}
        pipelineStatus="running"
        running={false}
        onRun={onCompactRun}
      />,
    );
    const sectionRendered = renderMetadataControl(
      <AdvisorSection
        snapshot={snapshot}
        pipelineStatus="running"
        running={false}
        onRun={jest.fn()}
      />,
    );
    const runningRendered = renderMetadataControl(
      <AdvisorSection
        snapshot={{ ...snapshot, status: 'running' }}
        pipelineStatus="running"
        running
        onRun={jest.fn()}
      />,
    );
    const headerRunningRendered = renderMetadataControl(
      <AdvisorHeaderAction
        snapshot={createSnapshot({
          latestReport: undefined,
          reports: [],
          status: 'running',
        })}
        pipelineStatus="running"
        running
        onRun={jest.fn()}
      />,
    );
    const compactRunningRendered = renderMetadataControl(
      <AdvisorCompactStatus
        snapshot={createSnapshot({
          latestReport: undefined,
          reports: [],
          status: 'running',
        })}
        pipelineStatus="running"
        running
      />,
    );

    try {
      const refreshButton = refreshRendered.container.querySelector(
        '[data-testid="pipeline-detail-refresh-advisor"]',
      );
      expect(refreshButton).toBeInstanceOf(HTMLButtonElement);
      expect(refreshButton?.textContent).toContain('Refresh');
      act(() => {
        (refreshButton as HTMLButtonElement).click();
      });
      expect(onRun).toHaveBeenCalledTimes(1);
      const compactRefreshButton =
        compactRefreshRendered.container.querySelector(
          '[data-testid="pipeline-detail-refresh-advisor"]',
        );
      expect(compactRefreshButton).toBeInstanceOf(HTMLButtonElement);
      expect(compactRefreshButton?.textContent).not.toContain('Refresh');
      act(() => {
        (compactRefreshButton as HTMLButtonElement).click();
      });
      expect(onCompactRun).toHaveBeenCalledTimes(1);
      expect(
        sectionRendered.container.querySelector(
          '[data-testid="pipeline-detail-refresh-advisor"]',
        ),
      ).toBeNull();
      expect(
        runningRendered.container.querySelector(
          '[data-testid="pipeline-detail-advisor-running-spinner"]',
        ),
      ).toBeNull();
      expect(
        headerRunningRendered.container.querySelector(
          '[data-testid="pipeline-detail-advisor-running-spinner"]',
        ),
      ).not.toBeNull();
      expect(compactRunningRendered.container.textContent).toContain(
        'Advisor running',
      );
      expect(
        compactRunningRendered.container.querySelector(
          '[data-testid="pipeline-detail-advisor-running-spinner"]',
        ),
      ).not.toBeNull();
    } finally {
      refreshRendered.cleanup();
      compactRefreshRendered.cleanup();
      sectionRendered.cleanup();
      runningRendered.cleanup();
      headerRunningRendered.cleanup();
      compactRunningRendered.cleanup();
    }
  });

  it('renders PipelineExecutionDetailModal advisor pending and error-only section states', () => {
    expect(renderToStaticMarkup(<AdvisorSection />)).toContain(
      'No advisor update is available yet.',
    );
    expect(
      renderToStaticMarkup(
        <AdvisorSection
          snapshot={createSnapshot({ latestReport: undefined, reports: [] })}
        />,
      ),
    ).toContain('Advisor update pending.');
    expect(
      renderToStaticMarkup(
        <AdvisorSection
          snapshot={createSnapshot({
            latestReport: undefined,
            reports: [],
            lastError: {
              message: 'SDK failed',
              at: '2026-05-13T00:03:00.000Z',
              retryable: true,
              consecutiveFailures: 1,
            },
          })}
        />,
      ),
    ).toContain('Advisor update failed: SDK failed');
  });

  it('renders a Run Advisor button instead of starting copy without a snapshot', () => {
    const onRun = jest.fn();
    const rendered = renderMetadataControl(
      <AdvisorSection running={false} onRun={onRun} />,
    );

    try {
      expect(rendered.container.textContent).toContain('Run pipeline advisor');
      expect(rendered.container.textContent).not.toContain('Advisor starting');
      const button = rendered.container.querySelector(
        '[data-testid="pipeline-detail-run-advisor"]',
      );
      if (!(button instanceof HTMLButtonElement)) {
        throw new Error('Run Advisor button not found');
      }

      act(() => {
        button.click();
      });
      expect(onRun).toHaveBeenCalledTimes(1);
    } finally {
      rendered.cleanup();
    }
  });

  it('renders a Run Advisor button for terminal executions with stale starting snapshots', () => {
    const onRun = jest.fn();
    const rendered = renderMetadataControl(
      <AdvisorSection
        running={false}
        onRun={onRun}
        pipelineStatus="cancelled"
        snapshot={createSnapshot({
          latestReport: undefined,
          reports: [],
          status: 'starting',
        })}
      />,
    );

    try {
      expect(rendered.container.textContent).toContain('Run pipeline advisor');
      expect(rendered.container.textContent).not.toContain('Advisor starting');
    } finally {
      rendered.cleanup();
    }
  });

  it('keeps the manual Run Advisor button enabled when no advisor is starting', () => {
    const rendered = renderMetadataControl(
      <AdvisorActionControl running={false} onRun={jest.fn()} />,
    );

    try {
      expect(rendered.container.textContent).toContain('Run pipeline advisor');
      const button = rendered.container.querySelector('button');
      expect(button).toBeInstanceOf(HTMLButtonElement);
      expect((button as HTMLButtonElement).disabled).toBe(false);
    } finally {
      rendered.cleanup();
    }
  });
});

function renderBadge(
  snapshot: PipelineAdvisorSnapshot,
  pipelineStatus?: ExecutionSummary['status'],
  interactive?: boolean,
): {
  container: HTMLElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(
      <AdvisorEtaBadge
        snapshot={snapshot}
        pipelineStatus={pipelineStatus}
        interactive={interactive}
      />,
    );
  });
  return {
    container,
    cleanup: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

function renderMetadataControl(element: JSX.Element): {
  container: HTMLElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(element);
  });
  return {
    container,
    cleanup: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

function createReport(
  overrides: Partial<PipelineAdvisorReport> = {},
): PipelineAdvisorReport {
  return {
    version: 1,
    reportId: 'report-1',
    executionId: 'execution-1',
    kind: 'periodic',
    generatedAt: '2026-05-13T00:01:00.000Z',
    pipelineStatus: 'running',
    health: {
      status: 'healthy',
      score: 92,
      summary: 'Healthy enough with `worker logs`',
      evidence: ['Worker logs show `progress`'],
      blockers: [],
    },
    eta: {
      status: 'available',
      remainingSeconds: 720,
      confidence: 'medium',
      rationale: 'One job remains.',
    },
    inefficiencies: [
      {
        severity: 'warning',
        title: '`Slow job`',
        evidence: 'The `transform` job has been running longer than peers.',
        recommendation: 'Split the `work`',
      },
    ],
    summary: 'Pipeline `summary`',
    recommendations: ['Keep `monitoring`'],
    ...overrides,
  };
}

function createReportWithSummary({
  reportId,
  kind = 'periodic',
  generatedAt,
  healthSummary,
  summary,
}: {
  reportId: string;
  kind?: PipelineAdvisorReport['kind'];
  generatedAt: string;
  healthSummary: string;
  summary: string;
}): PipelineAdvisorReport {
  const baseReport = createReport();
  return {
    ...baseReport,
    reportId,
    kind,
    generatedAt,
    health: {
      ...baseReport.health,
      summary: healthSummary,
    },
    summary,
  };
}

function createSnapshot(
  overrides: Partial<PipelineAdvisorSnapshot> = {},
): PipelineAdvisorSnapshot {
  const latestReport = Object.prototype.hasOwnProperty.call(
    overrides,
    'latestReport',
  )
    ? overrides.latestReport
    : createReport();
  return {
    version: 1,
    executionId: 'execution-1',
    executionDataDir: '/tmp/execution-1',
    stateFilePath: '/tmp/execution-1.json',
    provider: 'codex',
    model: 'gpt-6-luna',
    thinkingLevel: 'high',
    sdkSessionId: 'thread-1',
    status: 'waiting',
    turnCount: 1,
    backoffIndex: 1,
    lastUpdatedAt: '2026-05-13T00:01:00.000Z',
    reports: latestReport ? [latestReport] : [],
    ...(latestReport ? { latestReport } : {}),
    ...overrides,
  };
}

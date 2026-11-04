/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PipelineRunsSectionBody,
  type PipelineRunsSectionBodyProps,
} from '../pipeline/PipelineRunsSectionBody';
import type {
  PipelineRunSummary,
  PipelineRunTreeRowProps,
} from '../pipeline/PipelineRunRows';
import { FRAMELESS_HIDDEN_GROUP_MAX_H } from '@canopy/ui-shared/lib';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

const visibleSummary: PipelineRunSummary = {
  id: 'visible-run',
  pipeline_id: 'pipeline-1',
  pipeline_name: 'Visible pipeline',
  status: 'running',
  status_reasons: [],
  started_at: '2026-07-26T10:00:00.000Z',
};

const hiddenSummary: PipelineRunSummary = {
  ...visibleSummary,
  id: 'hidden-run',
  pipeline_name: 'Hidden pipeline',
  status: 'success',
  hidden: true,
};

const runRowProps: Omit<PipelineRunTreeRowProps, 'node'> = {
  expandedIds: new Set<string>(),
  onToggleExpand: jest.fn(),
  statesById: {},
  cancellingId: null,
  resumingId: null,
  onOpenDetail: jest.fn(),
  onCancel: jest.fn(),
  onResume: jest.fn(),
  onChatFollowUp: jest.fn(),
  onReportChatFollowUp: jest.fn(),
  onViewReport: jest.fn(),
  onPipelineFollowUp: jest.fn(),
  onOpenPlan: jest.fn(),
  onRetry: jest.fn(),
  onRerun: jest.fn(),
  onDebugFailure: jest.fn(),
  onToggleHidden: jest.fn(),
  chatFollowUpDisabled: false,
  retryingIds: new Set<string>(),
  rerunningIds: new Set<string>(),
  debuggingFailureId: null,
  summaryLookup: {
    'visible-run': visibleSummary,
    'hidden-run': hiddenSummary,
  },
  onOpenSource: jest.fn(),
  parentChain: [],
};

function createProps(
  overrides: Partial<PipelineRunsSectionBodyProps> = {},
): PipelineRunsSectionBodyProps {
  return {
    layout: 'card',
    queuedExecutions: [],
    failedQueuedExecutions: [],
    pendingExecutions: [],
    failedPendingExecutions: [],
    visibleRoots: [{ summary: visibleSummary, children: [], depth: 0 }],
    hiddenRoots: [{ summary: hiddenSummary, children: [], depth: 0 }],
    hiddenExpanded: false,
    onHiddenExpandedChange: jest.fn(),
    onCancelQueuedExecution: jest.fn(),
    onDismissFailedQueuedExecution: jest.fn(),
    onCancelPendingExecution: jest.fn(),
    onDismissFailedPendingExecution: jest.fn(),
    runRowProps,
    ...overrides,
  };
}

function renderBody(root: Root, props: PipelineRunsSectionBodyProps): void {
  act(() => {
    root.render(<PipelineRunsSectionBody {...props} />);
  });
}

describe('PipelineRunsSectionBody', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  /** The hidden group's scroll area, the first thing in the disclosure body. */
  function hiddenGroup(): Element | null | undefined {
    return container.querySelector('[data-testid="pipeline-hidden-body"]')
      ?.firstElementChild;
  }

  it.each([
    ['card', 'space-y-2', 'max-h-76 space-y-2 overflow-y-auto'],
    [
      'frameless',
      'flex min-h-0 flex-1 flex-col gap-2',
      'min-h-0 flex-1 space-y-2 overflow-y-auto',
    ],
  ] as const)(
    'renders the exact primary-list classes for %s layout',
    (layout, expectedBodyClassName, expectedListClassName) => {
      renderBody(root, createProps({ layout }));

      const primaryList = container.querySelector(
        '[data-testid="pipeline-runs-primary-list"]',
      );
      expect(primaryList?.parentElement?.className).toBe(expectedBodyClassName);
      expect(primaryList?.className).toBe(expectedListClassName);
    },
  );

  it('toggles the hidden disclosure and renders its layout-specific group', () => {
    const onHiddenExpandedChange = jest.fn();
    const props = createProps({
      layout: 'frameless',
      onHiddenExpandedChange,
    });
    renderBody(root, props);

    const disclosure = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Hidden (1)'),
    );
    expect(disclosure?.getAttribute('aria-expanded')).toBe('false');
    act(() => disclosure?.click());
    expect(onHiddenExpandedChange).toHaveBeenCalledWith(true);

    renderBody(root, { ...props, hiddenExpanded: true });
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('Hidden pipeline');
    // The body spells the frameless cap out as a literal so the design-system
    // lint can read it; this keeps that literal equal to the shared constant
    // the Plans section uses.
    expect(FRAMELESS_HIDDEN_GROUP_MAX_H).toBe('max-h-60');
    expect(hiddenGroup()?.className).toBe(
      `flex min-h-0 flex-col ${FRAMELESS_HIDDEN_GROUP_MAX_H}`,
    );
  });

  it('renders the card-layout hidden group with its own scroll clamp', () => {
    renderBody(root, createProps({ layout: 'card', hiddenExpanded: true }));
    const disclosure = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Hidden (1)'),
    );
    expect(disclosure?.getAttribute('aria-expanded')).toBe('true');
    expect(hiddenGroup()?.className).toBe('flex min-h-0 flex-col max-h-76');
  });

  it('uses an overlay scrollbar without reserving run-list width', () => {
    renderBody(root, createProps({ layout: 'card', hiddenExpanded: true }));
    expect(
      container.querySelector('[data-testid="pipeline-hidden-viewport"]')
        ?.className,
    ).toContain('scrollbar-hide');
    expect(container.querySelector('[data-overlay-scrollbar]')).not.toBeNull();
  });

  it('preserves the scrolled top fade when hidden history updates', async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    const flushFrames = (): void => {
      act(() => {
        for (const callback of frames.splice(0)) callback(0);
      });
    };
    try {
      const props = createProps({ hiddenExpanded: true });
      renderBody(root, props);
      const viewport = container.querySelector<HTMLDivElement>(
        '[data-testid="pipeline-hidden-viewport"]',
      );
      if (!viewport) throw new Error('Hidden viewport missing');
      Object.defineProperties(viewport, {
        clientHeight: { value: 100 },
        scrollHeight: { value: 500 },
      });
      flushFrames();
      act(() => {
        viewport.scrollTop = 50;
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(viewport.style.maskImage).toContain('linear-gradient');

      await act(async () => {
        root.render(
          <PipelineRunsSectionBody
            {...props}
            hiddenRoots={[
              {
                ...props.hiddenRoots[0],
                summary: { ...hiddenSummary, pipeline_name: 'Updated history' },
              },
            ]}
          />,
        );
        await Promise.resolve();
      });
      expect(frames.length).toBeGreaterThan(0);
      flushFrames();
      expect(viewport.style.maskImage).toContain('linear-gradient');
      act(() => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(viewport.style.maskImage).toBe('none');
    } finally {
      requestFrame.mockRestore();
    }
  });

  it('keeps the scrollbar in the card inset and prevents horizontal list scrolling', () => {
    renderBody(root, createProps({ layout: 'card', hiddenExpanded: true }));
    expect(
      container.querySelector('[data-testid="pipeline-hidden-viewport"]')
        ?.className,
    ).toContain('overflow-x-hidden');
    expect(
      container.querySelector('[data-overlay-scrollbar]')?.className,
    ).toContain('-right-3');
  });

  // CAN-2865: queued/pending runs come from a desktop-only channel. A host
  // with no queue projection (the web portal) omits those four arrays and
  // their four handlers rather than passing empty arrays and no-ops.
  describe('host with no queue projection', () => {
    function queuelessProps(): PipelineRunsSectionBodyProps {
      return {
        layout: 'card',
        visibleRoots: [{ summary: visibleSummary, children: [], depth: 0 }],
        hiddenRoots: [],
        hiddenExpanded: false,
        onHiddenExpandedChange: jest.fn(),
        runRowProps,
      };
    }

    it('renders the run rows with every queue prop omitted', () => {
      renderBody(root, queuelessProps());

      expect(
        container.querySelector('[data-testid="pipeline-runs-primary-list"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain('Visible pipeline');
    });

    it('renders nothing when a queueless host also has no runs', () => {
      renderBody(root, { ...queuelessProps(), visibleRoots: [] });
      expect(container.innerHTML).toBe('');
    });

    it('still shows the hidden disclosure without queue props', () => {
      renderBody(root, {
        ...queuelessProps(),
        hiddenRoots: [{ summary: hiddenSummary, children: [], depth: 0 }],
      });
      expect(container.textContent).toContain('Hidden (1)');
    });
  });

  // The Debug chip is the one completed-run control with no gating summary
  // flag behind it, so it takes an optional handler: absent means no chip,
  // rather than a chip that does nothing (CAN-2865).
  describe('optional onDebugFailure', () => {
    const failedSummary: PipelineRunSummary = {
      ...visibleSummary,
      id: 'failed-run',
      pipeline_name: 'Failed pipeline',
      status: 'failure',
    };

    function failedProps(
      rowOverrides: Partial<Omit<PipelineRunTreeRowProps, 'node'>>,
    ): PipelineRunsSectionBodyProps {
      return {
        layout: 'card',
        visibleRoots: [{ summary: failedSummary, children: [], depth: 0 }],
        hiddenRoots: [],
        hiddenExpanded: false,
        onHiddenExpandedChange: jest.fn(),
        runRowProps: {
          ...runRowProps,
          summaryLookup: { 'failed-run': failedSummary },
          ...rowOverrides,
        },
      };
    }

    it('renders the Debug chip when the host supplies a handler', () => {
      renderBody(root, failedProps({ onDebugFailure: jest.fn() }));
      expect(
        container.querySelector(
          '[data-testid="pipeline-run-debug-failure-failed-run"]',
        ),
      ).not.toBeNull();
    });

    it('omits the Debug chip entirely when the host supplies none', () => {
      const withoutDebug: Omit<PipelineRunTreeRowProps, 'node'> = {
        ...runRowProps,
      };
      delete withoutDebug.onDebugFailure;
      renderBody(root, {
        ...failedProps({}),
        runRowProps: {
          ...withoutDebug,
          summaryLookup: { 'failed-run': failedSummary },
        },
      });
      expect(
        container.querySelector(
          '[data-testid="pipeline-run-debug-failure-failed-run"]',
        ),
      ).toBeNull();
      expect(container.textContent).not.toContain('Debug');
    });
  });
});

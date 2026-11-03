/**
 * @jest-environment jsdom
 */
jest.mock('../AnsiOutput', () => ({
  AnsiOutput: ({ lines }: { lines: string[] }): JSX.Element => (
    <div data-testid="ansi-lines">{lines.join('|')}</div>
  ),
}));
jest.mock('../../chat/TranscriptViewer', () => ({
  TranscriptViewer: (): null => null,
}));
jest.mock('../PipelineAdvisorMarkdown', () => ({
  PipelineAdvisorMarkdownText: (): null => null,
}));
jest.mock('../PipelineReportModal', () => ({
  PipelineReportModal: (): null => null,
}));
jest.mock('../PipelineReportMarkdown', () => ({
  PipelineReportMarkdown: (): null => null,
}));
jest.mock('../../pipeline/flow/PipelineFlowDiagram', () => ({
  PipelineFlowDiagram: (): null => null,
}));
jest.mock('@/lib/app-actions/dispatcher', () => ({
  dispatchAppAction: jest.fn(),
}));

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ExecutionState,
  ExecutionSummary,
  IPCResult,
  NormalizedStep,
  StepLogReadResult,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';
import {
  getPipelineDetailLeaseCount,
  resetPipelineDetailLeasesForTests,
} from '@/lib/pipelineDetailLeases';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { resetStepLogStoreForTests } from '@/stores/pipelineStepLogStore';
import { PipelineExecutionDetail } from '../details/PipelineExecutionDetail';
import { PipelineExecutionInlineDetail } from '../details/PipelineExecutionInlineDetail';
import { createFakePipelineExecutionActions } from './fakePipelineExecutionActions';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
Object.defineProperty(globalThis, 'CSS', {
  configurable: true,
  value: {},
});

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

const STARTED_AT = '2026-05-19T00:00:00.000Z';
const LOG_FILE = '/data/pipeline-executions/exec-1/logs/build--compile.log';

const COMPILE_STEP: NormalizedStep = {
  id: 'compile',
  name: 'Compile',
  run: 'npm run build',
  shell: 'bash',
  continue_on_error: false,
  timeout_minutes: 30,
  skip_on_missing_action: false,
};

const NESTED_STEP: NormalizedStep = {
  id: 'nested',
  name: 'Nested',
  uses: 'builtin/run-pipeline',
  shell: 'bash',
  continue_on_error: false,
  timeout_minutes: 30,
  skip_on_missing_action: false,
};

function stepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    status: 'running',
    outputs: {},
    dynamic_env: {},
    started_at: STARTED_AT,
    log_file: LOG_FILE,
    ...overrides,
  };
}

function executionState(
  overrides: Partial<ExecutionState> = {},
  steps: NormalizedStep[] = [COMPILE_STEP],
  stepResults: Record<string, StepResult> = { compile: stepResult() },
): ExecutionState {
  return {
    version: 8,
    id: 'exec-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: {
      name: 'Build pipeline',
      scope: ['directory'],
      jobs: {
        build: {
          name: 'Build',
          needs: [],
          timeout_minutes: 60,
          max_retries: 0,
          continue_on_error: false,
          steps,
        },
      },
    },
    status: 'running',
    jobs: {
      build: {
        status: 'running',
        steps: stepResults,
        outputs: {},
        started_at: STARTED_AT,
        iteration_count: 1,
      },
    },
    job_definitions: {},
    job_groups: {},
    pending_pauses: [],
    status_reasons: [],
    started_at: STARTED_AT,
    cwd: '/repo',
    env: {},
    inputs: {},
    event_name: 'dispatch',
    project_id: 'project',
    worktree_id: 'worktree',
    ...overrides,
  };
}

const pausedWithInput: ExecutionState = executionState({
  status: 'paused',
  pending_pauses: [
    {
      id: 'pause-1',
      kind: 'input',
      job_id: 'build',
      logical_job_id: 'build',
      step_id: 'compile',
      attempt: 0,
      iteration: 1,
      detected_at: STARTED_AT,
      request: {
        fields: [
          {
            key: 'scope',
            label: 'Scope',
            type: 'string',
            required: true,
            default: 'desktop',
          },
        ],
      },
    },
  ],
});

const getExecution = jest.fn<Promise<IPCResult<ExecutionState>>, [string]>();
const readStepLog = jest.fn<
  Promise<IPCResult<StepLogReadResult>>,
  [unknown, unknown]
>();

function byTestId(root: ParentNode, testId: string): HTMLElement | null {
  return root.querySelector(`[data-testid="${testId}"]`);
}

async function click(element: Element | null): Promise<void> {
  expect(element).toBeInstanceOf(HTMLElement);
  await act(async () => {
    element?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    await flushAsyncWork();
  });
}

describe('PipelineExecutionDetail', () => {
  let container: HTMLDivElement;
  let root: Root;

  async function render(node: JSX.Element): Promise<void> {
    await act(async () => {
      root.render(node);
      await flushAsyncWork();
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    resetPipelineDetailLeasesForTests();
    resetStepLogStoreForTests();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue({}),
        savePreferences: jest.fn().mockResolvedValue(undefined),
      },
    });
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        getExecution,
        readStepLog,
        runAdvisor: jest.fn(),
        readReportFile: jest.fn().mockResolvedValue({
          success: true,
          data: { content: 'report' },
        }),
      },
    });
    getExecution.mockResolvedValue({ success: true, data: executionState() });
    readStepLog.mockResolvedValue({
      success: true,
      data: { lines: ['live line'] },
    });
    usePipelineRunsStore.setState({
      summaries: [],
      statesById: { 'exec-1': executionState() },
      advisorSnapshotsByExecutionId: {},
    });
    useCurrentUiStateStore.setState({ revision: 0, slices: {} });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  describe('navigation callbacks', () => {
    it('navigates to the definition and worker without closing the view', async () => {
      usePipelineRunsStore.setState({
        statesById: {
          'exec-1': executionState({}, [COMPILE_STEP], {
            compile: stepResult({
              agentTerminalMode: true,
              workerId: 'worker-1',
            }),
          }),
        },
      });
      const onOpenDefinition = jest.fn();
      const onOpenWorker = jest.fn();
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={{ projectId: 'project', worktreeId: 'worktree' }}
          actions={createFakePipelineExecutionActions()}
          onOpenDefinition={onOpenDefinition}
          onOpenWorker={onOpenWorker}
        />,
      );

      await click(byTestId(container, 'pipeline-details-open-definition'));
      expect(onOpenDefinition).toHaveBeenCalledWith({
        pipelineId: 'pipeline-1',
        cwd: '/repo',
      });
      expect(byTestId(container, 'pipeline-execution-detail')).not.toBeNull();

      await click(byTestId(container, 'pipeline-details-nav-job-build'));
      // A running step auto-expands, showing the terminal-mode banner.
      await click(byTestId(container, 'pipeline-step-view-worker-button'));
      expect(onOpenWorker).toHaveBeenCalledWith('worker-1');
      expect(byTestId(container, 'pipeline-execution-detail')).not.toBeNull();
      expect(byTestId(container, 'pipeline-job-view-build')).not.toBeNull();
    });

    it('routes follow-ups through the controller for the run shown and reports the destination', async () => {
      usePipelineRunsStore.setState({
        statesById: {
          'exec-1': executionState({
            status: 'failure',
            planId: 'plan-1',
            plan_hash_after: 'hash',
            report_outputs: { report_file: '/repo/report.md' },
          }),
        },
      });
      const actions = createFakePipelineExecutionActions();
      const onNavigatedAway = jest.fn<void, [string]>();
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={actions}
          onNavigatedAway={onNavigatedAway}
        />,
      );

      await click(byTestId(container, 'pipeline-detail-debug-failure-exec-1'));
      await click(byTestId(container, 'pipeline-detail-plan-exec-1'));
      await click(byTestId(container, 'pipeline-detail-chat-follow-up-exec-1'));
      await click(
        byTestId(container, 'pipeline-detail-pipeline-follow-up-exec-1'),
      );
      await click(byTestId(container, 'pipeline-detail-view-report-exec-1'));
      await click(byTestId(container, 'pipeline-detail-retry-exec-1'));

      expect(actions.debugFailure).toHaveBeenCalledWith('exec-1');
      expect(actions.openPlan).toHaveBeenCalledWith('exec-1');
      expect(actions.chatFollowUp).toHaveBeenCalledWith('exec-1');
      expect(actions.pipelineFollowUp).toHaveBeenCalledWith('exec-1');
      expect(actions.openReport).toHaveBeenCalledWith('exec-1');
      expect(actions.retry).toHaveBeenCalledWith('exec-1');
      expect(
        onNavigatedAway.mock.calls.map(([destination]) => destination),
      ).toEqual(['debug', 'plan', 'chat', 'pipeline-follow-up', 'report']);
      // The detail never closes itself.
      expect(byTestId(container, 'pipeline-execution-detail')).not.toBeNull();
    });

    it('disables an action another surface already has in flight', async () => {
      usePipelineRunsStore.setState({
        statesById: { 'exec-1': executionState({ status: 'failure' }) },
      });
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={createFakePipelineExecutionActions({
            retryingIds: new Set(['exec-1']),
          })}
        />,
      );
      const retry = byTestId(container, 'pipeline-detail-retry-exec-1');
      expect(retry).toBeInstanceOf(HTMLButtonElement);
      expect(retry?.hasAttribute('disabled')).toBe(true);
      expect(retry?.textContent).toContain('Trying again…');
    });
  });

  describe('Definition used', () => {
    it('shows the definition the run started with from the job list', async () => {
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={createFakePipelineExecutionActions()}
        />,
      );
      expect(byTestId(container, 'pipeline-run-definition-used')).toBeNull();

      const entry = byTestId(container, 'pipeline-job-list-definition');
      await click(entry);
      expect(entry?.getAttribute('aria-current')).toBe('true');
      const definition = byTestId(container, 'pipeline-run-definition-used');
      // The recorded snapshot, not the pipeline as it is now.
      expect(definition?.textContent).toContain('Build pipeline');
      expect(definition?.textContent).toContain('Compile');
      expect(
        byTestId(container, 'pipeline-run-definition-used-not-recorded'),
      ).toBeNull();
      expect(byTestId(container, 'pipeline-job-view-build')).toBeNull();

      await click(byTestId(container, 'pipeline-details-nav-summary'));
      expect(byTestId(container, 'pipeline-run-definition-used')).toBeNull();
    });

    it('opens directly on Definition used from an initial or revealed target', async () => {
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={createFakePipelineExecutionActions()}
          initialTarget={{ entry: 'definition', jobId: 'build' }}
        />,
      );
      expect(
        byTestId(container, 'pipeline-run-definition-used'),
      ).not.toBeNull();
      expect(byTestId(container, 'pipeline-job-view-build')).toBeNull();

      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      const detail = (nonce: number): JSX.Element => (
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={createFakePipelineExecutionActions()}
          revealTarget={
            nonce === 1 ? { nonce } : { nonce, entry: 'definition' }
          }
        />
      );
      await render(detail(1));
      expect(byTestId(container, 'pipeline-run-definition-used')).toBeNull();
      await render(detail(2));
      expect(
        byTestId(container, 'pipeline-run-definition-used'),
      ).not.toBeNull();
    });
  });

  describe('reveal target', () => {
    it('applies an explicit target to an already-mounted instance', async () => {
      usePipelineRunsStore.setState({
        statesById: {
          'exec-1': executionState(),
          'child-1': executionState({
            id: 'child-1',
            pipeline_snapshot: {
              name: 'Child pipeline',
              scope: ['directory'],
              jobs: executionState().pipeline_snapshot.jobs,
            },
            parent_execution_id: 'exec-1',
          }),
        },
      });
      const detail = (
        revealTarget: Parameters<
          typeof PipelineExecutionDetail
        >[0]['revealTarget'],
      ): JSX.Element => (
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={createFakePipelineExecutionActions()}
          revealTarget={revealTarget}
        />
      );

      await render(detail({ nonce: 1 }));
      expect(byTestId(container, 'pipeline-job-view-build')).toBeNull();

      await render(detail({ nonce: 2, jobId: 'build' }));
      expect(byTestId(container, 'pipeline-job-view-build')).not.toBeNull();

      // The user moves on; re-rendering the same target does not snap back.
      await click(byTestId(container, 'pipeline-details-nav-summary'));
      expect(byTestId(container, 'pipeline-job-view-build')).toBeNull();
      await render(detail({ nonce: 2, jobId: 'build' }));
      expect(byTestId(container, 'pipeline-job-view-build')).toBeNull();

      // A new explicit target with a breadcrumb stack re-focuses the child.
      await render(
        detail({
          nonce: 3,
          viewStack: [{ executionId: 'child-1', label: 'Child pipeline' }],
          jobId: 'build',
        }),
      );
      const root = byTestId(container, 'pipeline-execution-detail');
      expect(root?.getAttribute('data-execution-id')).toBe('exec-1');
      expect(root?.getAttribute('data-active-execution-id')).toBe('child-1');
      expect(byTestId(container, 'pipeline-job-view-build')).not.toBeNull();

      // Back to the root Summary.
      await render(detail({ nonce: 4 }));
      expect(
        byTestId(container, 'pipeline-execution-detail')?.getAttribute(
          'data-active-execution-id',
        ),
      ).toBe('exec-1');
      expect(byTestId(container, 'pipeline-job-view-build')).toBeNull();
    });

    it('reports view changes to a controlling host', async () => {
      const onSelectionChange = jest.fn();
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={createFakePipelineExecutionActions()}
          selection={null}
          onSelectionChange={onSelectionChange}
        />,
      );
      await click(byTestId(container, 'pipeline-details-nav-job-build'));
      expect(onSelectionChange).toHaveBeenCalledWith({ jobId: 'build' });
      // Controlled: the host did not apply it, so Summary stays.
      expect(byTestId(container, 'pipeline-job-view-build')).toBeNull();
    });
  });

  describe('inline report (panel host)', () => {
    const scrollIntoView = jest.fn<void, [ScrollIntoViewOptions?]>();
    let reducedMotion = false;
    // jsdom implements neither; restore whatever was there (usually nothing).
    const originalScrollIntoView = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView',
    );
    const originalMatchMedia = Object.getOwnPropertyDescriptor(
      window,
      'matchMedia',
    );
    function restore(
      target: object,
      key: string,
      descriptor: PropertyDescriptor | undefined,
    ): void {
      if (descriptor === undefined) {
        Reflect.deleteProperty(target, key);
      } else {
        Object.defineProperty(target, key, descriptor);
      }
    }

    function reportState(overrides: Partial<ExecutionState> = {}): void {
      usePipelineRunsStore.setState({
        statesById: {
          'exec-1': executionState({
            status: 'success',
            report_outputs: { report_file: '/repo/report.md' },
            ...overrides,
          }),
          'exec-child': executionState({
            id: 'exec-child',
            status: 'success',
            report_outputs: { report_file: '/repo/child-report.md' },
          }),
        },
      });
    }

    beforeEach(() => {
      scrollIntoView.mockClear();
      reducedMotion = false;
      Object.defineProperty(Element.prototype, 'scrollIntoView', {
        configurable: true,
        writable: true,
        value: scrollIntoView,
      });
      Object.defineProperty(window, 'matchMedia', {
        configurable: true,
        writable: true,
        value: (query: string): MediaQueryList => ({
          matches: reducedMotion && query.includes('prefers-reduced-motion'),
          media: query,
          onchange: null,
          addListener: jest.fn(),
          removeListener: jest.fn(),
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          dispatchEvent: jest.fn(() => false),
        }),
      });
    });

    afterEach(() => {
      restore(Element.prototype, 'scrollIntoView', originalScrollIntoView);
      restore(window, 'matchMedia', originalMatchMedia);
    });

    it('selects Summary and brings the report into view instead of opening the modal', async () => {
      reportState();
      const actions = createFakePipelineExecutionActions();
      const onNavigatedAway = jest.fn<void, [string]>();
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={actions}
          initialTarget={{ jobId: 'build' }}
          viewReportInline
          onNavigatedAway={onNavigatedAway}
        />,
      );
      expect(byTestId(container, 'pipeline-job-view-build')).not.toBeNull();
      expect(byTestId(container, 'pipeline-report')).toBeNull();

      await click(byTestId(container, 'pipeline-detail-view-report-exec-1'));

      expect(actions.openReport).not.toHaveBeenCalled();
      expect(onNavigatedAway).not.toHaveBeenCalled();
      expect(byTestId(container, 'pipeline-job-view-build')).toBeNull();
      const region = byTestId(container, 'pipeline-report-region');
      expect(region).not.toBeNull();
      expect(region?.contains(byTestId(container, 'pipeline-report'))).toBe(
        true,
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.mock.instances[0]).toBe(region);
      expect(scrollIntoView).toHaveBeenCalledWith({
        block: 'start',
        behavior: 'smooth',
      });
      expect(document.activeElement).toBe(region);
    });

    it('scrolls without animation when reduced motion is requested', async () => {
      reportState();
      reducedMotion = true;
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={createFakePipelineExecutionActions()}
          initialTarget={{ jobId: 'build' }}
          viewReportInline
        />,
      );

      await click(byTestId(container, 'pipeline-detail-view-report-exec-1'));

      expect(scrollIntoView).toHaveBeenCalledWith({
        block: 'start',
        behavior: 'auto',
      });
    });

    it('drives a controlling host to Summary and keeps the drilled-in run', async () => {
      reportState();
      const onSelectionChange = jest.fn();
      const onViewStackChange = jest.fn();
      const stack = [{ executionId: 'exec-child', label: 'Child' }];
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={createFakePipelineExecutionActions()}
          viewStack={stack}
          onViewStackChange={onViewStackChange}
          selection={{ jobId: 'build' }}
          onSelectionChange={onSelectionChange}
          viewReportInline
        />,
      );

      await click(
        byTestId(container, 'pipeline-detail-view-report-exec-child'),
      );

      expect(onSelectionChange).toHaveBeenCalledWith(null);
      // The child's own Summary: the stack is untouched.
      expect(onViewStackChange).not.toHaveBeenCalled();
    });

    it('reveals the report again when Summary is already showing', async () => {
      reportState();
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={createFakePipelineExecutionActions()}
          viewReportInline
        />,
      );

      await click(byTestId(container, 'pipeline-detail-view-report-exec-1'));
      await click(byTestId(container, 'pipeline-detail-view-report-exec-1'));

      expect(scrollIntoView).toHaveBeenCalledTimes(2);
    });

    describe('settle-window pin', () => {
      interface ObservedContent {
        target: Element;
        callback: ResizeObserverCallback;
        disconnect: jest.Mock;
      }
      const observed: ObservedContent[] = [];
      const layout = { contentHeight: 600, regionTop: 300 };
      let rectSpy: jest.SpyInstance<DOMRect, []>;

      function rect(top: number, height: number): DOMRect {
        return {
          x: 0,
          y: top,
          width: 100,
          height,
          top,
          left: 0,
          right: 100,
          bottom: top + height,
          toJSON: () => ({}),
        };
      }

      beforeEach(() => {
        observed.length = 0;
        layout.contentHeight = 600;
        layout.regionTop = 300;
        Object.defineProperty(window, 'ResizeObserver', {
          configurable: true,
          writable: true,
          value: class {
            private readonly callback: ResizeObserverCallback;
            private readonly disconnectMock = jest.fn();
            constructor(callback: ResizeObserverCallback) {
              this.callback = callback;
            }
            observe(target: Element): void {
              observed.push({
                target,
                callback: this.callback,
                disconnect: this.disconnectMock,
              });
            }
            unobserve(): void {}
            disconnect(): void {
              this.disconnectMock();
            }
          },
        });
        rectSpy = jest
          .spyOn(Element.prototype, 'getBoundingClientRect')
          .mockImplementation(function (this: Element): DOMRect {
            const testId = this.getAttribute('data-testid');
            if (testId === 'pipeline-report-region') {
              return rect(layout.regionTop, 200);
            }
            if (
              this.parentElement?.getAttribute('data-testid') ===
              'pipeline-execution-detail-body'
            ) {
              return rect(0, layout.contentHeight);
            }
            return rect(0, 400);
          });
      });

      afterEach(() => {
        rectSpy.mockRestore();
        Reflect.deleteProperty(window, 'ResizeObserver');
      });

      /** The observer watching the body's content, once the pin started. */
      function pinObserver(): ObservedContent {
        const match = observed.find(
          (entry) =>
            entry.target.parentElement?.getAttribute('data-testid') ===
            'pipeline-execution-detail-body',
        );
        if (match === undefined) throw new Error('no report pin observer');
        return match;
      }

      /** Fires the observer like the browser would: never once disconnected. */
      function notifyResize(): void {
        const { callback, disconnect } = pinObserver();
        if (disconnect.mock.calls.length > 0) return;
        act(() => {
          callback([], new window.ResizeObserver(callback));
        });
      }

      async function startReveal(): Promise<HTMLElement | null> {
        reportState();
        await render(
          <PipelineExecutionDetail
            executionId="exec-1"
            owner={null}
            actions={createFakePipelineExecutionActions()}
            initialTarget={{ jobId: 'build' }}
            viewReportInline
          />,
        );
        await click(byTestId(container, 'pipeline-detail-view-report-exec-1'));
        return byTestId(container, 'pipeline-report-region');
      }

      it('re-issues an instant scroll when the content above grows and pushes the report down', async () => {
        const region = await startReveal();
        expect(scrollIntoView).toHaveBeenCalledTimes(1);

        layout.contentHeight = 900;
        layout.regionTop = 420;
        notifyResize();

        expect(scrollIntoView).toHaveBeenCalledTimes(2);
        expect(scrollIntoView.mock.instances[1]).toBe(region);
        expect(scrollIntoView).toHaveBeenLastCalledWith({
          block: 'start',
          behavior: 'auto',
        });
      });

      it('leaves the scroll alone when the content changes but the report is already at the top', async () => {
        await startReveal();

        layout.contentHeight = 900;
        layout.regionTop = 0;
        notifyResize();

        expect(scrollIntoView).toHaveBeenCalledTimes(1);
      });

      it('ignores a resize callback that did not change the content height', async () => {
        await startReveal();

        layout.regionTop = 420;
        notifyResize();

        expect(scrollIntoView).toHaveBeenCalledTimes(1);
      });

      it.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])(
        'stops pinning once the user sends %s input',
        async (eventType) => {
          await startReveal();
          const { disconnect } = pinObserver();

          act(() => {
            document.body.dispatchEvent(
              new Event(eventType, { bubbles: true }),
            );
          });
          expect(disconnect).toHaveBeenCalledTimes(1);

          layout.contentHeight = 900;
          layout.regionTop = 420;
          notifyResize();
          expect(scrollIntoView).toHaveBeenCalledTimes(1);
        },
      );

      it('stops pinning when a new selection replaces the report', async () => {
        await startReveal();
        const { disconnect } = pinObserver();

        await click(byTestId(container, 'pipeline-details-nav-job-build'));

        expect(disconnect).toHaveBeenCalled();
      });

      it('stops pinning when the detail unmounts', async () => {
        await startReveal();
        const { disconnect } = pinObserver();

        act(() => {
          root.unmount();
        });
        root = createRoot(container);

        expect(disconnect).toHaveBeenCalledTimes(1);
      });
    });

    it('keeps opening the report modal without the inline option', async () => {
      reportState();
      const actions = createFakePipelineExecutionActions();
      const onNavigatedAway = jest.fn<void, [string]>();
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={actions}
          initialTarget={{ jobId: 'build' }}
          onNavigatedAway={onNavigatedAway}
        />,
      );

      await click(byTestId(container, 'pipeline-detail-view-report-exec-1'));

      expect(actions.openReport).toHaveBeenCalledWith('exec-1');
      expect(onNavigatedAway).toHaveBeenCalledWith('report');
      expect(byTestId(container, 'pipeline-job-view-build')).not.toBeNull();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  describe('instance-scoped ids', () => {
    it('gives each open detail its own pause-input ids', async () => {
      usePipelineRunsStore.setState({
        statesById: { 'exec-1': pausedWithInput },
      });
      await render(
        <>
          <PipelineExecutionDetail
            executionId="exec-1"
            owner={null}
            actions={createFakePipelineExecutionActions()}
          />
          <PipelineExecutionDetail
            executionId="exec-1"
            owner={null}
            actions={createFakePipelineExecutionActions()}
            idScope="panel-b"
          />
        </>,
      );
      const inputs = Array.from(
        container.querySelectorAll('[data-testid="pause-field-scope"]'),
      );
      expect(inputs).toHaveLength(2);
      const ids = inputs.map((input) => input.id);
      expect(new Set(ids).size).toBe(2);
      expect(ids[1]).toBe('pause-input-panel-b-scope');
      for (const input of inputs) {
        const label = container.querySelector(`label[for="${input.id}"]`);
        expect(label?.textContent).toContain('Scope');
      }
    });
  });

  describe('current UI reporting', () => {
    it('reports under its key, and an inline child never clears it', async () => {
      const key = 'pipelineRuns.panel.test';
      const tree = (withChild: boolean): JSX.Element => (
        <>
          <PipelineExecutionDetail
            executionId="exec-1"
            owner={null}
            actions={createFakePipelineExecutionActions()}
            uiStateKey={key}
          />
          {withChild ? (
            <PipelineExecutionInlineDetail executionId="exec-1" owner={null} />
          ) : null}
        </>
      );
      await render(tree(true));
      expect(useCurrentUiStateStore.getState().slices[key]).toMatchObject({
        executionId: 'exec-1',
      });

      await render(tree(false));
      expect(useCurrentUiStateStore.getState().slices[key]).toMatchObject({
        executionId: 'exec-1',
      });

      await render(<></>);
      expect(useCurrentUiStateStore.getState().slices[key]).toBeUndefined();
    });

    it('reports nothing without a key', async () => {
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={null}
          actions={createFakePipelineExecutionActions()}
        />,
      );
      expect(useCurrentUiStateStore.getState().slices).toEqual({});
    });
  });

  describe('visibility gate', () => {
    it('holds its lease only while enabled', async () => {
      usePipelineRunsStore.setState({ statesById: {} });
      const detail = (enabled: boolean): JSX.Element => (
        <PipelineExecutionDetail
          executionId="exec-1"
          owner={{ projectId: 'project', worktreeId: 'worktree' }}
          detailEnabled={enabled}
          actions={createFakePipelineExecutionActions()}
        />
      );
      await render(detail(false));
      expect(getPipelineDetailLeaseCount('exec-1')).toBe(0);
      expect(getExecution).not.toHaveBeenCalled();

      await render(detail(true));
      expect(getPipelineDetailLeaseCount('exec-1')).toBe(1);
      expect(getExecution).toHaveBeenCalledTimes(1);

      await render(detail(false));
      expect(getPipelineDetailLeaseCount('exec-1')).toBe(0);
    });
  });

  describe('job list without a panel', () => {
    it('always docks it, however narrow the host (the compat modal)', async () => {
      // A host that passes no `navigation` (the ownerless compat modal, the
      // archived viewer) keeps its static list: no toggle, no width rule.
      const observe = jest.fn();
      Object.defineProperty(window, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: class {
          observe = observe;
          unobserve = jest.fn();
          disconnect = jest.fn();
        },
      });
      try {
        container.style.width = '320px';
        await render(
          <PipelineExecutionDetail
            executionId="exec-1"
            owner={{ projectId: 'project', worktreeId: 'worktree' }}
            actions={createFakePipelineExecutionActions()}
          />,
        );
        expect(byTestId(container, 'pipeline-details-nav')).not.toBeNull();
        expect(byTestId(container, 'pipeline-panel-nav-toggle')).toBeNull();
        expect(byTestId(container, 'pipeline-panel-nav')).toBeNull();
        expect(observe).not.toHaveBeenCalled();
      } finally {
        Reflect.deleteProperty(window, 'ResizeObserver');
      }
    });
  });

  describe('archived source', () => {
    const ARCHIVED_SOURCE = { projectId: 'ws-1', containerId: 'container-1' };
    const listExecutions = jest.fn();
    const readExecution = jest.fn();
    const readExecutionStepLog = jest.fn();
    const readExecutionReport = jest.fn();

    const archivedParent = executionState(
      {
        status: 'failure',
        planId: 'plan-1',
        plan_hash_after: 'hash',
        report_outputs: { report_file: '/repo/report.md' },
      },
      [COMPILE_STEP, NESTED_STEP],
      {
        compile: stepResult({
          status: 'failure',
          agentTerminalMode: true,
          workerId: 'worker-1',
        }),
        nested: stepResult({ status: 'success' }),
      },
    );
    const archivedChild = executionState(
      {
        id: 'child-1',
        status: 'success',
        parent_execution_id: 'exec-1',
      },
      [COMPILE_STEP],
      { compile: stepResult({ status: 'success' }) },
    );
    const childSummary: ExecutionSummary = {
      id: 'child-1',
      pipeline_id: 'pipeline-1',
      pipeline_name: 'Child pipeline',
      status: 'success',
      status_reasons: [],
      started_at: STARTED_AT,
      cwd: '/repo',
      parent_execution_id: 'exec-1',
      parent_step_id: 'nested',
      parent_attempt: 0,
    };

    beforeEach(() => {
      usePipelineRunsStore.setState({ statesById: {} });
      listExecutions.mockResolvedValue({ executions: [childSummary] });
      readExecution.mockImplementation(
        ({ executionId }: { executionId: string }) =>
          Promise.resolve(
            executionId === 'child-1' ? archivedChild : archivedParent,
          ),
      );
      readExecutionStepLog.mockResolvedValue({ lines: ['archived line'] });
      readExecutionReport.mockResolvedValue({
        content: 'report',
        filePath: '/repo/report.md',
      });
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: {
          loadPreferences: jest.fn().mockResolvedValue({}),
          archivedContainers: {
            listExecutions,
            readExecution,
            readExecutionStepLog,
            readExecutionReport,
          },
        },
      });
    });

    it('reads through the archive transport, never the live API, and hides live controls', async () => {
      await render(
        <PipelineExecutionDetail
          executionId="exec-1"
          archivedSource={ARCHIVED_SOURCE}
        />,
      );
      expect(byTestId(container, 'pipeline-details-nav')).not.toBeNull();
      expect(getExecution).not.toHaveBeenCalled();
      expect(getPipelineDetailLeaseCount('exec-1')).toBe(0);
      // No live action bar, advisor, or watchers.
      expect(
        container.querySelectorAll('[data-testid^="pipeline-detail-"]'),
      ).toHaveLength(0);

      await click(byTestId(container, 'pipeline-details-nav-job-build'));
      await click(
        byTestId(container, 'pipeline-step-compile')?.querySelector('button') ??
          null,
      );
      expect(readExecutionStepLog).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'ws-1',
          containerId: 'container-1',
          executionId: 'exec-1',
          stepId: 'compile',
        }),
      );
      expect(
        byTestId(container, 'pipeline-step-log-output-compile')?.textContent,
      ).toContain('archived line');
      expect(
        byTestId(container, 'pipeline-step-terminal-mode-banner'),
      ).not.toBeNull();
      expect(
        byTestId(container, 'pipeline-step-view-worker-button'),
      ).toBeNull();

      // The nested child expands inline through the same archive transport.
      const childToggle = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Child pipeline',
      );
      await click(childToggle ?? null);
      expect(readExecution).toHaveBeenCalledWith({
        projectId: 'ws-1',
        containerId: 'container-1',
        executionId: 'child-1',
      });
      const childStepButton = Array.from(
        container.querySelectorAll('.border-line-accent button'),
      ).find((button) => button.textContent?.includes('Compile'));
      await click(childStepButton ?? null);
      expect(readExecutionStepLog).toHaveBeenCalledWith(
        expect.objectContaining({ executionId: 'child-1', stepId: 'compile' }),
      );

      expect(readStepLog).not.toHaveBeenCalled();
      expect(getExecution).not.toHaveBeenCalled();
    });

    it('never reads live logs from an archived inline child', async () => {
      await render(
        <PipelineExecutionInlineDetail
          executionId="child-1"
          owner={null}
          archivedSource={ARCHIVED_SOURCE}
        />,
      );
      const stepButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.includes('Compile'),
      );
      await click(stepButton ?? null);
      expect(readExecutionStepLog).toHaveBeenCalledTimes(1);
      expect(readStepLog).not.toHaveBeenCalled();
      expect(getExecution).not.toHaveBeenCalled();
    });
  });
});

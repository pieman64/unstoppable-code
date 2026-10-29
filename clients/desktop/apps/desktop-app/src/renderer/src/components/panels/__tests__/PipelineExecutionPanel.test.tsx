/**
 * @jest-environment jsdom
 *
 * PipelineExecutionPanel — the real run detail hosted in a panel tab: owner
 * from the panel, no modal chrome, data demand only while visible (phase 02
 * lease, step-log interests, report reads, and detail timers all released
 * while hidden, re-acquired once on reveal), per-panel session state that
 * survives unmounting, explicit reveal targets, recoverable load errors, and
 * the collapsible job list, which follows the panel's width until the user
 * makes an explicit choice.
 */
jest.mock('@/components/activity/AnsiOutput', () => ({
  AnsiOutput: ({ lines }: { lines: string[] }): JSX.Element => (
    <div data-testid="ansi-lines">{lines.join('|')}</div>
  ),
}));
jest.mock('@/components/chat/TranscriptViewer', () => ({
  TranscriptViewer: (): null => null,
}));
jest.mock('@/components/activity/PipelineAdvisorMarkdown', () => ({
  PipelineAdvisorMarkdownText: (): null => null,
}));
jest.mock('@/components/activity/PipelineReportModal', () => ({
  PipelineReportModal: (): null => null,
}));
jest.mock('@/components/activity/PipelineReportMarkdown', () => ({
  PipelineReportMarkdown: (): null => null,
}));
jest.mock('@/components/pipeline/flow/PipelineFlowDiagram', () => ({
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
import * as leases from '@/lib/pipelineDetailLeases';
import {
  getPipelineDetailLeaseCount,
  resetPipelineDetailLeasesForTests,
} from '@/lib/pipelineDetailLeases';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import {
  getStepLogInterestCount,
  resetStepLogStoreForTests,
} from '@/stores/pipelineStepLogStore';
import {
  PIPELINE_PANEL_NAV_AUTO_COLLAPSE_WIDTH_PX,
  pipelinePanelUiKey,
  requestPipelinePanelReveal,
  resetPipelinePanelUiStoreForTests,
  selectPipelinePanelUiEntry,
  usePipelinePanelUiStore,
} from '@/stores/pipelinePanelUiStore';
import { setNativeInputValue } from '@/test-utils/dom';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { pipelineDetailPanelUiStateKey } from '@/lib/current-ui-state/pipelineDetailUiState';
import { PipelineExecutionPanel } from '../pipeline/PipelineExecutionPanel';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
Object.defineProperty(globalThis, 'CSS', { configurable: true, value: {} });

const OWNER = { projectId: 'project', worktreeId: 'worktree' };
const OWNER_KEY = 'project/worktree';
const PANEL_ID = 'panel-pipeline-exec-1';
const UI_KEY = pipelinePanelUiKey(OWNER_KEY, PANEL_ID);
const STARTED_AT = '2026-05-19T00:00:00.000Z';

const COMPILE_STEP: NormalizedStep = {
  id: 'compile',
  name: 'Compile',
  run: 'npm run build',
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
    log_file: '/data/pipeline-executions/exec-1/logs/build--compile.log',
    ...overrides,
  };
}

function executionState(
  overrides: Partial<ExecutionState> = {},
): ExecutionState {
  return {
    version: 8,
    id: 'exec-1',
    pipeline_id: 'pipeline-1',
    pipeline_snapshot: {
      name: 'Build pipeline',
      jobs: {
        build: {
          name: 'Build',
          needs: [],
          timeout_minutes: 60,
          max_retries: 0,
          continue_on_error: false,
          steps: [COMPILE_STEP],
        },
      },
    },
    status: 'running',
    jobs: {
      build: {
        status: 'running',
        steps: { compile: stepResult() },
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
    event_name: 'manual',
    project_id: 'project',
    worktree_id: 'worktree',
    ...overrides,
  };
}

function summaryFor(state: ExecutionState): ExecutionSummary {
  return {
    id: state.id,
    pipeline_id: state.pipeline_id,
    pipeline_name: state.pipeline_snapshot.name,
    status: state.status,
    status_reasons: [],
    started_at: state.started_at,
    project_id: 'project',
    worktree_id: 'worktree',
  };
}

const pausedWithInput = (checkpointId: string): ExecutionState =>
  executionState({
    status: 'paused',
    pending_pauses: [
      {
        id: checkpointId,
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
const readReportFile = jest.fn();
const resumeExecution = jest.fn();

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
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

/**
 * Moves the pointer from one React-managed element to another. React
 * synthesizes both the leave and the enter from the `pointerout` on the
 * element being left (it ignores `pointerover` from a managed element).
 */
function movePointer(from: Element, to: Element): void {
  act(() => {
    from.dispatchEvent(
      new MouseEvent('pointerout', { bubbles: true, relatedTarget: to }),
    );
  });
}

/**
 * A `ResizeObserver` the test drives: `resize` reports a width for every
 * element the instance observes.
 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    this.disconnected = true;
  }

  resize(width: number): void {
    const entries = Array.from(this.targets, (target) =>
      resizeEntry(target, width),
    );
    if (entries.length > 0) this.callback(entries, this);
  }
}

function resizeEntry(target: Element, width: number): ResizeObserverEntry {
  const height = 800;
  const size: ResizeObserverSize = { inlineSize: width, blockSize: height };
  return {
    target,
    contentRect: {
      x: 0,
      y: 0,
      width,
      height,
      top: 0,
      left: 0,
      right: width,
      bottom: height,
      toJSON: (): object => ({ width, height }),
    },
    borderBoxSize: [size],
    contentBoxSize: [size],
    devicePixelContentBoxSize: [size],
  };
}

/** Active `setInterval` ids started through `window`, for timer checks. */
function trackIntervals(): { active: Set<number>; restore: () => void } {
  const active = new Set<number>();
  const realSet = window.setInterval.bind(window);
  const realClear = window.clearInterval.bind(window);
  const setSpy = jest
    .spyOn(window, 'setInterval')
    .mockImplementation((handler: TimerHandler, timeout?: number): number => {
      const id = realSet(handler, timeout);
      active.add(id);
      return id;
    });
  const clearSpy = jest
    .spyOn(window, 'clearInterval')
    .mockImplementation((id?: number): void => {
      if (id !== undefined) active.delete(id);
      realClear(id);
    });
  return {
    active,
    restore: (): void => {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    },
  };
}

describe('PipelineExecutionPanel', () => {
  let container: HTMLDivElement;
  let root: Root;

  function panel(visible: boolean, active = false): JSX.Element {
    return (
      <PipelineExecutionPanel
        panelId={PANEL_ID}
        executionId="exec-1"
        owner={OWNER}
        visible={visible}
        active={active}
        ownerDocument={document}
      />
    );
  }

  async function render(node: JSX.Element): Promise<void> {
    await act(async () => {
      root.render(node);
      await flushAsyncWork();
    });
  }

  async function remount(visible = true): Promise<void> {
    act(() => {
      root.unmount();
    });
    root = createRoot(container);
    await render(panel(visible));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    resetPipelineDetailLeasesForTests();
    resetStepLogStoreForTests();
    resetPipelinePanelUiStoreForTests();
    useCurrentUiStateStore.setState({ slices: {} });
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
        readReportFile,
      },
    });
    getExecution.mockImplementation(() =>
      Promise.resolve({ success: true, data: executionState() }),
    );
    readStepLog.mockResolvedValue({
      success: true,
      data: { lines: ['live line'] },
    });
    readReportFile.mockResolvedValue({
      success: true,
      data: { content: 'report body' },
    });
    resumeExecution.mockResolvedValue({ success: true });
    usePipelineRunsStore.setState({
      summaries: [],
      statesById: {},
      advisorSnapshotsByExecutionId: {},
      resumeExecution,
    });
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

  it('renders the run detail for its panel owner without modal chrome', async () => {
    const acquire = jest.spyOn(leases, 'acquirePipelineDetailLease');
    await render(panel(true));

    const host = byTestId('pipeline-execution-panel');
    expect(host?.getAttribute('data-execution-id')).toBe('exec-1');
    expect(host?.getAttribute('data-detail-state')).toBe('active');
    expect(byTestId('pipeline-execution-detail')).not.toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.querySelector('[aria-modal]')).toBeNull();
    expect(acquire).toHaveBeenCalledWith(OWNER, 'exec-1');
    expect(getPipelineDetailLeaseCount('exec-1')).toBe(1);
    // The tab learns the run's name.
    expect(
      selectPipelinePanelUiEntry(
        usePipelinePanelUiStore.getState(),
        UI_KEY,
        'exec-1',
      )?.title,
    ).toBe('Build pipeline');
    acquire.mockRestore();
  });

  it('reports its run to App Advisor under its own key only while shown', async () => {
    const slicesKey = pipelineDetailPanelUiStateKey(UI_KEY);
    await render(panel(true, true));

    expect(useCurrentUiStateStore.getState().slices[slicesKey]).toMatchObject({
      executionId: 'exec-1',
      pipelineId: 'pipeline-1',
      status: 'running',
      host: 'panel',
      ownerKey: OWNER_KEY,
      panelId: PANEL_ID,
      active: true,
      auxiliaryWindow: false,
    });
    // The fixed compatibility-modal key is left alone.
    expect(
      useCurrentUiStateStore.getState().slices['pipelineRuns.detailModal'],
    ).toBeUndefined();

    await render(panel(true, false));
    expect(useCurrentUiStateStore.getState().slices[slicesKey]).toMatchObject({
      active: false,
    });

    // Hidden (background tab, collapsed group, covered, other page): nothing.
    await render(panel(false));
    expect(useCurrentUiStateStore.getState().slices[slicesKey]).toBeUndefined();

    await render(panel(true, true));
    expect(useCurrentUiStateStore.getState().slices[slicesKey]).toMatchObject({
      executionId: 'exec-1',
      active: true,
    });
  });

  it('never mounts or reads anything before it is first shown', async () => {
    await render(panel(false));
    expect(byTestId('pipeline-execution-detail')).toBeNull();
    expect(getExecution).not.toHaveBeenCalled();
    expect(getPipelineDetailLeaseCount('exec-1')).toBe(0);
  });

  it('releases its lease and log interests while hidden and re-acquires once on reveal', async () => {
    const acquire = jest.spyOn(leases, 'acquirePipelineDetailLease');
    await render(panel(true));
    await click(byTestId('pipeline-details-nav-job-build'));
    // The running step auto-expands and reads its log once.
    expect(readStepLog).toHaveBeenCalledTimes(1);
    expect(getStepLogInterestCount()).toBe(1);
    expect(getPipelineDetailLeaseCount('exec-1')).toBe(1);
    expect(getExecution).toHaveBeenCalledTimes(1);

    await render(panel(false));
    expect(
      byTestId('pipeline-execution-panel')?.getAttribute('data-detail-state'),
    ).toBe('suspended');
    expect(getPipelineDetailLeaseCount('exec-1')).toBe(0);
    expect(getStepLogInterestCount()).toBe(0);
    // Nothing retained the heavy snapshot, so it was evicted.
    expect(
      usePipelineRunsStore.getState().statesById['exec-1'],
    ).toBeUndefined();

    acquire.mockClear();
    await render(panel(true));
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(getPipelineDetailLeaseCount('exec-1')).toBe(1);
    expect(getExecution).toHaveBeenCalledTimes(2);
    // The same job is still selected and its log is read once more.
    expect(byTestId('pipeline-job-view-build')).not.toBeNull();
    expect(getStepLogInterestCount()).toBe(1);
    expect(readStepLog).toHaveBeenCalledTimes(2);
    acquire.mockRestore();
  });

  it('stops detail timers while hidden and restarts them on reveal', async () => {
    const intervals = trackIntervals();
    try {
      await render(panel(true));
      await click(byTestId('pipeline-details-nav-job-build'));
      expect(intervals.active.size).toBeGreaterThan(0);
      await render(panel(false));
      expect(intervals.active.size).toBe(0);
      await render(panel(true));
      expect(intervals.active.size).toBeGreaterThan(0);
    } finally {
      intervals.restore();
    }
  });

  it('reads no report while hidden, even when the run changes', async () => {
    const withReport = executionState({
      status: 'success',
      report_outputs: { report_file: '/repo/report.md' },
    });
    getExecution.mockResolvedValue({ success: true, data: withReport });
    // Retained by the visible run list, so the snapshot survives hiding.
    usePipelineRunsStore.setState({
      summaries: [summaryFor(withReport)],
      statesById: { 'exec-1': withReport },
    });
    await render(panel(true));
    expect(readReportFile).toHaveBeenCalledTimes(1);

    await render(panel(false));
    await act(async () => {
      usePipelineRunsStore.setState({
        statesById: {
          'exec-1': {
            ...withReport,
            report_outputs: {
              report_file: '/repo/report.md',
              report_json_file: '/repo/report.json',
            },
          },
        },
      });
      await flushAsyncWork();
    });
    expect(readReportFile).toHaveBeenCalledTimes(1);

    await render(panel(true));
    // Revealed: the Summary's report region reads its current entries.
    expect(readReportFile).toHaveBeenCalledTimes(3);
  });

  it('keeps its place across an unmount (worktree switch)', async () => {
    await render(panel(true));
    await click(byTestId('pipeline-details-nav-job-build'));
    const stepToggle = byTestId('pipeline-step-compile')?.querySelector(
      'button[aria-expanded]',
    );
    expect(stepToggle?.getAttribute('aria-expanded')).toBe('true');
    // The user collapses the running step and hides the job list.
    await click(stepToggle ?? null);
    await click(byTestId('pipeline-panel-nav-toggle'));
    expect(byTestId('pipeline-panel-nav')).toBeNull();

    await remount();
    expect(byTestId('pipeline-job-view-build')).not.toBeNull();
    expect(
      byTestId('pipeline-step-compile')
        ?.querySelector('button[aria-expanded]')
        ?.getAttribute('aria-expanded'),
    ).toBe('false');
    expect(byTestId('pipeline-panel-nav')).toBeNull();
    expect(
      byTestId('pipeline-panel-nav-toggle')?.getAttribute('aria-label'),
    ).toBe('Show jobs');
  });

  it('applies an explicit reveal target to the mounted panel', async () => {
    await render(panel(true));
    expect(byTestId('pipeline-job-view-build')).toBeNull();
    await act(async () => {
      requestPipelinePanelReveal({
        ownerKey: OWNER_KEY,
        panelId: PANEL_ID,
        executionId: 'exec-1',
        target: { jobId: 'build' },
      });
      await flushAsyncWork();
    });
    expect(byTestId('pipeline-job-view-build')).not.toBeNull();
    await click(byTestId('pipeline-details-nav-summary'));
    expect(byTestId('pipeline-job-view-build')).toBeNull();
  });

  it('shows a recoverable error for a run it cannot read, and retries', async () => {
    getExecution.mockResolvedValue({ success: false, error: 'not found' });
    await render(panel(true));
    const notice = byTestId('pipeline-execution-panel-load-error');
    expect(notice?.textContent).toContain("Couldn't load this run");
    expect(getExecution).toHaveBeenCalledTimes(1);

    getExecution.mockResolvedValue({ success: true, data: executionState() });
    await click(byTestId('pipeline-execution-panel-retry'));
    expect(getExecution).toHaveBeenCalledTimes(2);
    expect(byTestId('pipeline-execution-panel-load-error')).toBeNull();
    expect(byTestId('pipeline-details-nav')).not.toBeNull();
  });

  describe('pause drafts', () => {
    it('keeps an unsent answer across an unmount, never submitting it', async () => {
      const paused = pausedWithInput('pause-1');
      getExecution.mockResolvedValue({ success: true, data: paused });
      usePipelineRunsStore.setState({
        summaries: [summaryFor(paused)],
        statesById: { 'exec-1': paused },
      });
      await render(panel(true));
      const input = byTestId('pause-field-scope');
      expect(input).toBeInstanceOf(HTMLInputElement);
      await act(async () => {
        if (input instanceof HTMLInputElement) {
          setNativeInputValue(input, 'web');
        }
        await flushAsyncWork();
      });

      await remount();
      const restored = byTestId('pause-field-scope');
      expect(restored instanceof HTMLInputElement ? restored.value : '').toBe(
        'web',
      );
      expect(resumeExecution).not.toHaveBeenCalled();
    });

    it('drops a draft whose checkpoint is no longer pending', async () => {
      const paused = pausedWithInput('pause-1');
      usePipelineRunsStore.setState({
        summaries: [summaryFor(paused)],
        statesById: { 'exec-1': paused },
      });
      await render(panel(true));
      const input = byTestId('pause-field-scope');
      await act(async () => {
        if (input instanceof HTMLInputElement) {
          setNativeInputValue(input, 'web');
        }
        await flushAsyncWork();
      });
      act(() => {
        root.unmount();
      });
      // The run moved on to a new request while the panel was away.
      const next = pausedWithInput('pause-2');
      usePipelineRunsStore.setState({
        summaries: [summaryFor(next)],
        statesById: { 'exec-1': next },
      });
      root = createRoot(container);
      await render(panel(true));
      const fresh = byTestId('pause-field-scope');
      expect(fresh instanceof HTMLInputElement ? fresh.value : '').toBe(
        'desktop',
      );
    });

    it('refuses to answer a checkpoint the live run has moved past', async () => {
      const paused = pausedWithInput('pause-1');
      usePipelineRunsStore.setState({
        summaries: [summaryFor(paused)],
        statesById: { 'exec-1': paused },
      });
      await render(panel(true));
      // The live store already shows the checkpoint answered elsewhere, but
      // this panel has not re-rendered from it yet.
      usePipelineRunsStore.setState({
        statesById: {
          'exec-1': { ...paused, status: 'running', pending_pauses: [] },
        },
      });
      await act(async () => {
        byTestId('pause-input-resume')?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        );
        await flushAsyncWork();
      });
      expect(resumeExecution).not.toHaveBeenCalled();
    });
  });

  describe('job list', () => {
    it('starts expanded, collapses to release its width, and previews on hover without moving the body', async () => {
      await render(panel(true));
      const toggle = byTestId('pipeline-panel-nav-toggle');
      expect(byTestId('pipeline-panel-nav')).not.toBeNull();
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(toggle?.getAttribute('aria-label')).toBe('Hide jobs');

      await click(toggle);
      expect(byTestId('pipeline-panel-nav')).toBeNull();
      expect(byTestId('pipeline-panel-nav-preview')).toBeNull();
      expect(toggle?.getAttribute('aria-label')).toBe('Show jobs');
      expect(toggle?.getAttribute('aria-expanded')).toBe('false');

      const trigger = byTestId('pipeline-panel-nav-trigger');
      const body = byTestId('pipeline-execution-detail-body');
      if (trigger === null || body === null) throw new Error('missing');
      movePointer(body, trigger);
      const preview = byTestId('pipeline-panel-nav-preview');
      expect(preview).not.toBeNull();
      expect(preview?.className).toContain('absolute');
      // The overlay sits beside the body in the same row; the body stays the
      // row's only flow child.
      expect(body.parentElement?.contains(preview)).toBe(true);

      // Travel into the overlay keeps it; leaving both closes it.
      if (preview === null) throw new Error('missing preview');
      movePointer(trigger, preview);
      expect(byTestId('pipeline-panel-nav-preview')).not.toBeNull();
      movePointer(preview, body);
      expect(byTestId('pipeline-panel-nav-preview')).toBeNull();
      expect(byTestId('pipeline-panel-nav')).toBeNull();
    });

    it('selecting from the preview navigates and dismisses it; the filter keeps it open', async () => {
      await render(panel(true));
      await click(byTestId('pipeline-panel-nav-toggle'));
      const trigger = byTestId('pipeline-panel-nav-trigger');
      const body = byTestId('pipeline-execution-detail-body');
      if (trigger === null || body === null) throw new Error('missing');
      movePointer(body, trigger);

      await click(byTestId('pipeline-details-filter-button'));
      expect(byTestId('pipeline-details-filter-popover')).not.toBeNull();
      expect(byTestId('pipeline-panel-nav-preview')).not.toBeNull();
      // Escape closes the menu first, not the preview.
      await act(async () => {
        byTestId('pipeline-details-filter-button')?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
        await flushAsyncWork();
      });
      expect(byTestId('pipeline-details-filter-popover')).toBeNull();
      expect(byTestId('pipeline-panel-nav-preview')).not.toBeNull();

      await click(byTestId('pipeline-details-nav-job-build'));
      expect(byTestId('pipeline-job-view-build')).not.toBeNull();
      expect(byTestId('pipeline-panel-nav-preview')).toBeNull();
      expect(byTestId('pipeline-panel-nav')).toBeNull();
    });

    it('pins a preview on toggle click, and Escape closes a preview back to the toggle', async () => {
      await render(panel(true));
      const toggle = byTestId('pipeline-panel-nav-toggle');
      await click(toggle);
      const trigger = byTestId('pipeline-panel-nav-trigger');
      const body = byTestId('pipeline-execution-detail-body');
      if (trigger === null || body === null || toggle === null) {
        throw new Error('missing');
      }
      movePointer(trigger, body);
      movePointer(body, trigger);
      const preview = byTestId('pipeline-panel-nav-preview');
      await click(toggle);
      // The same element becomes the docked rail: no second entry.
      expect(byTestId('pipeline-panel-nav')).toBe(preview);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');

      await click(toggle);
      movePointer(trigger, body);
      movePointer(body, trigger);
      byTestId('pipeline-details-nav-summary')?.focus();
      await act(async () => {
        byTestId('pipeline-details-nav-summary')?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
        await flushAsyncWork();
      });
      expect(byTestId('pipeline-panel-nav-preview')).toBeNull();
      expect(document.activeElement).toBe(toggle);
    });

    it('hiding the panel dismisses an open preview', async () => {
      await render(panel(true));
      await click(byTestId('pipeline-panel-nav-toggle'));
      const trigger = byTestId('pipeline-panel-nav-trigger');
      const body = byTestId('pipeline-execution-detail-body');
      if (trigger === null || body === null) throw new Error('missing');
      movePointer(body, trigger);
      expect(byTestId('pipeline-panel-nav-preview')).not.toBeNull();
      await render(panel(false));
      await render(panel(true));
      expect(byTestId('pipeline-panel-nav-preview')).toBeNull();
      expect(byTestId('pipeline-panel-nav')).toBeNull();
    });
  });
  describe('job list by panel width', () => {
    beforeEach(() => {
      FakeResizeObserver.instances = [];
      Object.defineProperty(window, 'ResizeObserver', {
        configurable: true,
        writable: true,
        value: FakeResizeObserver,
      });
    });

    afterEach(() => {
      Reflect.deleteProperty(window, 'ResizeObserver');
    });

    /** Reports `width` for the panel root to whoever observes it. */
    function resizePanel(width: number): void {
      const host = byTestId('pipeline-execution-panel');
      act(() => {
        for (const observer of FakeResizeObserver.instances) {
          if (host !== null && observer.targets.has(host)) {
            observer.resize(width);
          }
        }
      });
    }

    function navState(): string | null | undefined {
      return byTestId('pipeline-panel-nav-toggle')?.getAttribute(
        'data-nav-state',
      );
    }

    function storedOverride(): boolean | undefined {
      return selectPipelinePanelUiEntry(
        usePipelinePanelUiStore.getState(),
        UI_KEY,
        'exec-1',
      )?.navExpandedOverride;
    }

    it('observes its own root with the observer of the root’s window', async () => {
      await render(panel(true));
      const host = byTestId('pipeline-execution-panel');
      const observing = FakeResizeObserver.instances.filter(
        (observer) => host !== null && observer.targets.has(host),
      );
      expect(observing).toHaveLength(1);

      // Moved to another window's document: observe again, drop the old one.
      const [first] = observing;
      const otherDocument = document.implementation.createHTMLDocument('aux');
      await render(
        <PipelineExecutionPanel
          panelId={PANEL_ID}
          executionId="exec-1"
          owner={OWNER}
          visible
          ownerDocument={otherDocument}
        />,
      );
      expect(first.disconnected).toBe(true);
      expect(
        FakeResizeObserver.instances.filter(
          (observer) => host !== null && observer.targets.has(host),
        ),
      ).toHaveLength(1);

      act(() => {
        root.unmount();
      });
      expect(
        FakeResizeObserver.instances.every(
          (observer) => observer.targets.size === 0,
        ),
      ).toBe(true);
      root = createRoot(container);
    });

    it('presents the list collapsed below the threshold without storing it, and docks it again when widened', async () => {
      await render(panel(true));
      expect(navState()).toBe('expanded');

      resizePanel(PIPELINE_PANEL_NAV_AUTO_COLLAPSE_WIDTH_PX - 1);
      expect(
        byTestId('pipeline-execution-panel')?.getAttribute('data-panel-width'),
      ).toBe('narrow');
      expect(navState()).toBe('collapsed');
      expect(byTestId('pipeline-panel-nav')).toBeNull();
      expect(
        byTestId('pipeline-panel-nav-toggle')?.getAttribute('aria-label'),
      ).toBe('Show jobs');
      // The width presentation is never written as the user's choice.
      expect(storedOverride()).toBeUndefined();

      // The toggle still previews the list on hover.
      const trigger = byTestId('pipeline-panel-nav-trigger');
      const body = byTestId('pipeline-execution-detail-body');
      if (trigger === null || body === null) throw new Error('missing');
      movePointer(body, trigger);
      expect(byTestId('pipeline-panel-nav-preview')).not.toBeNull();

      // Widening docks it again and drops the preview.
      resizePanel(PIPELINE_PANEL_NAV_AUTO_COLLAPSE_WIDTH_PX);
      expect(navState()).toBe('expanded');
      expect(byTestId('pipeline-panel-nav')).not.toBeNull();
      expect(byTestId('pipeline-panel-nav-preview')).toBeNull();
      expect(storedOverride()).toBeUndefined();

      // A hidden panel measures 0; that says nothing about its width.
      resizePanel(536);
      resizePanel(0);
      expect(navState()).toBe('collapsed');
    });

    it('lets an explicit choice win at any width for the panel', async () => {
      await render(panel(true));
      resizePanel(536);
      expect(navState()).toBe('collapsed');

      // Expanding in a narrow panel is honored and stored.
      await click(byTestId('pipeline-panel-nav-toggle'));
      expect(navState()).toBe('expanded');
      expect(byTestId('pipeline-panel-nav')).not.toBeNull();
      expect(storedOverride()).toBe(true);
      resizePanel(320);
      expect(navState()).toBe('expanded');

      // Collapsing in a wide panel is honored too.
      resizePanel(1120);
      await click(byTestId('pipeline-panel-nav-toggle'));
      expect(navState()).toBe('collapsed');
      expect(storedOverride()).toBe(false);
      resizePanel(1400);
      expect(navState()).toBe('collapsed');

      // It survives an unmount (worktree switch) for this panel.
      await remount();
      resizePanel(1400);
      expect(navState()).toBe('collapsed');
    });

    it('starts docked before its first measurement', async () => {
      Reflect.deleteProperty(window, 'ResizeObserver');
      await render(panel(true));
      expect(navState()).toBe('expanded');
      expect(byTestId('pipeline-panel-nav')).not.toBeNull();
    });
  });
});

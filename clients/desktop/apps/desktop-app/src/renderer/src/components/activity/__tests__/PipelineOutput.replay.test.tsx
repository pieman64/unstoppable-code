/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { WorkflowRunState } from '@canopy/desktop-shared/types';
import { PipelineReportMarkdown } from '../PipelineReportMarkdown';
import { WorkflowRunView } from '../WorkflowRunView';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const BLOCK_SELECTOR = `.${POSTHOG_REPLAY_BLOCK_CLASS}`;

describe('pipeline and workflow output in session replay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('blocks the rendered pipeline report', () => {
    act(() =>
      root.render(
        <PipelineReportMarkdown content={'# Report\n\nCustomer **secret**'} />,
      ),
    );
    const report = container.firstElementChild;
    expect(report?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
    expect(container.querySelector('strong')?.closest(BLOCK_SELECTOR)).toBe(
      report,
    );
  });

  it("blocks a workflow run's phases, agents, and result and records its counts", () => {
    const run: WorkflowRunState = {
      runId: 'run-1',
      status: 'done',
      phases: [{ title: 'Review', detail: 'Read the secret plan' }],
      agents: [
        {
          index: 0,
          label: 'Reviewer',
          phaseIndex: 1,
          phaseTitle: 'Review',
          agentId: 'agent-1',
          agentType: 'general',
          state: 'done',
          promptPreview: 'Review the secret plan',
        },
      ],
      result: 'Secret **result**',
    };
    act(() =>
      root.render(
        <WorkflowRunView run={run} transcriptDir={undefined} loading={false} />,
      ),
    );
    const view = container.firstElementChild;
    expect(view?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    const counts = Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === '1/1 agents done',
    );
    expect(counts).toBeDefined();
    expect(counts?.closest(BLOCK_SELECTOR)).toBeNull();
    const phase = Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === 'Read the secret plan',
    );
    expect(phase?.closest(BLOCK_SELECTOR)).not.toBeNull();
    expect(
      container.querySelector('strong')?.closest(BLOCK_SELECTOR),
    ).not.toBeNull();
    const resultLabel = Array.from(container.querySelectorAll('div')).find(
      (div) => div.textContent === 'Result',
    );
    expect(resultLabel).toBeDefined();
    expect(resultLabel?.closest(BLOCK_SELECTOR)).toBeNull();
  });
});

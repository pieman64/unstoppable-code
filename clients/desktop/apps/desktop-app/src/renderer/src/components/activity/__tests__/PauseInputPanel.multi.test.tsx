/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ExecutionState } from '@canopy/desktop-shared/types/pipeline';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { PauseInputPanel } from '../PauseInputPanel';
import { outermostReplayBlock } from '@/test-utils/replay';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function render(node: JSX.Element): {
  container: HTMLDivElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => root.render(node));
  return {
    container,
    cleanup: (): void => {
      act((): void => root.unmount());
      container.remove();
    },
  };
}

async function click(element: Element | null): Promise<void> {
  expect(element).toBeInstanceOf(HTMLButtonElement);
  await act(async () => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

function chooseOption(trigger: Element | null, label: string): void {
  if (!(trigger instanceof HTMLButtonElement)) {
    throw new Error('Expected the select trigger');
  }
  act(() => trigger.click());
  const option = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[role="option"]'),
  ).find((element) => element.textContent?.includes(label));
  if (!option) throw new Error(`Missing option ${label}`);
  act(() => option.click());
}

function pausedState(): ExecutionState {
  const definition = (
    id: string,
  ): NonNullable<ExecutionState['job_definitions']>[string] => ({
    physical_job_id: id,
    logical_job_id: id,
    name: id === 'first' ? 'First review' : 'Second review',
    needs: [],
    if: 'true',
    env: {},
    outputs: {},
    timeout_minutes: 60,
    max_retries: 0,
    continue_on_error: false,
    steps: [{ id: 'approval', name: 'Approval', shell: 'bash' as const }],
  });
  const result = (structured: boolean): ExecutionState['jobs'][string] => ({
    status: 'paused' as const,
    steps: {
      approval: {
        status: 'success' as const,
        outputs: {},
        dynamic_env: {},
        pause_requested: true,
        ...(structured
          ? {
              input_request: {
                fields: [
                  {
                    key: 'decision',
                    label: 'Decision',
                    type: 'string' as const,
                    required: true,
                    default: 'continue',
                  },
                ],
              },
            }
          : {}),
      },
    },
    outputs: {},
  });
  return {
    version: 8,
    id: 'parallel-pauses',
    pipeline_id: 'parallel-pauses',
    pipeline_snapshot: {
      name: 'Parallel pauses',
      jobs: {
        first: definition('first'),
        second: definition('second'),
      },
    },
    status: 'paused',
    jobs: { first: result(true), second: result(false) },
    job_definitions: {
      first: definition('first'),
      second: definition('second'),
    },
    job_groups: {
      first: {
        job_id: 'first',
        kind: 'single',
        expansion: 'expanded',
        variant_job_ids: ['first'],
        status: 'paused',
      },
      second: {
        job_id: 'second',
        kind: 'single',
        expansion: 'expanded',
        variant_job_ids: ['second'],
        status: 'paused',
      },
    },
    pending_pauses: [
      {
        id: 'pause-first',
        kind: 'input',
        job_id: 'first',
        logical_job_id: 'first',
        step_id: 'approval',
        attempt: 0,
        iteration: 1,
        detected_at: '2026-08-03T00:00:00.000Z',
        request: {
          fields: [
            {
              key: 'decision',
              label: 'Decision',
              type: 'string',
              required: true,
              default: 'continue',
            },
          ],
        },
      },
      {
        id: 'pause-second',
        kind: 'action',
        job_id: 'second',
        logical_job_id: 'second',
        step_id: 'approval',
        attempt: 0,
        iteration: 1,
        detected_at: '2026-08-03T00:00:01.000Z',
      },
    ],
    status_reasons: [],
    started_at: '2026-08-03T00:00:00.000Z',
    cwd: '/repo',
    env: {},
    inputs: {},
  };
}

describe('PauseInputPanel concurrent checkpoints', () => {
  beforeEach(() => {
    usePipelineRunsStore.setState({ resumeExecution: jest.fn() });
  });

  it('submits every structured and formless checkpoint as one batch', async () => {
    const resumeExecution = jest
      .fn()
      .mockResolvedValue({ success: true, data: pausedState() });
    usePipelineRunsStore.setState({ resumeExecution });
    const state = pausedState();
    const rendered = render(
      <PauseInputPanel executionId={state.id} state={state} />,
    );

    try {
      expect(rendered.container.textContent).toContain('Inputs required');
      expect(rendered.container.textContent).toContain(
        '2 jobs are waiting for input',
      );
      await click(
        rendered.container.querySelector(
          '[data-testid="pause-input-submit-all"]',
        ),
      );
      expect(resumeExecution).toHaveBeenCalledWith(state.id, {
        pauseResponses: [
          {
            checkpoint_id: 'pause-first',
            job_id: 'first',
            step_id: 'approval',
            answers: { decision: 'continue' },
          },
          {
            checkpoint_id: 'pause-second',
            job_id: 'second',
            step_id: 'approval',
          },
        ],
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('targets only the checkpoint selected by the user', async () => {
    const resumeExecution = jest
      .fn()
      .mockResolvedValue({ success: true, data: pausedState() });
    usePipelineRunsStore.setState({ resumeExecution });
    const state = pausedState();
    const rendered = render(
      <PauseInputPanel executionId={state.id} state={state} />,
    );

    try {
      chooseOption(
        rendered.container.querySelector(
          '[data-testid="pause-input-selector"]',
        ),
        'Second review',
      );
      expect(rendered.container.textContent).toContain(
        'This job is paused and ready to continue.',
      );
      await click(
        rendered.container.querySelector('[data-testid="pause-input-resume"]'),
      );
      expect(resumeExecution).toHaveBeenCalledWith(state.id, {
        pauseResponses: [
          {
            checkpoint_id: 'pause-second',
            job_id: 'second',
            step_id: 'approval',
          },
        ],
      });
    } finally {
      rendered.cleanup();
    }
  });

  it('draws every pause field with the shared field controls', () => {
    const state = pausedState();
    const [first] = state.pending_pauses ?? [];
    if (!first) throw new Error('Expected a pending pause');
    first.request = {
      fields: [
        { key: 'reviewer', label: 'Reviewer', type: 'string', required: true },
        {
          key: 'notes',
          label: 'Notes',
          type: 'string',
          multiline: true,
          required: false,
        },
        { key: 'retries', label: 'Retries', type: 'number', required: false },
        {
          key: 'approved',
          label: 'Approved',
          type: 'boolean',
          required: false,
        },
        {
          key: 'channel',
          label: 'Channel',
          type: 'choice',
          options: ['stable', 'beta'],
          required: false,
        },
      ],
    };
    const rendered = render(
      <PauseInputPanel executionId={state.id} state={state} />,
    );

    try {
      // The border role is not a fill: no control paints itself with it.
      expect(rendered.container.querySelector('.bg-line-base')).toBeNull();
      // Text, number, multiline, choice, and the job picker share the field
      // edge that TextInput, TextArea, and Select draw.
      for (const testId of [
        'pause-field-reviewer',
        'pause-field-notes',
        'pause-field-retries',
        'pause-field-channel',
        'pause-input-selector',
      ]) {
        const control = rendered.container.querySelector(
          `[data-testid="${testId}"]`,
        );
        expect(control?.classList.contains('shadow-field')).toBe(true);
      }
    } finally {
      rendered.cleanup();
    }
  });

  it('blocks the answer fields from session replay and records the panel', () => {
    const state = pausedState();
    const rendered = render(
      <PauseInputPanel executionId={state.id} state={state} />,
    );

    try {
      const panel = rendered.container.querySelector(
        '[data-testid="pause-input-panel"]',
      );
      expect(outermostReplayBlock(panel)).toBeNull();
      const fields = Array.from(
        rendered.container.querySelectorAll('[data-testid^="pause-field-"]'),
      );
      expect(fields.length).toBeGreaterThan(0);
      const answers = outermostReplayBlock(fields[0]);
      expect(answers).not.toBeNull();
      expect(answers).not.toBe(panel);
      for (const field of fields) {
        expect(outermostReplayBlock(field)).toBe(answers);
      }
      expect(
        outermostReplayBlock(
          rendered.container.querySelector(
            '[data-testid="pause-input-resume"]',
          ),
        ),
      ).toBeNull();
      expect(
        outermostReplayBlock(
          rendered.container.querySelector(
            '[data-testid="pause-input-selector"]',
          ),
        ),
      ).toBeNull();
    } finally {
      rendered.cleanup();
    }
  });
});

/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type {
  NormalizedStep,
  StepResult,
} from '@canopy/desktop-shared/types/pipeline';
import { PipelineStepDetail } from '../PipelineStepDetail';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const STEP: NormalizedStep = {
  id: 'deploy',
  name: 'Deploy',
  run: 'curl -H "Authorization: Bearer $TOKEN" https://deploy.example.test',
  shell: 'bash',
  env: { TOKEN: 'secret' },
  continue_on_error: false,
  timeout_minutes: 10,
  skip_on_missing_action: false,
};

const RESULT: StepResult = {
  status: 'success',
  outputs: { url: 'https://deploy.example.test/secret' },
  dynamic_env: {},
  started_at: '2026-10-01T00:00:00.000Z',
  completed_at: '2026-10-01T00:00:05.000Z',
};

describe('PipelineStepDetail session replay', () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousPipelines: PropertyDescriptor | undefined;

  beforeEach(() => {
    previousPipelines = Object.getOwnPropertyDescriptor(window, 'pipelines');
    Object.defineProperty(window, 'pipelines', {
      configurable: true,
      value: {
        readStepLog: jest.fn().mockResolvedValue({
          success: true,
          data: { lines: ['deployed with secret token'] },
        }),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (previousPipelines) {
      Object.defineProperty(window, 'pipelines', previousPipelines);
    } else {
      Reflect.deleteProperty(window, 'pipelines');
    }
  });

  it('records the step detail and blocks inputs, outputs, and the log', async () => {
    await act(async () => {
      root.render(
        <PipelineStepDetail
          executionId="exec-1"
          jobId="job-1"
          stepDef={STEP}
          stepResult={{ ...RESULT, error: 'fatal: secret remote' }}
          attempt={0}
          iteration={1}
          source="current"
        />,
      );
      await Promise.resolve();
    });
    const block = `.${POSTHOG_REPLAY_BLOCK_CLASS}`;
    const detail = container.querySelector(
      '[data-testid="pipeline-step-detail-deploy"]',
    );
    expect(detail?.closest(block)).toBeNull();
    expect(container.textContent).toContain('deployed with secret token');
    // The log keeps its own AnsiOutput block.
    const log = container.querySelector('[data-testid="ansi-output"]');
    expect(log?.closest(block)).not.toBeNull();
    expect(log?.parentElement?.closest(block) ?? null).toBeNull();
    // Section headings stay recorded; the env value and outputs are blocked.
    const leaf = (text: string): Element | undefined =>
      Array.from(container.querySelectorAll('*')).find(
        (element) =>
          element.childElementCount === 0 && element.textContent === text,
      );
    expect(leaf('secret')?.closest(block)).not.toBeNull();
    expect(
      leaf('https://deploy.example.test/secret')?.closest(block),
    ).not.toBeNull();
    const inputsHeading = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Inputs'),
    );
    expect(inputsHeading).toBeDefined();
    expect(inputsHeading?.closest(block)).toBeNull();
    // The error banner label is recorded; its output text is blocked.
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.closest(block)).toBeNull();
    const errorTexts = Array.from(container.querySelectorAll('*')).filter(
      (element) =>
        element.childElementCount === 0 &&
        element.textContent === 'fatal: secret remote',
    );
    expect(errorTexts.length).toBeGreaterThan(0);
    for (const text of errorTexts) {
      expect(text.closest(block)).not.toBeNull();
    }
  });
});

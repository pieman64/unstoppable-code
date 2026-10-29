/** @jest-environment jsdom */

import { act } from 'react';
import { createPipelineRunCostStore } from '@canopy/app-state/cost';
import { PipelineRunCostPreviewCard } from '../PipelineRunCostPreviewCard';
import {
  createCostRenderer,
  createFakeCostClient,
  ENTRY_SCOPE,
  flush,
  ok,
  pipelineRunView,
  type CostRenderer,
} from './cost-test-utils';

function byTestId(parent: ParentNode, testId: string): HTMLElement {
  const element = parent.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected data-testid="${testId}"`);
  }
  return element;
}

describe('PipelineRunCostPreviewCard', () => {
  let renderer: CostRenderer | null = null;

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it('renders one button with the expected accessible name and opens cost', async () => {
    renderer = createCostRenderer();
    const onOpen = jest.fn();
    renderer.render(
      <PipelineRunCostPreviewCard
        client={createFakeCostClient()}
        scope={ENTRY_SCOPE}
        executionId="run-1"
        onOpen={onOpen}
      />,
    );
    await flush();

    const card = byTestId(renderer.container, 'pipeline-run-cost-preview');
    expect(card.tagName).toBe('BUTTON');
    expect(card.getAttribute('aria-label')).toBe(
      'Cost, $1.10 observed. Open cost',
    );
    expect(card.querySelectorAll('button')).toHaveLength(0);
    expect(card.querySelector('[role="img"]')).not.toBeNull();
    act(() => card.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('returns null for runs without agent steps', async () => {
    renderer = createCostRenderer();
    renderer.render(
      <PipelineRunCostPreviewCard
        client={createFakeCostClient({
          pipelineRun: ok(
            pipelineRunView({
              run: {
                ...pipelineRunView().run,
                agentStepCount: 0,
              },
            }),
          ),
        })}
        scope={ENTRY_SCOPE}
        executionId="run-1"
        onOpen={jest.fn()}
      />,
    );
    await flush();

    expect(
      renderer.container.querySelector(
        '[data-testid="pipeline-run-cost-preview"]',
      ),
    ).toBeNull();
  });

  it('returns null when the capability is off without creating a read', () => {
    renderer = createCostRenderer({ costInsights: false });
    const client = createFakeCostClient();
    renderer.render(
      <PipelineRunCostPreviewCard
        client={client}
        scope={ENTRY_SCOPE}
        executionId="run-1"
        onOpen={jest.fn()}
      />,
    );

    expect(
      renderer.container.querySelector(
        '[data-testid="pipeline-run-cost-preview"]',
      ),
    ).toBeNull();
    expect(client.getPipelineRun).not.toHaveBeenCalled();
  });

  it('returns null before the first value and after a failed first read', async () => {
    renderer = createCostRenderer();
    const client = createFakeCostClient();
    const store = createPipelineRunCostStore(client, ENTRY_SCOPE, 'run-1');
    renderer.render(
      <PipelineRunCostPreviewCard
        client={client}
        scope={ENTRY_SCOPE}
        executionId="run-1"
        onOpen={jest.fn()}
        store={store}
      />,
    );
    expect(
      renderer.container.querySelector(
        '[data-testid="pipeline-run-cost-preview"]',
      ),
    ).toBeNull();

    renderer.unmount();
    renderer = createCostRenderer();
    const failedClient = createFakeCostClient({
      pipelineRun: {
        status: 'error',
        reason: 'UNKNOWN',
        message: 'The first run read failed.',
      },
    });
    const failedStore = createPipelineRunCostStore(
      failedClient,
      ENTRY_SCOPE,
      'run-1',
    );
    await act(async () => {
      await failedStore.getState().load();
    });
    renderer.render(
      <PipelineRunCostPreviewCard
        client={failedClient}
        scope={ENTRY_SCOPE}
        executionId="run-1"
        onOpen={jest.fn()}
        store={failedStore}
      />,
    );
    expect(
      renderer.container.querySelector(
        '[data-testid="pipeline-run-cost-preview"]',
      ),
    ).toBeNull();
  });
});

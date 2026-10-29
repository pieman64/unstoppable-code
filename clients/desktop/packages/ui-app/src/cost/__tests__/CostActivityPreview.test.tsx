/** @jest-environment jsdom */
import { act } from 'react';
import type { CostNavigator } from '@canopy/app-core';
import { CostActivityPreview } from '../CostActivityPreview';
import {
  createCostRenderer,
  createFakeCostClient,
  ENTRY_SCOPE,
  flush,
  NOW,
  scopeView,
  totals,
  type CostRenderer,
} from './cost-test-utils';

function byTestId(parent: ParentNode, testId: string): HTMLElement {
  const element = parent.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`Expected data-testid="${testId}"`);
  }
  return element;
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

describe('CostActivityPreview', () => {
  let renderer: CostRenderer | null = null;

  afterEach(() => {
    renderer?.unmount();
    renderer = null;
  });

  it('caps the scroll area by the requested number of card rows without a split control', async () => {
    renderer = createCostRenderer();
    renderer.render(
      <CostActivityPreview
        client={createFakeCostClient()}
        navigator={{}}
        scope={ENTRY_SCOPE}
        maxRows={5}
        now={NOW}
      />,
    );
    await flush();

    expect(
      byTestId(renderer.container, 'cost-activity-preview'),
    ).not.toBeNull();
    expect(
      byTestId(renderer.container, 'cost-activity-scroll-cap').style.maxHeight,
    ).toBe('170px');
    expect(
      byTestId(renderer.container, 'cost-activity-scroll-cap').style.height,
    ).toBe('');
    expect(
      renderer.container.querySelector('[data-testid="cost-split"]'),
    ).toBeNull();
  });

  it('opens the Cost panel when the navigator supports it', async () => {
    renderer = createCostRenderer();
    const openCostPanel = jest.fn();
    renderer.render(
      <CostActivityPreview
        client={createFakeCostClient()}
        navigator={{ openCostPanel }}
        scope={ENTRY_SCOPE}
        now={NOW}
      />,
    );
    await flush();

    click(byTestId(renderer.container, 'cost-open-panel'));
    expect(openCostPanel).toHaveBeenCalledWith(ENTRY_SCOPE);
  });

  it('omits the Cost panel action when the navigator does not support it', async () => {
    renderer = createCostRenderer();
    renderer.render(
      <CostActivityPreview
        client={createFakeCostClient()}
        navigator={{}}
        scope={ENTRY_SCOPE}
        now={NOW}
      />,
    );
    await flush();

    expect(
      renderer.container.querySelector('[data-testid="cost-open-panel"]'),
    ).toBeNull();
  });

  it('opens chat and run rows through their navigator methods', async () => {
    renderer = createCostRenderer();
    const openSessionBreakdown = jest.fn();
    const openPipelineRun = jest.fn();
    const navigator: CostNavigator = { openSessionBreakdown, openPipelineRun };
    renderer.render(
      <CostActivityPreview
        client={createFakeCostClient()}
        navigator={navigator}
        scope={ENTRY_SCOPE}
        now={NOW}
      />,
    );
    await flush();

    click(byTestId(renderer.container, 'cost-chat-row-chat-1'));
    click(byTestId(renderer.container, 'cost-run-row-run-1'));

    expect(openSessionBreakdown).toHaveBeenCalledWith(ENTRY_SCOPE, 'chat-1');
    expect(openPipelineRun).toHaveBeenCalledWith(ENTRY_SCOPE, 'run-1');
  });

  it('renders nothing and does not read cost when capability is off', () => {
    renderer = createCostRenderer({ costInsights: false });
    const client = createFakeCostClient();
    renderer.render(
      <CostActivityPreview
        client={client}
        navigator={{}}
        scope={ENTRY_SCOPE}
      />,
    );

    expect(renderer.container.firstChild).toBeNull();
    expect(client.getScope).not.toHaveBeenCalled();
  });

  it('shows empty-state copy and includes an unattached row when present', async () => {
    renderer = createCostRenderer();
    const client = createFakeCostClient({
      scope: {
        status: 'ok',
        value: scopeView({
          chats: [],
          pipelineRuns: [],
          totals: totals(),
          unattached: totals(),
        }),
      },
    });
    renderer.render(
      <CostActivityPreview
        client={client}
        navigator={{}}
        scope={ENTRY_SCOPE}
        now={NOW}
      />,
    );
    await flush();

    expect(byTestId(renderer.container, 'cost-empty').textContent).toBe(
      'Costs appear after the first reply.',
    );
    expect(
      renderer.container.querySelector(
        '[data-testid="cost-activity-scroll-cap"]',
      ),
    ).toBeNull();
    expect(renderer.container.textContent).not.toContain('Pipeline runs');

    renderer.render(
      <CostActivityPreview
        client={createFakeCostClient({
          scope: {
            status: 'ok',
            value: scopeView({
              chats: [],
              pipelineRuns: [],
              unattached: totals({ background: 0.5 }),
            }),
          },
        })}
        navigator={{}}
        scope={ENTRY_SCOPE}
        now={NOW}
      />,
    );
    await flush();
    expect(byTestId(renderer.container, 'cost-unattached-row').tagName).toBe(
      'DIV',
    );
    expect(renderer.container.textContent).not.toContain('Pipeline runs');
  });
});

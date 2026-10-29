/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import type { CodeReviewFile } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { CodeReviewDiagramsPanel } from '../CodeReviewDiagramsPanel';
import { rootClassList } from '@/test-utils/replay';

jest.mock('@/components/plan-explore/diagram/PlanLogicDiffDiagram', () => ({
  PlanLogicDiffDiagram: (): JSX.Element => (
    <div data-testid="plan-logic-diff-diagram" />
  ),
}));
jest.mock('@/components/plan-explore/diagram/PlanDataModelDiffDiagram', () => ({
  PlanDataModelDiffDiagram: (): JSX.Element => (
    <div data-testid="plan-data-model-diff-diagram" />
  ),
}));

const review: CodeReviewFile = {
  version: 1,
  armed: true,
  commentThreads: [],
  diagrams: {
    logicDiff: {
      data: null,
      derivedFromFingerprint: 'fingerprint-1',
      status: 'ready',
    },
  },
};

describe('CodeReviewDiagramsPanel', () => {
  it('records the diagram root and blocks the diagram area', (): void => {
    const markup = renderToStaticMarkup(
      <CodeReviewDiagramsPanel
        review={review}
        armed
        onArm={jest.fn()}
        onRefresh={jest.fn()}
        onAddNodeComment={jest.fn()}
      />,
    );

    expect(rootClassList(markup)).toEqual([
      'flex',
      'min-h-0',
      'min-w-0',
      'flex-1',
      'flex-col',
      'overflow-hidden',
    ]);
    // The diagram area carries the block and mounts with the diagrams.
    const container = document.createElement('div');
    container.innerHTML = markup;
    const diagram = container.querySelector(
      '[data-testid="plan-logic-diff-diagram"]',
    );
    expect(
      diagram?.parentElement?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS),
    ).toBe(true);
    expect(
      container.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`),
    ).toHaveLength(1);
  });

  // React reuses the root div when Start review arms the panel; the block
  // sits on the diagram area, which mounts with the diagrams, so the
  // unarmed root (static copy and the start button) stays recorded.
  it('records the unarmed root', (): void => {
    const markup = renderToStaticMarkup(
      <CodeReviewDiagramsPanel
        review={null}
        armed={false}
        onArm={jest.fn()}
        onRefresh={jest.fn()}
        onAddNodeComment={jest.fn()}
      />,
    );

    expect(markup).not.toContain(POSTHOG_REPLAY_BLOCK_CLASS);
    expect(rootClassList(markup)).toEqual([
      'flex',
      'h-full',
      'min-h-0',
      'min-w-0',
      'flex-1',
      'flex-col',
      'items-center',
      'justify-center',
      'overflow-hidden',
      'p-8',
    ]);
    expect(markup).toContain('data-testid="code-review-start"');
  });
});

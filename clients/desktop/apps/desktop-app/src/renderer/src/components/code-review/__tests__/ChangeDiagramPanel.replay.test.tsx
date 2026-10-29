/**
 * @jest-environment jsdom
 */
import { renderToStaticMarkup } from 'react-dom/server';
import type { JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ChangeDiagramPanel } from '../ChangeDiagramPanel';
import { rootClassList } from '@/test-utils/replay';

jest.mock('../useWorktreeReview', () => ({
  useWorktreeReview: (): Record<string, never> => ({}),
}));
jest.mock('../useReviewComments', () => ({
  useReviewComments: (): Record<string, unknown> => ({
    threads: [],
    stagedCount: 0,
  }),
}));
jest.mock('../CodeReviewDiagramsPanel', () => ({
  CodeReviewDiagramsPanel: (): JSX.Element => (
    <div data-testid="code-review-diagrams-panel" />
  ),
}));
jest.mock('../../chat/FileCommentsDrawer', () => ({
  FileCommentsDrawer: (): null => null,
}));
jest.mock('../../chat/submitWorkspaceComments', () => ({
  submitWorkspaceComments: jest.fn(),
}));
jest.mock('@/hooks/useCurrentUiStateReporter', () => ({
  useCurrentUiStateReporter: (): void => {},
}));

describe('ChangeDiagramPanel', () => {
  it('records the diagram panel chrome; the diagrams panel blocks itself', (): void => {
    const markup = renderToStaticMarkup(
      <ChangeDiagramPanel
        projectId="project-1"
        worktreeId="worktree-1"
        active
      />,
    );

    expect(markup).not.toContain(POSTHOG_REPLAY_BLOCK_CLASS);
    expect(rootClassList(markup)).toEqual([
      'flex',
      'min-h-0',
      'flex-1',
      'flex-col',
      'outline-none',
    ]);
    expect(markup).toContain('data-testid="change-diagram-panel"');
    // Searched through the shared find bar, not an inline field.
    expect(markup).toContain('data-find-surface="diagram"');
    expect(markup).not.toContain('Search diagram');
    expect(markup).toContain('data-testid="code-review-diagrams-panel"');
  });
});

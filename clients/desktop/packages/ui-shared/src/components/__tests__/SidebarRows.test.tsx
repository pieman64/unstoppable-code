/**
 * @jest-environment jsdom
 */
import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WorktreeRow } from '../WorktreeRow';

function renderStatic(element: JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(element);
  return container;
}

describe('WorktreeRow branch and PR text', () => {
  it.each([
    ['classic sidebar', 'sidebar'],
    ['compact list', 'default'],
  ] as const)(
    'renders the branch label in the %s layout',
    (_layout, textScale) => {
      const container = renderStatic(
        <WorktreeRow
          branchLabel="feature/acquire-competitor"
          branchName="feature/acquire-competitor"
          worktreeId="calm-otter"
          uiStatus="idle"
          textScale={textScale}
        />,
      );
      expect(
        container.querySelector('[data-testid="worktree-row-title"]')
          ?.textContent,
      ).toBe('feature/acquire-competitor');
    },
  );

  it('renders the PR label in the classic sidebar layout', () => {
    const container = renderStatic(
      <WorktreeRow
        branchLabel="b"
        branchName="b"
        uiStatus="idle"
        textScale="sidebar"
        lastKnownPrStatus={{ state: 'open', label: 'PR #2495' }}
      />,
    );
    expect(
      container.querySelector('[data-testid="worktree-row-pr-label"]')
        ?.textContent,
    ).toBe('PR #2495');
  });
});

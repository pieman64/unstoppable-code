/** @jest-environment jsdom */
import type { JSX } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DiffTurnUnavailableState } from '../DiffStates';

function render(node: JSX.Element): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(node);
  return container;
}

describe('DiffTurnUnavailableState', () => {
  it('says why the turn has no comparison, with no stand-in', () => {
    const state = render(<DiffTurnUnavailableState />).querySelector(
      '[data-testid="diff-viewer-notice-turn-unavailable"]',
    );
    expect(state?.textContent).toBe(
      "This turn's changes weren't saved, so they can't be shown.",
    );
  });

  it('places the host action after the explanation', () => {
    const state = render(
      <DiffTurnUnavailableState
        action={<button type="button">Show all branch changes</button>}
        className="m-4"
      />,
    ).querySelector('[data-testid="diff-viewer-notice-turn-unavailable"]');
    expect(state?.className).toContain('m-4');
    expect(
      Array.from(state?.children ?? [], (child) => child.textContent),
    ).toEqual([
      "This turn's changes weren't saved, so they can't be shown.",
      'Show all branch changes',
    ]);
  });
});

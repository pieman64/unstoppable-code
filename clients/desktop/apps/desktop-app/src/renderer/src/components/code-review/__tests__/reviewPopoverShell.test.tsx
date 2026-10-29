/**
 * @jest-environment jsdom
 */
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ReviewPopoverShell } from '../reviewPopoverShell';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

describe('ReviewPopoverShell session-replay privacy', () => {
  it('blocks the portaled review popover at its own root', () => {
    act(() => {
      root.render(
        <ReviewPopoverShell
          anchorRect={new DOMRect(10, 10, 100, 20)}
          containerClassName="rounded-md bg-popover"
          onClose={jest.fn()}
          dataTestId="review-popover"
        >
          <p>Private review comment</p>
        </ReviewPopoverShell>,
      );
    });

    const popover = document.body.querySelector(
      ':scope > [data-testid="review-popover"]',
    );
    expect(popover?.textContent).toBe('Private review comment');
    expect(popover?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(true);
    // The caller's container classes still apply alongside the block.
    expect(popover?.classList.contains('bg-popover')).toBe(true);
  });
});

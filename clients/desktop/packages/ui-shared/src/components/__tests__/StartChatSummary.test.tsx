/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { StartChatSummary } from '../StartChatSummary';
import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// CAN-4551: a chat automation that runs as a workflow.
describe('StartChatSummary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  const byTestId = (id: string): HTMLElement | null =>
    container.querySelector(`[data-testid="${id}"]`);

  it('names the destination, masked, and lists the steps in order', () => {
    act(() =>
      root.render(
        <StartChatSummary
          destination="storefront"
          steps={['Create a worktree', 'Send the prompt', 'Wait for the reply']}
          actions={<button type="button">Open workflow</button>}
        />,
      ),
    );
    expect(byTestId('start-chat-summary-destination')?.textContent).toBe(
      'Start chat in storefront',
    );
    expect(
      byTestId('start-chat-summary-destination')?.querySelector(
        `.${REPLAY_MASK_CLASS}`,
      )?.textContent,
    ).toBe('storefront');
    expect(
      Array.from(
        byTestId('start-chat-summary-steps')?.querySelectorAll('li') ?? [],
        (step: HTMLLIElement) => step.textContent,
      ),
    ).toEqual(['Create a worktree', 'Send the prompt', 'Wait for the reply']);
    expect(container.querySelector('button')?.textContent).toBe(
      'Open workflow',
    );
    expect(byTestId('start-chat-summary-note')).toBeNull();
  });

  it('says why it is read-only', () => {
    act(() =>
      root.render(
        <StartChatSummary
          destination="storefront"
          steps={['Send the prompt']}
          note="Its workflow was edited, so you change it there."
        />,
      ),
    );
    expect(byTestId('start-chat-summary-note')?.textContent).toBe(
      'Its workflow was edited, so you change it there.',
    );
  });
});

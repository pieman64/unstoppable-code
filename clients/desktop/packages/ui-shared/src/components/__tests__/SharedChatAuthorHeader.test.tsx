/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { SharedChatAuthorHeader } from '../SharedChatAuthorHeader';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

/** Whether session replay blocks `element` (it or an ancestor carries the class). */
function replayBlocked(element: Element | null | undefined): boolean {
  if (!element) throw new Error('Missing element');
  return element.closest(`.${REPLAY_BLOCK_CLASS}`) !== null;
}

describe('SharedChatAuthorHeader', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('uses the standard two-letter initials fallback', () => {
    act(() => {
      root.render(
        <SharedChatAuthorHeader author={{ name: 'Taylor Teammate' }} />,
      );
    });

    expect(
      container.querySelector('[data-testid="shared-chat-turn-author"]')
        ?.firstElementChild?.textContent,
    ).toBe('TT');
    expect(container.textContent).toContain('Taylor Teammate');
  });

  it("blocks the author's name and avatar from session replay, not the header", () => {
    act(() => {
      root.render(
        <SharedChatAuthorHeader
          author={{
            name: 'Taylor Teammate',
            image: 'https://example.com/taylor.png',
          }}
        />,
      );
    });

    const header = container.querySelector(
      '[data-testid="shared-chat-turn-author"]',
    );
    const avatar = header?.querySelector('img');
    const name = Array.from(header?.querySelectorAll('span') ?? []).find(
      (span) => span.textContent === 'Taylor Teammate',
    );
    expect(replayBlocked(avatar)).toBe(true);
    expect(replayBlocked(name)).toBe(true);
    expect(replayBlocked(header)).toBe(false);
  });
});

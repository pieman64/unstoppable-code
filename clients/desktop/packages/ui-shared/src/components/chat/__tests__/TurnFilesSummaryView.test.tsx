/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChatLookProvider } from '../../chat-look';
import { TurnFilesSummaryView } from '../TurnFilesSummaryView';

describe('TurnFilesSummaryView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('draws the clean summary tile glyph at 16px', () => {
    act(() => {
      root.render(
        <ChatLookProvider value="clean">
          <TurnFilesSummaryView
            heading="2 files changed"
            expanded={false}
            onToggle={() => undefined}
          >
            {null}
          </TurnFilesSummaryView>
        </ChatLookProvider>,
      );
    });
    const glyph = container.querySelector<SVGElement>(
      '[data-testid="turn-files"] svg[data-app-icon="true"]',
    );
    // An inline size beats the tile's `[&_svg]:size-4`, so the glyph's own
    // size must be the 16px the tile draws.
    expect(glyph?.style.width).toBe('16px');
    expect(glyph?.style.height).toBe('16px');
  });
});

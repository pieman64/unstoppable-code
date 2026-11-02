/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  PANEL_TAB_BUSY_ATTRIBUTE,
  PanelChatTabBackgroundGlyph,
} from '../PanelTabBar';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

function render(node: JSX.Element): HTMLDivElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root?.render(node));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('PanelChatTabBackgroundGlyph', () => {
  it('names the background work and stays closable unless the host says otherwise', () => {
    const container = render(
      <PanelChatTabBackgroundGlyph
        backgroundTasks={2}
        fill
        data-testid="glyph"
      />,
    );
    const glyph = container.querySelector('[data-testid="glyph"]');
    expect(glyph?.hasAttribute(PANEL_TAB_BUSY_ATTRIBUTE)).toBe(false);
    expect(
      container.querySelector('[role="img"]')?.getAttribute('aria-label'),
    ).toBe('2 background tasks running');
  });

  it('marks the tab busy for work that blocks close', () => {
    const container = render(
      <PanelChatTabBackgroundGlyph
        backgroundTasks={1}
        fill={false}
        blocksClose
        data-testid="glyph"
      />,
    );
    expect(
      container
        .querySelector('[data-testid="glyph"]')
        ?.getAttribute(PANEL_TAB_BUSY_ATTRIBUTE),
    ).toBe('true');
    expect(
      container.querySelector('[role="img"]')?.getAttribute('aria-label'),
    ).toBe('1 background task running');
  });
});

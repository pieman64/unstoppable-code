/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { BackDetailOverlayShell } from '../BackDetailOverlayShell';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const CARD_CLASSES =
  'w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl bg-card shadow-xl';

describe('BackDetailOverlayShell session replay', () => {
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

  function renderShell(): HTMLElement {
    act(() =>
      root.render(
        <BackDetailOverlayShell
          title="Server"
          titleId="shell-title"
          onBack={(): void => undefined}
        >
          <p data-testid="shell-body">Secret value</p>
        </BackDetailOverlayShell>,
      ),
    );
    const card = container.querySelector<HTMLElement>('[role="dialog"]');
    if (!card) throw new Error('Dialog card did not render');
    return card;
  }

  it('blocks only the content area when the host asks for it', () => {
    act(() =>
      root.render(
        <BackDetailOverlayShell
          title="My skill"
          titleId="shell-title"
          onBack={(): void => undefined}
          blockContentFromReplay
        >
          <p data-testid="shell-body">SKILL.md body</p>
        </BackDetailOverlayShell>,
      ),
    );
    const card = container.querySelector<HTMLElement>('[role="dialog"]');
    if (!card) throw new Error('Dialog card did not render');
    // The card, back button, and title stay recorded.
    expect(card.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(
      card.querySelector('h2')?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    expect(card.querySelector('h2')?.textContent).toBe('My skill');
    const blockRoot = container
      .querySelector('[data-testid="shell-body"]')
      ?.closest(`.${REPLAY_BLOCK_CLASS}`);
    expect(blockRoot).not.toBeNull();
    expect(blockRoot !== card && card.contains(blockRoot ?? null)).toBe(true);
  });

  it('adds no replay marker unless the host asks for it', () => {
    const card = renderShell();
    expect(card.className).toBe(CARD_CLASSES);
    expect(container.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});

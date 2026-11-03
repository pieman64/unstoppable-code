/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { BackDetailOverlayShell } from '../BackDetailOverlayShell';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

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
    const card = document.body.querySelector<HTMLElement>('[role="dialog"]');
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
    const card = document.body.querySelector<HTMLElement>('[role="dialog"]');
    if (!card) throw new Error('Dialog card did not render');
    // The card, close button, and title stay recorded.
    expect(card.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    expect(
      card.querySelector('h2')?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    expect(card.querySelector('h2')?.textContent).toBe('My skill');
    const blockRoot = document.body
      .querySelector('[data-testid="shell-body"]')
      ?.closest(`.${REPLAY_BLOCK_CLASS}`);
    expect(blockRoot).not.toBeNull();
    expect(blockRoot !== card && card.contains(blockRoot ?? null)).toBe(true);
  });

  it('adds no replay marker unless the host asks for it', () => {
    renderShell();
    expect(document.body.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('is the shared dialog, and closing it goes back', () => {
    const onBack = jest.fn();
    act(() =>
      root.render(
        <BackDetailOverlayShell
          title="Server"
          titleId="shell-title"
          onBack={onBack}
          badge={<span data-testid="shell-badge">HTTP</span>}
        >
          <p>Body</p>
        </BackDetailOverlayShell>,
      ),
    );
    const card = document.body.querySelector<HTMLElement>('[role="dialog"]');
    expect(card?.getAttribute('aria-labelledby')).toBe('shell-title');
    expect(card?.querySelector('#shell-title')?.textContent).toBe('ServerHTTP');
    expect(container.contains(card)).toBe(false);
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onBack).toHaveBeenCalledTimes(1);
    act(() => {
      card
        ?.querySelector<HTMLButtonElement>('button[aria-label="Close"]')
        ?.click();
    });
    expect(onBack).toHaveBeenCalledTimes(2);
  });
});

/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { catchingUpMessage, CatchingUpNotice } from '../CatchingUpNotice';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('CatchingUpNotice', () => {
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

  function query<T extends HTMLElement>(selector: string): T | null {
    return container.querySelector<T>(selector);
  }

  function render(lagMs: number): void {
    act(() => root.render(<CatchingUpNotice lagMs={lagMs} />));
  }

  it('renders a neutral polite status without actions', () => {
    render(0);

    const notice = query<HTMLDivElement>('[data-testid="catching-up-notice"]');
    expect(notice).not.toBeNull();
    expect(notice?.getAttribute('data-notice-intent')).toBe('neutral');
    expect(notice?.getAttribute('role')).toBe('status');
    expect(notice?.getAttribute('aria-live')).toBe('polite');
    expect(notice?.querySelector('.font-medium')?.textContent).toBe(
      'Catching up.',
    );
    expect(notice?.querySelectorAll('button')).toHaveLength(0);
  });

  it.each([
    [0, 'Updates are a few seconds behind the agent.'],
    [59_999, 'Updates are a few seconds behind the agent.'],
    [60_000, 'Updates are about 1 minute behind the agent.'],
    [119_999, 'Updates are about 1 minute behind the agent.'],
    [120_000, 'Updates are about 2 minutes behind the agent.'],
    [179_999, 'Updates are about 2 minutes behind the agent.'],
    [600_000, 'Updates are about 10 minutes behind the agent.'],
    [-1, 'Updates are a few seconds behind the agent.'],
    [Number.NaN, 'Updates are a few seconds behind the agent.'],
    [Number.POSITIVE_INFINITY, 'Updates are a few seconds behind the agent.'],
  ])('uses the expected message for %s ms', (lagMs, expected) => {
    expect(catchingUpMessage(lagMs)).toBe(expected);
  });

  it('only mutates the live region when the visible message changes', () => {
    render(6_000);
    const notice = query<HTMLDivElement>('[data-testid="catching-up-notice"]');
    if (notice === null) throw new Error('Expected the notice to render');

    const observer = new MutationObserver(() => undefined);
    observer.observe(notice, {
      childList: true,
      characterData: true,
      subtree: true,
      attributes: true,
    });

    render(7_000);
    render(45_000);
    expect(observer.takeRecords()).toHaveLength(0);

    render(61_000);
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    expect(notice.textContent).toContain(
      'Updates are about 1 minute behind the agent.',
    );
    observer.disconnect();
  });
});

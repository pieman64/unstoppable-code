/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DevServerHit } from '@/lib/scriptDevServerDetection';
import { ActivityOpenControl } from '../ActivityOpenControl';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function hit(url: string): DevServerHit {
  return {
    url,
    displayUrl: url,
    patternIndex: 0,
    firstSeenAt: 0,
    openTarget: 'external',
  };
}

describe('ActivityOpenControl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <ActivityOpenControl
          context={{ projectId: 'project', worktreeId: 'worktree' }}
          sections={[
            {
              scriptKey: 'dev',
              scriptLabel: 'dev',
              hits: [
                hit('http://localhost:3000'),
                hit('http://localhost:3001'),
              ],
            },
          ]}
        />,
      );
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function trigger(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      'button[aria-haspopup="menu"]',
    );
    if (!button) throw new Error('missing Open trigger');
    return button;
  }

  it('lists the dev servers in the shared action menu and closes it on Escape', () => {
    act(() => {
      trigger().click();
    });
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(container.contains(menu)).toBe(false);
    expect(trigger().getAttribute('aria-controls')).toBe(menu?.id);
    expect(menu?.querySelectorAll('[role="menuitem"]')).toHaveLength(2);

    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });
});

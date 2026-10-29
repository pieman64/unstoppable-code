/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DevServerHit } from '@/lib/scriptDevServerDetection';
import { DevServerOpenControl } from '../DevServerOpenControl';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const CONTEXT = { projectId: 'project-1', worktreeId: 'worktree-1' };

function hit(url: string, label?: string): DevServerHit {
  return {
    url,
    displayUrl: url.replace(/^https?:\/\//, ''),
    label,
    patternIndex: 0,
    firstSeenAt: 1,
    openTarget: 'external',
  };
}

describe('DevServerOpenControl', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.useRealTimers();
  });

  it('labels the single-hit button with the Open verb and the hit label', () => {
    act(() => {
      root.render(
        <DevServerOpenControl
          hits={[hit('http://private-host:3000', 'private-label')]}
          context={CONTEXT}
        />,
      );
    });
    const button = container.querySelector('button');
    expect(button?.textContent).toBe('Open private-label');
  });

  it('leads the URL rows with one shared globe icon', () => {
    act(() => {
      root.render(
        <DevServerOpenControl
          hits={[
            hit('http://private-one:3000', 'web'),
            hit('http://private-two:4000'),
          ]}
          context={CONTEXT}
        />,
      );
    });
    act(() => {
      container.querySelector('button')?.click();
    });

    const slots = Array.from(
      container.querySelectorAll('[role="menuitem"]'),
    ).map((row) => {
      const slot = row.firstElementChild;
      if (slot?.getAttribute('aria-hidden') !== 'true') return 'missing';
      return slot.querySelector('svg') ? 'icon' : 'empty';
    });
    expect(slots).toEqual(['icon', 'empty']);
  });

  it('shows the full URL in a menu row hover tooltip', () => {
    act(() => {
      root.render(
        <DevServerOpenControl
          hits={[
            hit('http://private-one:3000', 'web'),
            hit('http://private-two:4000'),
          ]}
          context={CONTEXT}
        />,
      );
    });
    act(() => {
      container.querySelector('button')?.click();
    });

    const firstRow = container.querySelector('[role="menuitem"]');
    act(() => {
      firstRow?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      jest.runOnlyPendingTimers();
    });
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toBe('http://private-one:3000');
  });
});

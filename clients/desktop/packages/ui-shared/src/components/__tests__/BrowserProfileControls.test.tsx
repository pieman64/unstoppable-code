/** @jest-environment jsdom */
import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserProfileBadge } from '../BrowserProfileControls';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

/**
 * The badge label truncates on every surface that uses it, so the full text
 * has to stay reachable on hover — except where the caller already supplies a
 * richer tooltip carrying the same name.
 */
function render(node: ReactElement): {
  badge: HTMLElement | null;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(node);
  });
  return {
    badge:
      container.firstElementChild instanceof HTMLElement
        ? container.firstElementChild
        : null,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

it('titles the truncating label with the name it shows', () => {
  const { badge, cleanup } = render(
    <BrowserProfileBadge name="A very long profile name" />,
  );
  try {
    expect(badge?.getAttribute('title')).toBe('A very long profile name');
    expect(badge?.querySelector('.truncate')?.textContent).toBe(
      'A very long profile name',
    );
  } finally {
    cleanup();
  }
});

it('titles an unavailable profile with what it displays, not its real name', () => {
  const { badge, cleanup } = render(
    <BrowserProfileBadge name="Work" unavailable />,
  );
  try {
    expect(badge?.getAttribute('title')).toBe('Unavailable profile');
    expect(badge?.textContent).not.toContain('Work');
  } finally {
    cleanup();
  }
});

it('drops the title when the caller owns the tooltip', () => {
  const { badge, cleanup } = render(
    <BrowserProfileBadge name="Work" titleSuppressed />,
  );
  try {
    expect(badge?.hasAttribute('title')).toBe(false);
  } finally {
    cleanup();
  }
});

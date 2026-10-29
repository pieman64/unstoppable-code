/** @jest-environment jsdom */

import { act, useRef, useState, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { SidebarMoreControl } from '../SidebarMoreControl';
import { DropdownMenuItem } from '../DropdownMenu';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function Menu({ compact = false, name = 'more' }): JSX.Element {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <SidebarMoreControl
      open={open}
      onOpenChange={setOpen}
      triggerRef={triggerRef}
      triggerTestId={name}
      menuTestId={`${name}-menu`}
      compact={compact}
      touchTarget="always"
    >
      <DropdownMenuItem>Destination</DropdownMenuItem>
    </SidebarMoreControl>
  );
}

describe('SidebarMoreControl', () => {
  it.each([false, true])(
    'names its trigger and preserves keyboard/focus lifecycle (compact: %s)',
    (compact) => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      try {
        act(() => root.render(<Menu compact={compact} />));
        const trigger = container.querySelector<HTMLButtonElement>('button');
        if (!trigger) throw new Error('Missing More trigger');
        expect(trigger.getAttribute('aria-label') ?? trigger.textContent).toBe(
          'More',
        );
        expect(trigger.className).toContain(compact ? 'h-11 w-11' : 'min-h-11');
        expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        expect(trigger.hasAttribute('aria-controls')).toBe(false);
        act(() => {
          trigger.focus();
          trigger.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
          );
        });
        const menu = document.body.querySelector('[data-testid="more-menu"]');
        expect(trigger.getAttribute('aria-controls')).toBe(menu?.id);
        expect(document.activeElement?.textContent).toBe('Destination');
        // The destinations take the action-menu rows' small text.
        expect(document.activeElement?.className).toContain('text-xs');
        act(() => {
          document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
          );
        });
        expect(
          document.body.querySelector('[data-testid="more-menu"]'),
        ).toBeNull();
        expect(document.activeElement).toBe(trigger);
      } finally {
        act(() => root.unmount());
        container.remove();
      }
    },
  );

  it('gives simultaneous responsive controls unique menu relationships', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      act(() =>
        root.render(
          <>
            <Menu name="wide" />
            <Menu name="compact" compact />
          </>,
        ),
      );
      for (const name of ['wide', 'compact']) {
        act(() =>
          container
            .querySelector<HTMLButtonElement>(`[data-testid="${name}"]`)
            ?.click(),
        );
      }
      const ids = Array.from(
        container.querySelectorAll('[aria-controls]'),
        (element) => element.getAttribute('aria-controls'),
      );
      expect(ids).toHaveLength(2);
      expect(new Set(ids).size).toBe(2);
      for (const id of ids)
        expect(document.getElementById(id ?? '')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

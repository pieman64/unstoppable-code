/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarToggleButton } from '../SidebarToggleButton';
import { TITLEBAR_CONTROL_FOREGROUND_CLASSNAME } from '../sidebar-styles';

function renderToggle(hidden: boolean): {
  container: HTMLElement;
  root: Root;
  unmount: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<SidebarToggleButton hidden={hidden} onToggle={jest.fn()} />);
  });
  return {
    container,
    root,
    unmount: (): void => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe('SidebarToggleButton', () => {
  it('renders the sidebar-hidden-left-wide glyph when visible', () => {
    const { container, unmount } = renderToggle(false);
    try {
      const button = container.querySelector<HTMLButtonElement>(
        '[data-testid="sidebar-toggle"]',
      );
      expect(button?.getAttribute('aria-label')).toBe('Hide sidebar');
      expect(button?.getAttribute('title')).toBeNull();
      // Shared TitlebarIconButton frame: the exact 28px footprint and hover
      // surface every titlebar/top-bar icon action uses.
      expect(button?.className).toContain('h-7');
      expect(button?.className).toContain('w-7');
      expect(button?.className).toContain(
        TITLEBAR_CONTROL_FOREGROUND_CLASSNAME,
      );
      expect(button?.className).toContain('hover:bg-subtle');
      expect(button?.className).not.toContain('hover:bg-secondary');

      // No visual tooltip: hovering/focusing this control reveals the sidebar
      // itself, so a portalled label would float over the panel it opened.
      // `aria-label` (asserted above) still carries the state for assistive
      // technology.
      act(() => {
        button?.focus();
      });
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();

      const icon = container.querySelector('[data-app-icon="true"]');
      expect(icon).not.toBeNull();
      expect(icon?.getAttribute('style')).toContain('width: 14px');
      expect(icon?.getAttribute('style')).toContain('height: 14px');
    } finally {
      unmount();
    }
  });

  it('keeps the sidebar-hidden-left-wide glyph when hidden', () => {
    const { container, unmount } = renderToggle(true);
    try {
      const button = container.querySelector('[data-testid="sidebar-toggle"]');
      expect(button?.getAttribute('aria-label')).toBe('Show sidebar');
      expect(button?.getAttribute('title')).toBeNull();

      expect(container.querySelector('[data-app-icon="true"]')).not.toBeNull();
    } finally {
      unmount();
    }
  });
});

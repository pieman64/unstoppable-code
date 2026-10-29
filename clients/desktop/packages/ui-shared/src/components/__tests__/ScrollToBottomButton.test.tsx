/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ScrollToBottomButton } from '../ScrollToBottomButton';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

it.each(['Scroll to bottom', 'Scroll to latest message'])(
  'renders an opaque circular shared control named %s and invokes the host callback',
  (ariaLabel) => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onClick = jest.fn();
    try {
      act(() =>
        root.render(
          <ScrollToBottomButton
            ariaLabel={ariaLabel}
            dataTestId="return-to-tail"
            onClick={onClick}
          />,
        ),
      );
      const button = container.querySelector('button');
      if (!button) throw new Error('Scroll control not mounted');
      expect(button.type).toBe('button');
      expect(button.getAttribute('aria-label')).toBe(ariaLabel);
      expect(button.getAttribute('data-testid')).toBe('return-to-tail');
      expect(button.className).toContain('rounded-full');
      expect(button.className).toContain('h-8');
      expect(button.className).toContain('w-8');
      expect(button.className).toContain('px-0');
      expect(button.className).toContain('bg-quaternary');
      expect(button.className).toContain(
        'hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
      );
      expect(button.className).not.toMatch(/(?:^| )hover:bg-/);
      expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe(
        'true',
      );
      act(() => button.click());
      expect(onClick).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  },
);

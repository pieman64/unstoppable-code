/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  StartingPointChip,
  type StartingPointChipProps,
} from '../StartingPointChip';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

interface View {
  container: HTMLDivElement;
  root: Root;
  chip: () => HTMLButtonElement;
}

function render(overrides: Partial<StartingPointChipProps> = {}): View {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <StartingPointChip
        name="Research"
        description="Gathers sources."
        selected={false}
        onToggle={jest.fn()}
        data-testid="chip"
        {...overrides}
      />,
    );
  });
  return {
    container,
    root,
    chip: (): HTMLButtonElement => {
      const chip = container.querySelector<HTMLButtonElement>(
        '[data-testid="chip"]',
      );
      if (!chip) throw new Error('chip not rendered');
      return chip;
    },
  };
}

function cleanup({ container, root }: View): void {
  act(() => root.unmount());
  container.remove();
}

function hover(element: Element | null): void {
  act(() => {
    element?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  });
}

describe('StartingPointChip', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('is a toggle named by its label that reports presses', () => {
    const onToggle = jest.fn();
    const view = render({ onToggle, selected: true });
    try {
      expect(view.chip().textContent).toBe('Research');
      expect(view.chip().getAttribute('aria-pressed')).toBe('true');
      act(() => view.chip().click());
      expect(onToggle).toHaveBeenCalledTimes(1);
    } finally {
      cleanup(view);
    }
  });

  it('lets a long name truncate inside the row instead of overflowing it', () => {
    const view = render({ name: 'A'.repeat(256) });
    try {
      // Flex layout cannot be measured in jsdom: pin the classes that let
      // the tooltip wrapper and the chip shrink to the row's width.
      const chip = view.chip().closest('[data-chip]');
      const wrapper = chip?.parentElement;
      expect(wrapper?.classList.contains('shrink-0')).toBe(false);
      expect(wrapper?.classList.contains('min-w-0')).toBe(true);
      expect(wrapper?.classList.contains('max-w-full')).toBe(true);
      expect(chip?.classList.contains('max-w-full')).toBe(true);
      expect(view.chip().querySelector('.truncate')?.textContent).toBe(
        'A'.repeat(256),
      );
    } finally {
      cleanup(view);
    }
  });

  it('is the shared Chip with its selected look, and no remove button', () => {
    const view = render({ selected: true });
    try {
      const chip = view.chip().closest('[data-chip]');
      expect(chip?.classList.contains('bg-accent-subtle')).toBe(true);
      expect(chip?.querySelectorAll('button')).toHaveLength(1);
    } finally {
      cleanup(view);
    }
  });

  it('does not report presses while disabled', () => {
    const onToggle = jest.fn();
    const view = render({ onToggle, disabled: true });
    try {
      expect(view.chip().disabled).toBe(true);
      act(() => view.chip().click());
      expect(onToggle).not.toHaveBeenCalled();
    } finally {
      cleanup(view);
    }
  });

  it('shows the description in the shared tooltip after a long hover', () => {
    jest.useFakeTimers();
    const view = render();
    try {
      expect(view.chip().hasAttribute('title')).toBe(false);
      hover(view.chip().closest('[data-chip]')?.parentElement ?? null);
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Gathers sources.',
      );
    } finally {
      cleanup(view);
    }
  });

  it('describes the toggle button with the tooltip, as the title did', () => {
    jest.useFakeTimers();
    const view = render();
    try {
      hover(view.chip().closest('[data-chip]')?.parentElement ?? null);
      act(() => {
        jest.advanceTimersByTime(500);
      });
      const tooltipId = document.querySelector('[role="tooltip"]')?.id;
      expect(tooltipId).toBeTruthy();
      expect(view.chip().getAttribute('aria-describedby')).toContain(
        tooltipId ?? '',
      );
    } finally {
      cleanup(view);
    }
  });

  it('shows no tooltip without a description', () => {
    jest.useFakeTimers();
    const view = render({ description: '' });
    try {
      hover(view.chip().closest('[data-chip]')?.parentElement ?? null);
      act(() => {
        jest.advanceTimersByTime(500);
      });
      expect(document.querySelector('[role="tooltip"]')).toBeNull();
    } finally {
      cleanup(view);
    }
  });
});

/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { ColorSwatchPicker } from '../ColorSwatchPicker';
import { WORKSPACE_COLOR_PALETTE } from '../WorkspaceSettingsDialog';
Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function render(props: Parameters<typeof ColorSwatchPicker>[0]): {
  container: HTMLElement;
  cleanup: () => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ColorSwatchPicker {...props} />);
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

const swatch = (container: HTMLElement, color: string): HTMLButtonElement => {
  const found = container.querySelector(`[aria-label="Color ${color}"]`);
  if (!(found instanceof HTMLButtonElement))
    throw new Error(`Missing swatch: ${color}`);
  return found;
};

it('renders the workspace palette by default and checks the selected swatch', () => {
  const { container, cleanup } = render({
    value: WORKSPACE_COLOR_PALETTE[1],
    onChange: jest.fn(),
    testId: 'swatches',
  });
  try {
    expect(
      container.querySelectorAll('[data-testid="swatches"] button'),
    ).toHaveLength(WORKSPACE_COLOR_PALETTE.length);
    const selected = swatch(container, WORKSPACE_COLOR_PALETTE[1]);
    expect(selected.getAttribute('aria-pressed')).toBe('true');
    // A checkmark marks the choice; there is no ring.
    expect(selected.querySelector('svg')).toBeInstanceOf(SVGElement);
    expect(selected.className).not.toContain('ring-');
    const other = swatch(container, WORKSPACE_COLOR_PALETTE[0]);
    expect(other.getAttribute('aria-pressed')).toBe('false');
    expect(other.querySelector('svg')).toBeNull();
  } finally {
    cleanup();
  }
});

it('reports the clicked color and nothing else', () => {
  const onChange = jest.fn();
  const { container, cleanup } = render({ value: undefined, onChange });
  try {
    act(() => {
      swatch(container, WORKSPACE_COLOR_PALETTE[2]).click();
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(WORKSPACE_COLOR_PALETTE[2]);
  } finally {
    cleanup();
  }
});

it('leaves an off-palette value with no swatch ringed, losing nothing', () => {
  const { container, cleanup } = render({
    value: '#abcdef',
    onChange: jest.fn(),
    testId: 'swatches',
  });
  try {
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
  } finally {
    cleanup();
  }
});

it('blocks interaction while disabled', () => {
  const onChange = jest.fn();
  const { container, cleanup } = render({
    value: undefined,
    onChange,
    disabled: true,
  });
  try {
    const target = swatch(container, WORKSPACE_COLOR_PALETTE[0]);
    expect(target.disabled).toBe(true);
    act(() => {
      target.click();
    });
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

it('accepts a caller-supplied palette', () => {
  const { container, cleanup } = render({
    value: '#111111',
    onChange: jest.fn(),
    palette: ['#111111', '#222222'],
    testId: 'swatches',
  });
  try {
    expect(
      container.querySelectorAll('[data-testid="swatches"] button'),
    ).toHaveLength(2);
    expect(swatch(container, '#111111').getAttribute('aria-pressed')).toBe(
      'true',
    );
  } finally {
    cleanup();
  }
});

it('labels semantic swatches while reporting their stored key and preserving geometry', () => {
  const onChange = jest.fn();
  const { container, cleanup } = render({
    value: 'neutral',
    onChange,
    palette: [
      { value: 'neutral', label: 'Neutral', color: 'var(--fg-tertiary)' },
      {
        value: 'categorical-1',
        label: 'Color 1',
        color: 'var(--categorical-1)',
      },
    ],
  });
  try {
    const button = container.querySelector<HTMLButtonElement>(
      '[aria-label="Color 1"]',
    );
    expect(button?.className).toContain('h-6 w-6');
    act(() => button?.click());
    expect(onChange).toHaveBeenCalledWith('categorical-1');
    expect(
      container
        .querySelector('[aria-label="Neutral"]')
        ?.getAttribute('aria-pressed'),
    ).toBe('true');
  } finally {
    cleanup();
  }
});

it('draws smaller swatches in a settings row', () => {
  const { container, cleanup } = render({
    value: WORKSPACE_COLOR_PALETTE[0],
    onChange: jest.fn(),
    size: 'compact',
  });
  try {
    const selected = swatch(container, WORKSPACE_COLOR_PALETTE[0]);
    expect(selected.className).toContain('h-5');
    expect(selected.className).toContain('w-5');
    expect(selected.querySelector('svg')).toBeInstanceOf(SVGElement);
  } finally {
    cleanup();
  }
});

/**
 * @jest-environment jsdom
 */
import { act, useState, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { buttonClassName } from '../Button';
import {
  SegmentedControl,
  type SegmentedControlProps,
  type SegmentedControlShape,
} from '../SegmentedControl';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
  writable: true,
});

type Choice = 'short' | 'complete' | 'off';

/** jsdom does no layout; segments report the offsets a real track would. */
const LAYOUT: Record<string, { left: number; width: number }> = {
  'segment-short': { left: 2, width: 60 },
  'segment-complete': { left: 64, width: 90 },
  'segment-off': { left: 156, width: 40 },
};

function stubOffsets(): () => void {
  const prototype = HTMLElement.prototype;
  const left = Object.getOwnPropertyDescriptor(prototype, 'offsetLeft');
  const width = Object.getOwnPropertyDescriptor(prototype, 'offsetWidth');
  Object.defineProperty(prototype, 'offsetLeft', {
    configurable: true,
    get(this: HTMLElement): number {
      return LAYOUT[this.dataset.testid ?? '']?.left ?? 0;
    },
  });
  Object.defineProperty(prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      return LAYOUT[this.dataset.testid ?? '']?.width ?? 0;
    },
  });
  return (): void => {
    if (left) Object.defineProperty(prototype, 'offsetLeft', left);
    if (width) Object.defineProperty(prototype, 'offsetWidth', width);
  };
}

const OPTIONS: SegmentedControlProps<Choice>['options'] = [
  { value: 'short', label: 'Short', dataTestId: 'segment-short' },
  { value: 'complete', label: 'Complete', dataTestId: 'segment-complete' },
  {
    value: 'off',
    label: 'Off',
    dataTestId: 'segment-off',
    unavailable: true,
    tooltip: 'Subscribe to turn this off.',
  },
];

function Harness({
  onChange,
  semantics,
  shape,
}: {
  onChange: (next: Choice) => void;
  semantics?: 'toggle' | 'tabs';
  shape?: SegmentedControlShape;
}): JSX.Element {
  const [value, setValue] = useState<Choice>('short');
  return (
    <SegmentedControl
      value={value}
      options={OPTIONS}
      onChange={(next): void => {
        onChange(next);
        setValue(next);
      }}
      label="Diff stats"
      semantics={semantics}
      shape={shape}
      dataTestId="picker"
    />
  );
}

describe('SegmentedControl', () => {
  let container: HTMLDivElement;
  let root: Root;
  let restoreOffsets: () => void;

  beforeEach(() => {
    restoreOffsets = stubOffsets();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    restoreOffsets();
  });

  const query = (testId: string): HTMLElement | null =>
    container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

  it('slides one raised surface to the picked segment', () => {
    const onChange = jest.fn();
    act(() => root.render(<Harness onChange={onChange} />));

    const surface = query('picker-indicator');
    expect(surface?.style.left).toBe('2px');
    expect(surface?.style.width).toBe('60px');
    // The surface is the secondary button's resting shell; the segments
    // only change their ink.
    expect(surface?.className).toContain('bg-quaternary');
    expect(query('segment-short')?.className).not.toContain('bg-quaternary');

    act(() => query('segment-complete')?.click());
    expect(onChange).toHaveBeenCalledWith('complete');
    expect(surface?.style.left).toBe('64px');
    expect(surface?.style.width).toBe('90px');
    expect(query('segment-complete')?.className).toContain('fg-primary');
    expect(query('segment-short')?.className).toContain('fg-secondary');
  });

  it('slides the surface on the compositor instead of animating left and width', () => {
    // The surface reports the box its own styles lay it out in.
    const prototype = HTMLElement.prototype;
    const descriptors = {
      offsetLeft: Object.getOwnPropertyDescriptor(prototype, 'offsetLeft'),
      offsetWidth: Object.getOwnPropertyDescriptor(prototype, 'offsetWidth'),
      offsetHeight: Object.getOwnPropertyDescriptor(prototype, 'offsetHeight'),
    };
    const surfaceOr = (
      element: HTMLElement,
      own: number,
      fallback: PropertyDescriptor | undefined,
    ): number =>
      element.dataset.testid === 'picker-indicator'
        ? own
        : Number(fallback?.get?.call(element) ?? 0);
    Object.defineProperty(prototype, 'offsetLeft', {
      configurable: true,
      get(this: HTMLElement): number {
        return surfaceOr(
          this,
          Number.parseFloat(this.style.left),
          descriptors.offsetLeft,
        );
      },
    });
    Object.defineProperty(prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement): number {
        return surfaceOr(
          this,
          Number.parseFloat(this.style.width),
          descriptors.offsetWidth,
        );
      },
    });
    Object.defineProperty(prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        return surfaceOr(this, 24, descriptors.offsetHeight);
      },
    });
    const animate = jest.fn();
    Object.defineProperty(prototype, 'animate', {
      configurable: true,
      writable: true,
      value: animate,
    });
    try {
      act(() => root.render(<Harness onChange={jest.fn()} />));
      const surface = query('picker-indicator');
      // Drawn in place on mount: no slide in.
      expect(animate).not.toHaveBeenCalled();
      expect(surface?.className).not.toMatch(/transition-\[[^\]]*(width|left)/);
      expect(surface?.className).toContain('origin-top-left');

      act(() => query('segment-complete')?.click());
      // Laid out at the new segment at once, then drawn from the old one.
      expect(surface?.style.left).toBe('64px');
      expect(surface?.style.width).toBe('90px');
      expect(animate).toHaveBeenCalledTimes(1);
      expect(animate).toHaveBeenCalledWith(
        [
          { transform: `translate(-62px, 0px) scale(${60 / 90}, 1)` },
          { transform: 'none' },
        ],
        { duration: 200, easing: 'cubic-bezier(0, 0, 0.2, 1)' },
      );
    } finally {
      Reflect.deleteProperty(prototype, 'animate');
      for (const [name, descriptor] of Object.entries(descriptors)) {
        if (descriptor) Object.defineProperty(prototype, name, descriptor);
      }
    }
  });

  it('holds the control-column width by default and hugs its labels at content width', () => {
    act(() => root.render(<Harness onChange={jest.fn()} />));
    expect(query('picker')?.className).toContain('min-w-52');

    act(() =>
      root.render(
        <SegmentedControl
          value="short"
          options={OPTIONS}
          onChange={jest.fn()}
          label="Diff stats"
          width="content"
          dataTestId="picker"
        />,
      ),
    );
    const classes = query('picker')?.className.split(/\s+/) ?? [];
    expect(classes).not.toContain('min-w-52');
    expect(classes).not.toContain('w-full');
    expect(classes).not.toContain('undefined');
  });

  it('keeps the 8px control rectangle by default', () => {
    act(() => root.render(<Harness onChange={jest.fn()} />));

    const track = query('picker')?.className ?? '';
    expect(track).toContain('h-7');
    expect(track).toContain('rounded-md');
    expect(track).not.toContain('rounded-full');
    const segment = query('segment-short')?.className.split(/\s+/) ?? [];
    expect(segment).toContain('rounded-[calc(var(--radius-md)-2px)]');
    expect(segment).toContain('px-2');
    expect(segment).not.toContain('rounded-full');
  });

  it('is a 28px capsule, like the compact settings buttons, with capsule segments', () => {
    act(() => root.render(<Harness onChange={jest.fn()} shape="capsule" />));

    const track = query('picker')?.className ?? '';
    expect(track).toContain('h-7');
    expect(track).toContain('rounded-full');
    expect(track).not.toContain('rounded-md');
    expect(query('picker-indicator')?.className).toContain('rounded-full');
    const segment = query('segment-short')?.className.split(/\s+/) ?? [];
    expect(segment).toContain('rounded-full');
    expect(segment).toContain('px-3');
  });

  it('sets its capsule labels in the compact settings buttons type', () => {
    act(() => root.render(<Harness onChange={jest.fn()} shape="capsule" />));

    // The compact capsule button's label: 13px at the medium weight.
    const buttonType = buttonClassName({ size: 'compact' })
      .split(/\s+/)
      .filter((token) => /^(text-(xs|s|m)|font-)/.test(token));
    expect(buttonType).toEqual(['font-medium', 'text-xs']);
    const segment = query('segment-short')?.className.split(/\s+/) ?? [];
    for (const token of buttonType) expect(segment).toContain(token);
  });

  it('switches a setting as a group of pressed buttons by default', () => {
    act(() => root.render(<Harness onChange={jest.fn()} />));

    const track = query('picker');
    expect(track?.getAttribute('role')).toBe('group');
    expect(track?.getAttribute('aria-label')).toBe('Diff stats');
    expect(query('segment-short')?.getAttribute('aria-pressed')).toBe('true');
    expect(query('segment-complete')?.getAttribute('aria-pressed')).toBe(
      'false',
    );
    expect(query('segment-short')?.hasAttribute('role')).toBe(false);
  });

  it('switches a view as a tablist', () => {
    act(() => root.render(<Harness onChange={jest.fn()} semantics="tabs" />));

    expect(query('picker')?.getAttribute('role')).toBe('tablist');
    expect(query('segment-short')?.getAttribute('role')).toBe('tab');
    expect(query('segment-short')?.getAttribute('aria-selected')).toBe('true');
    expect(query('segment-short')?.hasAttribute('aria-pressed')).toBe(false);
  });

  it('keeps an unavailable option focusable but never selects it', () => {
    const onChange = jest.fn();
    act(() => root.render(<Harness onChange={onChange} />));

    const off = query('segment-off');
    expect(off?.getAttribute('aria-disabled')).toBe('true');
    expect(off?.hasAttribute('disabled')).toBe(false);
    act(() => off?.click());
    expect(onChange).not.toHaveBeenCalled();
    expect(query('picker-indicator')?.style.left).toBe('2px');
  });

  it('shows each option tooltip on hover', () => {
    act(() =>
      root.render(
        <SegmentedControl<Choice>
          value="short"
          options={[
            {
              value: 'short',
              label: 'Short',
              dataTestId: 'segment-short',
              tooltip: 'Managed by Private Org.',
            },
            {
              value: 'complete',
              label: 'Complete',
              dataTestId: 'segment-complete',
              tooltip: 'Shows every line.',
            },
          ]}
          onChange={jest.fn()}
          label="Diff stats"
        />,
      ),
    );

    function hoverTooltip(testId: string): Element | null {
      const segment = query(testId);
      act(() => {
        segment?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      });
      const tooltip = document.body.querySelector('[role="tooltip"]');
      act(() => {
        segment?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      });
      return tooltip;
    }

    expect(hoverTooltip('segment-short')?.textContent).toBe(
      'Managed by Private Org.',
    );
    expect(hoverTooltip('segment-complete')?.textContent).toBe(
      'Shows every line.',
    );
  });

  it('shows an icon in place of the label, which stays the accessible name', () => {
    act(() =>
      root.render(
        <SegmentedControl<'tree' | 'list'>
          value="list"
          width="content"
          options={[
            {
              value: 'tree',
              label: 'Tree',
              icon: <svg data-testid="tree-icon" />,
              tooltip: 'Tree view',
              dataTestId: 'segment-tree',
            },
            { value: 'list', label: 'List', dataTestId: 'segment-list' },
          ]}
          onChange={jest.fn()}
          label="View"
        />,
      ),
    );

    const tree = query('segment-tree');
    expect(tree?.getAttribute('aria-label')).toBe('Tree');
    expect(tree?.textContent).toBe('');
    expect(tree?.querySelector('[data-testid="tree-icon"]')).not.toBeNull();
    // A square segment, not the labeled segment's sides.
    expect(tree?.className.split(/\s+/)).toEqual(
      expect.arrayContaining(['w-6', 'px-0']),
    );
    // A labeled segment keeps its text and needs no aria-label.
    const list = query('segment-list');
    expect(list?.getAttribute('aria-label')).toBeNull();
    expect(list?.textContent).toBe('List');
    expect(list?.className.split(/\s+/)).toContain('px-2');
  });
});

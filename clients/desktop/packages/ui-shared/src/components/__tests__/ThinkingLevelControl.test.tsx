/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { useState, type JSX } from 'react';
import type { ThinkingLevel } from '@canopy/protocol/thinking';
import {
  ThinkingLevelControl,
  ThinkingLevelPanelPicker,
  ThinkingLevelProviderHint,
} from '../ThinkingLevelControl';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const FULL_LEVELS = ['off', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const NON_ULTRA_LEVELS = ['off', 'medium', 'high', 'xhigh', 'max'] as const;

it('can use the Settings dropdown instead of the native select', () => {
  const props = {
    value: 'high',
    supportedLevels: FULL_LEVELS,
    onChange: (): void => undefined,
    variant: 'select',
  } as const;
  const settings = renderToStaticMarkup(
    <ThinkingLevelControl {...props} selectShape="capsule" />,
  );
  const native = renderToStaticMarkup(<ThinkingLevelControl {...props} />);
  expect(settings).toContain('role="combobox"');
  expect(settings).not.toContain('<select');
  expect(native).toContain('<select');
  // Dropdowns are rounded rectangles either way (2026-10-30).
  for (const html of [settings, native]) {
    expect(html).toContain('rounded-row');
    expect(html).not.toContain('rounded-full');
  }
});

function renderControl(
  value: ThinkingLevel | undefined,
  supportedLevels: readonly ThinkingLevel[] = FULL_LEVELS,
): string {
  return renderToStaticMarkup(
    <ThinkingLevelControl
      value={value}
      supportedLevels={supportedLevels}
      onChange={(): void => undefined}
    />,
  );
}

function ControlledControl({
  supportedLevels,
  includeLow = false,
}: {
  supportedLevels: readonly ThinkingLevel[];
  includeLow?: boolean;
}): JSX.Element {
  const [value, setValue] = useState<ThinkingLevel | undefined>('off');
  return (
    <ThinkingLevelControl
      value={value}
      supportedLevels={supportedLevels}
      onChange={setValue}
      includeLow={includeLow}
    />
  );
}

function clickSequence(
  supportedLevels: readonly ThinkingLevel[],
  clickCount: number,
  includeLow = false,
): string[] {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() =>
    root.render(
      <ControlledControl
        supportedLevels={supportedLevels}
        includeLow={includeLow}
      />,
    ),
  );
  const labels: string[] = [];

  for (let click = 0; click < clickCount; click += 1) {
    const button = container.querySelector('button');
    act(() => button?.click());
    labels.push(
      container.querySelector('button')?.getAttribute('aria-label') ?? '',
    );
  }

  act(() => root.unmount());
  container.remove();
  return labels;
}

/**
 * Keyboard-driven focus. The shared tooltips follow `:focus-visible`: a Tab
 * keydown reaches the document before focus moves, so the tooltip opens. A
 * bare `.focus()` is programmatic focus and keeps it closed.
 */
function focusViaKeyboard(element: HTMLElement | null | undefined): void {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
  );
  element?.focus();
}

describe('ThinkingLevelControl', () => {
  it('clicks through an Ultra-capable model and always returns to off', () => {
    expect(clickSequence(FULL_LEVELS, 6)).toEqual([
      'Thinking: Medium; click to cycle',
      'Thinking: High; click to cycle',
      'Thinking: Extra High; click to cycle',
      'Thinking: Max; click to cycle',
      'Thinking: Ultra; click to cycle',
      'Thinking: None; click to cycle',
    ]);
  });

  it('never synthesizes Ultra for a model that does not declare it', () => {
    expect(clickSequence(NON_ULTRA_LEVELS, 5)).toEqual([
      'Thinking: Medium; click to cycle',
      'Thinking: High; click to cycle',
      'Thinking: Extra High; click to cycle',
      'Thinking: Max; click to cycle',
      'Thinking: None; click to cycle',
    ]);
  });

  it('opt-in cycles low explicitly and keeps Default in its original position', () => {
    expect(
      clickSequence(
        ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        8,
        true,
      ),
    ).toEqual([
      'Thinking: Low; click to cycle',
      'Thinking: Medium; click to cycle',
      'Thinking: High; click to cycle',
      'Thinking: Extra High; click to cycle',
      'Thinking: Max; click to cycle',
      'Thinking: Ultra; click to cycle',
      'Thinking: None; click to cycle',
      'Thinking: Low; click to cycle',
    ]);
  });

  it('opt-in preserves the full workspace-default editor cycle', () => {
    function WorkspaceDefaultControl(): JSX.Element {
      const [value, setValue] = useState<ThinkingLevel | undefined>(undefined);
      return (
        <ThinkingLevelControl
          value={value}
          supportedLevels={[
            'off',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
            'ultra',
          ]}
          onChange={setValue}
          allowWorkspaceDefault
          includeLow
        />
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(<WorkspaceDefaultControl />));
    const labels: string[] = [];
    for (let click = 0; click < 8; click += 1) {
      act(() => container.querySelector('button')?.click());
      labels.push(
        container.querySelector('button')?.getAttribute('aria-label') ?? '',
      );
    }
    expect(labels).toEqual([
      'Thinking: None; click to cycle',
      'Thinking: Low; click to cycle',
      'Thinking: Medium; click to cycle',
      'Thinking: High; click to cycle',
      'Thinking: Extra High; click to cycle',
      'Thinking: Max; click to cycle',
      'Thinking: Ultra; click to cycle',
      'Thinking: Default; click to cycle',
    ]);
    act(() => root.unmount());
    container.remove();
  });

  it('keeps disabled cycle controls as a no-op', () => {
    const onChange = jest.fn<void, [ThinkingLevel | undefined]>();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() =>
      root.render(
        <ThinkingLevelControl
          value="high"
          supportedLevels={FULL_LEVELS}
          onChange={onChange}
          disabled
        />,
      ),
    );

    act(() => container.querySelector('button')?.click());

    expect(onChange).not.toHaveBeenCalled();
    act(() => root.unmount());
    container.remove();
  });

  it('uses the Lucide thinking glyph at 14px', () => {
    const html = renderControl('high');

    expect(html).toContain('data-app-icon="true"');
    expect(html).toContain('width:14px');
    expect(html).toContain('height:14px');
    expect(html).toContain('data-glyph="brain-circuit"');
    expect(html).not.toContain('M6.5 16.5h9');
    expect(html).not.toContain('cx="3.5" cy="22"');
  });

  it('uses the xs text token in the capsule trigger', () => {
    const html = renderToStaticMarkup(
      <ThinkingLevelControl
        value="high"
        supportedLevels={FULL_LEVELS}
        onChange={(): void => undefined}
        variant="capsule"
      />,
    );

    expect(html).toContain('text-xs');
    expect(html).toContain('gap-1.5');
    expect(html).not.toContain('text-2xs');
    // 32px capsule on fine pointers, the 44px floor on coarse ones — the
    // same contract `ChatComposerToolbarChip`'s capsule keeps.
    expect(html).toContain('h-8');
    expect(html).toContain('pointer-coarse:min-h-11');
    expect(html).toContain('pointer-coarse:min-w-11');
  });

  it('uses compact 2px dots with equal spacing', () => {
    const html = renderControl('medium');

    expect(html).toContain('items-center');
    expect(html).toContain('gap-1');
    expect(html).toContain('h-0.5 w-0.5');
    expect(html).toContain('gap-0.5 fg-secondary');
    expect(html).not.toContain('h-0.75 w-0.75');
  });

  it('preserves the provider-specific active-dot tables', () => {
    const claudeHtml = renderControl('medium');
    const codexHtml = renderToStaticMarkup(
      <ThinkingLevelProviderHint providerHint="codex">
        <ThinkingLevelControl
          value="medium"
          supportedLevels={FULL_LEVELS}
          onChange={(): void => undefined}
        />
      </ThinkingLevelProviderHint>,
    );

    expect(claudeHtml.match(/opacity-20/g)).toHaveLength(3);
    expect(codexHtml.match(/opacity-20/g)).toHaveLength(2);
  });

  it('renders Ultra with fully saturated dots for both providers', () => {
    const claudeHtml = renderControl('ultra');
    const codexHtml = renderToStaticMarkup(
      <ThinkingLevelProviderHint providerHint="codex">
        <ThinkingLevelControl
          value="ultra"
          supportedLevels={FULL_LEVELS}
          onChange={(): void => undefined}
        />
      </ThinkingLevelProviderHint>,
    );

    expect(claudeHtml).not.toContain('opacity-20');
    expect(codexHtml).not.toContain('opacity-20');
  });

  it('draws no dots in the Off and workspace-default states', () => {
    expect(renderControl('off')).not.toContain('h-0.5 w-0.5');
    expect(
      renderToStaticMarkup(
        <ThinkingLevelControl
          value={undefined}
          supportedLevels={FULL_LEVELS}
          onChange={(): void => undefined}
          allowWorkspaceDefault
        />,
      ),
    ).not.toContain('h-0.5 w-0.5');
  });

  it.each([
    ['off', 'fg-secondary'],
    ['low', 'fg-secondary'],
    ['medium', 'fg-success'],
    ['high', 'fg-blue'],
    ['xhigh', 'fg-warning'],
    ['max', 'fg-destructive'],
    ['ultra', 'fg-purple'],
  ] as const)('uses %s effort icon color %s', (level, colorClass) => {
    const markup = document.createElement('div');
    markup.innerHTML = renderControl(level);
    expect(
      markup.querySelector('button > svg')?.classList.contains(colorClass),
    ).toBe(true);
  });

  it('marks the glyph active only for a thinking level above off', () => {
    expect(renderControl('high')).toContain('data-active="true"');
    expect(renderControl('off')).not.toContain('data-active');
  });

  it.each([
    ['high', 'High'],
    [undefined, 'Default'],
  ] as const)('renders the %s level label', (level, label) => {
    expect(renderControl(level)).toContain(`>${label}</span>`);
  });

  it('renders Off as the resting glyph without a label', () => {
    const html = renderControl('off');

    // The label stays mounted but folded, so it can grow back in.
    expect(html).toContain('data-fold-open="false"');
    expect(html).toContain('data-thinking-level="off"');
    expect(html).toContain('Thinking: None; click to cycle');
  });

  it('keeps a compact level in the exact aria-label contract', () => {
    const html = renderToStaticMarkup(
      <ThinkingLevelControl
        value="high"
        supportedLevels={FULL_LEVELS}
        onChange={(): void => undefined}
        compact
      />,
    );

    expect(html).toContain('Thinking: High; click to cycle');
    expect(html).toContain('data-thinking-level="high"');
    expect(html).toContain('h-0.5 w-0.5');
    expect(html).not.toContain('<span>High</span>');
  });

  it('keeps normal capsule padding when the effort label is compacted', () => {
    const html = renderToStaticMarkup(
      <ThinkingLevelControl
        value="high"
        supportedLevels={FULL_LEVELS}
        onChange={(): void => undefined}
        variant="capsule"
        compact
      />,
    );

    expect(html).toContain('h-8 gap-1.5 rounded-full px-2.5 text-xs');
    expect(html).not.toContain('rounded-full px-1 text-xs');
  });

  it.each(['cycle', 'capsule'] as const)(
    'uses a verbatim aria-label override for the %s variant without changing the default',
    (variant) => {
      const defaultHtml = renderToStaticMarkup(
        <ThinkingLevelControl
          value="high"
          supportedLevels={FULL_LEVELS}
          onChange={(): void => undefined}
          variant={variant}
        />,
      );
      const overriddenHtml = renderToStaticMarkup(
        <ThinkingLevelControl
          value="high"
          supportedLevels={FULL_LEVELS}
          onChange={(): void => undefined}
          variant={variant}
          ariaLabel="Cycle thinking level"
        />,
      );

      expect(defaultHtml).toContain(
        'aria-label="Thinking: High; click to cycle"',
      );
      expect(overriddenHtml).toContain('aria-label="Cycle thinking level"');
      expect(overriddenHtml).not.toContain(
        'aria-label="Thinking: High; click to cycle"',
      );
    },
  );

  it('keeps active resting states transparent with only the subtle hover', () => {
    for (const level of ['high', 'max', 'ultra'] as const) {
      const html = renderControl(level);
      expect(html).toContain('hover:bg-subtle');
      expect(html).not.toContain('bg-warning');
      expect(html).not.toContain('linear-gradient');
      expect(html).not.toContain('thinking-ultra-pulse');
    }
  });

  it('keeps the active effort label visible in fg-primary', () => {
    const html = renderControl('high');

    expect(html).toContain('>High</span>');
    expect(html).toContain('fg-primary');
  });

  it('uses one shared tooltip and no native title in every button state', () => {
    const offHtml = renderControl('off');
    const highHtml = renderControl('high');

    expect(offHtml).toContain('relative inline-flex shrink-0');
    expect(highHtml).toContain('relative inline-flex shrink-0');
    expect(offHtml).not.toContain(' title=');
    expect(highHtml).not.toContain(' title=');
  });

  function readTooltip(element: JSX.Element): string | undefined {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => root.render(element));
    const button = container.querySelector('button');
    act(() => focusViaKeyboard(button));
    const text = document.body.querySelector('[role="tooltip"]')?.textContent;
    act(() => root.unmount());
    container.remove();
    return text ?? undefined;
  }

  it('names only the control in the tooltip while the level label is visible', () => {
    expect(
      readTooltip(
        <ThinkingLevelControl
          value="high"
          supportedLevels={FULL_LEVELS}
          onChange={(): void => undefined}
        />,
      ),
    ).toBe('Effort');
  });

  it.each([
    ['the Off state', { value: 'off', compact: false }, 'Effort: None'],
    ['a compact level', { value: 'high', compact: true }, 'Effort: High'],
  ] as const)(
    'names the current effort in the tooltip for %s',
    (_case, { value, compact }, expected) => {
      expect(
        readTooltip(
          <ThinkingLevelControl
            value={value}
            supportedLevels={FULL_LEVELS}
            onChange={(): void => undefined}
            compact={compact}
          />,
        ),
      ).toBe(expected);
    },
  );

  it('binds a persisted low to the normalized Medium option in the select variant', () => {
    const html = renderToStaticMarkup(
      <ThinkingLevelControl
        value="low"
        supportedLevels={['off', 'low', 'medium', 'high', 'xhigh', 'max']}
        onChange={(): void => undefined}
        variant="select"
      />,
    );

    expect(html).toContain(
      '<option value="medium" selected="">Medium</option>',
    );
    expect(html).not.toContain('value="low"');
  });

  it('keeps a persisted low selected in the opt-in select variant', () => {
    const html = renderToStaticMarkup(
      <ThinkingLevelControl
        value="low"
        supportedLevels={['off', 'low', 'medium', 'high', 'xhigh', 'max']}
        onChange={(): void => undefined}
        variant="select"
        includeLow
      />,
    );

    expect(html).toContain('<option value="low" selected="">Low</option>');
  });

  it('renders the project default in the cycle and select variants', () => {
    const cycleHtml = renderToStaticMarkup(
      <ThinkingLevelControl
        value={undefined}
        supportedLevels={FULL_LEVELS}
        onChange={(): void => undefined}
        allowWorkspaceDefault
      />,
    );
    const selectHtml = renderToStaticMarkup(
      <ThinkingLevelControl
        value={undefined}
        supportedLevels={FULL_LEVELS}
        onChange={(): void => undefined}
        variant="select"
        allowWorkspaceDefault
      />,
    );

    expect(cycleHtml).toContain('Thinking: Default; click to cycle');
    expect(selectHtml).toContain(
      '<option value="" selected="">Default</option>',
    );
  });
});

/**
 * Every level set a model in the app declares (package metadata and the
 * hosted catalog), read off the effort panel's slider stop by stop.
 */
describe('ThinkingLevelPanelPicker workspace defaults', () => {
  it('distinguishes inherited High from an explicit High selection', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const change = jest.fn();
    act(() =>
      root.render(
        <ThinkingLevelPanelPicker
          value="high"
          supportedLevels={['off', 'high']}
          allowWorkspaceDefault
          workspaceDefaultSelected
          onChange={change}
          testId="resolved-default"
        />,
      ),
    );
    try {
      const trigger = container.querySelector<HTMLButtonElement>('button');
      expect(trigger?.getAttribute('aria-label')).toBe(
        'Effort, current level High',
      );
      act(() => trigger?.click());
      const reset = document.querySelector<HTMLButtonElement>(
        '[data-testid="resolved-default-default"]',
      );
      expect(reset?.getAttribute('aria-pressed')).toBe('true');
      act(() => {
        document
          .querySelector('[role="slider"]')
          ?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
          );
      });
      expect(change).toHaveBeenCalledWith('high');
      act(() => reset?.click());
      expect(change.mock.calls).toEqual([['high'], [undefined]]);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it('clears the override through an opt-in Default action and keeps one trigger', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const change = jest.fn();
    act(() =>
      root.render(
        <ThinkingLevelPanelPicker
          value="low"
          supportedLevels={['off', 'low', 'high']}
          includeLow
          allowWorkspaceDefault
          onChange={change}
          testId="effort-default"
        />,
      ),
    );
    try {
      const trigger = container.querySelector<HTMLButtonElement>('button');
      expect(trigger?.getAttribute('aria-label')).toBe(
        'Effort, current level Low',
      );
      act(() => trigger?.click());
      const defaultButton = document.querySelector<HTMLButtonElement>(
        '[data-testid="effort-default-default"]',
      );
      expect(defaultButton).not.toBeNull();
      act(() => defaultButton?.click());
      expect(change).toHaveBeenCalledTimes(1);
      expect(change).toHaveBeenCalledWith(undefined);
      expect(
        container.querySelectorAll('[data-testid="effort-default"]'),
      ).toHaveLength(1);
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});

describe('ThinkingLevelPanelPicker level sets', () => {
  function PanelHarness({
    levels,
  }: {
    levels: readonly ThinkingLevel[];
  }): JSX.Element {
    const [value, setValue] = useState<ThinkingLevel | undefined>(levels[0]);
    return (
      <ThinkingLevelPanelPicker
        testId="effort"
        value={value}
        supportedLevels={levels}
        onChange={setValue}
        includeLow
      />
    );
  }

  function readStops(levels: readonly ThinkingLevel[]): string[] {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => root.render(<PanelHarness levels={levels} />));
    try {
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="effort"]')
          ?.click();
      });
      const slider =
        document.body.querySelector<HTMLElement>('[role="slider"]');
      if (!slider) throw new Error('effort slider not found');
      const press = (key: string): void => {
        act(() => {
          slider.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true }),
          );
        });
      };
      press('Home');
      const stops = [slider.getAttribute('aria-valuetext') ?? ''];
      const count = Number(slider.getAttribute('aria-valuemax')) + 1;
      for (let stop = 1; stop < count; stop += 1) {
        press('ArrowRight');
        stops.push(slider.getAttribute('aria-valuetext') ?? '');
      }
      return stops;
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  }

  it('lifts the slider knob off the track with the large shadow', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() => root.render(<PanelHarness levels={['off', 'high']} />));
    try {
      act(() => {
        container
          .querySelector<HTMLButtonElement>('[data-testid="effort"]')
          ?.click();
      });
      const knob =
        document.body.querySelector('[role="slider"]')?.lastElementChild;
      expect(knob?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['rounded-full', 'shadow-lg']),
      );
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  it.each<[string, readonly ThinkingLevel[], string[]]>([
    [
      'None to Ultra (Fable 5.1, Opus 5.5, Sonnet 5, GPT 6 Astra, GPT 6 Sol)',
      ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      ['None', 'Low', 'Medium', 'High', 'Extra High', 'Max', 'Ultra'],
    ],
    [
      'None to Max (Haiku 4.5, Opus 4.x, GPT 6 Luna, GPT 5.6)',
      ['off', 'low', 'medium', 'high', 'xhigh', 'max'],
      ['None', 'Low', 'Medium', 'High', 'Extra High', 'Max'],
    ],
    [
      'None to Extra High (GPT 5.5, Codex-Spark, DeepSeek, Kimi K2, GLM-5.2)',
      ['off', 'low', 'medium', 'high', 'xhigh'],
      ['None', 'Low', 'Medium', 'High', 'Extra High'],
    ],
    ['None and High (MiniMax M3)', ['off', 'high'], ['None', 'High']],
    [
      'None, Low, High and Max (GLM 5.3, GLM 5.3 Flash)',
      ['off', 'low', 'high', 'max'],
      ['None', 'Low', 'High', 'Max'],
    ],
    ['a set with no None', ['low', 'high', 'max'], ['Low', 'High', 'Max']],
  ])('offers every level: %s', (_name, levels, expected) => {
    expect(readStops(levels)).toEqual(expected);
  });
});

/**
 * Speed rides in the effort panel's corner bolt: off, Fast (accent), and,
 * where the host offers it, Ultra fast (the special purple). The trigger
 * leads with the bolt in the same hue while either is on.
 */
describe('ThinkingLevelPanelPicker speed', () => {
  function renderPanel(
    fastMode: { on: boolean; ultra?: boolean },
    onToggle: () => void = (): void => undefined,
  ): { container: HTMLElement; unmount: () => void } {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() =>
      root.render(
        <ThinkingLevelPanelPicker
          testId="effort"
          value="high"
          supportedLevels={FULL_LEVELS}
          onChange={(): void => undefined}
          fastMode={{ ...fastMode, onToggle }}
        />,
      ),
    );
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="effort"]')
        ?.click();
    });
    return {
      container,
      unmount: (): void => {
        act(() => root.unmount());
        container.remove();
      },
    };
  }

  const toggle = (): HTMLButtonElement | null =>
    document.body.querySelector<HTMLButtonElement>(
      '[data-testid="effort-fast-mode"]',
    );
  const triggerBolt = (container: HTMLElement): HTMLElement | null =>
    container.querySelector<HTMLElement>('[data-testid="effort-speed-bolt"]');

  it('keeps the Fast toggle in accent with a secondary trigger bolt', () => {
    const { container, unmount } = renderPanel({ on: true });
    try {
      expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
      expect(toggle()?.getAttribute('aria-label')).toBe('Fast mode');
      expect(toggle()?.className).toContain('fg-accent');
      expect(toggle()?.className).not.toContain('fg-special');
      expect(triggerBolt(container)?.className).toContain('fg-secondary');
      expect(
        container
          .querySelector('[data-testid="effort"]')
          ?.getAttribute('aria-label'),
      ).toBe('Effort, current level High, fast mode on');
    } finally {
      unmount();
    }
  });

  it('turns the toggle and the trigger bolt purple at Ultra fast', () => {
    const { container, unmount } = renderPanel({ on: true, ultra: true });
    try {
      expect(toggle()?.getAttribute('aria-pressed')).toBe('true');
      expect(toggle()?.getAttribute('aria-label')).toBe('Ultra fast mode');
      expect(toggle()?.className).toContain('fg-special');
      expect(toggle()?.className).toContain('bg-special-subtle');
      expect(toggle()?.className).not.toContain('fg-accent');
      expect(triggerBolt(container)?.className).toContain('fg-special');
      expect(
        container
          .querySelector('[data-testid="effort"]')
          ?.getAttribute('aria-label'),
      ).toBe('Effort, current level High, ultra fast mode on');
    } finally {
      unmount();
    }
  });

  it('leaves the host to choose the next speed', () => {
    const onToggle = jest.fn();
    const { unmount } = renderPanel({ on: true, ultra: true }, onToggle);
    try {
      act(() => toggle()?.click());
      expect(onToggle).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });
});

it('offers speed without inventing effort levels for a speed-only model', () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const toggle = jest.fn();
  const change = jest.fn();
  act(() =>
    root.render(
      <ThinkingLevelPanelPicker
        testId="speed-only"
        value={undefined}
        supportedLevels={[]}
        speedOnly
        allowWorkspaceDefault
        fastMode={{ on: false, onToggle: toggle }}
        onChange={change}
      />,
    ),
  );
  try {
    const trigger = container.querySelector<HTMLButtonElement>(
      '[data-testid="speed-only"]',
    );
    expect(trigger?.getAttribute('aria-label')).toBe(
      'Speed, current speed Regular',
    );
    act(() => trigger?.click());
    expect(document.querySelector('[role="slider"]')).toBeNull();
    expect(
      document.querySelector('[data-testid="speed-only-default"]'),
    ).toBeNull();
    act(() =>
      document
        .querySelector<HTMLButtonElement>(
          '[data-testid="speed-only-fast-mode"]',
        )
        ?.click(),
    );
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(change).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});

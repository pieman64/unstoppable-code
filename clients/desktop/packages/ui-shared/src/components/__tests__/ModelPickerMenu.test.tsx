/** @jest-environment jsdom */
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelCatalog, ModelCatalogOption } from '@canopy/protocol/models';
import { SECONDARY_SURFACE_SHELL_CLASS } from '../../lib/row-chips';
import {
  ModelPickerMenu,
  pickerChromeMenuHeightPx,
  type ModelPickerOptionState,
  type ModelPickerMenuProps,
} from '../ModelPickerMenu';
import { RichHoverTooltip } from '../RichHoverTooltip';
import { TooltipProvider } from '../tooltip-handoff';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const LONG_REASON =
  'Claude is not signed in on the desktop app, so this model cannot run ' +
  'until the desktop session is re-authenticated with the provider account.';

const CATALOG: ModelCatalog = [
  {
    id: 'claude-opus-test',
    label: 'Claude Opus Test',
    provider: 'claude',
    kind: 'model',
    available: true,
  },
];

function unavailableState(option: ModelCatalogOption): ModelPickerOptionState {
  return option.id === 'claude-opus-test'
    ? { disabled: true, unavailableReason: LONG_REASON }
    : { disabled: false };
}

function mountPicker(): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() =>
    root.render(
      <ModelPickerMenu
        catalog={CATALOG}
        onSelect={(): void => undefined}
        getOptionState={unavailableState}
      />,
    ),
  );
  return { container, root };
}

function queryByTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

/**
 * CAN-5213 — a row's state icon (lock or check) follows its label and is the
 * row's last marker, so the icons line up in one column at the row's end.
 */
function expectStateIconLast(
  optionId: string,
  icon: Element | null,
  label: Element | null,
): void {
  const row = document.querySelector(
    `[data-testid="model-option-${optionId}"]`,
  );
  expect(icon).not.toBeNull();
  expect(label).not.toBeNull();
  if (row === null || icon === null || label === null) return;
  expect(
    label.compareDocumentPosition(icon) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
  const markers = Array.from(
    row.querySelectorAll('[data-testid*="-extra-charge"], svg'),
  ).filter((node) => node.closest('[role="img"]') === null);
  expect(markers[markers.length - 1]).toBe(icon);
}

describe('pickerChromeMenuHeightPx', () => {
  it('sizes the shell to tabs and a divider with 1px gaps', () => {
    // 6 tabs and the 7px divider slot give 7 children and 6 gaps; the 4px
    // rail padding then sits under the last tab as beside it.
    expect(pickerChromeMenuHeightPx({ railTabCount: 6 })).toBe(
      8 + 6 * 36 + 7 + 6,
    );
  });
});

describe('ModelPickerMenu revealed unavailable reason', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('uses the host overflow anchor without rendering a duplicate trigger', () => {
    const anchor = document.createElement('button');
    document.body.append(anchor);
    const externalTriggerRef = { current: anchor };
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const onSelect = jest.fn();
    const render = (openSignal: number, disabled = false): void => {
      act(() =>
        root.render(
          <ModelPickerMenu
            catalog={CATALOG}
            onSelect={onSelect}
            externalTriggerRef={externalTriggerRef}
            openSignal={openSignal}
            disabled={disabled}
          />,
        ),
      );
    };
    render(0);
    expect(queryByTestId('model-picker')).toBeNull();
    expect(queryByTestId('model-menu')).toBeNull();
    render(1);
    expect(queryByTestId('model-menu')).not.toBeNull();
    act(() => queryByTestId('model-option-claude-opus-test')?.click());
    expect(onSelect).toHaveBeenCalledWith('claude-opus-test');
    render(2, true);
    expect(queryByTestId('model-menu')).toBeNull();
    act(() => root.unmount());
  });

  it('keeps the reason screen-reader-only inside a fixed-height row before reveal', () => {
    const { root } = mountPicker();
    act(() => queryByTestId('model-picker')?.click());

    const row = queryByTestId('model-option-claude-opus-test');
    const reason = queryByTestId('model-option-locked-claude');
    expect(row).not.toBeNull();
    expect(reason?.className).toContain('sr-only');
    expect(row?.className ?? '').toContain('h-8');
    expect(row?.className ?? '').not.toContain('!h-auto');

    act(() => root.unmount());
  });

  it('lets the row grow and renders the full reason unclipped once revealed', () => {
    const { root } = mountPicker();
    act(() => queryByTestId('model-picker')?.click());
    act(() => queryByTestId('model-option-claude-opus-test')?.click());

    const row = queryByTestId('model-option-claude-opus-test');
    const reason = queryByTestId('model-option-locked-claude');

    expect(reason?.textContent).toBe(LONG_REASON);
    expect(reason?.className).not.toContain('sr-only');
    expect(reason?.className).toContain('whitespace-normal');

    // The row must grow past the 32px option height: a floor, never a
    // fixed height...
    expect(row?.className.split(/\s+/)).toContain('min-h-8');
    expect(row?.className.split(/\s+/)).not.toContain('h-8');
    // ...and the content column must stop clipping overflow so the wrapped
    // reason text is fully visible rather than truncated.
    const content = reason?.parentElement;
    expect(content?.className ?? '').toContain('!overflow-visible');

    act(() => root.unmount());
  });
});

describe('ModelPickerMenu trigger provider fallback', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders a neutral icon without claiming a provider when none resolves', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu catalog={CATALOG} onSelect={(): void => undefined} />,
      ),
    );

    const icon = queryByTestId('model-picker-provider-icon');
    expect(icon).not.toBeNull();
    expect(icon?.getAttribute('data-provider')).toBeNull();
  });

  it('keeps the resolved provider icon when a provider hint is present', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={CATALOG}
          providerType="claude"
          onSelect={(): void => undefined}
        />,
      ),
    );

    expect(
      queryByTestId('model-picker-provider-icon')?.getAttribute(
        'data-provider',
      ),
    ).toBe('claude');
  });

  it('keeps the compact Claude icon at 16px when the capsule label truncates', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={CATALOG}
          currentModel="claude-opus-test"
          providerType="claude"
          variant="capsule"
          compactTrigger
          onSelect={(): void => undefined}
        />,
      ),
    );

    const icon = queryByTestId('model-picker-provider-icon');
    expect(icon?.getAttribute('data-app-icon')).toBe('true');
    expect(icon?.getAttribute('style')).toContain('width: 16px');
    expect(icon?.getAttribute('style')).toContain('height: 16px');
    expect(icon?.classList.contains('shrink-0')).toBe(true);

    const trigger = queryByTestId('model-picker');
    expect(trigger?.classList.contains('px-1')).toBe(true);
    expect(trigger?.classList.contains('gap-1')).toBe(true);
    // The capsule trigger keeps desktop's 32px on fine pointers and the 44px
    // coarse-pointer floor a phone or tablet needs (DESIGN.md tap targets).
    expect(trigger?.classList.contains('h-8')).toBe(true);
    expect(trigger?.classList.contains('pointer-coarse:min-h-11')).toBe(true);
    expect(trigger?.classList.contains('pointer-coarse:min-w-11')).toBe(true);
    expect(icon?.classList.contains('mr-0.5')).toBe(true);
    const caret = trigger?.querySelectorAll('[data-app-icon="true"]')[1];
    expect(caret?.classList.contains('shrink-0')).toBe(true);

    act(() => root.unmount());
  });

  it('keeps toolbar callers fixed unless flex shrinking is explicitly enabled', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);

    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={CATALOG}
          triggerLabelClassName="max-w-20"
          onSelect={(): void => undefined}
        />,
      ),
    );
    expect(container.firstElementChild?.classList.contains('shrink-0')).toBe(
      true,
    );
    expect(container.firstElementChild?.classList.contains('min-w-0')).toBe(
      false,
    );

    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={CATALOG}
          triggerLabelClassName="max-w-20"
          allowTriggerShrink
          onSelect={(): void => undefined}
        />,
      ),
    );
    expect(container.firstElementChild?.classList.contains('min-w-0')).toBe(
      true,
    );
    act(() => root.unmount());
  });

  it('truncates the trigger label itself so hosts only cap its width', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={CATALOG}
          currentModel="claude-opus-test"
          providerType="claude"
          variant="capsule"
          triggerLabelClassName="max-w-20 lg:max-w-none"
          onSelect={(): void => undefined}
        />,
      ),
    );

    const label = Array.from(
      queryByTestId('model-picker')?.querySelectorAll('span') ?? [],
    ).find((span) => span.textContent === 'Claude Opus Test');
    expect(label?.classList.contains('truncate')).toBe(true);
    expect(label?.classList.contains('min-w-0')).toBe(true);
    expect(label?.classList.contains('max-w-20')).toBe(true);

    act(() => root.unmount());
  });

  it('caps a long trigger label at 12rem when the host sets no width', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={CATALOG}
          currentModel="claude-opus-test"
          providerType="claude"
          variant="capsule"
          onSelect={(): void => undefined}
        />,
      ),
    );

    const label = Array.from(
      queryByTestId('model-picker')?.querySelectorAll('span') ?? [],
    ).find((span) => span.textContent === 'Claude Opus Test');
    expect(label?.classList.contains('max-w-48')).toBe(true);

    act(() => root.unmount());
  });
});

describe('ModelPickerMenu harness browser', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = '';
  });

  const harnessCatalog: ModelCatalog = [
    {
      id: 'hosted-deepseek',
      label: 'DeepSeek V4',
      provider: 'codex',
      source: 'ai-gateway',
      vendor: 'deepseek',
      kind: 'model',
      available: true,
    },
    {
      id: 'claude-opus',
      label: 'Claude Opus',
      provider: 'claude',
      source: 'claude',
      vendor: 'anthropic',
      kind: 'model',
      available: true,
    },
    {
      id: 'codex-pro',
      label: 'Codex Pro',
      provider: 'codex',
      source: 'codex',
      vendor: 'openai',
      kind: 'model',
      available: true,
    },
  ];

  function mountHarnessPicker(props: Partial<ModelPickerMenuProps> = {}): Root {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={harnessCatalog}
          onSelect={(): void => undefined}
          harnessTabs={{
            brandIcon: <span data-testid="test-brand-logo">U</span>,
            brandLabel: 'Test brand',
            gatewayLayout: 'harnesses',
            favoritesStorageKey: 'test:model-favorites',
          }}
          {...props}
        />,
      ),
    );
    act(() => queryByTestId('model-picker')?.click());
    return root;
  }

  it.each(['favorites', 'codex', 'all'])(
    'remembers the %s tab across picker remounts',
    (tab) => {
      const props: Partial<ModelPickerMenuProps> = {
        harnessTabs: {
          brandIcon: null,
          brandLabel: 'Test brand',
          allModelsTab: true,
          favoritesStorageKey: 'test:sticky-picker',
        },
      };
      const first = mountHarnessPicker(props);
      act(() => queryByTestId(`model-harness-tab-${tab}`)?.click());
      act(() => first.unmount());
      const second = mountHarnessPicker(props);
      try {
        expect(
          queryByTestId(`model-harness-tab-${tab}`)?.getAttribute(
            'aria-checked',
          ),
        ).toBe('true');
      } finally {
        act(() => second.unmount());
      }
    },
  );

  it('keeps a locked chat on its required tab without replacing the remembered tab', () => {
    window.localStorage.setItem('test:model-favorites:last-tab', 'favorites');
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: null,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites',
        initialTab: 'claude',
      },
    });
    try {
      expect(
        queryByTestId('model-harness-tab-claude')?.getAttribute('aria-checked'),
      ).toBe('true');
      act(() => queryByTestId('model-harness-tab-codex')?.click());
      act(() => queryByTestId('model-picker')?.click());
      act(() => queryByTestId('model-picker')?.click());
      expect(
        queryByTestId('model-harness-tab-claude')?.getAttribute('aria-checked'),
      ).toBe('true');
      expect(window.localStorage.getItem('test:model-favorites:last-tab')).toBe(
        'favorites',
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('falls back safely when the remembered tab is unavailable', () => {
    window.localStorage.setItem(
      'test:model-favorites:last-tab',
      'removed-provider',
    );
    const root = mountHarnessPicker();
    try {
      expect(
        queryByTestId('model-harness-tab-favorites')?.getAttribute(
          'aria-checked',
        ),
      ).toBe('true');
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps the clicked tab usable when storage is blocked', () => {
    const read = jest
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => {
        throw new Error('Storage blocked');
      });
    const write = jest
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => {
        throw new Error('Storage blocked');
      });
    const root = mountHarnessPicker();
    try {
      act(() => queryByTestId('model-harness-tab-favorites')?.click());
      act(() => queryByTestId('model-picker')?.click());
      act(() => queryByTestId('model-picker')?.click());
      expect(
        queryByTestId('model-harness-tab-favorites')?.getAttribute(
          'aria-checked',
        ),
      ).toBe('true');
    } finally {
      act(() => root.unmount());
      read.mockRestore();
      write.mockRestore();
    }
  });

  it('sizes rail glyphs at 18px, row glyphs at 14px and section marks at 12px', () => {
    const root = mountHarnessPicker({
      autoModeOption: {
        id: 'lab-auto',
        label: 'Auto',
        provider: 'claude',
        kind: 'model',
        available: true,
      },
      harnessTabs: {
        brandIcon: null,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-glyph-size',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
        leadingFavorites: true,
        chrome: 'picker',
        initialTab: 'claude',
        runnableHarnesses: [
          { id: 'claude', connected: true },
          { id: 'codex', connected: true },
          { id: 'opencode', connected: true },
        ],
      },
    });
    try {
      const widthsOf = (selector: string): string[] =>
        Array.from(document.querySelectorAll(`${selector} svg`)).map(
          (svg) => svg.getAttribute('width') ?? '',
        );
      const rail = widthsOf('[data-testid^="model-harness-tab-"]');
      const stars = widthsOf('[data-testid^="model-favorite-"]');
      const providers = widthsOf('[data-testid^="model-harness-icon-"]');
      const header = widthsOf('[data-testid^="model-group-icon-"]');
      expect(rail).toHaveLength(5);
      expect(stars.length).toBeGreaterThan(0);
      expect(providers.length).toBeGreaterThan(0);
      expect(header.length).toBeGreaterThan(0);
      const search = queryByTestId('model-search')
        ?.parentElement?.querySelector('svg')
        ?.getAttribute('width');
      const auto = queryByTestId('model-option-lab-auto')
        ?.querySelector('svg')
        ?.getAttribute('width');
      // Rail tabs, Lucide and provider marks alike, share one 18px box.
      expect(new Set(rail)).toEqual(new Set(['18px']));
      // Search, Auto and row glyphs (stars, provider marks) sit at 14px.
      expect(new Set([...stars, ...providers, search, auto])).toEqual(
        new Set(['14px']),
      );
      // Section headers keep their small 12px mark beside the label.
      expect(new Set(header)).toEqual(new Set(['12px']));
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps Lucide-backed section marks at 12px', () => {
    const root = mountHarnessPicker({
      catalog: [
        ...harnessCatalog,
        {
          id: 'opencode-big-pickle',
          label: 'Big Pickle',
          provider: 'opencode',
          source: 'opencode',
          vendor: 'opencode',
          kind: 'model',
          available: true,
        },
      ],
      harnessTabs: {
        brandIcon: null,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-section-marks',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
        leadingFavorites: true,
        chrome: 'picker',
        initialTab: 'all',
        runnableHarnesses: [
          { id: 'claude', connected: true },
          { id: 'codex', connected: true },
          { id: 'opencode', connected: true },
        ],
      },
    });
    try {
      const marks = Array.from(
        document.querySelectorAll('[data-testid^="model-group-icon-"] svg'),
      );
      expect(
        marks.some((svg) => svg.getAttribute('data-glyph') === 'terminal'),
      ).toBe(true);
      expect(new Set(marks.map((svg) => svg.getAttribute('width')))).toEqual(
        new Set(['12px']),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('puts Auto at the end of the search row as a toggle', () => {
    const autoModeOption: ModelCatalogOption = {
      id: 'lab-auto',
      label: 'Auto',
      provider: 'claude',
      kind: 'model',
      available: true,
    };
    const harnessTabs: ModelPickerMenuProps['harnessTabs'] = {
      brandIcon: <span>U</span>,
      brandLabel: 'Test brand',
      favoritesStorageKey: 'test:model-favorites-auto-toggle',
      gatewayLayout: 'harnesses',
      allModelsTab: true,
      chrome: 'picker',
    };
    const onSelect = jest.fn();
    const root = mountHarnessPicker({ autoModeOption, harnessTabs, onSelect });
    try {
      const toggle = queryByTestId('model-option-lab-auto');
      expect(toggle?.tagName).toBe('BUTTON');
      expect(toggle?.getAttribute('aria-pressed')).toBe('false');
      expect(toggle?.getAttribute('aria-label')).toBe('Auto');
      // Off, Auto keeps the accent ink with no surface, so it reads as an
      // option to turn on rather than a muted control.
      expect(toggle?.className.split(/\s+/)).toContain('fg-accent');
      expect(toggle?.className).not.toContain('bg-accent-subtle');
      // Named on screen, and 8px from the search row's right edge as from
      // its top and bottom.
      expect(toggle?.textContent).toBe('Auto');
      expect(toggle?.closest('.h-9')?.className.split(/\s+/)).toContain('pr-2');
      // The same row as the search field, and no Auto row or divider below.
      expect(
        queryByTestId('model-search')?.parentElement?.parentElement?.contains(
          toggle,
        ),
      ).toBe(true);
      expect(queryByTestId('model-auto-divider')).toBeNull();
      // Searching is about models: Auto steps aside while a query is typed.
      const search = queryByTestId('model-search') as HTMLInputElement;
      const typeSearch = (value: string): void => {
        act(() => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set?.call(search, value);
          search.dispatchEvent(new Event('input', { bubbles: true }));
        });
      };
      typeSearch('cl');
      expect(queryByTestId('model-option-lab-auto')).toBeNull();
      typeSearch('');
      act(() => queryByTestId('model-option-lab-auto')?.click());
      expect(onSelect).toHaveBeenCalledWith('lab-auto');
    } finally {
      act(() => root.unmount());
    }
    const onSelectAgain = jest.fn();
    const selected = mountHarnessPicker({
      autoModeOption,
      harnessTabs,
      currentModel: 'lab-auto',
      onSelect: onSelectAgain,
    });
    try {
      const pressed = queryByTestId('model-option-lab-auto');
      expect(pressed?.getAttribute('aria-pressed')).toBe('true');
      // Auto is already on: clicking it changes nothing and keeps the
      // picker open.
      act(() => pressed?.click());
      expect(onSelectAgain).not.toHaveBeenCalled();
      expect(queryByTestId('model-menu')).not.toBeNull();
    } finally {
      act(() => selected.unmount());
    }
  });

  it('colors only the highlighted selection icon for Auto and each vendor', () => {
    const autoModeOption: ModelCatalogOption = {
      id: 'lab-auto',
      label: 'Auto',
      provider: 'claude',
      kind: 'model',
      available: true,
    };
    const catalog: ModelCatalog = [
      ...harnessCatalog,
      ...[
        ['moonshot', 'moonshot'],
        ['minimax', 'minimax'],
        ['zai', 'zai'],
      ].map(([id, vendor]) => ({
        id: `hosted-${id}`,
        label: id,
        provider: 'codex' as const,
        source: 'ai-gateway' as const,
        vendor,
        kind: 'model' as const,
        available: true,
      })),
    ];
    for (const [modelId, color] of [
      ['lab-auto', 'var(--fg-accent)'],
      ['claude-opus', 'rgb(217, 119, 87)'],
      ['codex-pro', 'var(--fg-primary)'],
      ['hosted-deepseek', 'rgb(87, 134, 254)'],
      ['hosted-moonshot', 'rgb(0, 124, 255)'],
      ['hosted-minimax', 'rgb(255, 100, 82)'],
      ['hosted-zai', 'var(--fg-primary)'],
    ]) {
      const root = mountHarnessPicker({
        catalog,
        currentModel: modelId,
        autoModeOption,
        highlightSelection: true,
        harnessTabs: {
          brandIcon: <span>U</span>,
          brandLabel: 'Test brand',
          favoritesStorageKey: 'test:model-favorites-colors',
          gatewayLayout: 'harnesses',
          allModelsTab: true,
          chrome: 'picker',
        },
      });
      if (modelId === 'lab-auto') {
        // Auto is the search row's toggle: pressed, on the accent surface.
        const toggle = queryByTestId('model-option-lab-auto');
        expect(toggle?.getAttribute('aria-pressed')).toBe('true');
        expect(toggle?.classList.contains('fg-accent')).toBe(true);
      } else {
        const icon = queryByTestId(`model-option-${modelId}`)?.querySelector(
          'svg',
        )?.parentElement;
        expect(icon?.style.color).toBe(color);
      }
      expect(
        queryByTestId('model-option-claude-opus')?.querySelector('svg')
          ?.parentElement?.style.color,
      ).toBe(modelId === 'claude-opus' ? 'rgb(217, 119, 87)' : '');
      if (modelId !== 'claude-opus') {
        expect(
          queryByTestId('model-option-claude-opus')
            ?.querySelector('svg')
            ?.parentElement?.classList.contains('fg-tertiary'),
        ).toBe(true);
      }
      act(() => root.unmount());
      document.body.innerHTML = '';
    }
  });

  it('keeps typing and caret navigation in the search field', () => {
    const root = mountHarnessPicker();
    const search = queryByTestId('model-search') as HTMLInputElement;
    act(() => search.focus());
    for (const key of ['c', 'Home', 'End']) {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        search.dispatchEvent(event);
      });
      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(search);
    }
    act(() => root.unmount());
  });

  it('allows returning a configured model to the workspace default', () => {
    const onSelectWorkspaceDefault = jest.fn();
    const root = mountHarnessPicker({
      currentModel: 'claude-opus',
      allowWorkspaceDefault: true,
      workspaceDefaultLabel: 'Workspace default',
      onSelectWorkspaceDefault,
    });
    const defaultRow = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((row) => row.textContent?.includes('Workspace default'));
    expect(defaultRow).toBeDefined();
    act(() => defaultRow?.click());
    expect(onSelectWorkspaceDefault).toHaveBeenCalledTimes(1);
    expect(queryByTestId('model-menu')).toBeNull();
    act(() => root.unmount());
  });

  it('switches harness tabs and fuzzy-searches every harness', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        gatewayLayout: 'harnesses',
        favoritesStorageKey: 'test:model-favorites',
        runnableHarnesses: [
          { id: 'claude', connected: true },
          { id: 'codex', connected: true },
        ],
        supportedModelIds: { codex: ['hosted-deepseek'] },
      },
    });
    const claude = queryByTestId('model-option-claude-opus');
    expect(claude?.closest('[hidden]')).toBeNull();
    expect(
      queryByTestId('model-option-codex-pro')?.closest('[hidden]'),
    ).not.toBeNull();

    act(() => queryByTestId('model-harness-tab-codex')?.click());
    expect(
      queryByTestId('model-option-codex-pro')?.closest('[hidden]'),
    ).toBeNull();
    expect(
      queryByTestId('model-option-hosted-deepseek')?.closest('[hidden]'),
    ).toBeNull();
    expect(
      queryByTestId('model-option-claude-opus')?.closest('[hidden]'),
    ).not.toBeNull();

    const search = queryByTestId('model-search') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(search, 'cdx');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const visibleIds = Array.from(
      document.querySelectorAll<HTMLElement>('[data-model-id]'),
    )
      .filter((row) => row.closest('[hidden]') === null)
      .map((row) => row.dataset.modelId);
    expect(visibleIds).toEqual(['codex-pro']);
    expect(
      queryByTestId('model-harness-tab-claude')?.closest('nav')?.className,
    ).toContain('opacity-0');
    act(() => root.unmount());
  });

  it.each(['stored', 'default'])(
    'resolves %s favorite aliases without losing route order or unknown keys',
    (source) => {
      const saved = [
        'copilot::old-account',
        'codex::codex-pro',
        'copilot::claude-opus',
        'opencode::old-open',
        'copilot::unknown-model',
      ];
      if (source === 'stored')
        localStorage.setItem('test:model-favorites', JSON.stringify(saved));
      const harnessTabs = {
        brandIcon: null,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites',
        defaultFavorites: source === 'default' ? saved : undefined,
        favoriteModelAliases: new Map([
          ['old-account', 'claude-opus'],
          ['old-open', 'claude-opus'],
          ['unknown-model', 'missing-target'],
        ]),
        supportedModelIds: {
          copilot: ['claude-opus'],
          opencode: ['claude-opus'],
        },
      };
      const root = mountHarnessPicker({ harnessTabs });
      try {
        act(() => queryByTestId('model-harness-tab-favorites')?.click());
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>('[data-model-id]'),
        ).filter((row) => !row.closest('[hidden]'));
        expect(rows.map((row) => row.dataset.modelId)).toEqual([
          'claude-opus',
          'codex-pro',
          'claude-opus',
        ]);
        expect(localStorage.getItem('test:model-favorites')).toBe(
          source === 'stored' ? JSON.stringify(saved) : null,
        );
        const star = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[data-testid="model-favorite-claude-opus"]',
          ),
        ).find((element) => !element.closest('[hidden]'));
        expect(star).toBeDefined();
        act(() => star?.click());
        expect(
          JSON.parse(localStorage.getItem('test:model-favorites') ?? '[]'),
        ).toEqual([
          'codex::codex-pro',
          'opencode::claude-opus',
          'copilot::unknown-model',
        ]);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it.each(['cursor', 'copilot', 'opencode'] as const)(
    'disables an aliased %s favorite when its account stops offering the model',
    (harness) => {
      localStorage.setItem(
        'test:model-favorites',
        JSON.stringify([`${harness}::old-account`]),
      );
      const onSelect = jest.fn();
      const harnessTabs = {
        brandIcon: null,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites',
        favoriteModelAliases: new Map([['old-account', 'claude-opus']]),
        supportedModelIds: { [harness]: ['claude-opus'] },
      };
      const root = mountHarnessPicker({ harnessTabs, onSelect });
      try {
        act(() => queryByTestId('model-harness-tab-favorites')?.click());
        expect(
          queryByTestId('model-option-claude-opus')?.getAttribute(
            'aria-disabled',
          ),
        ).not.toBe('true');
        act(() =>
          root.render(
            <ModelPickerMenu
              catalog={harnessCatalog}
              harnessTabs={{
                ...harnessTabs,
                supportedModelIds: { [harness]: [] },
              }}
              onSelect={onSelect}
            />,
          ),
        );
        const row = queryByTestId('model-option-claude-opus');
        expect(row).not.toBeNull();
        expect(row?.getAttribute('aria-disabled')).toBe('true');
        act(() => row?.click());
        expect(onSelect).not.toHaveBeenCalled();
        expect(document.body.textContent).toContain(
          'Choose another account or model',
        );
        act(() =>
          root.render(
            <ModelPickerMenu
              catalog={harnessCatalog}
              harnessTabs={harnessTabs}
              onSelect={onSelect}
            />,
          ),
        );
        expect(
          queryByTestId('model-option-claude-opus')?.getAttribute(
            'aria-disabled',
          ),
        ).not.toBe('true');
        act(() => queryByTestId('model-option-claude-opus')?.click());
        expect(onSelect).toHaveBeenCalledWith('claude-opus', { harness });
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it.each(['cursor', 'copilot', 'opencode'] as const)(
    'does not bypass a missing %s favorite route through credits',
    (harness) => {
      localStorage.setItem(
        'test:model-favorites',
        JSON.stringify([`${harness}::claude-opus`]),
      );
      const onSelect = jest.fn();
      const onCreditsSelect = jest.fn();
      const root = mountHarnessPicker({
        onSelect,
        harnessTabs: {
          brandIcon: null,
          brandLabel: 'Test brand',
          favoritesStorageKey: 'test:model-favorites',
          supportedModelIds: { [harness]: [] },
          billing: {
            modelIds: new Set(['claude-opus']),
            getPreference: () => ({ payment: 'credits', fallback: false }),
            onChange: jest.fn(),
          },
          credits: {
            modelIds: new Set(['claude-opus']),
            getOptionState: () => ({ disabled: false }),
            onSelect: onCreditsSelect,
          },
        },
      });
      try {
        act(() => queryByTestId('model-harness-tab-favorites')?.click());
        const row = queryByTestId('model-option-claude-opus');
        expect(row).not.toBeNull();
        expect(row?.getAttribute('aria-disabled')).toBe('true');
        act(() => row?.click());
        expect(onSelect).not.toHaveBeenCalled();
        expect(onCreditsSelect).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('resolves saved aliases when catalog mapping arrives after the picker mounts', () => {
    localStorage.setItem(
      'test:model-favorites',
      JSON.stringify(['copilot::old-account']),
    );
    const harnessTabs = {
      brandIcon: null,
      brandLabel: 'Test brand',
      favoritesStorageKey: 'test:model-favorites',
      supportedModelIds: { copilot: ['claude-opus'] },
    };
    const onSelect = jest.fn();
    const root = mountHarnessPicker({ harnessTabs, onSelect });
    try {
      act(() => queryByTestId('model-harness-tab-favorites')?.click());
      expect(queryByTestId('model-favorites-empty')).not.toBeNull();
      const mapped = {
        ...harnessTabs,
        favoriteModelAliases: new Map([['old-account', 'claude-opus']]),
      };
      act(() =>
        root.render(
          <ModelPickerMenu
            catalog={harnessCatalog}
            harnessTabs={mapped}
            onSelect={onSelect}
          />,
        ),
      );
      const row = queryByTestId('model-option-claude-opus');
      expect(row).not.toBeNull();
      act(() => row?.click());
      expect(onSelect).toHaveBeenCalledWith('claude-opus', {
        harness: 'copilot',
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps favorites in the order they were first starred', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        gatewayLayout: 'harnesses',
        favoritesStorageKey: 'test:model-favorites',
        supportedModelIds: { codex: ['hosted-deepseek'] },
      },
    });
    act(() => queryByTestId('model-favorite-claude-opus')?.click());
    expect(queryByTestId('model-favorite-claude-opus')?.classList).toContain(
      'fg-tertiary',
    );
    act(() => queryByTestId('model-harness-tab-codex')?.click());
    act(() => queryByTestId('model-favorite-hosted-deepseek')?.click());
    act(() => queryByTestId('model-harness-tab-favorites')?.click());

    const visibleIds = Array.from(
      document.querySelectorAll<HTMLElement>('[data-model-id]'),
    )
      .filter((row) => row.closest('[hidden]') === null)
      .map((row) => row.dataset.modelId);
    expect(visibleIds).toEqual(['claude-opus', 'hosted-deepseek']);
    expect(window.localStorage.getItem('test:model-favorites')).toBe(
      '["claude::claude-opus","codex::hosted-deepseek"]',
    );
    act(() => root.unmount());
  });

  it.each(['cursor', 'ollama'] as const)(
    'lists %s models on their own tab without hosted billing',
    (provider) => {
      const onSelect = jest.fn();
      const id = `${provider}-model`;
      const tab = provider;
      const root = mountHarnessPicker({
        catalog: [
          ...harnessCatalog,
          {
            id,
            label: 'Native model',
            provider,
            kind: 'model',
            available: true,
          },
        ],
        onSelect,
      });
      try {
        const row = queryByTestId(`model-option-${id}`);
        expect(row).not.toBeNull();
        expect(row?.closest('[hidden]')).not.toBeNull();
        expect(
          row?.querySelector('[data-testid="test-brand-logo"]'),
        ).toBeNull();
        act(() => queryByTestId(`model-harness-tab-${tab}`)?.click());
        expect(
          queryByTestId(`model-option-${id}`)?.closest('[hidden]'),
        ).toBeNull();
        act(() => queryByTestId(`model-favorite-${id}`)?.click());
        act(() => queryByTestId('model-harness-tab-favorites')?.click());
        expect(
          queryByTestId(`model-option-${id}`)?.closest('[hidden]'),
        ).toBeNull();
        expect(
          queryByTestId(`model-option-${id}`)?.querySelector(
            '[data-testid="test-brand-logo"]',
          ),
        ).toBeNull();
        act(() => queryByTestId(`model-option-${id}`)?.click());
        expect(onSelect).toHaveBeenCalledWith(id);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('keys an Ollama favorite by its own tab in All and on the Ollama tab', () => {
    const storageKey = 'test:model-favorites-ollama-all';
    window.localStorage.setItem(storageKey, JSON.stringify([]));
    const root = mountHarnessPicker({
      catalog: [
        ...harnessCatalog,
        {
          id: 'ollama-llama3',
          label: 'Llama 3',
          provider: 'ollama',
          source: 'ollama',
          // Ollama models execute on the Codex harness.
          harness: 'codex',
          kind: 'model',
          available: true,
        },
      ],
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: storageKey,
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
        leadingFavorites: true,
        runnableHarnesses: [
          { id: 'claude', connected: true },
          { id: 'codex', connected: true },
        ],
      },
    });
    const visibleStar = (): HTMLElement | undefined =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="model-favorite-ollama-llama3"]',
        ),
      ).find((node) => node.closest('[hidden]') === null);
    try {
      act(() => queryByTestId('model-harness-tab-all')?.click());
      act(() => visibleStar()?.click());
      expect(
        JSON.parse(window.localStorage.getItem(storageKey) ?? '[]'),
      ).toEqual(['ollama::ollama-llama3']);
      act(() => queryByTestId('model-harness-tab-ollama')?.click());
      expect(visibleStar()?.getAttribute('aria-checked')).toBe('true');
    } finally {
      act(() => root.unmount());
    }
  });

  it('un-stars from Favorites a model starred on the Ollama tab', () => {
    const storageKey = 'test:model-favorites-ollama-roundtrip';
    window.localStorage.setItem(storageKey, JSON.stringify([]));
    const root = mountHarnessPicker({
      catalog: [
        ...harnessCatalog,
        {
          id: 'ollama-llama3',
          label: 'Llama 3',
          provider: 'ollama',
          source: 'ollama',
          kind: 'model',
          available: true,
        },
      ],
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: storageKey,
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
        leadingFavorites: true,
        runnableHarnesses: [
          { id: 'claude', connected: true },
          { id: 'codex', connected: true },
        ],
      },
    });
    const visibleStar = (): HTMLElement | undefined =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="model-favorite-ollama-llama3"]',
        ),
      ).find((node) => node.closest('[hidden]') === null);
    try {
      act(() => queryByTestId('model-harness-tab-ollama')?.click());
      act(() => visibleStar()?.click());
      expect(
        JSON.parse(window.localStorage.getItem(storageKey) ?? '[]'),
      ).toEqual(['ollama::ollama-llama3']);
      act(() => queryByTestId('model-harness-tab-favorites')?.click());
      act(() => visibleStar()?.click());
      expect(
        JSON.parse(window.localStorage.getItem(storageKey) ?? '[]'),
      ).toEqual([]);
    } finally {
      act(() => root.unmount());
    }
  });

  it('lists and searches Ollama models in the harness picker', () => {
    const root = mountHarnessPicker({
      catalog: [
        ...harnessCatalog,
        {
          id: 'ollama-llama3',
          label: 'Llama 3',
          provider: 'ollama',
          source: 'ollama',
          kind: 'model',
          available: true,
        },
      ],
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-ollama',
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
        runnableHarnesses: [
          { id: 'claude', connected: true },
          { id: 'codex', connected: true },
        ],
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-ollama')?.click());
      expect(
        queryByTestId('model-option-ollama-llama3')?.closest('[hidden]'),
      ).toBeNull();

      const search = queryByTestId('model-search');
      if (!(search instanceof HTMLInputElement)) {
        throw new Error('Search input not found');
      }
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(search, 'llama');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(queryByTestId('model-search-empty')).toBeNull();
      expect(
        queryByTestId('model-option-ollama-llama3')?.closest('[hidden]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(['ollama', 'other'] as const)(
    'removes a %s model from Favorites using its stored harness key',
    (tab) => {
      const id = `${tab}-favorite`;
      const storageKey = `test:model-favorites-${tab}-roundtrip`;
      const root = mountHarnessPicker({
        catalog: [
          ...harnessCatalog,
          {
            id,
            label: `${tab} favorite`,
            provider: tab === 'other' ? 'unknown' : 'ollama',
            kind: 'model',
            available: true,
          },
        ],
        harnessTabs: {
          brandIcon: <span>U</span>,
          brandLabel: 'Test brand',
          favoritesStorageKey: storageKey,
          gatewayLayout: 'harnesses',
          leadingFavorites: true,
        },
      });
      try {
        act(() => queryByTestId(`model-harness-tab-${tab}`)?.click());
        act(() => queryByTestId(`model-favorite-${id}`)?.click());
        expect(window.localStorage.getItem(storageKey)).toBe(
          `["${tab}::${id}"]`,
        );

        act(() => queryByTestId('model-harness-tab-favorites')?.click());
        const favorite = queryByTestId(`model-favorite-${id}`);
        expect(favorite?.getAttribute('aria-label')).toBe(
          `Remove ${tab} favorite from favorites`,
        );
        act(() => favorite?.click());
        expect(window.localStorage.getItem(storageKey)).toBe('[]');
        expect(queryByTestId('model-favorites-empty')).not.toBeNull();
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('opens the harness picker from its trigger with the arrow keys', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-trigger-arrows',
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
      },
    });
    try {
      // The mount helper opened it by click; close it and use the keyboard.
      act(() => queryByTestId('model-picker')?.click());
      expect(queryByTestId('model-menu')).toBeNull();
      const trigger = queryByTestId('model-picker');
      act(() => {
        trigger?.focus();
        trigger?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      });
      expect(queryByTestId('model-menu')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('moves between visible rows with the arrow keys in the harness picker', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-arrows',
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
        runnableHarnesses: [
          { id: 'claude', connected: true },
          { id: 'codex', connected: true },
        ],
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-all')?.click());
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>('[data-model-id]'),
      ).filter((row) => row.closest('[hidden]') === null);
      expect(rows.length).toBeGreaterThan(1);
      const press = (key: string): void => {
        act(() => {
          document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true }),
          );
        });
      };
      act(() => rows[0]?.focus());
      press('ArrowDown');
      expect(document.activeElement).toBe(rows[1]);
      press('ArrowUp');
      expect(document.activeElement).toBe(rows[0]);
      // Above the first row is the search field the list was entered from.
      press('ArrowUp');
      expect(document.activeElement).toBe(queryByTestId('model-search'));
    } finally {
      act(() => root.unmount());
    }
  });

  it('only offers extra provider tabs when their catalog rows are present', () => {
    const root = mountHarnessPicker();
    for (const tab of ['cursor', 'ollama', 'other']) {
      expect(queryByTestId(`model-harness-tab-${tab}`)).toBeNull();
    }
    act(() => root.unmount());
  });

  it('centers an empty Favorites tab like a disconnected harness', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        gatewayLayout: 'harnesses',
        favoritesStorageKey: 'test:model-favorites-empty',
        chrome: 'picker',
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-favorites')?.click());
      const empty = queryByTestId('model-favorites-empty');
      expect(empty?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['flex-1', 'justify-center', 'pb-3']),
      );
      expect(empty?.textContent).toContain('Star models for quick access');
      // Text only, no illustration.
      expect(empty?.querySelector('svg')).toBeNull();
      // Same ink and size as the search's No models match.
      expect(empty?.querySelector('p')?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['text-s', 'fg-tertiary']),
      );
      expect(queryByTestId('model-connect-prompt')).toBeNull();
      expect(document.querySelector('.canopy-picker-menu-list')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('centers unmatched search as plain grey text', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        gatewayLayout: 'harnesses',
        favoritesStorageKey: 'test:model-search-empty',
        chrome: 'picker',
      },
    });
    try {
      const search = queryByTestId('model-search') as HTMLInputElement;
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(search, 'zzz-no-such-model');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const empty = queryByTestId('model-search-empty');
      expect(empty?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['flex-1', 'justify-center', 'pb-3']),
      );
      expect(empty?.textContent).toBe('No models match');
      expect(empty?.textContent).not.toContain('your search');
      // Plain grey text, no illustration.
      expect(empty?.querySelector('svg')).toBeNull();
      expect(empty?.querySelector('p')?.className.split(/\s+/)).toContain(
        'fg-tertiary',
      );
      expect(document.querySelector('.canopy-picker-menu-list')).toBeNull();
      expect(queryByTestId('model-favorites-empty')).toBeNull();
      expect(queryByTestId('model-connect-prompt')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('prompts to connect a harness that is listed but not connected', () => {
    const onConnectHarness = jest.fn();
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        gatewayLayout: 'harnesses',
        favoritesStorageKey: 'test:model-favorites-connect',
        chrome: 'picker',
        onConnectHarness,
        runnableHarnesses: [
          { id: 'claude', connected: true },
          { id: 'cursor', connected: false },
          { id: 'ollama', connected: false },
        ],
      },
    });
    try {
      const cursor = queryByTestId('model-harness-tab-cursor');
      expect(cursor).not.toBeNull();
      expect(cursor?.className).toContain('fg-quaternary');
      expect(cursor?.className).toContain('hover:bg-subtle');
      expect(cursor?.className).not.toContain('hover:fg-primary');
      expect(cursor?.className).not.toContain('opacity-40');
      act(() => cursor?.click());
      expect(cursor?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['bg-quaternary', 'shadow-sm', 'fg-quaternary']),
      );
      expect(cursor?.className).not.toContain('fg-primary');
      expect(cursor?.className).not.toContain('opacity-40');
      const prompt = queryByTestId('model-connect-prompt');
      expect(prompt?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['flex-1', 'justify-center', 'w-full', 'pb-5']),
      );
      const emptyState = prompt?.firstElementChild;
      // inset="none": the host centers it, so no page-level vertical inset.
      expect(emptyState?.className.split(/\s+/)).not.toContain('py-16');
      // spacing="relaxed": a wider gap between the icon and the title.
      expect(emptyState?.firstElementChild?.className.split(/\s+/)).toContain(
        'mb-3',
      );
      expect(prompt?.textContent).toContain('Connect Cursor in Settings');
      const promptTitle = prompt?.querySelector('h3');
      expect(promptTitle?.className.split(/\s+/)).toContain('text-s');
      expect(promptTitle?.className.split(/\s+/)).toContain('font-normal');
      expect(promptTitle?.className.split(/\s+/)).not.toContain('font-medium');
      expect(prompt?.textContent).not.toContain(
        'Models appear here after you connect it in Settings.',
      );
      expect(prompt?.querySelector('svg')).not.toBeNull();
      const connect = queryByTestId('model-connect-harness');
      expect(connect?.textContent).toBe('Open settings');
      act(() => connect?.click());
      expect(onConnectHarness).toHaveBeenCalledWith('cursor');
      // Settings takes over the screen, so the picker closes.
      expect(queryByTestId('model-menu')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  describe('connect rows for harnesses that are not connected', () => {
    type HarnessTabs = NonNullable<ModelPickerMenuProps['harnessTabs']>;
    const connectRowsTabs = (
      overrides: Partial<HarnessTabs> = {},
    ): HarnessTabs => ({
      brandIcon: <span data-testid="test-brand-logo">U</span>,
      brandLabel: 'Test brand',
      gatewayLayout: 'harnesses',
      favoritesStorageKey: 'test:model-favorites-connect-rows',
      chrome: 'picker',
      allModelsTab: true,
      onConnectHarness: jest.fn(),
      runnableHarnesses: [
        { id: 'claude', connected: true },
        { id: 'codex', connected: false, connectVia: 'sign-in' },
        { id: 'cursor', connected: false },
        { id: 'copilot', connected: false },
      ],
      ...overrides,
    });
    const search = (value: string): void => {
      const field = queryByTestId('model-search');
      if (!(field instanceof HTMLInputElement)) throw new Error('no search');
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(field, value);
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
    };
    const connectRowIds = (): string[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-connect-harness]'),
      ).map((row) => row.dataset.connectHarness ?? '');
    const press = (key: string): void => {
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
      });
    };
    const visibleModelRows = (): HTMLElement[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>('[data-model-id]'),
      ).filter((row) => row.closest('[hidden]') === null);

    it('ends All with one row per disconnected harness in rail order', () => {
      const root = mountHarnessPicker({ harnessTabs: connectRowsTabs() });
      try {
        act(() => queryByTestId('model-harness-tab-all')?.click());
        const section = queryByTestId('model-connect-section');
        expect(section).not.toBeNull();
        expect(section?.getAttribute('aria-label')).toBe(
          'Bring your subscription',
        );
        expect(section?.textContent).toContain('Bring your subscription');
        const modelRows = visibleModelRows();
        expect(modelRows.length).toBeGreaterThan(0);
        for (const row of modelRows) {
          expect(
            row.compareDocumentPosition(section ?? document.body) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy();
        }
        expect(connectRowIds()).toEqual(['codex', 'cursor', 'copilot']);
        expect(queryByTestId('model-connect-row-claude')).toBeNull();
        // Model groups precede it, so a hairline separates it.
        expect(section?.className.split(/\s+/)).toEqual(
          expect.arrayContaining(['border-t', 'mt-2', 'pt-2']),
        );
      } finally {
        act(() => root.unmount());
      }
    });

    it('renders no section without a connect action', () => {
      const root = mountHarnessPicker({
        harnessTabs: connectRowsTabs({ onConnectHarness: undefined }),
      });
      try {
        act(() => queryByTestId('model-harness-tab-all')?.click());
        expect(queryByTestId('model-connect-section')).toBeNull();
        search('cursor');
        expect(queryByTestId('model-search-empty')).not.toBeNull();
        expect(connectRowIds()).toEqual([]);
      } finally {
        act(() => root.unmount());
      }
    });

    it('renders no section when every harness is connected', () => {
      const root = mountHarnessPicker({
        harnessTabs: connectRowsTabs({
          runnableHarnesses: [
            { id: 'claude', connected: true },
            { id: 'codex', connected: true },
          ],
        }),
      });
      try {
        act(() => queryByTestId('model-harness-tab-all')?.click());
        expect(queryByTestId('model-connect-section')).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    });

    it.each([
      ['the hosted-model status', true],
      ['nothing', false],
    ] as const)(
      'divides the All section only when %s precedes it',
      (_label, withGatewayCatalog) => {
        const root = mountHarnessPicker({
          catalog: [],
          harnessTabs: connectRowsTabs(
            withGatewayCatalog
              ? { gatewayCatalog: { status: 'loading', onRetry: jest.fn() } }
              : {},
          ),
        });
        try {
          act(() => queryByTestId('model-harness-tab-all')?.click());
          expect(visibleModelRows()).toEqual([]);
          const classes =
            queryByTestId('model-connect-section')?.className.split(/\s+/) ??
            [];
          expect(classes.length).toBeGreaterThan(0);
          if (withGatewayCatalog) {
            expect(classes).toEqual(expect.arrayContaining(['border-t']));
          } else {
            expect(classes).not.toContain('border-t');
            expect(classes).not.toContain('mt-2');
          }
        } finally {
          act(() => root.unmount());
        }
      },
    );

    it('labels rows with the harness and its connect action', () => {
      const root = mountHarnessPicker({ harnessTabs: connectRowsTabs() });
      try {
        act(() => queryByTestId('model-harness-tab-all')?.click());
        const cursor = queryByTestId('model-connect-row-cursor');
        expect(cursor?.textContent).toContain('Cursor');
        expect(cursor?.textContent).toContain('Connect');
        expect(cursor?.getAttribute('aria-label')).toBe('Connect Cursor');
        const codex = queryByTestId('model-connect-row-codex');
        expect(codex?.textContent).toContain('Codex');
        expect(codex?.textContent).toContain('Sign in');
        expect(codex?.getAttribute('aria-label')).toBe('Sign in to Codex');
        for (const row of [cursor, codex]) {
          expect(row?.getAttribute('role')).toBe('menuitem');
          expect(row?.hasAttribute('data-connect-harness')).toBe(true);
          expect(row?.hasAttribute('data-model-id')).toBe(false);
        }
      } finally {
        act(() => root.unmount());
      }
    });

    it('hands off to the host and closes on click', () => {
      const onConnectHarness = jest.fn();
      const root = mountHarnessPicker({
        harnessTabs: connectRowsTabs({ onConnectHarness }),
      });
      try {
        act(() => queryByTestId('model-harness-tab-all')?.click());
        act(() => queryByTestId('model-connect-row-cursor')?.click());
        expect(onConnectHarness).toHaveBeenCalledTimes(1);
        expect(onConnectHarness).toHaveBeenCalledWith('cursor');
        expect(queryByTestId('model-menu')).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    });

    it('finds disconnected harnesses by name in search', () => {
      const root = mountHarnessPicker({ harnessTabs: connectRowsTabs() });
      try {
        act(() => queryByTestId('model-harness-tab-all')?.click());
        for (const query of ['cursor', 'CURSOR']) {
          search(query);
          expect(connectRowIds()).toEqual(['cursor']);
          expect(queryByTestId('model-search-empty')).toBeNull();
          expect(visibleModelRows()).toEqual([]);
          // A lone result starts with no hairline.
          const section = queryByTestId('model-connect-section');
          expect(section?.className.split(/\s+/)).not.toContain('border-t');
          expect(section?.className.split(/\s+/)).not.toContain('mt-2');
        }

        // A connected harness never gets a row.
        search('claude');
        expect(visibleModelRows().length).toBeGreaterThan(0);
        expect(queryByTestId('model-connect-section')).toBeNull();

        // Contiguous matches only.
        search('gpt');
        expect(connectRowIds()).toEqual([]);

        // Model groups first, then the connect section.
        search('co');
        const section = queryByTestId('model-connect-section');
        expect(connectRowIds()).toEqual(['codex', 'copilot']);
        const modelRows = visibleModelRows();
        expect(modelRows.length).toBeGreaterThan(0);
        for (const row of modelRows) {
          expect(
            row.compareDocumentPosition(section ?? document.body) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy();
        }
        expect(section?.className.split(/\s+/)).toContain('border-t');

        search('zzz');
        expect(queryByTestId('model-search-empty')).not.toBeNull();
        expect(connectRowIds()).toEqual([]);

        search('   ');
        expect(connectRowIds()).toEqual([]);
      } finally {
        act(() => root.unmount());
      }
    });

    it('keeps other tabs unchanged and search independent of the tab', () => {
      const root = mountHarnessPicker({ harnessTabs: connectRowsTabs() });
      try {
        act(() => queryByTestId('model-harness-tab-favorites')?.click());
        expect(queryByTestId('model-connect-section')).toBeNull();
        act(() => queryByTestId('model-harness-tab-cursor')?.click());
        expect(queryByTestId('model-connect-section')).toBeNull();
        expect(queryByTestId('model-connect-prompt')).not.toBeNull();
        search('cursor');
        expect(
          document.querySelectorAll('[data-testid="model-connect-row-cursor"]'),
        ).toHaveLength(1);
        expect(queryByTestId('model-connect-prompt')).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    });

    it('reaches connect rows with the keyboard', () => {
      const root = mountHarnessPicker({ harnessTabs: connectRowsTabs() });
      try {
        act(() => queryByTestId('model-harness-tab-all')?.click());
        const field = queryByTestId('model-search');
        const lastRow = (): HTMLElement | null =>
          queryByTestId('model-connect-row-copilot');

        // ArrowUp from search lands on the last row, which is a connect row.
        act(() => field?.focus());
        press('ArrowUp');
        expect(document.activeElement).toBe(lastRow());

        // ArrowDown from the last model row reaches the first connect row.
        const modelRows = visibleModelRows();
        act(() => modelRows[modelRows.length - 1]?.focus());
        press('ArrowDown');
        expect(document.activeElement).toBe(
          queryByTestId('model-connect-row-codex'),
        );

        act(() => modelRows[0]?.focus());
        press('End');
        expect(document.activeElement).toBe(lastRow());

        // With only connect rows, ArrowDown from search enters them.
        search('cursor');
        act(() => queryByTestId('model-search')?.focus());
        press('ArrowDown');
        expect(document.activeElement).toBe(
          queryByTestId('model-connect-row-cursor'),
        );
      } finally {
        act(() => root.unmount());
      }
    });
  });

  it('hides showMoreOnly Claude and Codex models under Legacy models', () => {
    const root = mountHarnessPicker({
      catalog: [
        ...harnessCatalog,
        {
          id: 'claude-opus-legacy',
          label: 'Claude Opus Legacy',
          provider: 'claude',
          source: 'claude',
          vendor: 'anthropic',
          kind: 'model',
          available: true,
          showMoreOnly: true,
        },
        {
          id: 'gpt-5.5',
          label: 'GPT 5.5',
          provider: 'codex',
          source: 'codex',
          vendor: 'openai',
          kind: 'model',
          available: true,
          showMoreOnly: true,
        },
      ],
      currentModel: 'claude-opus-legacy',
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        gatewayLayout: 'harnesses',
        favoritesStorageKey: 'test:model-favorites-legacy',
        chrome: 'picker',
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-claude')?.click());
      expect(queryByTestId('model-option-claude-opus')).not.toBeNull();
      expect(queryByTestId('model-option-claude-opus-legacy')).toBeNull();
      const claudeLegacy = queryByTestId('model-more-anthropic');
      expect(claudeLegacy?.textContent).toContain('Legacy models');
      expect(
        claudeLegacy?.querySelector('svg[data-glyph="check"]'),
      ).not.toBeNull();
      act(() => claudeLegacy?.click());
      expect(queryByTestId('model-option-claude-opus-legacy')).not.toBeNull();

      act(() => queryByTestId('model-harness-tab-codex')?.click());
      expect(queryByTestId('model-option-codex-pro')).not.toBeNull();
      expect(queryByTestId('model-option-gpt-5.5')).toBeNull();
      const openaiLegacy = queryByTestId('model-more-openai');
      expect(openaiLegacy?.textContent).toContain('Legacy models');
      act(() => openaiLegacy?.click());
      expect(queryByTestId('model-option-gpt-5.5')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('says why the list is empty when the host explains it', () => {
    const root = mountHarnessPicker({
      catalog: [],
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-empty-catalog',
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
        emptyCatalog: {
          title: 'Your organization turned off all models',
          subtitle: 'Ask your admin to turn one on',
        },
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-all')?.click());
      const empty = queryByTestId('model-catalog-empty');
      expect(empty?.textContent).toContain(
        'Your organization turned off all models',
      );
      expect(empty?.textContent).toContain('Ask your admin to turn one on');
    } finally {
      act(() => root.unmount());
    }
  });

  it('offers the empty catalog action and runs it', () => {
    const onClick = jest.fn();
    const root = mountHarnessPicker({
      catalog: [],
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-empty-catalog-action',
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
        emptyCatalog: {
          title: 'Your organization turned off all models',
          action: {
            label: 'Manage model policy',
            onClick,
            testId: 'model-catalog-empty-manage-policy',
          },
        },
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-all')?.click());
      const action = queryByTestId('model-catalog-empty-manage-policy');
      expect(action?.textContent).toBe('Manage model policy');
      act(() => action?.click());
      expect(onClick).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it('shows no empty catalog action unless the host offers one', () => {
    const root = mountHarnessPicker({
      catalog: [],
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-empty-catalog-no-action',
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
        emptyCatalog: { title: 'Your organization turned off all models' },
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-all')?.click());
      expect(queryByTestId('model-catalog-empty')).not.toBeNull();
      expect(queryByTestId('model-catalog-empty-action')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(['loading', 'failed'] as const)(
    'ends All with the hosted-model %s state',
    (status) => {
      const onRetry = jest.fn();
      const root = mountHarnessPicker({
        harnessTabs: {
          brandIcon: <span data-testid="test-brand-logo">U</span>,
          brandLabel: 'Test brand',
          favoritesStorageKey: `test:model-favorites-gateway-${status}`,
          chrome: 'picker',
          gatewayLayout: 'harnesses',
          allModelsTab: true,
          gatewayCatalog: { status, onRetry },
        },
      });
      try {
        act(() => queryByTestId('model-harness-tab-all')?.click());
        const block = queryByTestId(`model-gateway-catalog-${status}`);
        expect(block?.textContent).toContain('More models');
        const retry = queryByTestId('model-gateway-catalog-retry');
        if (status === 'loading') {
          expect(block?.textContent).toContain('Loading more models');
          expect(retry).toBeNull();
        } else {
          expect(block?.textContent).toContain('Couldn’t load');
          act(() => retry?.click());
          expect(onRetry).toHaveBeenCalledTimes(1);
          // The picker stays open to show the new attempt.
          expect(queryByTestId('model-menu')).not.toBeNull();
        }
        act(() => queryByTestId('model-harness-tab-claude')?.click());
        expect(queryByTestId(`model-gateway-catalog-${status}`)).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('clears search with a trailing icon button', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-clear-search',
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
      },
    });
    try {
      expect(queryByTestId('model-clear-search')).toBeNull();
      const search = queryByTestId('model-search');
      if (!(search instanceof HTMLInputElement)) {
        throw new Error('Search input not found');
      }
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(search, 'opus');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const clear = queryByTestId('model-clear-search');
      expect(clear?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['right-1.5', 'size-7', 'rounded-md']),
      );
      expect(
        document.querySelectorAll('[aria-label="Clear search"]'),
      ).toHaveLength(1);
      act(() => clear?.click());
      expect(search.value).toBe('');
      expect(queryByTestId('model-clear-search')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('spaces All groups without a document-wide sibling selector', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-group-spacing',
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-all')?.click());
      const groups = Array.from(
        document.querySelectorAll<HTMLElement>('[role="group"][aria-label]'),
      );
      expect(groups.length).toBeGreaterThan(1);
      // A `[&+div]` class compiles to a rule ending in a bare `div`, which
      // re-styles every div in a long transcript on each insertion.
      const classes = Array.from(
        document.querySelectorAll('[class]'),
        (element) => element.getAttribute('class') ?? '',
      );
      expect(classes.some((value) => value.includes('[&+div]'))).toBe(false);
      expect(groups[0]?.getAttribute('data-picker-gap')).toBe('3');
      expect(groups[1]?.className).toContain('[[data-picker-gap="3"]+&]:mt-3');
    } finally {
      act(() => root.unmount());
    }
  });

  it('shows each native row its own harness on the right in All', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-native-harness',
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-all')?.click());
      const claude = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="model-harness-icon-claude-opus"]',
        ),
      ).find((node) => node.closest('[hidden]') === null);
      expect(claude?.getAttribute('data-harness')).toBe('claude');
      expect(claude?.getAttribute('aria-label')).toBe('Runs on Claude');
      const codex = Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="model-harness-icon-codex-pro"]',
        ),
      ).find((node) => node.closest('[hidden]') === null);
      expect(codex?.getAttribute('data-harness')).toBe('codex');
    } finally {
      act(() => root.unmount());
    }
  });

  it('replaces a list of only disabled models with the host explanation', () => {
    const root = mountHarnessPicker({
      catalog: [
        {
          id: 'sonnet',
          label: 'Sonnet 5',
          provider: 'claude',
          source: 'claude',
          vendor: 'anthropic',
          kind: 'model',
          available: true,
        },
      ],
      currentModel: 'sonnet',
      getOptionState: () => ({
        disabled: true,
        unavailableReason: 'Your organization requires its model gateway.',
      }),
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-all-disabled',
        chrome: 'picker',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
        emptyCatalog: {
          title: "Your organization hasn't added any models yet",
          subtitle: 'Ask your admin to add one',
        },
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-all')?.click());
      expect(queryByTestId('model-catalog-empty')?.textContent).toContain(
        "Your organization hasn't added any models yet",
      );
      expect(queryByTestId('model-option-sonnet')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('tints Legacy models instead of checking it when it holds the highlighted selection', () => {
    const root = mountHarnessPicker({
      catalog: [
        ...harnessCatalog,
        {
          id: 'claude-opus-legacy',
          label: 'Claude Opus Legacy',
          provider: 'claude',
          source: 'claude',
          vendor: 'anthropic',
          kind: 'model',
          available: true,
          showMoreOnly: true,
        },
        {
          id: 'gpt-5.5',
          label: 'GPT 5.5',
          provider: 'codex',
          source: 'codex',
          vendor: 'openai',
          kind: 'model',
          available: true,
          showMoreOnly: true,
        },
      ],
      currentModel: 'claude-opus-legacy',
      highlightSelection: true,
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        gatewayLayout: 'harnesses',
        favoritesStorageKey: 'test:model-favorites-legacy-highlight',
        chrome: 'picker',
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-claude')?.click());
      const claudeLegacy = queryByTestId('model-more-anthropic');
      expect(claudeLegacy?.getAttribute('data-contains-selection')).toBe(
        'true',
      );
      expect(claudeLegacy?.classList.contains('bg-subtle')).toBe(true);
      expect(claudeLegacy?.querySelector('svg[data-glyph="check"]')).toBeNull();

      act(() => queryByTestId('model-harness-tab-codex')?.click());
      const openaiLegacy = queryByTestId('model-more-openai');
      expect(openaiLegacy?.hasAttribute('data-contains-selection')).toBe(false);
      expect(openaiLegacy?.classList.contains('bg-subtle')).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('does not mark Legacy models as selected while Auto is on', () => {
    const root = mountHarnessPicker({
      catalog: [
        ...harnessCatalog,
        {
          id: 'claude-opus-legacy',
          label: 'Claude Opus Legacy',
          provider: 'claude',
          source: 'claude',
          vendor: 'anthropic',
          kind: 'model',
          available: true,
          showMoreOnly: true,
        },
      ],
      // The chat keeps its legacy model while Auto picks for it.
      currentModel: 'claude-opus-legacy',
      autoOption: { selected: true, onSelect: (): void => undefined },
      highlightSelection: true,
      harnessTabs: {
        brandIcon: <span>U</span>,
        brandLabel: 'Test brand',
        gatewayLayout: 'harnesses',
        favoritesStorageKey: 'test:model-favorites-legacy-auto',
        chrome: 'picker',
      },
    });
    try {
      act(() => queryByTestId('model-harness-tab-claude')?.click());
      const claudeLegacy = queryByTestId('model-more-anthropic');
      expect(claudeLegacy).not.toBeNull();
      expect(claudeLegacy?.hasAttribute('data-contains-selection')).toBe(false);
      expect(claudeLegacy?.classList.contains('bg-subtle')).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('uses the compact picker chrome for row details', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        gatewayLayout: 'harnesses',
        favoritesStorageKey: 'test:model-favorites-chrome',
        chrome: 'picker',
        allModelsTab: true,
        runnableHarnesses: [
          { id: 'claude', connected: true },
          { id: 'codex', connected: true },
        ],
        supportedModelIds: { codex: ['hosted-deepseek'] },
      },
    });
    try {
      const menu = queryByTestId('model-menu');
      expect(menu?.className).toContain('canopy-picker-menu');
      expect(menu?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['flex', 'flex-col']),
      );
      expect(menu?.className).not.toContain('h-[304px]');
      expect(menu?.className).not.toContain('h-[328px]');
      expect(menu?.style.height).toBe(
        `${pickerChromeMenuHeightPx({
          railTabCount: 4,
        })}px`,
      );
      const search = queryByTestId('model-search') as HTMLInputElement;
      const searchFieldRow = search.parentElement?.parentElement;
      const searchHeader = searchFieldRow?.parentElement;
      expect(searchHeader?.className.split(/\s+/)).toContain('-mr-1');
      expect(searchHeader?.className.split(/\s+/)).not.toContain('-mx-1');
      const listBeforeSearch = menu?.querySelector(
        '.canopy-picker-menu-list',
      )?.parentElement;
      expect(listBeforeSearch?.className.split(/\s+/)).toContain('-mr-1');
      expect(listBeforeSearch?.className.split(/\s+/)).not.toContain('-mx-1');
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(search, '4');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const railWhileSearching = document.querySelector(
        '[aria-label="Model harnesses"]',
      );
      expect(railWhileSearching?.hasAttribute('hidden')).toBe(true);
      expect(searchHeader?.className.split(/\s+/)).toContain('-mx-1');
      expect(searchFieldRow?.className.split(/\s+/)).toContain('pl-1');
      const listWhileSearching = menu?.querySelector(
        '.canopy-picker-menu-list',
      )?.parentElement;
      expect(listWhileSearching?.className.split(/\s+/)).toContain('-mx-1');
      const clear = queryByTestId('model-clear-search') as HTMLButtonElement;
      expect(clear).not.toBeNull();
      expect(clear.getAttribute('aria-label')).toBe('Clear search');
      expect(clear.parentElement).toBe(searchFieldRow);
      expect(clear.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['right-1.5', 'size-7', 'rounded-md']),
      );
      expect(clear.querySelector('svg')?.getAttribute('data-glyph')).toBe('x');
      expect(
        document.querySelectorAll('[aria-label="Clear search"]'),
      ).toHaveLength(1);
      act(() => clear?.click());
      expect(search.value).toBe('');
      expect(document.activeElement).toBe(search);
      expect(document.querySelector('[aria-label="Clear search"]')).toBeNull();
      expect(
        document
          .querySelector('[aria-label="Model harnesses"]')
          ?.hasAttribute('hidden'),
      ).toBe(false);
      const row = queryByTestId('model-option-hosted-deepseek');
      expect(row?.querySelector('[data-testid="test-brand-logo"]')).toBeNull();
      expect(
        row
          ?.querySelector('svg[data-app-icon="true"]')
          ?.getAttribute('data-glyph'),
      ).toBe('deepseek');
      // Room for its harness icon beside the star: every row names its harness.
      expect(row?.className.split(/\s+/)).toContain('pr-16.5');
      expect(
        queryByTestId('model-harness-icon-hosted-deepseek')?.getAttribute(
          'data-harness',
        ),
      ).toBe('codex');
      expect(row?.className.split(/\s+/)).toContain('gap-2');
      expect(row?.className.split(/\s+/)).toContain('px-2');
      expect(row?.className.split(/\s+/)).toContain(
        'group-hover/model-row:bg-subtle',
      );
      const favorite = queryByTestId('model-favorite-hosted-deepseek');
      expect(favorite?.className.split(/\s+/)).toContain('right-0.5');
      expect(favorite?.className.split(/\s+/)).toContain('size-7');
      expect(favorite?.className.split(/\s+/)).toContain(
        'rounded-[calc(var(--radius-md)-2px)]',
      );
      expect(favorite?.className.split(/\s+/)).toContain('hover:bg-subtle');
      expect(favorite?.className.split(/\s+/)).toContain('transition-colors');
      expect(favorite?.className.split(/\s+/)).not.toContain('duration-150');
      const activeTab = queryByTestId('model-harness-tab-all');
      const tabClasses = activeTab?.className.split(/\s+/) ?? [];
      expect(tabClasses).toContain('rounded-md');
      expect(tabClasses).toContain('size-9');
      expect(
        queryByTestId('model-harness-tab-favorites')
          ?.querySelector('svg')
          ?.getAttribute('fill'),
      ).toBe('none');
      // Provider marks and Lucide glyphs fill the same 18px box.
      const railIconWidths = Array.from(
        document.querySelectorAll('[data-testid^="model-harness-tab-"] svg'),
      ).map((svg) => svg.getAttribute('width'));
      expect(railIconWidths.length).toBeGreaterThan(2);
      expect(new Set(railIconWidths)).toEqual(new Set(['18px']));
      expect(tabClasses).toContain('mx-1');
      expect(activeTab?.parentElement?.className.split(/\s+/)).toContain('h-9');
      expect(
        queryByTestId(
          'model-search',
        )?.parentElement?.parentElement?.className.split(/\s+/),
      ).toContain('h-9');
      expect(tabClasses).toEqual(
        expect.arrayContaining([
          ...SECONDARY_SURFACE_SHELL_CLASS.split(/\s+/),
          'fg-primary',
        ]),
      );
      expect(tabClasses).not.toContain('hover:bg-subtle');
      expect(tabClasses).not.toContain(
        'hover:[background-image:linear-gradient(var(--bg-subtle),var(--bg-subtle))]',
      );
      expect(tabClasses).not.toContain('bg-subtle');
      expect(activeTab?.parentElement?.querySelector('.bg-accent')).toBeNull();
      expect(
        queryByTestId('model-harness-tab-claude')?.className.split(/\s+/),
      ).toContain('hover:bg-subtle');
      const rail = activeTab?.parentElement?.parentElement;
      expect(rail?.className).toContain('py-1');
      expect(rail?.className).toContain('gap-px');
      expect(activeTab?.closest('nav')?.className).toContain('bg-card');
      expect(activeTab?.closest('nav')?.className).toContain(
        '[.dark_&]:bg-secondary',
      );
      const favoritesDivider = queryByTestId('model-favorites-divider');
      // A fixed 7px slot, so the hairline's width on screen never changes
      // the rail's height.
      expect(favoritesDivider?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['mx-3', 'h-1.75', 'items-center']),
      );
      expect(
        favoritesDivider?.firstElementChild?.className.split(/\s+/),
      ).toContain('border-b');
      expect(favoritesDivider?.className).not.toContain('opacity-0');
      expect(favoritesDivider?.className.split(/\s+/)).not.toContain('mt-1');
      act(() => queryByTestId('model-harness-tab-claude')?.click());
      expect(
        queryByTestId('model-favorites-divider')?.className.split(/\s+/),
      ).not.toContain('opacity-0');
      act(() => queryByTestId('model-harness-tab-favorites')?.click());
      expect(
        queryByTestId('model-favorites-divider')?.className.split(/\s+/),
      ).not.toContain('opacity-0');
      act(() => queryByTestId('model-harness-tab-all')?.click());
      expect(
        queryByTestId(
          'model-harness-tab-claude',
        )?.parentElement?.className.split(/\s+/),
      ).toEqual(expect.arrayContaining(['relative', 'flex', 'h-9']));
      expect(
        queryByTestId(
          'model-harness-tab-claude',
        )?.parentElement?.className.split(/\s+/),
      ).not.toContain('mb-[2px]');
      expect(
        queryByTestId(
          'model-harness-tab-claude',
        )?.parentElement?.className.split(/\s+/),
      ).not.toContain('pt-1');
      expect(queryByTestId('model-rail-reserve')).toBeNull();
      // Favorites empty unmounts the list; re-query after returning to a harness.
      const visibleRow = queryByTestId('model-option-hosted-deepseek');
      expect(
        visibleRow?.querySelector('[data-picker-selected-check="true"]'),
      ).toBeNull();
      act(() => {
        visibleRow?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(document.body.textContent).not.toContain('Reasoning');
      act(() => jest.advanceTimersByTime(200));
      expect(document.body.textContent).toContain('Reasoning');
      expect(document.body.textContent).toContain('No reasoning');
    } finally {
      act(() => root.unmount());
    }
  });

  it('orders the rail and labels hosted rows as AI credits on All', () => {
    const root = mountHarnessPicker({
      harnessTabs: {
        brandIcon: <span data-testid="test-brand-logo">U</span>,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-vendors',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
      },
    });
    try {
      const tabIds = Array.from(
        document.querySelectorAll(
          '[aria-label="Model harnesses"] [role="menuitemradio"]',
        ),
        (tab) => tab.getAttribute('data-testid'),
      );
      expect(tabIds).toEqual([
        'model-harness-tab-favorites',
        'model-harness-tab-all',
        'model-harness-tab-claude',
        'model-harness-tab-codex',
      ]);

      const row = queryByTestId('model-option-hosted-deepseek');
      expect(queryByTestId('model-credits-legend')).toBeNull();
      expect(row?.closest('[hidden]')).toBeNull();
      expect(
        queryByTestId('model-harness-tab-all')?.getAttribute('aria-checked'),
      ).toBe('true');
      const favoritesIcon = (): SVGElement | null | undefined =>
        queryByTestId('model-harness-tab-favorites')?.querySelector('svg');
      const allGlyph = (): string | null | undefined =>
        queryByTestId('model-harness-tab-all')
          ?.querySelector('svg')
          ?.getAttribute('data-glyph');
      expect(favoritesIcon()?.getAttribute('fill')).toBe('none');
      expect(allGlyph()).toBe('layout-grid-fill1');
      act(() => queryByTestId('model-harness-tab-favorites')?.click());
      expect(favoritesIcon()?.getAttribute('fill')).toBe('currentColor');
      expect(allGlyph()).toBe('layout-grid');
      act(() => queryByTestId('model-harness-tab-all')?.click());
      const hostedGroup = row?.closest('[role="group"]');
      expect(
        hostedGroup?.querySelector('[data-testid^="model-group-credits-"]'),
      ).toBeNull();
      const creditsLabel = row?.querySelector(
        '[data-testid="model-row-credits-hosted-deepseek"]',
      );
      expect(creditsLabel?.textContent).toBe('AI Credits');
      // fg-tertiary fails AA on a hovered dark row (CAN-5022).
      expect(creditsLabel?.classList.contains('fg-secondary')).toBe(true);
      expect(creditsLabel?.classList.contains('fg-tertiary')).toBe(false);
      expect(
        queryByTestId('model-option-claude-opus')?.querySelector(
          '[data-testid^="model-row-credits-"]',
        ),
      ).toBeNull();
      act(() => queryByTestId('model-harness-tab-all')?.click());
      expect(
        queryByTestId('model-option-hosted-deepseek')?.closest('[hidden]'),
      ).toBeNull();
      expect(
        queryByTestId('model-option-claude-opus')?.closest('[hidden]'),
      ).toBeNull();

      expect(queryByTestId('model-credits-legend')).toBeNull();
      expect(
        queryByTestId('model-option-hosted-deepseek')?.closest('[hidden]'),
      ).toBeNull();

      act(() => queryByTestId('model-harness-tab-claude')?.click());
      expect(queryByTestId('model-credits-legend')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('renders the Org gateway tag in AA-contrast secondary text', () => {
    const root = mountHarnessPicker({
      catalog: [
        {
          id: 'org-sonnet',
          label: 'Org Sonnet',
          provider: 'claude',
          source: 'ai-gateway',
          vendor: 'anthropic',
          kind: 'model',
          available: true,
          funding: 'org-gateway',
        },
        ...harnessCatalog,
      ],
      harnessTabs: {
        brandIcon: null,
        brandLabel: 'Test brand',
        favoritesStorageKey: 'test:model-favorites-org-gateway',
        gatewayLayout: 'harnesses',
        allModelsTab: true,
      },
    });
    try {
      const tag = queryByTestId('model-row-org-gateway-org-sonnet');
      expect(tag?.textContent).toBe('Org gateway');
      // fg-tertiary fails AA on a hovered dark row (CAN-5022).
      expect(tag?.classList.contains('fg-secondary')).toBe(true);
      expect(tag?.classList.contains('fg-tertiary')).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('removes experimental help when the host releases Cursor', () => {
    const root = mountHarnessPicker({
      cursorExperimental: false,
      catalog: [
        {
          id: 'cursor-default',
          label: 'Default',
          provider: 'cursor',
          source: 'cursor',
          kind: 'model',
          available: true,
        },
      ],
    });
    try {
      act(() => queryByTestId('model-harness-tab-cursor')?.click());
      expect(queryByTestId('model-option-cursor-default')).not.toBeNull();
      expect(queryByTestId('model-experimental-cursor')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('preserves Cursor experimental help in the harness browser', () => {
    const root = mountHarnessPicker({
      catalog: [
        {
          id: 'cursor-default',
          label: 'Default',
          provider: 'cursor',
          source: 'cursor',
          kind: 'model',
          available: true,
        },
      ],
    });
    try {
      const help = queryByTestId('model-experimental-cursor');
      expect(help).not.toBeNull();
      expect(help?.hidden).toBe(true);
      act(() => queryByTestId('model-harness-tab-cursor')?.click());
      expect(help?.hidden).toBe(false);
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps canonical models in their source tabs and vendor groups when Cursor runs them', () => {
    const root = mountHarnessPicker({
      catalog: harnessCatalog.map((option) => ({
        ...option,
        provider: 'cursor',
      })),
    });
    expect(queryByTestId('model-harness-tab-cursor')).toBeNull();
    expect(queryByTestId('model-group-label-provider:cursor')).toBeNull();
    for (const [tab, id] of [
      ['claude', 'claude-opus'],
      ['codex', 'codex-pro'],
    ]) {
      act(() => queryByTestId(`model-harness-tab-${tab}`)?.click());
      expect(
        queryByTestId(`model-option-${id}`)?.closest('[hidden]'),
      ).toBeNull();
    }
    act(() => root.unmount());
  });
});

/**
 * CAN-2701 fixture: the shipping catalog shape. Two vendors, several families
 * inside each, plus the longest label currently shipping.
 */
const SHIPPING_CATALOG: ModelCatalog = [
  {
    id: 'fable[1m]',
    label: 'Fable 5',
    description:
      'Most capable Claude model, for demanding reasoning and long-horizon agentic work',
    provider: 'claude',
    kind: 'model',
    available: true,
    family: 'fable',
    familyLabel: 'Fable',
    vendor: 'anthropic',
    sortOrder: 10,
    contextWindow: 1_000_000,
    extraChargeOnly: true,
  },
  {
    id: 'opus[1m]',
    label: 'Opus 5',
    description:
      'Highly capable Claude model, for agentic coding and professional knowledge work',
    provider: 'claude',
    kind: 'model',
    available: true,
    family: 'opus',
    familyLabel: 'Opus',
    vendor: 'anthropic',
    sortOrder: 20,
    contextWindow: 1_000_000,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',
    description:
      'Fastest, lowest-cost Claude model, for high-throughput agent tasks',
    provider: 'claude',
    kind: 'model',
    available: true,
    family: 'haiku',
    familyLabel: 'Haiku',
    vendor: 'anthropic',
    sortOrder: 40,
    contextWindow: 200_000,
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT 5.6 Sol',
    description: 'Frontier Codex model for complex coding work',
    provider: 'codex',
    kind: 'model',
    available: true,
    family: 'gpt-5.6',
    familyLabel: 'GPT 5.6',
    vendor: 'openai',
    sortOrder: 50,
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT 5.3-Codex-Spark',
    description: 'Low-latency native Codex model',
    provider: 'codex',
    kind: 'model',
    available: true,
    family: 'gpt-5.3-codex',
    familyLabel: 'GPT 5.3 Codex',
    vendor: 'openai',
    sortOrder: 90,
  },
];

function mountShippingPicker(
  props: Partial<React.ComponentProps<typeof ModelPickerMenu>> = {},
): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() =>
    root.render(
      <ModelPickerMenu
        catalog={SHIPPING_CATALOG}
        currentModel="opus[1m]"
        onSelect={(): void => undefined}
        {...props}
      />,
    ),
  );
  return root;
}

function hoverOption(id: string): void {
  act((): void => {
    queryByTestId(`model-option-${id}`)?.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    );
  });
}

function groupLabels(): readonly string[] {
  return Array.from(
    document.querySelectorAll('[data-testid^="model-group-label-"]'),
  ).map((node) => node.textContent ?? '');
}

describe('ModelPickerMenu vendor grouping (CAN-2701)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it.each(['cursor', 'copilot', 'opencode'] as const)(
    'shows %s discovery status once across maker groups',
    (provider) => {
      const root = mountShippingPicker({
        catalog: ['anthropic', 'google'].map(
          (vendor): ModelCatalogOption => ({
            id: `${provider}:${vendor}`,
            label: vendor,
            provider,
            source: provider,
            vendor,
            kind: 'model',
            available: true,
          }),
        ),
        harnessTabs: {
          allModelsTab: true,
          initialTab: provider,
          brandIcon: null,
          brandLabel: 'AI Credits',
          harnessStatus: {
            [provider]: (
              <span data-testid="discovery-status">Discovery unavailable</span>
            ),
          },
        },
      });
      const statuses = (): Element[] =>
        Array.from(
          document.querySelectorAll('[data-testid="discovery-status"]'),
        ).filter((element) => !element.closest('[hidden]'));
      act(() => queryByTestId('model-picker')?.click());
      expect(statuses()).toHaveLength(1);
      act(() => queryByTestId('model-harness-tab-all')?.click());
      expect(statuses()).toHaveLength(1);
      act(() => root.unmount());
    },
  );

  it.each(['cursor', 'copilot', 'opencode'] as const)(
    'groups %s models by maker with an account fallback for missing metadata',
    (provider) => {
      const accountLabel = {
        cursor: 'Cursor',
        copilot: 'GitHub Copilot',
        opencode: 'OpenCode',
      }[provider];
      const root = mountShippingPicker({
        catalog: [
          ...SHIPPING_CATALOG,
          ...[
            ['cursor:sonnet', 'Sonnet variant', 'anthropic'],
            ['cursor:gpt', 'GPT variant', 'openai'],
            ['cursor:gemini', 'Gemini', 'google'],
            ['cursor:composer', 'Composer', 'cursor'],
            ['cursor:opaque', 'Opaque model', undefined],
            ['cursor-default', 'Default', undefined],
          ].map(
            ([id, label, vendor]): ModelCatalogOption => ({
              id: id ?? '',
              label: label ?? '',
              provider,
              source: provider,
              kind: 'model',
              available: true,
              ...(vendor ? { vendor } : {}),
            }),
          ),
        ],
      });
      act(() => queryByTestId('model-picker')?.click());
      for (const [id, heading] of [
        ['cursor:sonnet', 'Anthropic'],
        ['cursor:gpt', 'OpenAI'],
        ['cursor:gemini', 'Google'],
        ['cursor:composer', 'Cursor'],
        ['cursor:opaque', accountLabel],
        ['cursor-default', 'Cursor'],
      ]) {
        expect(
          queryByTestId(`model-option-${id}`)
            ?.closest('[role="group"]')
            ?.getAttribute('aria-label'),
        ).toBe(heading);
      }
      expect(
        document
          .querySelector('[role="group"][aria-label="Cursor"]')
          ?.querySelectorAll('[role="menuitemradio"]'),
      ).toHaveLength(provider === 'cursor' ? 3 : 2);
      act(() => root.unmount());
    },
  );

  it('keeps a canonical native model in its vendor group when Cursor runs it', () => {
    const root = mountShippingPicker({
      catalog: [
        ...SHIPPING_CATALOG,
        {
          id: 'gpt-shared',
          label: 'GPT Shared',
          provider: 'cursor',
          harness: 'cursor',
          source: 'codex',
          vendor: 'openai',
          family: 'codex',
          familyLabel: 'Codex',
          kind: 'model',
          available: true,
        },
      ],
    });
    act(() => queryByTestId('model-picker')?.click());
    expect(groupLabels()).toEqual(['Anthropic', 'OpenAI']);
    expect(
      document
        .querySelector('[role="group"][aria-label="OpenAI"]')
        ?.querySelector('[data-testid="model-option-gpt-shared"]'),
    ).not.toBeNull();
    act(() => root.unmount());
  });

  it('uses the people ID card glyph for the Agents section', () => {
    const root = mountShippingPicker({
      catalog: [
        {
          id: 'agent-fixture',
          label: 'Agent fixture',
          provider: 'codex',
          kind: 'agent',
          available: true,
        },
      ],
    });
    act(() => queryByTestId('model-picker')?.click());
    const icon = queryByTestId('model-group-icon-agents');
    expect(icon?.innerHTML).toContain('data-glyph="contact-round"');
    expect(icon?.innerHTML).not.toContain('data-glyph="mouse-pointer-click"');
    act(() => root.unmount());
  });

  it('gives Cursor its own branded experimental section and Default option', () => {
    const root = mountShippingPicker({
      currentModel: 'cursor-default',
      catalog: [
        ...SHIPPING_CATALOG,
        {
          id: 'cursor-default',
          label: 'Default',
          provider: 'cursor',
          kind: 'model',
          available: true,
        },
      ],
    });
    act(() => queryByTestId('model-picker')?.click());
    expect(groupLabels()).toEqual(['Anthropic', 'OpenAI', 'Cursor']);
    const group = document.querySelector('[role="group"][aria-label="Cursor"]');
    expect(group?.querySelectorAll('[role="menuitemradio"]')).toHaveLength(1);
    expect(
      queryByTestId('model-option-label-cursor-default')?.textContent,
    ).toBe('Default');
    expect(
      queryByTestId('model-group-icon-provider:cursor')
        ?.querySelector('svg')
        ?.getAttribute('viewBox'),
    ).toBe('-88.11 -55.43 642.94 642.94');
    expect(
      queryByTestId('model-group-icon-provider:cursor')?.querySelector('text'),
    ).toBeNull();
    expect(
      queryByTestId('model-experimental-cursor')?.getAttribute('aria-label'),
    ).toBe('Cursor experimental features');
    expect(
      queryByTestId('model-picker-provider-icon')?.getAttribute(
        'data-provider',
      ),
    ).toBe('cursor');
    act(() => root.unmount());
  });

  it.each(['click', 'Enter', ' '] as const)(
    'keeps the picker open when Cursor experimental help is activated with %s',
    (activation) => {
      const onSelect = jest.fn();
      const root = mountShippingPicker({
        onSelect,
        catalog: [
          ...SHIPPING_CATALOG,
          {
            id: 'cursor-default',
            label: 'Default',
            provider: 'cursor',
            kind: 'model',
            available: true,
          },
        ],
      });
      try {
        act(() => queryByTestId('model-picker')?.click());
        const help = queryByTestId('model-experimental-cursor');
        expect(help).not.toBeNull();
        act(() => help?.focus());
        act(() => {
          if (activation === 'click') help?.click();
          else
            help?.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: activation,
                bubbles: true,
                cancelable: true,
              }),
            );
        });
        expect(queryByTestId('model-menu')).not.toBeNull();
        expect(document.activeElement).toBe(help);
        expect(onSelect).not.toHaveBeenCalled();
        // Informational activation must not break the real selection path.
        act(() => queryByTestId('model-option-cursor-default')?.click());
        expect(onSelect).toHaveBeenCalledWith('cursor-default');
        expect(queryByTestId('model-menu')).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it.each(['cursor', 'copilot', 'opencode'] as const)(
    'keeps the %s section when an older host omits vendor metadata',
    (provider) => {
      const root = mountShippingPicker({
        catalog: [
          {
            id: `${provider}:older-model`,
            label: 'Older model',
            provider,
            source: provider,
            kind: 'model',
            available: true,
          },
        ],
      });
      try {
        act(() => queryByTestId('model-picker')?.click());
        expect(
          queryByTestId(`model-group-label-provider:${provider}`)?.textContent,
        ).toBe(
          provider === 'cursor'
            ? 'Cursor'
            : provider === 'copilot'
              ? 'GitHub Copilot'
              : 'OpenCode',
        );
        expect(
          queryByTestId(`model-option-${provider}:older-model`)
            ?.closest('[role="group"]')
            ?.getAttribute('aria-label'),
        ).toBe(
          provider === 'cursor'
            ? 'Cursor'
            : provider === 'copilot'
              ? 'GitHub Copilot'
              : 'OpenCode',
        );
        expect(groupLabels()).not.toContain('Other models');
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('groups by vendor, not by model family', () => {
    // Family grouping produced one heading per model for Claude ("Fable",
    // "Opus", "Haiku"), so headings outnumbered the rows they organized.
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());

    expect(groupLabels()).toEqual(['Anthropic', 'OpenAI']);

    act(() => root.unmount());
  });

  it('bounds the open menu by the viewport', () => {
    const previousWidth = window.innerWidth;
    const previousHeight = window.innerHeight;
    window.innerWidth = 800;
    window.innerHeight = 900;
    const root = mountShippingPicker();
    mockRect(queryByTestId('model-picker'), 40, 800, 80, 28);
    act(() => queryByTestId('model-picker')?.click());

    const maxHeight = Number.parseFloat(
      queryByTestId('model-menu')?.style.maxHeight ?? '',
    );
    expect(maxHeight).toBeGreaterThan(280);

    window.innerWidth = previousWidth;
    window.innerHeight = previousHeight;
    act(() => root.unmount());
  });

  it('uses the first API family label for its matching vendor section', () => {
    const catalog: ModelCatalog = [
      {
        id: 'deepseek-v4.1-flash',
        label: 'DeepSeek V4.1 Flash',
        provider: 'codex',
        kind: 'model',
        available: true,
        family: 'deepseek',
        familyLabel: 'DeepSeek API',
        vendor: 'deepseek',
      },
      {
        id: 'deepseek-v4.1-pro',
        label: 'DeepSeek V4.1 Pro',
        provider: 'codex',
        kind: 'model',
        available: true,
        family: 'deepseek',
        familyLabel: 'Ignored later label',
        vendor: 'deepseek',
      },
    ];
    const root = mountShippingPicker({ catalog });
    act(() => queryByTestId('model-picker')?.click());

    expect(groupLabels()).toEqual(['DeepSeek API']);
    act(() => root.unmount());
  });

  it('uses the legacy vendor label when a pre-v6 family differs', () => {
    const catalog: ModelCatalog = [
      {
        id: 'deepseek-v4',
        label: 'DeepSeek V4',
        provider: 'codex',
        kind: 'model',
        available: true,
        family: 'deepseek-v4',
        familyLabel: 'DeepSeek V4',
        vendor: 'deepseek',
      },
    ];
    const root = mountShippingPicker({ catalog });
    act(() => queryByTestId('model-picker')?.click());

    expect(groupLabels()).toEqual(['DeepSeek']);
    act(() => root.unmount());
  });

  it('keys each group on the vendor so a family is never its own section', () => {
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());

    expect(queryByTestId('model-group-label-anthropic')).not.toBeNull();
    expect(queryByTestId('model-group-label-openai')).not.toBeNull();
    expect(queryByTestId('model-group-label-anthropic:opus')).toBeNull();

    act(() => root.unmount());
  });

  it('orders rows inside a vendor by the host catalog sort order', () => {
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());

    const ids = Array.from(
      document.querySelectorAll(
        '[data-testid^="model-option-"][data-model-id]',
      ),
    ).map((node) => node.getAttribute('data-model-id'));
    expect(ids).toEqual([
      'fable[1m]',
      'opus[1m]',
      'claude-haiku-4-5-20251001',
      'gpt-5.6-sol',
      'gpt-5.3-codex-spark',
    ]);

    act(() => root.unmount());
  });

  it('does not read a vendor label off Object.prototype', () => {
    // Same hazard `getModelVendorLabel` was hardened against: a bare index on
    // a host-supplied literal would make the label a function, and the section
    // sort's `localeCompare` would throw.
    const root = mountShippingPicker({
      catalog: [
        {
          id: 'x',
          label: 'X',
          provider: 'codex',
          kind: 'model',
          available: true,
          vendor: 'constructor',
        },
      ],
      currentModel: 'x',
      vendorLabels: {},
    });
    act(() => queryByTestId('model-picker')?.click());

    expect(groupLabels()).toEqual(['Constructor']);

    act(() => root.unmount());
  });

  it('never files a row under a vendor it did not declare', () => {
    // `provider` is the execution harness. A gateway model routed over the
    // Claude harness is not an Anthropic model, and merging it into the
    // Anthropic section would both mislabel it and split that vendor across
    // two identically-titled headings.
    const root = mountShippingPicker({
      catalog: [
        ...SHIPPING_CATALOG,
        {
          id: 'aurora-lite',
          label: 'Aurora Lite',
          provider: 'claude',
          source: 'ai-gateway',
          kind: 'model',
          available: true,
          sortOrder: 300,
        },
      ],
    });
    act(() => queryByTestId('model-picker')?.click());

    // Not "Claude": that would read as a second heading for the vendor already
    // shown as "Anthropic" — one vendor under two names, which is the defect
    // this ticket removes.
    expect(groupLabels()).toEqual(['Anthropic', 'OpenAI', 'Other models']);
    expect(queryByTestId('model-group-label-vendor:unclaimed')).not.toBeNull();
    expect(groupLabels()).not.toContain('Claude');

    act(() => root.unmount());
  });

  it('keeps a declared vendor mark whatever casing the host sent', () => {
    // Folding into the `anthropic` section but rendering the generic letter
    // badge would be the icon and the heading disagreeing.
    const root = mountShippingPicker({
      catalog: [
        {
          id: 'a',
          label: 'A',
          provider: 'claude',
          kind: 'model',
          available: true,
          vendor: 'Anthropic',
        },
      ],
      currentModel: 'a',
    });
    act(() => queryByTestId('model-picker')?.click());

    expect(groupLabels()).toEqual(['Anthropic']);
    // State the positive contract: `not.toBe('A')` also passes when the
    // element is missing entirely.
    const icon = queryByTestId('model-group-icon-anthropic');
    expect(icon).not.toBeNull();
    expect(icon?.textContent).toBe('');

    act(() => root.unmount());
  });

  it('treats one vendor as one section regardless of casing', () => {
    // Keying on the raw string would let a mixed-case vendor render two
    // sections under the same heading — this ticket's defect, by typo.
    const root = mountShippingPicker({
      catalog: [
        {
          id: 'a',
          label: 'A',
          provider: 'codex',
          kind: 'model',
          available: true,
          vendor: 'openai',
          sortOrder: 1,
        },
        {
          id: 'b',
          label: 'B',
          provider: 'codex',
          kind: 'model',
          available: true,
          vendor: 'OpenAI',
          sortOrder: 2,
        },
      ],
      currentModel: 'a',
    });
    act(() => queryByTestId('model-picker')?.click());

    expect(groupLabels()).toEqual(['OpenAI']);

    act(() => root.unmount());
  });

  it('gathers unclaimed rows into one section, not one per harness', () => {
    // Keying these per-harness produced two adjacent sections both headed
    // "Other models" — indistinguishable, and the same "one thing, two
    // headings" defect this ticket removes wearing a different label.
    const root = mountShippingPicker({
      catalog: [
        {
          id: 'aurora-lite',
          label: 'Aurora Lite',
          provider: 'claude',
          kind: 'model',
          available: true,
        },
        {
          id: 'zephyr-9',
          label: 'Zephyr 9',
          provider: 'codex',
          kind: 'model',
          available: true,
        },
      ],
      currentModel: 'aurora-lite',
    });
    act(() => queryByTestId('model-picker')?.click());

    expect(groupLabels()).toEqual(['Other models']);
    expect(
      document.querySelectorAll(
        '[data-testid^="model-option-"][data-model-id]',
      ),
    ).toHaveLength(2);
    // The GLYPH must make no claim the heading refuses to make: falling back
    // to the harness here put the Anthropic mark over "Other models".
    expect(
      queryByTestId('model-group-icon-vendor:unclaimed')?.textContent,
    ).toBe('O');

    act(() => root.unmount());
  });

  it('alphabetizes rows a host declares no sortOrder for', () => {
    // Discovered Ollama models carry no family metadata and so no `sortOrder`.
    // They all collapse to the same tie and settle by label — deliberate, and
    // worth pinning because it replaces the host's own catalog order.
    const root = mountShippingPicker({
      catalog: ['zeta', 'alpha', 'mid'].map((id) => ({
        id: `ollama-${id}`,
        label: id,
        provider: 'ollama',
        kind: 'model',
        available: true,
      })),
      currentModel: 'ollama-zeta',
    });
    act(() => queryByTestId('model-picker')?.click());

    expect(
      Array.from(
        document.querySelectorAll(
          '[data-testid^="model-option-"][data-model-id]',
        ),
      ).map((node) => node.getAttribute('data-model-id')),
    ).toEqual(['ollama-alpha', 'ollama-mid', 'ollama-zeta']);

    act(() => root.unmount());
  });

  it('still names Ollama itself, where the harness is the vendor', () => {
    const root = mountShippingPicker({
      catalog: [
        {
          id: 'ollama-llama',
          label: 'Llama',
          provider: 'ollama',
          kind: 'model',
          available: true,
        },
      ],
      currentModel: 'ollama-llama',
    });
    act(() => queryByTestId('model-picker')?.click());

    expect(groupLabels()).toEqual(['Ollama']);

    act(() => root.unmount());
  });

  it('lets a host override a vendor label it owns the branding for', () => {
    const root = mountShippingPicker({
      catalog: [
        {
          id: 'kimi',
          label: 'Kimi',
          provider: 'claude',
          kind: 'model',
          available: true,
          vendor: 'ai-gateway',
        },
      ],
      currentModel: 'kimi',
      vendorLabels: { 'ai-gateway': 'Unstoppable' },
    });
    act(() => queryByTestId('model-picker')?.click());

    expect(groupLabels()).toEqual(['Unstoppable']);

    act(() => root.unmount());
  });

  it('renders a family added after this build with its catalog label and the generic glyph', () => {
    const catalog: ModelCatalog = [
      {
        id: 'mistral-large',
        label: 'Mistral Large',
        provider: 'codex',
        kind: 'model',
        available: true,
        family: 'mistral',
        familyLabel: 'Mistral AI',
        vendor: 'mistral',
        sortOrder: 2,
      },
      {
        id: 'claude-model',
        label: 'Claude Model',
        provider: 'claude',
        kind: 'model',
        available: true,
        family: 'anthropic',
        familyLabel: 'Anthropic',
        vendor: 'anthropic',
        sortOrder: 1,
      },
    ];
    const root = mountShippingPicker({
      catalog,
      currentModel: 'mistral-large',
    });
    act(() => queryByTestId('model-picker')?.click());

    expect(groupLabels()).toEqual(['Anthropic', 'Mistral AI']);
    const icon = queryByTestId('model-group-icon-mistral')?.querySelector(
      'svg[data-generic-provider-icon="true"]',
    );
    expect(icon?.querySelector('text')?.textContent).toBe('M');
    expect(
      queryByTestId('model-group-icon-anthropic')?.querySelector(
        '[data-generic-provider-icon]',
      ) ?? null,
    ).toBeNull();
    expect(queryByTestId('model-option-mistral-large')).not.toBeNull();
    act(() => root.unmount());
  });
});

describe('ModelPickerMenu row detail (CAN-2701)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders no inline description, so every row is one line', () => {
    // The inline subtext was always cut off mid-sentence; it moved to hover.
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());

    expect(queryByTestId('model-option-description-opus[1m]')).toBeNull();
    expect(
      document.querySelector('[data-testid^="model-option-description-"]'),
    ).toBeNull();

    act(() => root.unmount());
  });

  it('shows the full description and context window on hover', () => {
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());
    hoverOption('opus[1m]');

    const detail = queryByTestId('model-option-detail');
    expect(detail).not.toBeNull();
    // No model name here: the row's own label is visible immediately beside
    // this popover, so repeating it would be the redundancy the trigger
    // tooltip already avoids.
    expect(detail?.textContent).not.toContain('Opus 5');
    expect(detail?.textContent).toContain(
      'Highly capable Claude model, for agentic coding and professional knowledge work',
    );
    expect(detail?.textContent).toContain('1M context');
    // The detail must wrap, not truncate — that is the whole point of moving it.
    expect(detail?.className ?? '').toContain('whitespace-normal');
    expect(detail?.className ?? '').not.toContain('truncate');

    act(() => root.unmount());
  });

  it('restores the focused row detail when hover is released', () => {
    // The menu focuses its selected row on open. Hovering another row and then
    // leaving used to clear the slot outright, stranding the still-focused row
    // with no detail and no event that would bring it back.
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());

    act(() => {
      queryByTestId('model-menu')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', bubbles: true }),
      );
      queryByTestId('model-menu')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
      );
      queryByTestId('model-menu')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });

    const focused = queryByTestId('model-option-detail')?.textContent ?? '';
    expect(focused).toContain('Highly capable Claude model');

    hoverOption('claude-haiku-4-5-20251001');
    expect(queryByTestId('model-option-detail')?.textContent).toContain(
      'Fastest, lowest-cost Claude model',
    );

    act((): void => {
      queryByTestId('model-option-claude-haiku-4-5-20251001')?.dispatchEvent(
        new MouseEvent('mouseout', { bubbles: true }),
      );
    });
    // Back to the focused row, not to nothing.
    expect(queryByTestId('model-option-detail')?.textContent).toContain(
      'Highly capable Claude model',
    );

    act(() => root.unmount());
  });

  it('lets the keyboard take the detail back from a resting pointer', () => {
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());

    hoverOption('claude-haiku-4-5-20251001');
    expect(queryByTestId('model-option-detail')?.textContent).toContain(
      'Fastest, lowest-cost Claude model',
    );

    // A focus move must win over a pointer that never left the other row. The
    // menu owns which row focus lands on, so assert the contract — the detail
    // stops describing the hovered row — rather than a specific destination.
    act((): void => {
      queryByTestId('model-option-gpt-5.6-sol')?.focus();
      queryByTestId('model-menu')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    const afterArrow = queryByTestId('model-option-detail')?.textContent ?? '';
    expect(afterArrow).not.toContain('Fastest, lowest-cost Claude model');
    expect(afterArrow.length).toBeGreaterThan(0);

    act(() => root.unmount());
  });

  it('lets typeahead take the detail back, not just the arrow keys', () => {
    // `FloatingMenu` also moves focus on any printable character. Enumerating
    // its keys missed this; keying off focus itself cannot.
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());

    hoverOption('claude-haiku-4-5-20251001');
    expect(queryByTestId('model-option-detail')?.textContent).toContain(
      'Fastest, lowest-cost Claude model',
    );

    act((): void => {
      queryByTestId('model-menu')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'g', bubbles: true }),
      );
    });
    const afterTypeahead =
      queryByTestId('model-option-detail')?.textContent ?? '';
    expect(afterTypeahead).toContain('Frontier Codex model');
    expect(afterTypeahead).not.toContain('Fastest, lowest-cost Claude model');

    act(() => root.unmount());
  });

  it('keeps the resting row detail through a modifier keypress', () => {
    // Releasing on EVERY keydown dropped it, and `mouseenter` does not re-fire
    // for a stationary pointer, so it never came back.
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());
    hoverOption('claude-haiku-4-5-20251001');

    act((): void => {
      queryByTestId('model-menu')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }),
      );
    });
    expect(queryByTestId('model-option-detail')?.textContent).toContain(
      'Fastest, lowest-cost Claude model',
    );

    act(() => root.unmount());
  });

  it('omits the context line for a model that declares no window', () => {
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());
    hoverOption('gpt-5.6-sol');

    const detail = queryByTestId('model-option-detail');
    expect(detail?.textContent).toContain('Frontier Codex model');
    expect(detail?.textContent).not.toContain('context');

    act(() => root.unmount());
  });

  it('keeps the extra-charge explanation alongside the model detail', () => {
    const root = mountShippingPicker();
    act(() => queryByTestId('model-picker')?.click());
    hoverOption('fable[1m]');

    const detail = queryByTestId('model-option-detail');
    // Extra-charge copy leads: a cost caveat outranks a capability blurb.
    const text = detail?.textContent ?? '';
    expect(text).toContain('Extra charge only');
    expect(text).toContain('Most capable Claude model');
    expect(text.indexOf('Extra charge only')).toBeLessThan(
      text.indexOf('Most capable Claude model'),
    );

    act(() => root.unmount());
  });
});

/** Hovers the trigger and waits out its long tooltip delay. */
function hoverTrigger(): void {
  act((): void => {
    queryByTestId('model-picker')?.dispatchEvent(
      new MouseEvent('mouseover', { bubbles: true }),
    );
  });
  // The trigger's tooltip uses the long (1s) hover delay.
  act(() => jest.advanceTimersByTime(1000));
}

/**
 * Resolve the TRIGGER's own tooltip through `aria-describedby`. Scoped rather
 * than querying every `[role="tooltip"]`, because an open menu also mounts the
 * focused row's detail popover.
 */
function triggerTooltipText(): string | undefined {
  const describedBy =
    queryByTestId('model-picker')?.getAttribute('aria-describedby');
  if (!describedBy) return undefined;
  return document.getElementById(describedBy)?.textContent ?? undefined;
}

describe('ModelPickerMenu trigger (CAN-2701)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('describes what the control governs rather than repeating the model name', () => {
    const root = mountShippingPicker();
    hoverTrigger();

    // The label "Opus 5" is already visible on the chip, so the tooltip must
    // add what the chip cannot say: what this control decides.
    expect(triggerTooltipText()).toBe('Model for this chat');

    act(() => root.unmount());
  });

  it('does not repeat a truncation-capable label that is not actually clipped', () => {
    // The desktop composer allows its chip to truncate but usually renders the
    // label in full. Treating "may truncate" as "is truncated" put the model
    // name in the tooltip right next to the chip already showing it.
    const root = mountShippingPicker({
      variant: 'capsule',
      triggerLabelClassName: 'min-w-0 truncate',
      allowTriggerShrink: true,
    });
    hoverTrigger();

    expect(triggerTooltipText()).toBe('Model for this chat');

    act(() => root.unmount());
  });

  it('waits for the resize observer before measuring the label', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      window,
      'ResizeObserver',
    );
    const reads = jest.spyOn(HTMLElement.prototype, 'scrollWidth', 'get');
    let notify = (): void => undefined;
    class Observer implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notify = (): void => callback([], this);
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: Observer,
    });
    let root: Root | undefined;
    try {
      root = mountShippingPicker({ triggerLabelClassName: 'measured-label' });
      expect(
        reads.mock.contexts.filter(
          (element) =>
            element instanceof HTMLElement &&
            element.classList.contains('measured-label'),
        ),
      ).toHaveLength(0);
      act(() => notify());
      expect(
        reads.mock.contexts.some(
          (element) =>
            element instanceof HTMLElement &&
            element.classList.contains('measured-label'),
        ),
      ).toBe(true);
    } finally {
      act(() => root?.unmount());
      reads.mockRestore();
      if (descriptor)
        Object.defineProperty(window, 'ResizeObserver', descriptor);
      else Reflect.deleteProperty(window, 'ResizeObserver');
    }
  });

  it('adds the model name only when the trigger label is hidden', () => {
    const root = mountShippingPicker({ hideLabel: true });
    hoverTrigger();

    expect(triggerTooltipText()).toBe('Opus 5: Model for this chat');

    act(() => root.unmount());
  });

  it('lets a host that is not configuring a chat say what it configures', () => {
    const root = mountShippingPicker({
      triggerTooltip: 'Model this automation runs on',
    });
    hoverTrigger();

    expect(triggerTooltipText()).toBe('Model this automation runs on');

    act(() => root.unmount());
  });

  it('shows no tooltip when a host drops the description and the label is visible', () => {
    const root = mountShippingPicker({ triggerTooltip: null });
    hoverTrigger();

    expect(triggerTooltipText()).toBeUndefined();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    act(() => root.unmount());
  });

  it('still names the model when the description is dropped but the label is hidden', () => {
    const root = mountShippingPicker({ triggerTooltip: null, hideLabel: true });
    hoverTrigger();

    expect(triggerTooltipText()).toBe('Opus 5');

    act(() => root.unmount());
  });

  it('drops the tooltip while the menu is open so it cannot occlude the list', () => {
    const root = mountShippingPicker();
    hoverTrigger();
    expect(triggerTooltipText()).toBe('Model for this chat');

    act(() => queryByTestId('model-picker')?.click());
    // Suppressed: no description link, so nothing is announced or painted.
    expect(
      queryByTestId('model-picker')?.getAttribute('aria-describedby'),
    ).toBeNull();
    expect(triggerTooltipText()).toBeUndefined();

    act(() => root.unmount());
  });
});

describe('ModelPickerMenu model metadata presentation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('places showMoreOnly rows in a nested Legacy models menu at the end of the family', () => {
    const onSelect = jest.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const catalog: ModelCatalog = [
      {
        id: 'fable-primary',
        label: 'Fable Primary',
        provider: 'claude',
        kind: 'model',
        available: true,
        family: 'fable',
        familyLabel: 'Fable',
        vendor: 'anthropic',
      },
      {
        id: 'fable-specialized',
        label: 'Fable Specialized',
        provider: 'claude',
        kind: 'model',
        available: true,
        family: 'fable',
        familyLabel: 'Fable',
        vendor: 'anthropic',
        showMoreOnly: true,
      },
    ];
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={catalog}
          currentModel="fable-specialized"
          onSelect={onSelect}
        />,
      ),
    );
    act(() => queryByTestId('model-picker')?.click());

    expect(queryByTestId('model-option-fable-primary')).not.toBeNull();
    expect(queryByTestId('model-option-fable-specialized')).toBeNull();
    // CAN-2701: sections are keyed on the vendor, so the Legacy models flyout
    // that used to sit under a per-family key now sits under the vendor's.
    const more = queryByTestId('model-more-anthropic');
    expect(more?.textContent).toContain('Legacy models');
    expect(more?.querySelector('svg[data-glyph="check"]')).not.toBeNull();

    const focusBeforeHover = document.activeElement;
    act((): void => {
      more?.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    expect(queryByTestId('model-option-fable-specialized')).not.toBeNull();
    expect(document.activeElement).toBe(focusBeforeHover);

    const flyout = queryByTestId('model-more-group-anthropic');
    act((): void => {
      more?.dispatchEvent(
        new MouseEvent('pointerout', { bubbles: true, relatedTarget: flyout }),
      );
      flyout?.dispatchEvent(
        new MouseEvent('pointerover', { bubbles: true, relatedTarget: more }),
      );
    });
    expect(more?.className.split(/\s+/)).toContain('bg-subtle');

    act(() => more?.click());
    const specialized = queryByTestId('model-option-fable-specialized');
    expect(document.activeElement).toBe(specialized);
    expect(specialized).not.toBeNull();
    act(() => specialized?.click());
    expect(onSelect).toHaveBeenCalledWith('fable-specialized');

    act(() => root.unmount());
  });

  it('shows description-only tooltips and orders extra-charge copy first', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const catalog: ModelCatalog = [
      {
        id: 'described',
        label: 'Described',
        description: 'Description only.',
        provider: 'claude',
        kind: 'model',
        available: true,
      },
      {
        id: 'charged',
        label: 'Charged',
        description: 'Model description.',
        provider: 'claude',
        kind: 'model',
        available: true,
        extraChargeOnly: true,
        extraChargeMessage: 'Credit details.',
      },
    ];
    act(() =>
      root.render(
        <ModelPickerMenu catalog={catalog} onSelect={(): void => undefined} />,
      ),
    );
    act(() => queryByTestId('model-picker')?.click());
    expect(queryByTestId('model-option-description-described')).toBeNull();

    const described = queryByTestId('model-option-described');
    act(() => {
      described?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Description only.',
    );
    act(() => {
      described?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
    });

    const charged = queryByTestId('model-option-charged');
    act(() => {
      charged?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    const text = document.querySelector('[role="tooltip"]')?.textContent ?? '';
    expect(text).toContain('Extra charge only');
    expect(text).toContain('Credit details.');
    expect(text).toContain('Model description.');
    expect(text.indexOf('Credit details.')).toBeLessThan(
      text.indexOf('Model description.'),
    );

    act(() => root.unmount());
  });

  it('places showMoreOnly rows in a nested Legacy models menu', () => {
    const onSelect = jest.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const catalog: ModelCatalog = [
      {
        id: 'fable-primary',
        label: 'Fable Primary',
        provider: 'claude',
        kind: 'model',
        available: true,
        family: 'fable',
        familyLabel: 'Fable',
        vendor: 'anthropic',
      },
      {
        id: 'fable-specialized',
        label: 'Fable Specialized',
        provider: 'claude',
        kind: 'model',
        available: true,
        family: 'fable',
        familyLabel: 'Fable',
        vendor: 'anthropic',
        showMoreOnly: true,
      },
    ];
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={catalog}
          currentModel="fable-specialized"
          onSelect={onSelect}
        />,
      ),
    );
    act(() => queryByTestId('model-picker')?.click());

    expect(queryByTestId('model-option-fable-primary')).not.toBeNull();
    expect(queryByTestId('model-option-fable-specialized')).toBeNull();
    // CAN-2701: sections are keyed on the vendor, so the "More" flyout that
    // used to sit under a per-family key now sits under the vendor's.
    const more = queryByTestId('model-more-anthropic');
    expect(more?.textContent).toContain('Legacy models');
    expect(more?.querySelector('svg[data-glyph="check"]')).not.toBeNull();

    act(() => more?.click());
    const specialized = queryByTestId('model-option-fable-specialized');
    expect(specialized).not.toBeNull();
    act(() => specialized?.click());
    expect(onSelect).toHaveBeenCalledWith('fable-specialized');

    act(() => root.unmount());
  });
});

const FLYOUT_CATALOG: ModelCatalog = [
  {
    id: 'fable-primary',
    label: 'Fable Primary',
    description: 'Primary description.',
    provider: 'claude',
    kind: 'model',
    available: true,
    family: 'fable',
    familyLabel: 'Fable',
    vendor: 'anthropic',
  },
  {
    id: 'fable-secondary',
    label: 'Fable Secondary',
    description: 'Secondary description.',
    provider: 'claude',
    kind: 'model',
    available: true,
    family: 'fable',
    familyLabel: 'Fable',
    vendor: 'anthropic',
  },
  {
    id: 'fable-legacy-a',
    label: 'Fable Legacy A',
    description: 'Legacy A description.',
    provider: 'claude',
    kind: 'model',
    available: true,
    family: 'fable',
    familyLabel: 'Fable',
    vendor: 'anthropic',
    showMoreOnly: true,
  },
  {
    id: 'fable-legacy-b',
    label: 'Fable Legacy B',
    description: 'Legacy B description.',
    provider: 'claude',
    kind: 'model',
    available: true,
    family: 'fable',
    familyLabel: 'Fable',
    vendor: 'anthropic',
    showMoreOnly: true,
  },
];

const DETAIL_WIDTH = 256;
const DETAIL_HEIGHT = 60;

function mockRect(
  element: Element | null,
  left: number,
  top: number,
  width: number,
  height: number,
): { readonly left: number; readonly right: number } {
  if (!element) throw new Error('element to mock is missing');
  const rect = {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: (): Record<string, never> => ({}),
  };
  element.getBoundingClientRect = (): DOMRect => rect;
  return rect;
}

function detailBox(): { readonly left: number; readonly right: number } {
  const detail = queryByTestId('model-option-detail');
  if (!detail) throw new Error('detail popup is not open');
  const left = Number.parseFloat(detail.style.left);
  return { left, right: left + DETAIL_WIDTH };
}

describe('ModelPickerMenu flyout row detail placement', () => {
  const offsetWidth = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetWidth',
  );
  const offsetHeight = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'offsetHeight',
  );
  const innerWidth = window.innerWidth;
  const innerHeight = window.innerHeight;

  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: (): number => DETAIL_WIDTH,
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: (): number => DETAIL_HEIGHT,
    });
    window.innerWidth = 800;
    window.innerHeight = 600;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    if (offsetWidth) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', offsetWidth);
    }
    if (offsetHeight) {
      Object.defineProperty(
        HTMLElement.prototype,
        'offsetHeight',
        offsetHeight,
      );
    }
    window.innerWidth = innerWidth;
    window.innerHeight = innerHeight;
  });

  function openFlyout(): Root {
    const root = mountShippingPicker({
      catalog: FLYOUT_CATALOG,
      currentModel: 'fable-primary',
    });
    act(() => queryByTestId('model-picker')?.click());
    return root;
  }

  it('keeps a right-side flyout row detail off the parent menu', () => {
    const root = openFlyout();
    const parent = mockRect(queryByTestId('model-menu'), 100, 100, 256, 300);
    act(() => queryByTestId('model-more-anthropic')?.click());
    mockRect(queryByTestId('model-more-group-anthropic'), 356, 180, 256, 120);
    mockRect(queryByTestId('model-option-fable-legacy-a'), 360, 200, 248, 32);

    hoverOption('fable-legacy-a');

    const detail = queryByTestId('model-option-detail');
    expect(detail?.textContent).toContain('Legacy A description.');
    // Right of the flyout (620) overflows the 800px viewport, and left of the
    // flyout (92) would sit on the parent menu — the old row-relative
    // fallback. The popup takes the viewport-clamped right side instead.
    const box = detailBox();
    expect(box.left).toBe(536);
    expect(box.left).toBeGreaterThanOrEqual(parent.right);
    // Vertical centring on the row is unchanged.
    expect(Number.parseFloat(detail?.style.top ?? '')).toBe(186);

    act(() => root.unmount());
  });

  it('keeps a left-side flyout row detail off the parent menu', () => {
    const root = openFlyout();
    const parent = mockRect(queryByTestId('model-menu'), 400, 100, 256, 300);
    act(() => queryByTestId('model-more-anthropic')?.click());
    mockRect(queryByTestId('model-more-group-anthropic'), 144, 180, 256, 120);
    mockRect(queryByTestId('model-option-fable-legacy-a'), 148, 200, 248, 32);

    hoverOption('fable-legacy-a');

    // Right of the flyout (408) fits the viewport but covers the parent menu,
    // so the popup goes to the left, clamped to the viewport edge.
    const box = detailBox();
    expect(box.left).toBe(8);
    expect(box.right).toBeLessThanOrEqual(parent.left);

    act(() => root.unmount());
  });

  it('places a main-list row detail beside the menu surface as before', () => {
    const root = openFlyout();
    window.innerWidth = 1000;
    mockRect(queryByTestId('model-menu'), 100, 100, 256, 300);
    // The selected row is focused on open with its detail already placed, so
    // hover a different row to exercise a fresh placement against the mocks.
    mockRect(queryByTestId('model-option-fable-secondary'), 104, 152, 248, 32);

    hoverOption('fable-secondary');

    expect(queryByTestId('model-option-detail')?.textContent).toContain(
      'Secondary description.',
    );
    expect(detailBox().left).toBe(364);

    act(() => root.unmount());
  });

  it('preserves focus on pointer open and supports keyboard entry into the flyout', () => {
    const root = openFlyout();
    act((): void => {
      queryByTestId('model-more-anthropic')?.dispatchEvent(
        new MouseEvent('pointerover', { bubbles: true }),
      );
    });

    const first = queryByTestId('model-option-fable-legacy-a');
    expect(first).not.toBeNull();
    expect(document.activeElement).not.toBe(first);
    expect(
      queryByTestId('model-option-detail')?.textContent ?? '',
    ).not.toContain('Legacy');
    act(() => {
      queryByTestId('model-more-anthropic')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(first);

    // Keyboard navigation inside the flyout still brings the detail back.
    act((): void => {
      queryByTestId('model-more-group-anthropic')?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    expect(queryByTestId('model-option-detail')?.textContent).toContain(
      'Legacy B description.',
    );

    // And hover is unaffected.
    hoverOption('fable-legacy-a');
    expect(queryByTestId('model-option-detail')?.textContent).toContain(
      'Legacy A description.',
    );

    act(() => root.unmount());
  });
});

describe('ModelPickerMenu harness selection', () => {
  const HARNESS_CATALOG: ModelCatalog = [
    {
      id: 'native-claude',
      label: 'Native Claude',
      provider: 'claude',
      source: 'claude',
      harness: 'claude',
      vendor: 'anthropic',
      kind: 'model',
      available: true,
    },
    {
      id: 'gateway-model',
      label: 'Gateway Model',
      provider: 'codex',
      source: 'ai-gateway',
      harness: 'codex',
      vendor: 'deepseek',
      kind: 'model',
      available: true,
    },
  ];

  function mountHarnessPicker(
    overrides: Partial<NonNullable<ModelPickerMenuProps['harnessTabs']>> = {},
  ): {
    root: Root;
    onSelect: jest.Mock;
    onModelHarnessChange: jest.Mock;
  } {
    const onSelect = jest.fn();
    const onModelHarnessChange = jest.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={HARNESS_CATALOG}
          currentModel="native-claude"
          onSelect={onSelect}
          testIdPrefix="hp"
          harnessTabs={{
            brandIcon: <span>U</span>,
            brandLabel: 'Brand',
            favoritesStorageKey: `test:harness-selection:${Math.random()}`,
            gatewayLayout: 'harnesses',
            allModelsTab: true,
            leadingFavorites: true,
            chrome: 'picker',
            runnableHarnesses: [
              { id: 'claude', connected: true },
              { id: 'codex', connected: true },
            ],
            supportedModelIds: {
              claude: ['gateway-model'],
              codex: ['gateway-model'],
            },
            onModelHarnessChange,
            ...overrides,
          }}
        />,
      ),
    );
    return { root, onSelect, onModelHarnessChange };
  }

  const visible = (testId: string): HTMLElement | null =>
    document.querySelector(`[data-testid="${testId}"]:not([hidden])`);
  // A pick closes the menu, so each step reopens it from the trigger first.
  const click = (testId: string): void => {
    if (!document.querySelector('[data-testid="hp-menu"]')) {
      act(() => queryByTestId('hp-picker')?.click());
    }
    act(() => visible(testId)?.click());
  };

  it('runs a native model on its own harness from All, whatever its saved default', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSelect = jest.fn();
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={[
            {
              ...HARNESS_CATALOG[0],
              // Its saved default harness is Cursor.
              harness: 'cursor',
            },
          ]}
          onSelect={onSelect}
          testIdPrefix="hp"
          harnessTabs={{
            brandIcon: <span>U</span>,
            brandLabel: 'Brand',
            favoritesStorageKey: `test:own-harness:${Math.random()}`,
            gatewayLayout: 'harnesses',
            allModelsTab: true,
            leadingFavorites: true,
            chrome: 'picker',
            runnableHarnesses: [
              { id: 'claude', connected: true },
              { id: 'cursor', connected: true },
            ],
            supportedModelIds: { cursor: ['native-claude'] },
            billing: {
              modelIds: new Set(['native-claude']),
              getPreference: () => ({
                payment: 'subscription',
                fallback: false,
              }),
              onChange: (): void => undefined,
            },
          }}
        />,
      ),
    );
    try {
      click('hp-harness-tab-all');
      expect(
        visible('hp-harness-control-native-claude')?.getAttribute(
          'data-harness',
        ),
      ).toBe('claude');
      click('hp-option-native-claude');
      expect(onSelect).toHaveBeenLastCalledWith('native-claude', {
        harness: 'claude',
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it("marks every row in a harness tab with that tab's harness", () => {
    const { root } = mountHarnessPicker();
    try {
      click('hp-harness-tab-claude');
      for (const id of ['native-claude', 'gateway-model']) {
        expect(
          visible(`hp-harness-icon-${id}`)?.getAttribute('data-harness'),
        ).toBe('claude');
      }
    } finally {
      act(() => root.unmount());
    }
  });

  it('marks a named search group as an explicit harness choice', () => {
    const { root, onSelect } = mountHarnessPicker();
    try {
      click('hp-harness-tab-all');
      const search = queryByTestId('hp-search');
      if (!(search instanceof HTMLInputElement))
        throw new Error('Missing search');
      act(() => {
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(search, 'Gateway');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const row = document.querySelector<HTMLElement>(
        '[role="group"][aria-label="Claude"] [data-testid="hp-option-gateway-model"]',
      );
      expect(row).not.toBeNull();
      act(() => row?.click());
      expect(onSelect).toHaveBeenCalledWith('gateway-model', {
        harness: 'claude',
        harnessExplicitlyChosen: true,
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it('reports the harness a non-native row runs on', () => {
    const { root, onSelect } = mountHarnessPicker();
    try {
      click('hp-harness-tab-claude');
      click('hp-option-gateway-model');
      expect(onSelect).toHaveBeenLastCalledWith('gateway-model', {
        harness: 'claude',
        harnessExplicitlyChosen: true,
      });
      click('hp-harness-tab-codex');
      click('hp-option-gateway-model');
      expect(onSelect).toHaveBeenLastCalledWith('gateway-model', {
        harness: 'codex',
        harnessExplicitlyChosen: true,
      });
      // A native row runs on its own harness; there is nothing to report.
      click('hp-harness-tab-claude');
      click('hp-option-native-claude');
      expect(onSelect).toHaveBeenLastCalledWith('native-claude');
    } finally {
      act(() => root.unmount());
    }
  });

  it('hands the All-tab harness choice to the host and selects on it', () => {
    const { root, onSelect, onModelHarnessChange } = mountHarnessPicker();
    try {
      click('hp-harness-tab-all');
      click('hp-harness-control-gateway-model');
      click('hp-settings-harness-claude-gateway-model');
      expect(onModelHarnessChange).toHaveBeenCalledWith(
        'gateway-model',
        'claude',
      );
      expect(onSelect).toHaveBeenLastCalledWith('gateway-model', {
        harness: 'claude',
      });
    } finally {
      act(() => root.unmount());
    }
  });

  it('hides the limits fallback when the host has no such setting', () => {
    const { root } = mountHarnessPicker({
      billing: {
        modelIds: new Set(['native-claude']),
        fallback: false,
        getPreference: () => ({ payment: 'subscription', fallback: false }),
        onChange: (): void => undefined,
      },
    });
    try {
      click('hp-harness-tab-claude');
      // The row's harness icon doubles as its settings trigger.
      click('hp-harness-control-native-claude');
      expect(visible('hp-billing-subscription-native-claude')).not.toBeNull();
      expect(visible('hp-billing-fallback-native-claude')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('ModelPickerMenu harness rail and status', () => {
  const CATALOG: ModelCatalog = [
    {
      id: 'native-claude',
      label: 'Native Claude',
      provider: 'claude',
      source: 'claude',
      vendor: 'anthropic',
      kind: 'model',
      available: true,
    },
    {
      id: 'cursor-only',
      label: 'Cursor Only',
      provider: 'cursor',
      source: 'cursor',
      kind: 'model',
      available: true,
    },
  ];

  afterEach(() => {
    document.body.innerHTML = '';
  });

  function mount(
    footer?: ModelPickerMenuProps['footer'],
    runnableHarnesses: NonNullable<
      ModelPickerMenuProps['harnessTabs']
    >['runnableHarnesses'] = [
      { id: 'claude', connected: true },
      { id: 'cursor', connected: true },
    ],
  ): Root {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={CATALOG}
          onSelect={(): void => undefined}
          testIdPrefix="hr"
          footer={footer}
          harnessTabs={{
            brandIcon: <span>U</span>,
            brandLabel: 'Brand',
            favoritesStorageKey: `test:harness-rail:${Math.random()}`,
            gatewayLayout: 'harnesses',
            allModelsTab: true,
            leadingFavorites: true,
            chrome: 'picker',
            runnableHarnesses,
          }}
        />,
      ),
    );
    act(() => queryByTestId('hr-picker')?.click());
    return root;
  }

  it('puts connected harnesses above ones still to set up', () => {
    const root = mount(undefined, [
      { id: 'claude', connected: true },
      { id: 'copilot', connected: false },
      { id: 'codex', connected: false },
      { id: 'cursor', connected: true },
    ]);
    try {
      const tabs = Array.from(
        document.querySelectorAll('[data-testid^="hr-harness-tab-"]'),
        (tab) =>
          tab.getAttribute('data-testid')?.slice('hr-harness-tab-'.length),
      );
      expect(tabs).toEqual([
        'favorites',
        'all',
        'claude',
        'cursor',
        'copilot',
        'codex',
      ]);
    } finally {
      act(() => root.unmount());
    }
  });

  const visible = (testId: string): HTMLElement | null =>
    document.querySelector(`[data-testid="${testId}"]:not([hidden])`);
  const visibleStatus = (): HTMLElement | undefined =>
    Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="cursor-status"]'),
    ).find((node) => node.closest('[hidden]') === null);

  function mountWithStatus(catalog: ModelCatalog): Root {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={catalog}
          onSelect={(): void => undefined}
          testIdPrefix="hr"
          harnessTabs={{
            brandIcon: <span>U</span>,
            brandLabel: 'Brand',
            favoritesStorageKey: `test:harness-status:${Math.random()}`,
            gatewayLayout: 'harnesses',
            allModelsTab: true,
            leadingFavorites: true,
            chrome: 'picker',
            runnableHarnesses: [
              { id: 'claude', connected: true },
              { id: 'cursor', connected: true },
            ],
            harnessStatus: {
              cursor: <span data-testid="cursor-status">Loading</span>,
            },
          }}
        />,
      ),
    );
    act(() => queryByTestId('hr-picker')?.click());
    return root;
  }

  function mountSelecting(
    currentModel: string,
    storageKey: string,
    props: Partial<ModelPickerMenuProps> = {},
  ): { root: Root; onSelect: jest.Mock } {
    const onSelect = jest.fn();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={CATALOG}
          currentModel={currentModel}
          onSelect={onSelect}
          testIdPrefix="hr"
          harnessTabs={{
            brandIcon: <span>U</span>,
            brandLabel: 'Brand',
            favoritesStorageKey: storageKey,
            gatewayLayout: 'harnesses',
            allModelsTab: true,
            leadingFavorites: true,
            chrome: 'picker',
            runnableHarnesses: [
              { id: 'claude', connected: true },
              { id: 'cursor', connected: true },
            ],
          }}
          {...props}
        />,
      ),
    );
    act(() => queryByTestId('hr-picker')?.click());
    return { root, onSelect };
  }

  it.each(['trigger', 'external trigger', 'host callback'] as const)(
    'returns focus to the %s after a harness model selection',
    (destination) => {
      const hostTarget = document.createElement('button');
      document.body.append(hostTarget);
      const onRestoreFocus = jest.fn(() => hostTarget.focus());
      const externalTriggerRef = { current: hostTarget };
      const { root, onSelect } = mountSelecting(
        'native-claude',
        `test:restore-focus:${destination}`,
        destination === 'host callback' ? { onRestoreFocus } : {},
      );
      try {
        if (destination === 'external trigger') {
          act(() =>
            root.render(
              <ModelPickerMenu
                catalog={CATALOG}
                onSelect={onSelect}
                externalTriggerRef={externalTriggerRef}
                testIdPrefix="hr"
                harnessTabs={{
                  brandIcon: <span>U</span>,
                  brandLabel: 'Brand',
                  allModelsTab: true,
                }}
              />,
            ),
          );
        }
        const trigger = queryByTestId('hr-picker');
        const row = visible('hr-option-native-claude');
        expect(row).not.toBeNull();
        act(() => row?.focus());
        expect(document.activeElement).toBe(row);
        act(() => row?.click());
        act(() => jest.runAllTicks());
        expect(onSelect).toHaveBeenCalled();
        expect(queryByTestId('hr-menu')).toBeNull();
        expect(document.activeElement).toBe(
          destination === 'trigger' ? trigger : hostTarget,
        );
        expect(onRestoreFocus).toHaveBeenCalledTimes(
          destination === 'host callback' ? 1 : 0,
        );
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('reopens on the tab the current model was picked from', () => {
    const storageKey = `test:selection-tab:${Math.random()}`;
    const first = mountSelecting('native-claude', storageKey);
    try {
      act(() => visible('hr-harness-tab-cursor')?.click());
      act(() => visible('hr-option-cursor-only')?.click());
      expect(first.onSelect).toHaveBeenCalled();
      // A later tab click does not move where the pick was made.
      act(() => queryByTestId('hr-picker')?.click());
      act(() => visible('hr-harness-tab-claude')?.click());
    } finally {
      act(() => first.root.unmount());
      document.body.innerHTML = '';
    }
    const picked = mountSelecting('cursor-only', storageKey);
    try {
      expect(
        visible('hr-harness-tab-cursor')?.getAttribute('aria-checked'),
      ).toBe('true');
    } finally {
      act(() => picked.root.unmount());
      document.body.innerHTML = '';
    }
    // Another current model falls back to the last tab clicked.
    const other = mountSelecting('native-claude', storageKey);
    try {
      expect(
        visible('hr-harness-tab-claude')?.getAttribute('aria-checked'),
      ).toBe('true');
    } finally {
      act(() => other.root.unmount());
    }
  });

  it.each(['Escape', 'Tab'])(
    'keeps the floating layer focus behavior for %s dismissal',
    (key) => {
      const { root } = mountSelecting('native-claude', `test:dismiss:${key}`);
      try {
        const trigger = queryByTestId('hr-picker');
        const search = queryByTestId('hr-search');
        act(() => search?.focus());
        act(() => {
          search?.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true }),
          );
        });
        act(() => jest.runAllTicks());
        expect(queryByTestId('hr-menu')).toBeNull();
        if (key === 'Escape') expect(document.activeElement).toBe(trigger);
        else expect(document.activeElement).not.toBe(trigger);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('scrolls the selected row into view on open', () => {
    jest.useFakeTimers();
    const rect = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 200,
        width: 200,
        x: 0,
        y: top,
      }) as DOMRect;
    const spy = jest
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute('data-model-id')
          ? rect(500, 32)
          : rect(0, 200);
      });
    const clientHeight = jest
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockReturnValue(200);
    const { root } = mountSelecting(
      'cursor-only',
      `test:scroll:${Math.random()}`,
    );
    try {
      act(() => visible('hr-harness-tab-all')?.click());
      act(() => queryByTestId('hr-picker')?.click());
      act(() => queryByTestId('hr-picker')?.click());
      act(() => {
        jest.runOnlyPendingTimers();
      });
      const list = document.querySelector<HTMLElement>(
        '.canopy-picker-menu-list',
      );
      // Row top 500 in a 200px list: centered at 500 - (200 - 32) / 2.
      expect(list?.scrollTop).toBe(416);
    } finally {
      act(() => root.unmount());
      spy.mockRestore();
      clientHeight.mockRestore();
      jest.useRealTimers();
    }
  });

  it("shows a harness's status only in its own section", () => {
    const root = mountWithStatus(CATALOG);
    try {
      act(() => visible('hr-harness-tab-all')?.click());
      expect(
        visibleStatus()
          ?.closest('[role="group"]')
          ?.querySelector('[data-testid="hr-option-cursor-only"]'),
      ).not.toBeNull();
      act(() => visible('hr-harness-tab-claude')?.click());
      expect(visibleStatus()).toBeUndefined();
      act(() => visible('hr-harness-tab-cursor')?.click());
      expect(visibleStatus()).toBeDefined();
    } finally {
      act(() => root.unmount());
    }
  });

  it('shows the status atop its tab before the harness lists any model', () => {
    const root = mountWithStatus(
      CATALOG.filter((option) => option.provider !== 'cursor'),
    );
    try {
      act(() => visible('hr-harness-tab-cursor')?.click());
      expect(visibleStatus()).toBeDefined();
    } finally {
      act(() => root.unmount());
    }
  });

  it('names the harness of every row in All, Cursor-only models included', () => {
    const root = mountWithStatus(CATALOG);
    try {
      act(() => visible('hr-harness-tab-all')?.click());
      expect(
        visible('hr-harness-icon-cursor-only')?.getAttribute('data-harness'),
      ).toBe('cursor');
      expect(
        visible('hr-harness-icon-native-claude')?.getAttribute('data-harness'),
      ).toBe('claude');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('ModelPickerMenu single list', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const harnessCatalog: ModelCatalog = [
    {
      id: 'hosted-deepseek',
      label: 'DeepSeek V4',
      provider: 'codex',
      source: 'ai-gateway',
      vendor: 'deepseek',
      kind: 'model',
      available: true,
    },
    {
      id: 'claude-opus',
      label: 'Claude Opus',
      provider: 'claude',
      source: 'claude',
      vendor: 'anthropic',
      kind: 'model',
      available: true,
    },
    {
      id: 'codex-pro',
      label: 'Codex Pro',
      provider: 'codex',
      source: 'codex',
      vendor: 'openai',
      kind: 'model',
      available: true,
    },
  ];

  function mountPicker(props: Partial<ModelPickerMenuProps> = {}): Root {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={harnessCatalog}
          onSelect={(): void => undefined}
          {...props}
        />,
      ),
    );
    act(() => queryByTestId('model-picker')?.click());
    return root;
  }

  it('renders every harness in one list, with no tabs, search, or favorites', () => {
    const root = mountPicker();
    // All three sources are reachable at once, which is the whole point of a
    // single list: no view has to be switched to before a model is visible.
    expect(queryByTestId('model-option-hosted-deepseek')).not.toBeNull();
    expect(queryByTestId('model-option-claude-opus')).not.toBeNull();
    expect(queryByTestId('model-option-codex-pro')).not.toBeNull();
    expect(
      document.querySelectorAll('[data-testid^="model-harness-tab-"]'),
    ).toHaveLength(0);
    expect(queryByTestId('model-search')).toBeNull();
    expect(
      document.querySelectorAll('[data-testid^="model-favorite-"]'),
    ).toHaveLength(0);
    act(() => root.unmount());
  });

  it.each(['click', 'Enter', ' '] as const)(
    'offers the Cursor experimental help in its section and keeps the picker open on %s',
    (activation) => {
      // The experimental help that explains Cursor's current limits belongs to
      // the Cursor section, reachable as a menu item, and is informational
      // only: using it never selects anything or closes the menu.
      const onSelect = jest.fn();
      const root = mountPicker({
        onSelect,
        catalog: [
          ...harnessCatalog,
          {
            id: 'cursor-default',
            label: 'Default',
            provider: 'cursor',
            kind: 'model',
            available: true,
          },
        ],
      });
      try {
        const group = document.querySelector(
          '[role="group"][aria-label="Cursor"]',
        );
        expect(group).not.toBeNull();
        const help = group?.querySelector<HTMLElement>(
          '[data-testid="model-experimental-cursor"]',
        );
        expect(help?.getAttribute('role')).toBe('menuitem');
        expect(help?.getAttribute('aria-label')).toBe(
          'Cursor experimental features',
        );
        act(() => help?.focus());
        act(() => {
          if (activation === 'click') help?.click();
          else
            help?.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: activation,
                bubbles: true,
                cancelable: true,
              }),
            );
        });
        expect(queryByTestId('model-menu')).not.toBeNull();
        expect(document.activeElement).toBe(help);
        expect(onSelect).not.toHaveBeenCalled();
        act(() => queryByTestId('model-option-cursor-default')?.click());
        expect(onSelect).toHaveBeenCalledWith('cursor-default');
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('reaches the Cursor experimental help by keyboard from its section', () => {
    // Menu navigation up from the Cursor section's first row reaches its help,
    // wherever the section sits in the list.
    const root = mountPicker({
      catalog: [
        ...harnessCatalog,
        {
          id: 'cursor-default',
          label: 'Default',
          provider: 'cursor',
          kind: 'model',
          available: true,
        },
        {
          id: 'cursor-other',
          label: 'Other',
          provider: 'cursor',
          kind: 'model',
          available: true,
        },
      ],
    });
    try {
      act(() => queryByTestId('model-option-cursor-default')?.focus());
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'ArrowUp',
            bubbles: true,
            cancelable: true,
          }),
        );
      });
      expect(document.activeElement).toBe(
        queryByTestId('model-experimental-cursor'),
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('allows returning a configured model to the workspace default', () => {
    const onSelectWorkspaceDefault = jest.fn();
    const root = mountPicker({
      currentModel: 'claude-opus',
      allowWorkspaceDefault: true,
      workspaceDefaultLabel: 'Workspace default',
      onSelectWorkspaceDefault,
    });
    const defaultRow = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((row) => row.textContent?.includes('Workspace default'));
    expect(defaultRow).toBeDefined();
    act(() => defaultRow?.click());
    expect(onSelectWorkspaceDefault).toHaveBeenCalledTimes(1);
    expect(queryByTestId('model-menu')).toBeNull();
    act(() => root.unmount());
  });

  it('reopens at the top of the list', () => {
    // The menu surface is rebuilt on each open, so a scrolled list cannot
    // carry its offset into the next open. Asserted on the real elements
    // rather than trusted, since the reopened node is what the user sees.
    const root = mountPicker();
    const viewport = queryByTestId('model-option-hosted-deepseek')?.closest(
      '.overflow-y-auto',
    );
    if (!(viewport instanceof HTMLElement)) {
      throw new Error('Expected the model list viewport');
    }
    viewport.scrollTop = 500;
    act(() => queryByTestId('model-picker')?.click());
    expect(queryByTestId('model-menu')).toBeNull();
    act(() => queryByTestId('model-picker')?.click());
    const reopened = queryByTestId('model-option-hosted-deepseek')?.closest(
      '.overflow-y-auto',
    );
    if (!(reopened instanceof HTMLElement)) {
      throw new Error('Expected the reopened model list viewport');
    }
    expect(reopened).not.toBe(viewport);
    expect(reopened.scrollTop).toBe(0);
    act(() => root.unmount());
  });
});

describe('ModelPickerMenu picker chrome placement', () => {
  it('opens the harness browser 8px left of its trigger', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={CATALOG}
          onSelect={(): void => undefined}
          testIdPrefix="nudge"
          harnessTabs={{
            brandIcon: <span>U</span>,
            brandLabel: 'Brand',
            gatewayLayout: 'harnesses',
            chrome: 'picker',
          }}
        />,
      ),
    );
    try {
      const anchor = container.querySelector(
        '[data-testid="nudge-menu-anchor"]',
      );
      expect(anchor?.className.split(/\s+/)).toContain('-left-2');
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('library-locked rows', () => {
  const LOCK_CATALOG: ModelCatalog = [
    {
      id: 'a-locked',
      label: 'A Locked',
      provider: 'claude',
      kind: 'model',
      available: true,
    },
    {
      id: 'b-open',
      label: 'B Open',
      provider: 'claude',
      kind: 'model',
      available: true,
    },
    {
      id: 'c-policy',
      label: 'C Policy',
      provider: 'claude',
      kind: 'model',
      available: true,
    },
  ];
  const HINT = 'Unlock with AI Credit purchase';

  function mountLocked(
    onUnlock: () => void,
    onSelect: (modelId: string) => void,
  ): Root {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root: Root = createRoot(container);
    const getOptionState = (
      option: ModelCatalogOption,
    ): ModelPickerOptionState => {
      if (option.id === 'a-locked')
        return { disabled: false, locked: { hint: HINT, onUnlock } };
      // A restriction unlocking cannot fix keeps its own reason.
      if (option.id === 'c-policy')
        return {
          disabled: true,
          unavailableReason: 'Turned off by your organization',
          locked: { hint: HINT, onUnlock },
        };
      return { disabled: false };
    };
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={LOCK_CATALOG}
          onSelect={onSelect}
          getOptionState={getOptionState}
        />,
      ),
    );
    act(() => queryByTestId('model-picker')?.click());
    return root;
  }

  it('starts recovery instead of selecting, and exposes the hint', () => {
    const onUnlock = jest.fn();
    const onSelect = jest.fn();
    const root = mountLocked(onUnlock, onSelect);

    const row = queryByTestId('model-option-a-locked');
    expect(row).toHaveProperty('disabled', false);
    expect(row?.getAttribute('role')).toBe('menuitem');
    expect(row?.getAttribute('aria-checked')).toBeNull();
    const describedBy = row?.getAttribute('aria-describedby') ?? '';
    expect(
      describedBy
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent),
    ).toContain(HINT);
    expect(queryByTestId('model-option-unlock-a-locked')).not.toBeNull();

    act(() => row?.click());
    expect(onUnlock).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(queryByTestId('model-menu')).toBeNull();
    act(() => root.unmount());
  });

  it('sorts usable rows ahead of locked ones in a section', () => {
    const root = mountLocked(jest.fn(), jest.fn());
    const ids = Array.from(document.querySelectorAll('[data-model-id]')).map(
      (row) => row.getAttribute('data-model-id'),
    );
    expect(ids.indexOf('b-open')).toBeLessThan(ids.indexOf('a-locked'));
    act(() => root.unmount());
  });

  it('keeps a disabled row disabled even when it is also locked', () => {
    const onUnlock = jest.fn();
    const root = mountLocked(onUnlock, jest.fn());
    const row = queryByTestId('model-option-c-policy');
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(queryByTestId('model-option-unlock-c-policy')).toBeNull();
    act(() => row?.click());
    expect(onUnlock).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});

describe('sign-in labels on library-locked rows (CAN-4705)', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = '';
  });

  const SIGN_IN_HINT = 'Unlock with sign-in and AI Credit purchase';
  const PURCHASE_HINT = 'Unlock with AI Credit purchase';
  const GATED_CATALOG: ModelCatalog = [
    {
      id: 'gated',
      label: 'Gated Model',
      provider: 'codex',
      source: 'ai-gateway',
      vendor: 'deepseek',
      kind: 'model',
      available: true,
      description: 'A model that needs an account',
    },
    {
      id: 'allowed',
      label: 'Allowed Model',
      provider: 'codex',
      source: 'ai-gateway',
      vendor: 'deepseek',
      kind: 'model',
      available: true,
      description: 'A model available to guests',
    },
    {
      id: 'policy',
      label: 'Policy Model',
      provider: 'codex',
      source: 'ai-gateway',
      vendor: 'deepseek',
      kind: 'model',
      available: true,
    },
  ];

  type GatedLock = NonNullable<ModelPickerOptionState['locked']>;

  function stateFor(
    lock: GatedLock | undefined,
  ): (option: ModelCatalogOption) => ModelPickerOptionState {
    return (option) => {
      if (option.id === 'gated') {
        return lock ? { disabled: false, locked: lock } : { disabled: false };
      }
      if (option.id === 'policy') {
        return {
          disabled: true,
          unavailableReason: 'Turned off by your organization',
          locked: { hint: SIGN_IN_HINT, label: 'Sign in', onUnlock: jest.fn() },
        };
      }
      return { disabled: false };
    };
  }

  // Only the harness picker carries the credits tag; the flat list marks
  // credits-only rows with `$` instead.
  const PICKER_TABS: ModelPickerMenuProps['harnessTabs'] = {
    brandIcon: <span>U</span>,
    brandLabel: 'Test brand',
    gatewayLayout: 'harnesses',
    chrome: 'picker',
    allModelsTab: true,
    favoritesStorageKey: 'test:can-4705',
  };

  function openGatewayTab(): void {
    act(() => queryByTestId('model-harness-tab-all')?.click());
  }

  function renderMenu(
    root: Root,
    lock: GatedLock | undefined,
    {
      picker = false,
      onSelect = jest.fn(),
      libraryAccess,
    }: {
      readonly picker?: boolean;
      readonly onSelect?: (modelId: string) => void;
      readonly libraryAccess?: ModelPickerMenuProps['libraryAccess'];
    } = {},
  ): void {
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={GATED_CATALOG}
          onSelect={onSelect}
          getOptionState={stateFor(lock)}
          harnessTabs={picker ? PICKER_TABS : undefined}
          libraryAccess={libraryAccess}
        />,
      ),
    );
  }

  function mountMenu(
    lock: GatedLock | undefined,
    options: Parameters<typeof renderMenu>[2] = {},
  ): Root {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    renderMenu(root, lock, options);
    act(() => queryByTestId('model-picker')?.click());
    if (options.picker) openGatewayTab();
    return root;
  }

  it('shows the label beside the lock instead of the credits tag', () => {
    const root = mountMenu(
      { hint: SIGN_IN_HINT, label: 'Sign in', onUnlock: jest.fn() },
      { picker: true },
    );
    try {
      const label = queryByTestId('model-option-lock-label-gated');
      expect(label?.textContent).toBe('Sign in');
      expect(label?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['text-2xs', 'fg-secondary']),
      );
      const group = label?.parentElement;
      expect(group?.getAttribute('aria-hidden')).toBe('true');
      expect(group?.className.split(/\s+/)).toEqual(
        expect.arrayContaining(['inline-flex', 'items-center', 'gap-1']),
      );
      expect(group?.contains(queryByTestId('model-option-unlock-gated'))).toBe(
        true,
      );
      expect(queryByTestId('model-row-credits-gated')).toBeNull();
      expect(queryByTestId('model-credits-area-gated')).toBeNull();
      // Allowed rows keep their tag and get no lock.
      expect(queryByTestId('model-row-credits-allowed')?.textContent).toBe(
        'AI Credits',
      );
      expect(queryByTestId('model-option-unlock-allowed')).toBeNull();
      expect(queryByTestId('model-option-lock-label-allowed')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps the full hint as the accessible description, not the label', () => {
    const root = mountMenu({
      hint: SIGN_IN_HINT,
      label: 'Sign in',
      onUnlock: jest.fn(),
    });
    try {
      const row = queryByTestId('model-option-gated');
      const descriptions = (row?.getAttribute('aria-describedby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent);
      expect(descriptions).toContain(SIGN_IN_HINT);
      expect(row?.getAttribute('role')).toBe('menuitem');
    } finally {
      act(() => root.unmount());
    }
  });

  it('draws the lock at the row glyph size in the secondary ink', () => {
    const root = mountMenu({ hint: PURCHASE_HINT, onUnlock: jest.fn() });
    try {
      const lock = queryByTestId('model-option-unlock-gated');
      expect(lock?.getAttribute('width')).toBe('14px');
      expect(lock?.getAttribute('height')).toBe('14px');
      expect(lock?.getAttribute('class')?.split(/\s+/)).toContain(
        'fg-secondary',
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps the credits tag on an unlabeled purchase lock', () => {
    const root = mountMenu(
      { hint: PURCHASE_HINT, onUnlock: jest.fn() },
      { picker: true },
    );
    try {
      expect(queryByTestId('model-option-unlock-gated')).not.toBeNull();
      expect(queryByTestId('model-option-lock-label-gated')).toBeNull();
      expect(queryByTestId('model-row-credits-gated')?.textContent).toBe(
        'AI Credits',
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('shows neither lock nor label on a disabled row', () => {
    const root = mountMenu({
      hint: SIGN_IN_HINT,
      label: 'Sign in',
      onUnlock: jest.fn(),
    });
    try {
      expect(queryByTestId('model-option-unlock-policy')).toBeNull();
      expect(queryByTestId('model-option-lock-label-policy')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps extra-charge markers and Auto copy alongside a labeled non-credits row', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={GATED_CATALOG.map((option) => ({
            ...option,
            extraChargeOnly: true,
          }))}
          onSelect={jest.fn()}
          getOptionState={stateFor({
            hint: SIGN_IN_HINT,
            label: 'Sign in',
            onUnlock: jest.fn(),
          })}
          autoOption={{ selected: true, onSelect: jest.fn() }}
        />,
      ),
    );
    act(() => queryByTestId('model-picker')?.click());
    try {
      expect(queryByTestId('model-option-lock-label-gated')?.textContent).toBe(
        'Sign in',
      );
      expect(
        queryByTestId('model-option-extra-charge-gated')?.textContent,
      ).toBe('$');
      // CAN-5213: the lock trails its label and every other marker, so state
      // icons form one column beside the harness icon.
      expectStateIconLast(
        'gated',
        queryByTestId('model-option-unlock-gated'),
        queryByTestId('model-option-lock-label-gated'),
      );
      expect(queryByTestId('model-row-credits-gated')).toBeNull();
      expect(
        queryByTestId('model-option-gated')?.querySelectorAll(
          '[data-testid="model-option-unlock-gated"]',
        ),
      ).toHaveLength(1);
      expect(queryByTestId('model-option-auto')?.textContent).toContain('Auto');
      expect(queryByTestId('model-option-auto')?.textContent).not.toContain(
        'Sign in',
      );
    } finally {
      act(() => root.unmount());
    }
  });

  describe('CAN-5028 free credits tag', () => {
    it('tags only available credit rows Free AI Credits before purchase', () => {
      const root = mountMenu(
        { hint: PURCHASE_HINT, onUnlock: jest.fn() },
        { picker: true, libraryAccess: 'needs_purchase' },
      );
      try {
        expect(queryByTestId('model-row-credits-allowed')?.textContent).toBe(
          'Free AI Credits',
        );
        // CAN-5213: the free tag says the row runs now, so its check trails
        // it like every other state icon.
        expectStateIconLast(
          'allowed',
          queryByTestId('model-row-credits-check-allowed'),
          queryByTestId('model-row-credits-allowed'),
        );
        // A purchase-locked row keeps its plain tag and its lock.
        expect(queryByTestId('model-row-credits-gated')?.textContent).toBe(
          'AI Credits',
        );
        expect(queryByTestId('model-row-credits-check-gated')).toBeNull();
        expect(queryByTestId('model-option-unlock-gated')).not.toBeNull();
      } finally {
        act(() => root.unmount());
      }
    });

    it('lets a replacement lock label win over the free tag', () => {
      const root = mountMenu(
        { hint: SIGN_IN_HINT, label: 'Sign in', onUnlock: jest.fn() },
        { picker: true, libraryAccess: 'needs_sign_in_then_purchase' },
      );
      try {
        expect(
          queryByTestId('model-option-lock-label-gated')?.textContent,
        ).toBe('Sign in');
        expect(queryByTestId('model-row-credits-gated')).toBeNull();
        expect(queryByTestId('model-row-credits-allowed')?.textContent).toBe(
          'Free AI Credits',
        );
      } finally {
        act(() => root.unmount());
      }
    });

    it.each(['unlocked', 'needs_sign_in', undefined] as const)(
      'keeps the plain tag for %s access',
      (libraryAccess) => {
        const root = mountMenu(undefined, { picker: true, libraryAccess });
        try {
          expect(queryByTestId('model-row-credits-allowed')?.textContent).toBe(
            'AI Credits',
          );
          expect(queryByTestId('model-row-credits-gated')?.textContent).toBe(
            'AI Credits',
          );
          expect(
            document.body.querySelector(
              '[data-testid^="model-row-credits-check-"]',
            ),
          ).toBeNull();
        } finally {
          act(() => root.unmount());
        }
      },
    );

    it('adds no tag to the flat list', () => {
      const root = mountMenu(undefined, { libraryAccess: 'needs_purchase' });
      try {
        expect(
          document.body.querySelector('[data-testid^="model-row-credits-"]'),
        ).toBeNull();
      } finally {
        act(() => root.unmount());
      }
    });

    it('follows a purchase without a remount', () => {
      const container = document.createElement('div');
      document.body.appendChild(container);
      const root = createRoot(container);
      const lock = { hint: PURCHASE_HINT, onUnlock: jest.fn() };
      renderMenu(root, lock, { picker: true, libraryAccess: 'needs_purchase' });
      act(() => queryByTestId('model-picker')?.click());
      openGatewayTab();
      try {
        expect(queryByTestId('model-row-credits-allowed')?.textContent).toBe(
          'Free AI Credits',
        );
        expect(queryByTestId('model-option-unlock-gated')).not.toBeNull();
        renderMenu(root, undefined, {
          picker: true,
          libraryAccess: 'unlocked',
        });
        expect(queryByTestId('model-option-unlock-gated')).toBeNull();
        expect(queryByTestId('model-row-credits-allowed')?.textContent).toBe(
          'AI Credits',
        );
        expect(queryByTestId('model-row-credits-gated')?.textContent).toBe(
          'AI Credits',
        );
      } finally {
        act(() => root.unmount());
      }
    });
  });

  it('drops a stale label when access changes without a remount', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const picker = { picker: true };
    renderMenu(
      root,
      { hint: SIGN_IN_HINT, label: 'Sign in', onUnlock: jest.fn() },
      picker,
    );
    act(() => queryByTestId('model-picker')?.click());
    try {
      expect(queryByTestId('model-option-lock-label-gated')).not.toBeNull();
      expect(queryByTestId('model-row-credits-gated')).toBeNull();
      renderMenu(root, { hint: PURCHASE_HINT, onUnlock: jest.fn() }, picker);
      expect(queryByTestId('model-option-lock-label-gated')).toBeNull();
      expect(queryByTestId('model-row-credits-gated')).not.toBeNull();
      renderMenu(root, undefined, picker);
      expect(queryByTestId('model-option-unlock-gated')).toBeNull();
      expect(queryByTestId('model-option-lock-label-gated')).toBeNull();
      expect(queryByTestId('model-row-credits-gated')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('starts recovery once and never selects the locked model', () => {
    const onUnlock = jest.fn();
    const onSelect = jest.fn();
    const root = mountMenu(
      { hint: SIGN_IN_HINT, label: 'Sign in', onUnlock },
      { onSelect },
    );
    try {
      act(() => queryByTestId('model-option-gated')?.click());
      expect(onUnlock).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it('leads the keyboard detail with the hint over a resting pointer', () => {
    const root = mountMenu({
      hint: SIGN_IN_HINT,
      label: 'Sign in',
      onUnlock: jest.fn(),
    });
    try {
      hoverOption('allowed');
      act((): void => {
        queryByTestId('model-menu')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      });
      const details = document.querySelectorAll(
        '[data-testid="model-option-detail"]',
      );
      expect(details).toHaveLength(1);
      const first = details[0]?.firstElementChild;
      expect(first?.textContent).toBe(SIGN_IN_HINT);
      expect(first?.className ?? '').not.toContain('fg-secondary');
      expect(first?.className ?? '').not.toContain('opacity');
      expect(details[0]?.textContent).toContain(
        'A model that needs an account',
      );

      act((): void => {
        queryByTestId('model-menu')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Home', bubbles: true }),
        );
      });
      expect(
        document.querySelector('[data-testid="model-option-detail"]')
          ?.textContent ?? '',
      ).not.toContain(SIGN_IN_HINT);
    } finally {
      act(() => root.unmount());
    }
  });

  function pointerMove(target: Element | null, movement: number): void {
    const event = new MouseEvent('pointermove', { bubbles: true });
    Object.defineProperty(event, 'movementX', { value: movement });
    Object.defineProperty(event, 'movementY', { value: 0 });
    target?.dispatchEvent(event);
  }

  function scrollList(row: Element | null, scrollTop: number): void {
    const list = row?.closest('[role="presentation"].overflow-x-hidden');
    if (!list) throw new Error('model list missing');
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      value: scrollTop,
    });
    list.dispatchEvent(new Event('scroll'));
  }

  function highlightFirstRowByKeyboard(): string {
    const search = queryByTestId('model-search');
    act((): void => {
      search?.focus();
      search?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });
    const focusedId =
      document.activeElement?.getAttribute('data-model-id') ?? '';
    expect(['gated', 'allowed']).toContain(focusedId);
    expect(queryByTestId(`model-option-detail-${focusedId}`)).not.toBeNull();
    return focusedId;
  }

  it('opens a hovered row card after a keyboard highlight and a late scroll event', () => {
    const root = mountMenu(undefined, { picker: true });
    try {
      const focusedId = highlightFirstRowByKeyboard();
      const target = focusedId === 'gated' ? 'allowed' : 'gated';
      const row = queryByTestId(`model-option-${target}`);
      // Scrolling a row into view and then pointing at it: Chromium reports
      // the scroll a frame later, after the pointer already entered the row.
      act((): void => {
        Object.defineProperty(
          row?.closest('[role="presentation"].overflow-x-hidden') ?? {},
          'scrollTop',
          { configurable: true, value: 104 },
        );
        row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        pointerMove(row, 12);
        row?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      });
      act(() => scrollList(row, 104));
      act(() => jest.advanceTimersByTime(200));
      expect(queryByTestId(`model-option-detail-${target}`)).not.toBeNull();
      expect(queryByTestId(`model-option-detail-${focusedId}`)).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('still holds hover cards while the list scrolls under a resting pointer', () => {
    const root = mountMenu(undefined, { picker: true });
    try {
      const row = queryByTestId('model-option-allowed');
      act((): void => {
        row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        pointerMove(row, 12);
      });
      act(() => scrollList(row, 40));
      act(() => jest.advanceTimersByTime(200));
      expect(queryByTestId('model-option-detail-allowed')).toBeNull();
      act(() => pointerMove(row, 3));
      act((): void => {
        row?.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
      });
      act(() => jest.advanceTimersByTime(200));
      expect(queryByTestId('model-option-detail-allowed')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it('closes the detail with the menu on Escape', () => {
    const root = mountMenu({
      hint: SIGN_IN_HINT,
      label: 'Sign in',
      onUnlock: jest.fn(),
    });
    try {
      act((): void => {
        queryByTestId('model-menu')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
        );
      });
      expect(queryByTestId('model-option-detail')).not.toBeNull();
      act((): void => {
        queryByTestId('model-menu')?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
      });
      expect(queryByTestId('model-menu')).toBeNull();
      expect(queryByTestId('model-option-detail')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });

  it.each([false, true])(
    'coordinates real keyboard navigation and hover (picker=%s)',
    (picker) => {
      const onUnlock = jest.fn();
      const onSelect = jest.fn();
      // Establish pointer modality before the menu programmatically focuses
      // its initial row. Opening by pointer must not show that row's detail.
      act(() => {
        document.body.dispatchEvent(
          new MouseEvent('mousedown', { bubbles: true }),
        );
      });
      const root = mountMenu(
        { hint: SIGN_IN_HINT, label: 'Sign in', onUnlock },
        { picker, onSelect },
      );
      const details = (): Element[] =>
        Array.from(
          document.querySelectorAll('[data-testid^="model-option-detail"]'),
        );
      const press = (key: string): void => {
        act(() => {
          document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key, bubbles: true }),
          );
          jest.advanceTimersByTime(250);
        });
      };
      const navigateTo = (id: string): void => {
        press('Home');
        for (let step = 0; step < 30; step += 1) {
          if (document.activeElement === queryByTestId(`model-option-${id}`))
            return;
          press('ArrowDown');
        }
        throw new Error(`Keyboard navigation did not reach ${id}`);
      };
      try {
        act(() => jest.advanceTimersByTime(250));
        expect(details()).toHaveLength(0);
        hoverOption('allowed');
        act(() => jest.advanceTimersByTime(250));
        expect(details()).toHaveLength(1);
        navigateTo('gated');
        expect(details()).toHaveLength(1);
        expect(details()[0]?.textContent).toContain(SIGN_IN_HINT);
        act(() => {
          queryByTestId('model-option-allowed')?.dispatchEvent(
            new MouseEvent('mousemove', { bubbles: true }),
          );
          jest.advanceTimersByTime(250);
        });
        expect(details()).toHaveLength(1);
        expect(details()[0]?.textContent).not.toContain(SIGN_IN_HINT);
        act(() => {
          queryByTestId('model-option-allowed')?.dispatchEvent(
            new MouseEvent('mouseout', { bubbles: true }),
          );
        });
        // Releasing hover restores the row still highlighted by keyboard.
        expect(details()).toHaveLength(1);
        expect(details()[0]?.textContent).toContain(SIGN_IN_HINT);
        navigateTo('allowed');
        expect(details()).toHaveLength(1);
        expect(details()[0]?.textContent).not.toContain(SIGN_IN_HINT);
        hoverOption('gated');
        act(() => jest.advanceTimersByTime(250));
        expect(details()).toHaveLength(1);
        expect(details()[0]?.textContent).toContain(SIGN_IN_HINT);
        // Access updates must update the open card without a remount.
        renderMenu(root, undefined, { picker, onSelect });
        expect(details()[0]?.textContent).not.toContain(SIGN_IN_HINT);
        press('Escape');
        expect(queryByTestId('model-menu')).toBeNull();
        expect(details()).toHaveLength(0);

        renderMenu(
          root,
          { hint: SIGN_IN_HINT, label: 'Sign in', onUnlock },
          { picker, onSelect },
        );
        act(() => queryByTestId('model-picker')?.click());
        act(() => jest.advanceTimersByTime(250));
        navigateTo('gated');
        press('Enter');
        // jsdom does not synthesize a native button's Enter click. The
        // harness layout leaves activation to the browser; the flat menu
        // implements it itself and prevents the default.
        if (picker) act(() => queryByTestId('model-option-gated')?.click());
        expect(onUnlock).toHaveBeenCalledTimes(1);
        expect(onSelect).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('honors tooltip dismissal outside the menu and resumes on keyboard navigation', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <TooltipProvider stacking="single">
          <ModelPickerMenu
            catalog={GATED_CATALOG}
            onSelect={jest.fn()}
            harnessTabs={PICKER_TABS}
            getOptionState={stateFor({
              hint: SIGN_IN_HINT,
              label: 'Sign in',
              onUnlock: jest.fn(),
            })}
          />
          <RichHoverTooltip
            content="Another control"
            dataTestId="external-detail"
          >
            <button data-testid="external-detail-trigger">
              Another control
            </button>
          </RichHoverTooltip>
        </TooltipProvider>,
      ),
    );
    const press = (key: string): void => {
      act(() => {
        document.activeElement?.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true }),
        );
        jest.advanceTimersByTime(250);
      });
    };
    try {
      act(() => queryByTestId('model-picker')?.click());
      act(() => jest.advanceTimersByTime(250));
      press('ArrowDown');
      press('ArrowDown');
      expect(document.activeElement).toBe(queryByTestId('model-option-gated'));
      expect(queryByTestId('model-option-detail-gated')).not.toBeNull();
      act(() => {
        queryByTestId('external-detail-trigger')?.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: document.body,
          }),
        );
      });
      expect(queryByTestId('external-detail')).not.toBeNull();
      expect(queryByTestId('model-option-detail-gated')).toBeNull();
      press('ArrowUp');
      press('ArrowDown');
      expect(queryByTestId('external-detail')).toBeNull();
      expect(queryByTestId('model-option-detail-gated')?.textContent).toContain(
        SIGN_IN_HINT,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('opens only the visible copy of a native row shared across harness tabs', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const catalog = GATED_CATALOG.map<ModelCatalogOption>((option) =>
      option.id === 'gated'
        ? {
            ...option,
            source: 'claude',
            provider: 'claude',
            vendor: 'anthropic',
          }
        : option,
    );
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={catalog}
          onSelect={jest.fn()}
          harnessTabs={{
            ...PICKER_TABS,
            initialTab: 'claude',
            supportedModelIds: { codex: ['gated'] },
          }}
          getOptionState={stateFor({
            hint: SIGN_IN_HINT,
            label: 'Sign in',
            onUnlock: jest.fn(),
          })}
        />,
      ),
    );
    try {
      act(() => queryByTestId('model-picker')?.click());
      expect(
        document.querySelectorAll('[data-model-id="gated"]').length,
      ).toBeGreaterThan(1);
      for (let step = 0; step < 30; step += 1) {
        act(() => {
          document.activeElement?.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
          );
          jest.advanceTimersByTime(250);
        });
        if (document.activeElement?.getAttribute('data-model-id') === 'gated')
          break;
      }
      expect(document.activeElement?.getAttribute('data-model-id')).toBe(
        'gated',
      );
      expect(
        document.querySelectorAll('[data-testid="model-option-detail-gated"]'),
      ).toHaveLength(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it('puts the hint right after the title in the picker detail card', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={GATED_CATALOG}
          onSelect={(): void => undefined}
          getOptionState={stateFor({
            hint: SIGN_IN_HINT,
            label: 'Sign in',
            onUnlock: jest.fn(),
          })}
          harnessTabs={PICKER_TABS}
        />,
      ),
    );
    act(() => queryByTestId('model-picker')?.click());
    try {
      expect(queryByTestId('model-option-lock-label-gated')?.textContent).toBe(
        'Sign in',
      );
      expect(queryByTestId('model-row-credits-gated')).toBeNull();
      hoverOption('gated');
      act(() => jest.advanceTimersByTime(200));
      const card = queryByTestId('model-option-detail-gated');
      const title = Array.from(card?.querySelectorAll('p') ?? []).find(
        (node) => node.textContent === 'Gated Model',
      );
      const hint = title?.nextElementSibling;
      expect(hint?.textContent).toBe(SIGN_IN_HINT);
      expect(hint?.className ?? '').not.toContain('opacity');
      expect(card?.textContent).toContain('Reasoning');

      act((): void => {
        queryByTestId('model-option-gated')?.dispatchEvent(
          new MouseEvent('mouseout', { bubbles: true }),
        );
      });
      hoverOption('allowed');
      act(() => jest.advanceTimersByTime(200));
      const unlocked = queryByTestId('model-option-detail-allowed');
      expect(unlocked?.textContent).not.toContain('Unlock');
      expect(unlocked?.querySelectorAll('[role="separator"]')).toHaveLength(1);
    } finally {
      act(() => root.unmount());
    }
  });
});

describe('ModelPickerMenu orphaned account favorites', () => {
  const storageKey = 'test:orphaned-account-favorites';
  const visible = (id: string): HTMLElement | undefined =>
    Array.from(document.querySelectorAll<HTMLElement>('[data-testid]')).find(
      (el) => el.getAttribute('data-testid') === id && !el.closest('[hidden]'),
    );
  function mount(
    catalog: ModelCatalog,
    saved: readonly string[],
  ): {
    root: Root;
    onSelect: jest.MockedFunction<ModelPickerMenuProps['onSelect']>;
  } {
    localStorage.setItem(storageKey, JSON.stringify(saved));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const onSelect = jest.fn<
      ReturnType<ModelPickerMenuProps['onSelect']>,
      Parameters<ModelPickerMenuProps['onSelect']>
    >();
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={catalog}
          onSelect={onSelect}
          harnessTabs={{
            brandIcon: <span>U</span>,
            brandLabel: 'Brand',
            favoritesStorageKey: storageKey,
            gatewayLayout: 'harnesses',
            allModelsTab: true,
            leadingFavorites: true,
            favoriteModelAliases: new Map(
              catalog.map((option) => [option.id, 'shared-model']),
            ),
          }}
        />,
      ),
    );
    act(() => queryByTestId('model-picker')?.click());
    act(() => queryByTestId('model-harness-tab-favorites')?.click());
    return { root, onSelect };
  }
  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.removeItem(storageKey);
  });

  it.each(['cursor', 'copilot', 'opencode'] as const)(
    'resolves orphaned account favorites only through the saved %s account, retaining order and removing aliases',
    (harness) => {
      const other = harness === 'cursor' ? 'copilot' : 'cursor';
      const saved = [
        `${harness}::shared-model`,
        `${other}::shared-model`,
        `${harness}::account-route`,
        'unknown::unlisted-model',
      ];
      const { root, onSelect } = mount(
        [
          {
            id: 'account-route',
            label: 'Account model',
            kind: 'model',
            provider: harness,
            source: harness,
            available: true,
          },
          {
            id: 'other-route',
            label: 'Other account model',
            kind: 'model',
            provider: other,
            source: other,
            available: true,
          },
        ],
        saved,
      );
      try {
        const rows = Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="menuitemradio"][data-testid^="model-option-"]',
          ),
        ).filter((el) => !el.closest('[hidden]'));
        expect(rows.map((row) => row.getAttribute('data-testid'))).toEqual([
          'model-option-account-route',
          'model-option-other-route',
        ]);
        expect(JSON.parse(localStorage.getItem(storageKey) ?? '[]')).toEqual(
          saved,
        );
        act(() => visible('model-option-account-route')?.click());
        expect(onSelect.mock.calls[0]?.[0]).toBe('account-route');
        act(() => queryByTestId('model-picker')?.click());
        act(() => queryByTestId('model-harness-tab-favorites')?.click());
        act(() => visible('model-favorite-account-route')?.click());
        // Explicit writes normalize known aliases while retaining account,
        // order, and unknown entries; the read above leaves storage untouched.
        expect(JSON.parse(localStorage.getItem(storageKey) ?? '[]')).toEqual([
          `${other}::other-route`,
          'unknown::unlisted-model',
        ]);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it.each(['different account', 'ambiguous account'])(
    'does not guess orphaned account favorites with a %s match',
    (scenario) => {
      const saved = ['copilot::shared-model'];
      const catalog: ModelCatalog =
        scenario === 'different account'
          ? [
              {
                id: 'cursor-route',
                label: 'Other account model',
                kind: 'model',
                provider: 'cursor',
                source: 'cursor',
                available: true,
              },
            ]
          : [
              {
                id: 'copilot-one',
                label: 'First route',
                kind: 'model',
                provider: 'copilot',
                source: 'copilot',
                available: true,
              },
              {
                id: 'copilot-two',
                label: 'Second route',
                kind: 'model',
                provider: 'copilot',
                source: 'copilot',
                available: true,
              },
            ];
      const { root, onSelect } = mount(catalog, saved);
      try {
        expect(
          Array.from(
            document.querySelectorAll(
              '[role="menuitemradio"][data-testid^="model-option-"]',
            ),
          ).filter((el) => !el.closest('[hidden]')),
        ).toHaveLength(0);
        expect(JSON.parse(localStorage.getItem(storageKey) ?? '[]')).toEqual(
          saved,
        );
        expect(onSelect).not.toHaveBeenCalled();
      } finally {
        act(() => root.unmount());
      }
    },
  );
});

describe('availability cues (CAN-5213)', () => {
  afterEach(() => {
    window.localStorage.clear();
    document.body.innerHTML = '';
  });

  const DAILY_HINT = 'Turn on free daily credits to use this model.';
  const CUE_CATALOG: ModelCatalog = [
    {
      id: 'a-daily',
      label: 'A Daily',
      provider: 'codex',
      source: 'ai-gateway',
      vendor: 'deepseek',
      kind: 'model',
      available: true,
      sortOrder: 1,
    },
    {
      id: 'b-ready',
      label: 'B Ready',
      provider: 'codex',
      source: 'ai-gateway',
      vendor: 'deepseek',
      kind: 'model',
      available: true,
      sortOrder: 2,
    },
    {
      id: 'c-plain',
      label: 'C Plain',
      provider: 'codex',
      source: 'ai-gateway',
      vendor: 'deepseek',
      kind: 'model',
      available: true,
      sortOrder: 3,
    },
  ];
  const PICKER_TABS: ModelPickerMenuProps['harnessTabs'] = {
    brandIcon: <span>U</span>,
    brandLabel: 'Test brand',
    gatewayLayout: 'harnesses',
    chrome: 'picker',
    allModelsTab: true,
    favoritesStorageKey: 'test:can-5213',
  };

  function mountCues({
    onRecover = jest.fn(),
    onSelect = jest.fn(),
    picker = false,
    currentModel,
    catalog = CUE_CATALOG,
    tabs,
  }: {
    readonly onRecover?: () => void;
    readonly onSelect?: (modelId: string) => void;
    readonly picker?: boolean;
    readonly currentModel?: string;
    readonly catalog?: ModelCatalog;
    readonly tabs?: ModelPickerMenuProps['harnessTabs'];
  } = {}): Root {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const getOptionState = (
      option: ModelCatalogOption,
    ): ModelPickerOptionState => {
      if (option.id === 'a-daily')
        return {
          disabled: false,
          locked: {
            hint: DAILY_HINT,
            label: 'Needs free daily credits',
            onUnlock: onRecover,
            keepsOrder: true,
          },
        };
      if (option.id === 'b-ready') return { disabled: false, available: true };
      return { disabled: false };
    };
    act(() =>
      root.render(
        <ModelPickerMenu
          catalog={catalog}
          currentModel={currentModel}
          onSelect={onSelect}
          getOptionState={getOptionState}
          harnessTabs={tabs ?? (picker ? PICKER_TABS : undefined)}
        />,
      ),
    );
    act(() => queryByTestId('model-picker')?.click());
    if (picker) act(() => queryByTestId('model-harness-tab-all')?.click());
    return root;
  }

  function descriptions(row: HTMLElement | null): (string | null)[] {
    return (row?.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent ?? null);
  }

  it('marks a usable row Available and keeps it a selectable radio', () => {
    const onSelect = jest.fn();
    const root = mountCues({ onSelect, currentModel: 'b-ready' });
    try {
      const row = queryByTestId('model-option-b-ready');
      expect(row?.getAttribute('role')).toBe('menuitemradio');
      expect(row?.getAttribute('aria-checked')).toBe('true');
      expect(row?.getAttribute('data-available')).toBe('true');
      expect(descriptions(row)).toContain('Available');
      const label = queryByTestId('model-option-available-b-ready');
      expect(label?.textContent).toBe('Available');
      expect(label?.parentElement?.getAttribute('aria-hidden')).toBe('true');
      expect(
        queryByTestId('model-option-c-plain')?.hasAttribute('data-available'),
      ).toBe(false);

      act(() => row?.click());
      expect(onSelect).toHaveBeenCalledWith('b-ready');
    } finally {
      act(() => root.unmount());
    }
  });

  it('recovers a daily-credit lock once without selecting the model', () => {
    const onRecover = jest.fn();
    const onSelect = jest.fn();
    const root = mountCues({ onRecover, onSelect });
    try {
      const row = queryByTestId('model-option-a-daily');
      expect(row?.getAttribute('role')).toBe('menuitem');
      expect(row?.hasAttribute('data-available')).toBe(false);
      expect(descriptions(row)).toContain(DAILY_HINT);
      expect(
        queryByTestId('model-option-lock-label-a-daily')?.textContent,
      ).toBe('Needs free daily credits');

      act(() => row?.click());
      expect(onRecover).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it('recovers from the keyboard too', () => {
    const onRecover = jest.fn();
    const onSelect = jest.fn();
    const root = mountCues({ onRecover, onSelect });
    try {
      const row = queryByTestId('model-option-a-daily');
      act(() => row?.focus());
      act(() => {
        row?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      expect(onRecover).toHaveBeenCalledTimes(1);
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it('selects an Available row with the keyboard', () => {
    const onSelect = jest.fn();
    const root = mountCues({ onSelect });
    try {
      const row = queryByTestId('model-option-b-ready');
      act(() => row?.focus());
      act(() => {
        row?.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
        );
      });
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith('b-ready');
    } finally {
      act(() => root.unmount());
    }
  });

  it('gives duplicate harness rows distinct accessible description IDs', () => {
    const root = mountCues({
      picker: true,
      catalog: CUE_CATALOG.map((option) =>
        option.id === 'b-ready'
          ? {
              ...option,
              source: 'claude',
              provider: 'claude',
              harness: 'claude',
            }
          : option,
      ),
      tabs: { ...PICKER_TABS, supportedModelIds: { codex: ['b-ready'] } },
    });
    try {
      act(() => queryByTestId('model-harness-tab-claude')?.click());
      const rows = Array.from(
        document.querySelectorAll('[data-model-id="b-ready"]'),
      );
      expect(rows.length).toBeGreaterThan(1);
      const ids = rows.map((row) => row.getAttribute('aria-describedby'));
      expect(new Set(ids).size).toBe(rows.length);
      for (const id of ids)
        expect(document.getElementById(id ?? '')?.textContent).toBe(
          'Available',
        );
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps an extra-charge warning alongside Available', () => {
    const root = mountCues({
      catalog: CUE_CATALOG.map((option) =>
        option.id === 'b-ready' ? { ...option, extraChargeOnly: true } : option,
      ),
    });
    try {
      const row = queryByTestId('model-option-b-ready');
      expect(row?.getAttribute('data-available')).toBe('true');
      expect(
        queryByTestId('model-option-extra-charge-b-ready')?.textContent,
      ).toBe('$');
      const label = queryByTestId('model-option-available-b-ready');
      expectStateIconLast(
        'b-ready',
        label?.parentElement?.querySelector('svg') ?? null,
        label,
      );
    } finally {
      act(() => root.unmount());
    }
  });

  it('names credits billing in the detail when Available replaces the tag', () => {
    const root = mountCues({ picker: true });
    try {
      hoverOption('b-ready');
      act(() => jest.advanceTimersByTime(200));
      const detail = queryByTestId('model-option-detail-b-ready');
      expect(detail?.textContent).toContain('BillingAI Credits');
      expect(detail?.textContent?.match(/AI Credits/g)).toHaveLength(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it('does not add a second billing line for organization funding', () => {
    const root = mountCues({
      picker: true,
      catalog: CUE_CATALOG.map((option) =>
        option.id === 'b-ready'
          ? { ...option, funding: 'org-gateway' }
          : option,
      ),
    });
    try {
      hoverOption('b-ready');
      act(() => jest.advanceTimersByTime(200));
      const detail = queryByTestId('model-option-detail-b-ready');
      expect(detail?.textContent).toContain('BillingOrganization gateway');
      expect(detail?.textContent).not.toContain('AI Credits');
    } finally {
      act(() => root.unmount());
    }
  });

  it('keeps the section order when a recovery lock keeps its place', () => {
    const root = mountCues();
    try {
      const ids = Array.from(document.querySelectorAll('[data-model-id]')).map(
        (row) => row.getAttribute('data-model-id'),
      );
      expect(ids).toEqual(['a-daily', 'b-ready', 'c-plain']);
    } finally {
      act(() => root.unmount());
    }
  });

  it.each(['codex', 'favorites'] as const)(
    'keeps recovery rows in their prior order under %s',
    (tab) => {
      localStorage.setItem(
        'test:can-5213',
        JSON.stringify(['codex::a-daily', 'codex::b-ready', 'codex::c-plain']),
      );
      const root = mountCues({
        picker: true,
        catalog: CUE_CATALOG.map((option) => ({
          ...option,
          source: 'codex',
          harness: 'codex',
        })),
      });
      try {
        act(() => queryByTestId(`model-harness-tab-${tab}`)?.click());
        const ids = Array.from(document.querySelectorAll('[data-model-id]'))
          .filter((row) => row.closest('[hidden]') === null)
          .map((row) => row.getAttribute('data-model-id'));
        expect(ids).toEqual(['a-daily', 'b-ready', 'c-plain']);
      } finally {
        act(() => root.unmount());
      }
    },
  );

  it('replaces the credits tag with the cue in the harness layout', () => {
    const root = mountCues({ picker: true });
    try {
      expect(queryByTestId('model-row-credits-b-ready')).toBeNull();
      expect(queryByTestId('model-row-credits-a-daily')).toBeNull();
      expect(queryByTestId('model-row-credits-c-plain')?.textContent).toBe(
        'AI Credits',
      );
      expect(queryByTestId('model-option-available-b-ready')).not.toBeNull();
    } finally {
      act(() => root.unmount());
    }
  });
});

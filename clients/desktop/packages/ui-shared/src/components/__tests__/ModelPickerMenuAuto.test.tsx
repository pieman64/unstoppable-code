/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ModelCatalog } from '@canopy/protocol/models';
import {
  ModelPickerMenu,
  MODEL_PICKER_AUTO_DESCRIPTION,
  MODEL_PICKER_AUTO_REASONS,
  type ModelPickerAutoOption,
  type ModelPickerMenuProps,
} from '../ModelPickerMenu';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const CATALOG: ModelCatalog = [
  {
    id: 'claude-opus-test',
    label: 'Claude Opus Test',
    provider: 'claude',
    kind: 'model',
    available: true,
  },
  {
    id: 'claude-sonnet-test',
    label: 'Claude Sonnet Test',
    provider: 'claude',
    kind: 'model',
    available: true,
  },
];

function mount(
  autoOption?: ModelPickerAutoOption,
  props: Partial<ModelPickerMenuProps> = {},
): Root {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() =>
    root.render(
      <ModelPickerMenu
        catalog={CATALOG}
        currentModel="claude-sonnet-test"
        onSelect={(): void => undefined}
        {...(autoOption ? { autoOption } : {})}
        {...props}
      />,
    ),
  );
  return root;
}

function byTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}

function openMenu(): void {
  const trigger = byTestId('model-picker');
  if (!trigger) throw new Error('trigger missing');
  act(() => {
    trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ModelPickerMenu Auto row', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders no Auto row when the host supplies no auto option', () => {
    mount();
    openMenu();
    expect(byTestId('model-option-auto')).toBeNull();
  });

  it('renders Auto with its shared description and no check while manual', () => {
    mount({ selected: false, onSelect: (): void => undefined });
    openMenu();
    const row = byTestId('model-option-auto');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain(MODEL_PICKER_AUTO_DESCRIPTION);
    expect(row?.getAttribute('aria-checked')).toBe('false');
    // A manual chat still reads its concrete model on the trigger.
    expect(byTestId('model-picker')?.textContent).toContain(
      'Claude Sonnet Test',
    );
  });

  it('reads plain `Auto` while selected, never the concrete model', () => {
    // Each routed turn names its own model; the chip only names the mode.
    mount({ selected: true, onSelect: (): void => undefined });
    expect(byTestId('model-picker')?.textContent?.trim()).toBe('Auto');
    expect(byTestId('model-picker')?.textContent).not.toContain(
      'Claude Sonnet Test',
    );
  });

  it('suppresses the concrete-model check mark while Auto owns the selection', () => {
    mount({ selected: true, onSelect: (): void => undefined });
    openMenu();
    expect(byTestId('model-option-auto')?.getAttribute('aria-checked')).toBe(
      'true',
    );
    const concrete = document.querySelector(
      '[data-testid="model-option-claude-sonnet-test"]',
    );
    expect(concrete?.getAttribute('aria-checked')).toBe('false');
  });

  it('shows the reason and refuses selection when Auto is unavailable', () => {
    let selected = false;
    mount({
      selected: false,
      onSelect: (): void => {
        selected = true;
      },
      unavailableReason: MODEL_PICKER_AUTO_REASONS.noCredits,
    });
    openMenu();
    const row = byTestId('model-option-auto');
    expect(row?.textContent).toContain(MODEL_PICKER_AUTO_REASONS.noCredits);
    expect(row).toHaveProperty('disabled', true);
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(selected).toBe(false);
  });

  it('hides an unavailable Auto row in compact pickers that opt out', () => {
    mount({
      selected: false,
      onSelect: (): void => undefined,
      unavailableReason: MODEL_PICKER_AUTO_REASONS.tooFewCandidates,
      hideWhenUnavailable: true,
    });
    openMenu();
    expect(byTestId('model-option-auto')).toBeNull();
  });

  it('keeps an already-Auto chat`s row visible even when unavailable', () => {
    mount({
      selected: true,
      onSelect: (): void => undefined,
      unavailableReason: MODEL_PICKER_AUTO_REASONS.noCredits,
      hideWhenUnavailable: true,
    });
    openMenu();
    expect(byTestId('model-option-auto')).not.toBeNull();
  });

  it('leads the Auto row with the sparkle and tints it, not a check, when selected', () => {
    mount({ selected: true, onSelect: (): void => undefined });
    openMenu();
    const row = byTestId('model-option-auto');
    const icon = byTestId('model-option-auto-icon');
    expect(icon).not.toBeNull();
    expect(row?.contains(icon)).toBe(true);
    expect(icon?.closest('.fg-accent')).not.toBeNull();
    // One selection language: the tinted leading icon, like every model row.
    expect(row?.querySelector('polyline')).toBeNull();
  });

  it('shows the sparkle on the chip while Auto is selected', () => {
    mount({ selected: true, onSelect: (): void => undefined });
    const icon = byTestId('model-picker-provider-icon');
    expect(icon?.getAttribute('data-selection-mode')).toBe('auto');
    expect(icon?.hasAttribute('data-provider')).toBe(false);
  });

  it('keeps the provider icon on the chip while manual', () => {
    mount({ selected: false, onSelect: (): void => undefined });
    const icon = byTestId('model-picker-provider-icon');
    expect(icon?.getAttribute('data-provider')).toBe('claude');
    expect(icon?.hasAttribute('data-selection-mode')).toBe(false);
  });

  it('runs the unavailable action instead of selecting Auto', () => {
    const onSelect = jest.fn();
    const onUnavailableAction = jest.fn();
    mount({
      selected: false,
      onSelect,
      unavailableReason: MODEL_PICKER_AUTO_REASONS.noCredits,
      unavailableAction: onUnavailableAction,
    });
    openMenu();
    const row = byTestId('model-option-auto');
    expect(row).toHaveProperty('disabled', false);
    expect(row?.getAttribute('role')).toBe('menuitem');
    expect(row?.hasAttribute('aria-checked')).toBe(false);
    expect(byTestId('model-option-auto-action-icon')).not.toBeNull();
    act(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onUnavailableAction).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(byTestId('model-menu')).toBeNull();
  });
});

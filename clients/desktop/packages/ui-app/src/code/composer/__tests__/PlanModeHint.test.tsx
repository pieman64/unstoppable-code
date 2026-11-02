/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerDrawer } from '@canopy/ui-shared/components';
import { PlanModeHint } from '../PlanModeHint';
import type { PlanModeSuggestion } from '../usePlanModeSuggestion';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function suggestion(
  overrides: Partial<PlanModeSuggestion> = {},
): PlanModeSuggestion {
  return {
    visible: true,
    pending: false,
    accept: jest.fn(() => Promise.resolve()),
    dismiss: jest.fn(),
    ...overrides,
  };
}

describe('PlanModeHint', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
  });

  function byTestId(id: string): HTMLElement {
    const element = container.querySelector<HTMLElement>(
      `[data-testid="${id}"]`,
    );
    if (element === null) throw new Error(`missing ${id}`);
    return element;
  }

  function renderHint(hint: PlanModeSuggestion): void {
    act(() =>
      root.render(
        <ComposerDrawer edge="top">
          <PlanModeHint hint={hint} />
        </ComposerDrawer>,
      ),
    );
  }

  it('is the composer tip: announced politely, never focused, with named actions', () => {
    const focused = document.createElement('textarea');
    document.body.appendChild(focused);
    focused.focus();
    renderHint(suggestion());

    const hint = byTestId('plan-mode-suggestion');
    expect(hint.getAttribute('role')).toBe('status');
    expect(hint.getAttribute('aria-live')).toBe('polite');
    expect(hint.getAttribute('data-onboarding-tip-placement')).toBe('composer');
    expect(hint.hasAttribute('data-composer-drawer-section')).toBe(true);
    expect(hint.textContent).toContain('Plan first?');
    expect(hint.textContent).toContain(
      'This looks like a multi-step task. Plan mode works out the approach before making changes.',
    );
    expect(byTestId('plan-mode-suggestion-accept').textContent).toBe(
      'Plan first',
    );
    expect(
      byTestId('plan-mode-suggestion-dismiss').getAttribute('aria-label'),
    ).toBe('Dismiss plan mode suggestion');
    // The tip's verb takes the drawer row's one action slot.
    expect(
      container.querySelector('[data-testid="plan-mode-suggestion-got-it"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(focused);
  });

  it('draws no banner: no notice surface or intent colour', () => {
    renderHint(suggestion());
    const hint = byTestId('plan-mode-suggestion');
    expect(hint.closest('[data-notice-shape]')).toBeNull();
    expect(hint.className).not.toMatch(/warning|accent|info|success/);
  });

  it('accepts and dismisses through real buttons', () => {
    const hint = suggestion();
    renderHint(hint);

    const accept = byTestId('plan-mode-suggestion-accept');
    const dismiss = byTestId('plan-mode-suggestion-dismiss');
    expect(accept.tagName).toBe('BUTTON');
    expect(dismiss.tagName).toBe('BUTTON');
    act(() => accept.click());
    act(() => dismiss.click());
    expect(hint.accept).toHaveBeenCalledTimes(1);
    expect(hint.dismiss).toHaveBeenCalledTimes(1);
  });

  it('blocks a second activation while pending', () => {
    const hint = suggestion({ pending: true });
    renderHint(hint);

    const accept = byTestId('plan-mode-suggestion-accept');
    expect(accept.getAttribute('aria-disabled')).toBe('true');
    expect(accept.getAttribute('aria-busy')).toBe('true');
    act(() => accept.click());
    expect(hint.accept).not.toHaveBeenCalled();
  });

  it('renders nothing while hidden, so the drawer stays empty', () => {
    renderHint(suggestion({ visible: false }));
    expect(
      container.querySelector('[data-testid="plan-mode-suggestion"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-composer-drawer-section]'),
    ).toBeNull();
  });
});

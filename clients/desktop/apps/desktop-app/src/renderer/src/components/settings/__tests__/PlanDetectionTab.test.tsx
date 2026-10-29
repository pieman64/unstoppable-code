/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PlanDetectionPreferences,
  PreferencesData,
} from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { PlanDetectionTab } from '../PlanDetectionTab';

interface MockApi {
  loadPreferences: jest.Mock<Promise<PreferencesData>, []>;
  savePreferences: jest.Mock<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >;
}

let originalApiDescriptor: PropertyDescriptor | undefined;

function installApi(planDetection: PlanDetectionPreferences): MockApi {
  const api: MockApi = {
    loadPreferences: jest
      .fn<Promise<PreferencesData>, []>()
      .mockResolvedValue(makeTestPreferences({ planDetection })),
    savePreferences: jest.fn((patch) =>
      Promise.resolve(makeTestPreferences(patch)),
    ),
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

async function renderTab(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<PlanDetectionTab />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

function byTestId<T extends Element>(
  container: HTMLElement,
  testId: string,
  type: new () => T,
): T {
  const element = container.querySelector(`[data-testid="${testId}"]`);
  if (!(element instanceof type)) {
    throw new Error(`Expected ${testId}`);
  }
  return element;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  );
  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('PlanDetectionTab', () => {
  beforeEach(() => {
    originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  });

  afterEach(() => {
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('lists each built-in rule as a switch row that reflects the disabled set', async () => {
    installApi({
      disabledBuiltinRuleIds: ['superpowers-designs'],
      customRules: [],
    });
    const { container, cleanup } = await renderTab();

    const specs = byTestId(
      container,
      'settings-plan-detection-inherited-superpowers-specs',
      HTMLDivElement,
    );
    const designs = byTestId(
      container,
      'settings-plan-detection-inherited-superpowers-designs',
      HTMLDivElement,
    );
    expect(specs.textContent).toContain('docs/superpowers/specs/*.md');
    expect(
      specs.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(
      designs.querySelector('[role="switch"]')?.getAttribute('aria-checked'),
    ).toBe('false');
    cleanup();
  });

  it('turns a built-in rule off by saving its id in the disabled set', async () => {
    const api = installApi({ disabledBuiltinRuleIds: [], customRules: [] });
    const { container, cleanup } = await renderTab();

    const toggle = byTestId(
      container,
      'settings-plan-detection-inherited-superpowers-specs',
      HTMLDivElement,
    ).querySelector('[role="switch"]');
    if (!(toggle instanceof HTMLButtonElement)) {
      throw new Error('Expected the built-in rule switch');
    }
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(api.savePreferences).toHaveBeenCalledWith({
      planDetection: {
        disabledBuiltinRuleIds: ['superpowers-specs'],
        customRules: [],
      },
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    cleanup();
  });

  it('requires a pattern before adding a custom rule', async () => {
    const api = installApi({ disabledBuiltinRuleIds: [], customRules: [] });
    const { container, cleanup } = await renderTab();

    await act(async () => {
      byTestId(
        container,
        'settings-plan-detection-add',
        HTMLButtonElement,
      ).click();
      await Promise.resolve();
    });

    expect(
      byTestId(container, 'settings-plan-detection-error', HTMLElement)
        .textContent,
    ).toBe('Pattern is required.');
    expect(api.savePreferences).not.toHaveBeenCalled();
    cleanup();
  });

  it('adds a custom rule on Enter and removes it again', async () => {
    const api = installApi({ disabledBuiltinRuleIds: [], customRules: [] });
    const { container, cleanup } = await renderTab();
    expect(
      container.querySelector('[data-testid="settings-plan-detection-empty"]'),
    ).not.toBeNull();

    const label = byTestId(
      container,
      'settings-plan-detection-label',
      HTMLInputElement,
    );
    const pattern = byTestId(
      container,
      'settings-plan-detection-pattern',
      HTMLInputElement,
    );
    act(() => setInputValue(label, 'Notes'));
    act(() => setInputValue(pattern, ' docs/notes/*.md '));
    await act(async () => {
      pattern.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await Promise.resolve();
    });

    const saved = api.savePreferences.mock.calls[0]?.[0].planDetection;
    expect(saved?.customRules).toEqual([
      expect.objectContaining({
        label: 'Notes',
        kind: 'include',
        pattern: 'docs/notes/*.md',
        enabled: true,
      }),
    ]);
    const rows = container.querySelectorAll(
      '[data-testid^="settings-plan-detection-custom-"]',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('docs/notes/*.md');
    expect(
      container.querySelector('[data-testid="settings-plan-detection-empty"]'),
    ).toBeNull();
    expect(pattern.value).toBe('');

    const remove = container.querySelector('button[aria-label="Remove Notes"]');
    if (!(remove instanceof HTMLButtonElement)) {
      throw new Error('Expected the remove button');
    }
    await act(async () => {
      remove.click();
      await Promise.resolve();
    });

    expect(api.savePreferences).toHaveBeenLastCalledWith({
      planDetection: { disabledBuiltinRuleIds: [], customRules: [] },
    });
    expect(
      container.querySelector('[data-testid="settings-plan-detection-empty"]'),
    ).not.toBeNull();
    cleanup();
  });
});

/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createEmptyGlobalInstructionsConfig } from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { InstructionsTab } from '../InstructionsTab';

jest.mock('@/components/shared/loading', () => ({
  LoadingPlaceholder: ({ label }: { label?: string }): JSX.Element => (
    <div data-testid="shared-loading-placeholder">{label}</div>
  ),
}));

jest.mock('../GlobalInstructionsSettings', () => ({
  GlobalInstructionsSettings: ({
    onChange,
  }: {
    onChange: (
      next: ReturnType<typeof createEmptyGlobalInstructionsConfig>,
    ) => void;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="instructions-save-probe"
      onClick={() =>
        onChange({
          ...createEmptyGlobalInstructionsConfig(),
          chats: { overall: 'Updated instructions.', scoped: [] },
        })
      }
    />
  ),
}));

describe('InstructionsTab', () => {
  const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');
  const loadPreferences = jest.fn();
  type SavePreferences = typeof window.api.savePreferences;
  const savePreferences = jest
    .fn<ReturnType<SavePreferences>, Parameters<SavePreferences>>()
    .mockResolvedValue(undefined);
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    loadPreferences.mockResolvedValue(makeTestPreferences());
    savePreferences.mockClear();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { loadPreferences, savePreferences },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container);
      root.render(<InstructionsTab />);
      await Promise.resolve();
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalApiDescriptor) {
      Object.defineProperty(window, 'api', originalApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'api');
    }
  });

  it('loads on its own settings page and persists edits', async () => {
    expect(
      container.querySelector('[data-testid="settings-tab-instructions"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Instructions');
    // The page description states the new-session-only contract.
    expect(container.textContent).toContain(
      'only added when a new agent session starts',
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="instructions-save-probe"]',
        )
        ?.click();
      await Promise.resolve();
    });

    expect(savePreferences).toHaveBeenCalledTimes(1);
    const savedPreferences = savePreferences.mock.calls[0]?.[0];
    if (!savedPreferences) {
      throw new Error('Expected the Instructions settings to be saved');
    }
    expect(savedPreferences.globalInstructions.chats).toEqual({
      overall: 'Updated instructions.',
      scoped: [],
    });
  });

  it('shows a form skeleton while preferences load', () => {
    act(() => root.unmount());
    container.replaceChildren();
    loadPreferences.mockReset();
    loadPreferences.mockReturnValue(new Promise(() => {}));

    act(() => {
      root = createRoot(container);
      root.render(<InstructionsTab />);
    });

    expect(
      container.querySelector(
        '[role="status"][data-testid="settings-skeleton-form"]',
      ),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('Loading preferences…');
  });
});

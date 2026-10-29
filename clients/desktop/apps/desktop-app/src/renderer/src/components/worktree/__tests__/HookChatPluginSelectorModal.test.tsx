/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';

jest.mock('../../shared/PluginSelector', () => ({
  PluginSelector: ({
    onChange,
  }: {
    onChange: (selections: ChatTabPluginSelections) => void;
  }): JSX.Element => (
    <button
      type="button"
      data-testid="mock-select-plugin"
      onClick={() =>
        onChange({
          collectionIds: ['selected'],
          skillRefs: [],
          pluginRefs: [],
          mcpServerRefs: [],
        })
      }
    >
      Select plugin
    </button>
  ),
}));
jest.mock('../../shared/ShareablePluginSelector', () => ({
  ShareablePluginSelector: (): null => null,
}));

import { HookChatPluginSelectorModal } from '../HookChatPluginSelectorModal';

function initialSelections(): ChatTabPluginSelections {
  return {
    collectionIds: [],
    bundleIds: ['legacy-collection'],
    skillRefs: [],
    pluginRefs: [],
    mcpServerRefs: [],
    mcpHttpAuthPreferences: [
      {
        target: {
          kind: 'standalone',
          serverId: 'linear',
          configId: 'work',
        },
        handler: 'provider',
      },
    ],
  };
}

describe('HookChatPluginSelectorModal full selections', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(onSave: (selections: ChatTabPluginSelections) => void): void {
    act(() => {
      root.render(
        <HookChatPluginSelectorModal
          mode="full"
          initial={initialSelections()}
          onSave={onSave}
          onClose={() => undefined}
        />,
      );
    });
  }

  it('records the card and its scrim', () => {
    render(() => undefined);

    const card = container.querySelector('[role="dialog"]');
    expect(
      card?.querySelector('[data-testid="mock-select-plugin"]'),
    ).not.toBeNull();
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(
      card?.parentElement?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS),
    ).toBe(false);
  });

  it('normalizes legacy bundle IDs for the selected count', () => {
    render(() => undefined);
    expect(container.textContent).toContain('1 selected');
  });

  it('does not discard in-progress selections when the parent rerenders', () => {
    const onSave = jest.fn();
    render(onSave);
    const selectButton = container.querySelector(
      '[data-testid="mock-select-plugin"]',
    );
    if (!(selectButton instanceof HTMLButtonElement)) {
      throw new Error('Mock plugin selection button not found');
    }

    act(() => selectButton.click());
    expect(container.textContent).toContain('1 selected');

    render(onSave);
    expect(container.textContent).toContain('1 selected');
  });

  it('preserves MCP HTTP auth preferences when picker-owned fields change', () => {
    const onSave = jest.fn();
    render(onSave);
    const selectButton = container.querySelector(
      '[data-testid="mock-select-plugin"]',
    );
    if (!(selectButton instanceof HTMLButtonElement)) {
      throw new Error('Mock plugin selection button not found');
    }
    act(() => selectButton.click());

    const saveButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Save',
    );
    if (!saveButton) throw new Error('Save button not found');
    act(() => saveButton.click());

    expect(onSave).toHaveBeenCalledWith({
      collectionIds: ['selected'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
      mcpHttpAuthPreferences: initialSelections().mcpHttpAuthPreferences,
    });
  });
});

/** @jest-environment jsdom */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { AutoArchiveToggleButton } from '../AutoArchiveToggleButton';
import {
  BACKGROUND_DEFERS_AUTO_ARCHIVE_TOOLTIP,
  DELEGATES_DEFER_AUTO_ARCHIVE_TOOLTIP,
} from '@/stores/chat/close-guard';
import {
  resetDelegationActivityStoreForTests,
  useDelegationActivityStore,
} from '@/stores/delegationActivityStore';
import {
  resetLiveBackgroundTaskStoreForTests,
  useLiveBackgroundTaskStore,
} from '@/stores/liveBackgroundTaskStore';
import { ChatLookProvider } from '@canopy/ui-shared/components/chat-look';

const TARGET = {
  projectId: 'project',
  worktreeId: 'worktree',
  chatId: 'chat-1',
};

describe('AutoArchiveToggleButton', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resetDelegationActivityStoreForTests();
    resetLiveBackgroundTaskStoreForTests();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document
      .querySelectorAll('[role="tooltip"]')
      .forEach((node) => node.remove());
    resetDelegationActivityStoreForTests();
    resetLiveBackgroundTaskStoreForTests();
  });

  function renderButton(): HTMLButtonElement {
    act(() => {
      root.render(
        createElement(ChatLookProvider, {
          value: 'classic',
          children: createElement(AutoArchiveToggleButton, {
            enabled: true,
            onToggle: (): void => undefined,
            target: TARGET,
          }),
        }),
      );
    });
    const button = container.querySelector('button');
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Auto-archive toggle was not rendered');
    }
    return button;
  }

  function hoverTooltip(button: HTMLButtonElement): string {
    act(() => {
      button.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    return document.body.querySelector('[role="tooltip"]')?.textContent ?? '';
  }

  it('uses the delegate copy when delegates are live', () => {
    useDelegationActivityStore.getState().applyActivity({
      ...TARGET,
      live: 1,
      queued: 0,
    });
    useLiveBackgroundTaskStore.getState().applyPush({
      ...TARGET,
      sessionActive: true,
      liveTasks: [{ taskId: 'agent', taskType: 'local_agent' }],
    });
    const button = renderButton();

    expect(button.getAttribute('data-delegates-live')).toBe('true');
    const tooltip = hoverTooltip(button);
    expect(tooltip).toContain(DELEGATES_DEFER_AUTO_ARCHIVE_TOOLTIP);
    expect(tooltip).not.toContain(BACKGROUND_DEFERS_AUTO_ARCHIVE_TOOLTIP);
  });

  it('uses the background-work copy when provider agents or workflows are live', () => {
    useLiveBackgroundTaskStore.getState().applyPush({
      ...TARGET,
      sessionActive: true,
      liveTasks: [{ taskId: 'agent', taskType: 'local_agent' }],
    });
    const button = renderButton();

    expect(button.hasAttribute('data-delegates-live')).toBe(false);
    expect(hoverTooltip(button)).toContain(
      BACKGROUND_DEFERS_AUTO_ARCHIVE_TOOLTIP,
    );
  });

  it('does not add an auto-archive suffix for shell-only work', () => {
    useLiveBackgroundTaskStore.getState().applyPush({
      ...TARGET,
      sessionActive: true,
      liveTasks: [{ taskId: 'shell', taskType: 'local_bash' }],
    });
    const button = renderButton();

    const tooltip = hoverTooltip(button);
    expect(tooltip).toContain(
      'This chat will move to the archive when the current turn finishes. Click to keep it open.',
    );
    expect(tooltip).not.toContain(DELEGATES_DEFER_AUTO_ARCHIVE_TOOLTIP);
    expect(tooltip).not.toContain(BACKGROUND_DEFERS_AUTO_ARCHIVE_TOOLTIP);
  });
});

/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { resetChatLiveStepWindowStoreForTest } from '@/stores/chatLiveStepWindowStore';
import { resetChatGroupToolCallsStoreForTest } from '@/stores/chatGroupToolCallsStore';
import { ChatLiveStepWindowSection } from '../ChatLiveStepWindowSection';

type SyncListener = (preferences: PreferencesData) => void;

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

let loadPreferences: jest.Mock<Promise<PreferencesData>, []>;
let savePreferences: jest.Mock<
  Promise<PreferencesData>,
  [Partial<PreferencesData>]
>;
let syncListeners: SyncListener[] = [];

function installApi(enabled: boolean): void {
  syncListeners = [];
  loadPreferences = jest
    .fn<Promise<PreferencesData>, []>()
    .mockResolvedValue(
      makeTestPreferences({ chatLiveStepWindowEnabled: enabled }),
    );
  savePreferences = jest
    .fn<Promise<PreferencesData>, [Partial<PreferencesData>]>()
    .mockImplementation((patch) =>
      Promise.resolve(
        makeTestPreferences({
          chatLiveStepWindowEnabled: patch.chatLiveStepWindowEnabled === true,
          chatGroupToolCallsEnabled: patch.chatGroupToolCallsEnabled === true,
        }),
      ),
    );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences,
      savePreferences,
      onPreferencesSynced: (listener: SyncListener): (() => void) => {
        syncListeners.push(listener);
        return (): void => undefined;
      },
    },
  });
}

beforeEach(() => {
  resetChatLiveStepWindowStoreForTest();
  resetChatGroupToolCallsStoreForTest();
});

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
  });
}

async function mount(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  act(() => {
    root = createRoot(container);
    root.render(<ChatLiveStepWindowSection />);
  });
  await settle();
  return {
    container,
    cleanup: (): void => {
      act(() => root?.unmount());
      container.remove();
    },
  };
}

function toggleOf(container: HTMLElement): HTMLButtonElement {
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="chat-live-step-window-toggle"]',
  );
  if (!toggle) throw new Error('Expected the live step window toggle.');
  return toggle;
}

describe('ChatLiveStepWindowSection', () => {
  it('is off by default and says what it changes', async () => {
    installApi(false);
    const { container, cleanup } = await mount();
    try {
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
      expect(toggleOf(container).disabled).toBe(false);
      expect(container.textContent).toContain('three most recent steps');
    } finally {
      cleanup();
    }
  });

  it('reflects a saved choice on load', async () => {
    installApi(true);
    const { container, cleanup } = await mount();
    try {
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('true');
    } finally {
      cleanup();
    }
  });

  it('saves the choice when switched on and back off', async () => {
    installApi(false);
    const { container, cleanup } = await mount();
    try {
      act(() => {
        toggleOf(container).click();
      });
      await settle();
      expect(savePreferences).toHaveBeenLastCalledWith({
        chatLiveStepWindowEnabled: true,
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('true');

      act(() => {
        toggleOf(container).click();
      });
      await settle();
      expect(savePreferences).toHaveBeenLastCalledWith({
        chatLiveStepWindowEnabled: false,
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
    } finally {
      cleanup();
    }
  });

  it('rolls back and explains when the save fails', async () => {
    installApi(false);
    savePreferences.mockRejectedValue(new Error('disk full'));
    const { container, cleanup } = await mount();
    try {
      act(() => {
        toggleOf(container).click();
      });
      await settle();
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
      expect(container.textContent).toContain(
        'Could not save this setting. Try again.',
      );
    } finally {
      cleanup();
    }
  });

  it('follows a change saved in another window', async () => {
    installApi(false);
    const { container, cleanup } = await mount();
    try {
      loadPreferences.mockResolvedValue(
        makeTestPreferences({ chatLiveStepWindowEnabled: true }),
      );
      act(() => {
        for (const listener of syncListeners) {
          listener(makeTestPreferences({ chatLiveStepWindowEnabled: true }));
        }
      });
      await settle();
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('true');
    } finally {
      cleanup();
    }
  });

  it('saves Group tool calls on its own, off by default', async () => {
    installApi(false);
    const { container, cleanup } = await mount();
    try {
      const group = container.querySelector<HTMLButtonElement>(
        '[data-testid="chat-group-tool-calls-toggle"]',
      );
      expect(group?.getAttribute('aria-checked')).toBe('false');
      act(() => {
        group?.click();
      });
      await settle();
      expect(savePreferences).toHaveBeenCalledWith({
        chatGroupToolCallsEnabled: true,
      });
      expect(group?.getAttribute('aria-checked')).toBe('true');
      // "Show only recent steps" is a separate switch and stays off.
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
    } finally {
      cleanup();
    }
  });
});

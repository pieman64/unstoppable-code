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
import { useNavigationModeStore } from '@/stores/navigationModeStore';
import { NavigationModeSection } from '../NavigationModeSection';

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

let loadPreferences: jest.Mock;
let savePreferences: jest.Mock;
// Shared across tests on purpose: the store subscribes to
// `onPreferencesSynced` once per renderer session, so the subscriber it
// registered under the first test's `window.api` must keep receiving the
// broadcasts replayed by later tests.
const syncSubscribers: ((preferences: PreferencesData) => void)[] = [];

beforeEach(() => {
  loadPreferences = jest.fn().mockResolvedValue(makeTestPreferences());
  savePreferences = jest.fn().mockResolvedValue(makeTestPreferences());
  const onPreferencesSynced = jest.fn(
    (cb: (p: PreferencesData) => void): (() => void) => {
      syncSubscribers.push(cb);
      return (): void => {
        const index = syncSubscribers.indexOf(cb);
        if (index >= 0) syncSubscribers.splice(index, 1);
      };
    },
  );
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { loadPreferences, savePreferences, onPreferencesSynced },
  });
  useNavigationModeStore.setState({ mode: 'code', hydrated: false });
});

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

async function mount(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<NavigationModeSection />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    cleanup: (): void => {
      act(() => {
        root?.unmount();
      });
      container.remove();
    },
  };
}

function button(
  container: HTMLElement,
  mode: 'code' | 'work',
): HTMLButtonElement {
  const el = container.querySelector(
    `[data-testid="settings-navigation-mode-${mode}"]`,
  );
  if (!(el instanceof HTMLButtonElement)) {
    throw new Error(`Expected the ${mode} mode button`);
  }
  return el;
}

async function click(el: HTMLButtonElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('NavigationModeSection (CAN-1817)', () => {
  test('reflects the persisted mode and offers Code before Work', async () => {
    loadPreferences.mockResolvedValue(
      makeTestPreferences({ navigationMode: 'work' }),
    );
    const { container, cleanup } = await mount();
    try {
      expect(button(container, 'work').getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(button(container, 'code').getAttribute('aria-pressed')).toBe(
        'false',
      );
      const buttons = Array.from(
        container.querySelectorAll(
          '[data-testid^="settings-navigation-mode-"]',
        ),
      ).map((el) => el.getAttribute('data-testid'));
      expect(buttons).toEqual([
        'settings-navigation-mode-code',
        'settings-navigation-mode-work',
      ]);
    } finally {
      cleanup();
    }
  });

  test('persists an override and applies it immediately', async () => {
    const { container, cleanup } = await mount();
    try {
      expect(button(container, 'code').getAttribute('aria-pressed')).toBe(
        'true',
      );
      await click(button(container, 'work'));
      expect(savePreferences).toHaveBeenCalledWith({ navigationMode: 'work' });
      expect(button(container, 'work').getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(useNavigationModeStore.getState().mode).toBe('work');
    } finally {
      cleanup();
    }
  });

  test('reverts and explains when the save fails', async () => {
    savePreferences.mockRejectedValue(new Error('disk full'));
    const { container, cleanup } = await mount();
    try {
      await click(button(container, 'work'));
      expect(button(container, 'code').getAttribute('aria-pressed')).toBe(
        'true',
      );
      expect(useNavigationModeStore.getState().mode).toBe('code');
      expect(
        container.querySelector(
          '[data-testid="settings-navigation-mode-error"]',
        )?.textContent,
      ).toContain("Couldn't save");
      expect(
        container
          .querySelector('[data-testid="settings-navigation-mode-error"]')
          ?.classList.contains('fg-destructive'),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test('ignores a stale failure once a newer selection has settled', async () => {
    const stale: { reject?: (error: Error) => void } = {};
    savePreferences
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            stale.reject = reject;
          }),
      )
      .mockResolvedValueOnce(makeTestPreferences({ navigationMode: 'code' }));
    const { container, cleanup } = await mount();
    try {
      // First selection hangs, second selection succeeds.
      await click(button(container, 'work'));
      await click(button(container, 'code'));
      expect(useNavigationModeStore.getState().mode).toBe('code');

      if (!stale.reject) throw new Error('first save never started');
      await act(async () => {
        stale.reject?.(new Error('stale failure'));
        await Promise.resolve();
        await Promise.resolve();
      });
      // The persisted selection stands and no error is shown for the
      // superseded request.
      expect(useNavigationModeStore.getState().mode).toBe('code');
      expect(
        container.querySelector(
          '[data-testid="settings-navigation-mode-error"]',
        ),
      ).toBeNull();
    } finally {
      cleanup();
    }
  });

  test('follows a mode persisted elsewhere through the synced broadcast', async () => {
    const { container, cleanup } = await mount();
    try {
      // A broadcast is only an invalidation signal: the store re-reads the
      // canonical preferences, so the snapshot payload itself is ignored.
      loadPreferences.mockResolvedValue(
        makeTestPreferences({ navigationMode: 'work' }),
      );
      await act(async () => {
        for (const subscriber of syncSubscribers) {
          subscriber(makeTestPreferences({ navigationMode: 'code' }));
        }
        await Promise.resolve();
      });
      expect(button(container, 'work').getAttribute('aria-pressed')).toBe(
        'true',
      );
    } finally {
      cleanup();
    }
  });
});

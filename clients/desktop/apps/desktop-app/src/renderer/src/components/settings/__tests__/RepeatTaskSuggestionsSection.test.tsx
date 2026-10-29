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
  PreferencesData,
  PreferencesSaveResult,
} from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { REPEAT_TASK_HISTORY_STORAGE_KEY } from '@/lib/repeat-task-automation/history';
import { useRepeatTaskOfferStore } from '@/lib/repeat-task-automation/offerStore';
import { RepeatTaskSuggestionsSection } from '../RepeatTaskSuggestionsSection';

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

let savePreferences: jest.Mock<
  Promise<PreferencesSaveResult>,
  [Partial<PreferencesData>]
>;
let syncedListener: ((preferences: PreferencesSaveResult) => void) | null;

/** `saved` is the stored value; `undefined` models older preferences. */
function installApi(
  saved: boolean | undefined,
  save: 'ok' | 'fail' = 'ok',
): void {
  savePreferences = jest
    .fn<Promise<PreferencesSaveResult>, [Partial<PreferencesData>]>()
    .mockImplementation((patch) =>
      save === 'fail'
        ? Promise.reject(new Error('save failed'))
        : Promise.resolve(
            makeTestPreferences({
              repeatTaskAutomationSuggestionsEnabled:
                patch.repeatTaskAutomationSuggestionsEnabled,
            }),
          ),
    );
  syncedListener = null;
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: () =>
        Promise.resolve(
          makeTestPreferences(
            saved === undefined
              ? {}
              : { repeatTaskAutomationSuggestionsEnabled: saved },
          ),
        ),
      savePreferences,
      onPreferencesSynced: (
        listener: (preferences: PreferencesSaveResult) => void,
      ): (() => void) => {
        syncedListener = listener;
        return () => undefined;
      },
    },
  });
}

function seedHistoryAndOffer(): void {
  window.localStorage.setItem(REPEAT_TASK_HISTORY_STORAGE_KEY, '[]');
  useRepeatTaskOfferStore.setState({
    offer: {
      entryId: 'entry-1',
      accountEpoch: 0,
      seed: { projectId: 'workspace-1', isCowork: false },
    },
  });
}

function expectSuggestionsStopped(): void {
  expect(window.localStorage.getItem(REPEAT_TASK_HISTORY_STORAGE_KEY)).toBe(
    null,
  );
  expect(useRepeatTaskOfferStore.getState().offer).toBeNull();
}

beforeEach(() => {
  window.localStorage.clear();
  useRepeatTaskOfferStore.setState({ offer: null });
});

afterEach(() => {
  if (originalApiDescriptor) {
    Object.defineProperty(window, 'api', originalApiDescriptor);
  } else {
    Reflect.deleteProperty(window, 'api');
  }
});

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function mount(): Promise<{
  container: HTMLElement;
  cleanup: () => void;
}> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<RepeatTaskSuggestionsSection />);
    await flush();
  });
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
    '[data-testid="settings-repeat-task-suggestions-toggle"]',
  );
  if (!toggle)
    throw new Error('Expected the repeated-task suggestions toggle.');
  return toggle;
}

describe('RepeatTaskSuggestionsSection', () => {
  it('is on by default for preferences saved before the setting existed', async () => {
    installApi(undefined);
    seedHistoryAndOffer();
    const { container, cleanup } = await mount();

    try {
      expect(container.querySelector('h2')?.textContent).toBe('Suggestions');
      const toggle = toggleOf(container);
      expect(toggle.getAttribute('aria-label')).toBe(
        'Suggest automations for repeated tasks',
      );
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(toggle.disabled).toBe(false);
      expect(useRepeatTaskOfferStore.getState().offer).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('saves the choice and stops suggestions when switched off', async () => {
    installApi(true);
    seedHistoryAndOffer();
    const { container, cleanup } = await mount();

    try {
      await act(async () => {
        toggleOf(container).click();
        await flush();
      });
      expect(savePreferences).toHaveBeenCalledWith({
        repeatTaskAutomationSuggestionsEnabled: false,
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
      expectSuggestionsStopped();
    } finally {
      cleanup();
    }
  });

  it('keeps suggestions and shows an error when the save fails', async () => {
    installApi(true, 'fail');
    seedHistoryAndOffer();
    const { container, cleanup } = await mount();

    try {
      await act(async () => {
        toggleOf(container).click();
        await flush();
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('true');
      expect(container.textContent).toContain(
        "Couldn't save this setting. Try again.",
      );
      expect(useRepeatTaskOfferStore.getState().offer).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('follows a choice saved from another window', async () => {
    installApi(true);
    const { container, cleanup } = await mount();
    seedHistoryAndOffer();

    try {
      act(() => {
        syncedListener?.(
          makeTestPreferences({
            repeatTaskAutomationSuggestionsEnabled: false,
          }),
        );
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
      expectSuggestionsStopped();
    } finally {
      cleanup();
    }
  });
});

/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import type {
  PreferencesData,
  PreferencesSaveResult,
} from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { LedgerAgentRecordingSection } from '../LedgerAgentRecordingSection';

const originalApiDescriptor = Object.getOwnPropertyDescriptor(window, 'api');

let loadPreferences: jest.Mock<Promise<PreferencesData>, []>;
let savePreferences: jest.Mock<
  Promise<PreferencesSaveResult>,
  [Partial<PreferencesData>]
>;
let syncedListener: ((preferences: PreferencesSaveResult) => void) | null;
let stopSynced: jest.Mock<void, []>;

function setLedgerFlag(enabled: boolean): void {
  const snapshot = getDefaultFeatureFlagSnapshot();
  snapshot.values[CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key] = enabled;
  useFeatureFlagsStore.setState({ snapshot });
}

/** `saved` is the stored value; `undefined` models older preferences. */
function installApi(saved: boolean | undefined): void {
  loadPreferences = jest
    .fn<Promise<PreferencesData>, []>()
    .mockResolvedValue(
      makeTestPreferences(
        saved === undefined ? {} : { ledgerAgentRecordingEnabled: saved },
      ),
    );
  savePreferences = jest
    .fn<Promise<PreferencesSaveResult>, [Partial<PreferencesData>]>()
    .mockImplementation((patch) =>
      Promise.resolve(
        makeTestPreferences({
          ledgerAgentRecordingEnabled: patch.ledgerAgentRecordingEnabled,
        }),
      ),
    );
  syncedListener = null;
  stopSynced = jest.fn<void, []>();
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences,
      savePreferences,
      onPreferencesSynced: (
        listener: (preferences: PreferencesSaveResult) => void,
      ): (() => void) => {
        syncedListener = listener;
        return stopSynced;
      },
    },
  });
}

afterEach(() => {
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
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
    root.render(<LedgerAgentRecordingSection />);
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

function rowOf(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(
    '[data-testid="settings-ledger-agent-recording"]',
  );
}

function toggleOf(container: HTMLElement): HTMLButtonElement {
  const toggle = container.querySelector<HTMLButtonElement>(
    '[data-testid="settings-ledger-agent-recording-toggle"]',
  );
  if (!toggle) throw new Error('Expected the Agents add to the Feed toggle.');
  return toggle;
}

describe('LedgerAgentRecordingSection', () => {
  it('stays hidden and reads nothing while the Ledger flag is off', async () => {
    setLedgerFlag(false);
    installApi(true);
    const { container, cleanup } = await mount();

    try {
      expect(rowOf(container)).toBeNull();
      expect(container.textContent).toBe('');
      expect(loadPreferences).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it('shows the setting on by default when the Ledger flag is on', async () => {
    setLedgerFlag(true);
    installApi(undefined);
    const { container, cleanup } = await mount();

    try {
      expect(container.querySelector('h2')?.textContent).toBe('Feed');
      const row = rowOf(container);
      expect(row).not.toBeNull();
      expect(row?.querySelector('label')?.textContent).toBe(
        'Agents add to the Feed',
      );
      expect(row?.textContent).toContain(
        'Agents add and update entries as they work.',
      );
      const toggle = toggleOf(container);
      expect(toggle.getAttribute('role')).toBe('switch');
      expect(toggle.getAttribute('aria-label')).toBe('Agents add to the Feed');
      expect(toggle.getAttribute('aria-checked')).toBe('true');
      expect(toggle.disabled).toBe(false);
    } finally {
      cleanup();
    }
  });

  it('reflects a saved choice to stop agents recording', async () => {
    setLedgerFlag(true);
    installApi(false);
    const { container, cleanup } = await mount();

    try {
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
    } finally {
      cleanup();
    }
  });

  it('saves only this setting when switched off', async () => {
    setLedgerFlag(true);
    installApi(true);
    const { container, cleanup } = await mount();

    try {
      await act(async () => {
        toggleOf(container).click();
        await flush();
      });
      expect(savePreferences).toHaveBeenCalledTimes(1);
      expect(savePreferences).toHaveBeenCalledWith({
        ledgerAgentRecordingEnabled: false,
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
    } finally {
      cleanup();
    }
  });

  it('switches from its visible label', async () => {
    setLedgerFlag(true);
    installApi(false);
    const { container, cleanup } = await mount();

    try {
      const label = container.querySelector('label');
      if (!label) throw new Error('Expected a visible label.');
      await act(async () => {
        label.click();
        await flush();
      });
      expect(savePreferences).toHaveBeenCalledWith({
        ledgerAgentRecordingEnabled: true,
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('true');
    } finally {
      cleanup();
    }
  });

  it('rolls back and explains when the save fails', async () => {
    setLedgerFlag(true);
    installApi(true);
    savePreferences.mockRejectedValue(new Error('disk full'));
    const { container, cleanup } = await mount();

    try {
      await act(async () => {
        toggleOf(container).click();
        await flush();
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('true');
      expect(container.textContent).toContain("Couldn't save this setting.");
      expect(container.textContent).toContain('Try again.');
    } finally {
      cleanup();
    }
  });

  it('follows a choice saved in another window', async () => {
    setLedgerFlag(true);
    installApi(true);
    const { container, cleanup } = await mount();

    try {
      await act(async () => {
        syncedListener?.(
          makeTestPreferences({ ledgerAgentRecordingEnabled: false }),
        );
        await flush();
      });
      expect(toggleOf(container).getAttribute('aria-checked')).toBe('false');
    } finally {
      cleanup();
    }
    expect(stopSynced).toHaveBeenCalled();
  });
});

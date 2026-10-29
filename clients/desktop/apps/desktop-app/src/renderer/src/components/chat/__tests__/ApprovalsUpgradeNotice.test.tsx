/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { ApprovalsUpgradeNotice } from '../ApprovalsUpgradeNotice';
import { useNavigationStore } from '@/stores/navigationStore';
import { makeTestPreferences } from '@/test-utils/preferences';

async function flushAsyncEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ApprovalsUpgradeNotice', () => {
  const initialOpenSettings = useNavigationStore.getState().openSettings;
  const loadPreferences = jest.fn<Promise<PreferencesData>, []>();
  const savePreferences = jest.fn<
    Promise<PreferencesData>,
    [Partial<PreferencesData>]
  >();

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    loadPreferences.mockReset();
    savePreferences.mockReset();

    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences,
        savePreferences,
      },
    });

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useNavigationStore.setState({ openSettings: initialOpenSettings });
  });

  it('shows the notice when the preference is not dismissed', async () => {
    loadPreferences.mockResolvedValue(
      makeTestPreferences({ approvalsUpgradeNoticeDismissed: false }),
    );

    await act(async () => {
      root.render(<ApprovalsUpgradeNotice />);
      await flushAsyncEffects();
    });

    // CAN-3055 copy pass: the notice explains what the setting does in plain
    // language instead of describing the migration that no longer causes it.
    expect(container.textContent).toContain('Agents can act without asking');
    expect(container.textContent).toContain(
      'runs agent actions like editing files and running commands without checking with you first',
    );
    expect(container.textContent).toContain(
      'Change this any time in Settings.',
    );
    expect(container.textContent).not.toContain('Existing profiles');
    expect(container.textContent).not.toMatch(/full access/i);
  });

  it('renders nothing once the preference is dismissed', async () => {
    loadPreferences.mockResolvedValue(
      makeTestPreferences({ approvalsUpgradeNoticeDismissed: true }),
    );

    await act(async () => {
      root.render(<ApprovalsUpgradeNotice />);
      await flushAsyncEffects();
    });

    expect(container.innerHTML).toBe('');
  });

  it('opens the approvals settings section', async () => {
    const openSettings = jest.fn();
    useNavigationStore.setState({ openSettings });
    loadPreferences.mockResolvedValue(
      makeTestPreferences({ approvalsUpgradeNoticeDismissed: false }),
    );

    await act(async () => {
      root.render(<ApprovalsUpgradeNotice />);
      await flushAsyncEffects();
    });

    const openSettingsButton = container.querySelector(
      '[data-testid="approvals-upgrade-notice-open-settings"]',
    );
    if (!(openSettingsButton instanceof HTMLButtonElement)) {
      throw new Error('Expected the open-settings button');
    }
    act(() => openSettingsButton.click());
    expect(openSettings).toHaveBeenCalledWith('approvals');
  });

  it('dismisses immediately and persists the preference', async () => {
    loadPreferences.mockResolvedValue(
      makeTestPreferences({ approvalsUpgradeNoticeDismissed: false }),
    );
    savePreferences.mockResolvedValue(
      makeTestPreferences({ approvalsUpgradeNoticeDismissed: true }),
    );

    await act(async () => {
      root.render(<ApprovalsUpgradeNotice />);
      await flushAsyncEffects();
    });

    const dismissButton = container.querySelector(
      '[data-testid="approvals-upgrade-notice-dismiss"]',
    );
    if (!(dismissButton instanceof HTMLButtonElement)) {
      throw new Error('Expected the dismiss button');
    }

    await act(async () => {
      dismissButton.click();
      await flushAsyncEffects();
    });

    expect(container.innerHTML).toBe('');
    expect(savePreferences).toHaveBeenCalledWith({
      approvalsUpgradeNoticeDismissed: true,
    });
  });
});

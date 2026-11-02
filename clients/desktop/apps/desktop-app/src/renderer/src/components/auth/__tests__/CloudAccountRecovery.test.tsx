/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyCloudAccountPublicState,
  ResetUnreadableCanopyCloudAccountResult,
} from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { CloudAuthPanel } from '../CloudAuthPanel';
import { CanopyCloudAccountSection } from '@/components/settings/CanopyCloudAccountSection';

/**
 * An unreadable credential collapses to a signed-out-shaped snapshot; `read`
 * is the only field distinguishing it from a real sign-out, which is exactly
 * why routing on `hasApiKey`/`account` alone dropped the user into ordinary
 * OAuth against an entry they could never get past.
 */
function unreadableAccount(): CanopyCloudAccountPublicState {
  return {
    read: 'error',
    hasApiKey: false,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
  };
}

function signedOutAccount(): CanopyCloudAccountPublicState {
  return {
    read: 'ok',
    hasApiKey: false,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
  };
}

describe('cloud account recovery surfaces', () => {
  let container: HTMLElement;
  let root: Root;
  const loadCanopyCloudAccount = jest.fn();
  const resetUnreadableCanopyCloudAccount = jest.fn();
  const startCanopyCloudOAuthLogin = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    loadCanopyCloudAccount.mockResolvedValue(unreadableAccount());
    const resetResult: ResetUnreadableCanopyCloudAccountResult = {
      status: 'reset',
      account: signedOutAccount(),
      backupFileName: 'canopy-cloud-account.enc.bak-20260903-101112-000Z-ab12',
    };
    resetUnreadableCanopyCloudAccount.mockResolvedValue(resetResult);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadCanopyCloudAccount,
        loadCanopyCloudApiKey: jest.fn().mockResolvedValue(''),
        loadPreferences: jest
          .fn()
          .mockResolvedValue(
            makeTestPreferences({ telemetrySharingPromptSeen: true }),
          ),
        savePreferences: jest.fn().mockResolvedValue(undefined),
        startCanopyCloudOAuthLogin,
        cancelCanopyCloudOAuthLogin: jest.fn().mockResolvedValue(undefined),
        resetUnreadableCanopyCloudAccount,
      },
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(window, 'api');
    jest.clearAllMocks();
  });

  async function settle(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  }

  async function renderPanel(): Promise<void> {
    await act(async () => {
      root.render(<CloudAuthPanel />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  }

  async function renderSettings(): Promise<void> {
    await act(async () => {
      root.render(<CanopyCloudAccountSection />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  }

  function find(testId: string): HTMLElement | null {
    return (
      container.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ??
      document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
    );
  }

  async function click(testId: string): Promise<void> {
    const target = find(testId);
    await act(async () => {
      target?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  }

  describe.each([
    ['CloudAuthPanel', renderPanel] as const,
    ['CanopyCloudAccountSection', renderSettings] as const,
  ])('%s', (_name, render) => {
    it('shows recovery instead of sign-in for an unreadable account', async () => {
      await render();

      expect(find('cloud-account-recovery-notice')).not.toBeNull();
      expect(find('settings-account-canopy-cloud-oauth')).toBeNull();
      expect(find('settings-account-canopy-cloud-api-key')).toBeNull();
      expect(find('settings-account-canopy-cloud-oauth-login')).toBeNull();
      expect(startCanopyCloudOAuthLogin).not.toHaveBeenCalled();
    });

    it('does not mutate anything until the confirmation is accepted', async () => {
      await render();
      await click('cloud-account-recovery-reset');

      expect(find('cloud-account-recovery-confirm')).not.toBeNull();
      expect(resetUnreadableCanopyCloudAccount).not.toHaveBeenCalled();
    });

    it('cancels confirmation without mutating account state', async () => {
      await render();
      await click('cloud-account-recovery-reset');
      // The shared confirmation's Cancel (its esc chip is part of its text).
      const cancelButton = document.body.querySelector<HTMLButtonElement>(
        '[data-testid="confirm-dialog-cancel"]',
      );

      await act(async () => {
        cancelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        for (let i = 0; i < 4; i += 1) await Promise.resolve();
      });

      expect(find('cloud-account-recovery-confirm')).toBeNull();
      expect(find('cloud-account-recovery-notice')).not.toBeNull();
      expect(resetUnreadableCanopyCloudAccount).not.toHaveBeenCalled();
    });

    it('returns to ordinary sign-in after a successful reset', async () => {
      await render();
      await click('cloud-account-recovery-reset');
      await click('cloud-account-recovery-confirm-button');

      expect(resetUnreadableCanopyCloudAccount).toHaveBeenCalledTimes(1);
      expect(find('cloud-account-recovery-notice')).toBeNull();
      expect(find('cloud-account-recovery-confirm')).toBeNull();
      expect(find('settings-account-canopy-cloud-oauth')).not.toBeNull();
      expect(container.textContent).toContain(
        'Saved sign-in was reset. Sign in again to reconnect.',
      );
    });

    it('keeps the notice and reports the failure when the reset rejects', async () => {
      resetUnreadableCanopyCloudAccount.mockRejectedValue(
        new Error('locked by another build'),
      );

      await render();
      await click('cloud-account-recovery-reset');
      await click('cloud-account-recovery-confirm-button');

      expect(find('cloud-account-recovery-notice')).not.toBeNull();
      expect(find('cloud-account-recovery-confirm')).not.toBeNull();
      expect(document.body.textContent).toContain(
        'Couldn’t reset the saved sign-in. Close other desktop builds and try again.',
      );
    });
  });

  it('does not announce a reset that turned out not to be needed', async () => {
    const notNeeded: ResetUnreadableCanopyCloudAccountResult = {
      status: 'not-needed',
      account: signedOutAccount(),
    };
    resetUnreadableCanopyCloudAccount.mockResolvedValue(notNeeded);

    await renderPanel();
    await click('cloud-account-recovery-reset');
    await click('cloud-account-recovery-confirm-button');

    expect(find('cloud-account-recovery-notice')).toBeNull();
    expect(container.textContent).not.toContain('Saved sign-in was reset');
  });

  it('issues one request for a double-confirmed reset', async () => {
    let release: (
      value: ResetUnreadableCanopyCloudAccountResult,
    ) => void = () => undefined;
    resetUnreadableCanopyCloudAccount.mockImplementation(
      () =>
        new Promise<ResetUnreadableCanopyCloudAccountResult>((resolve) => {
          release = resolve;
        }),
    );

    await renderPanel();
    await click('cloud-account-recovery-reset');
    await click('cloud-account-recovery-confirm-button');
    await click('cloud-account-recovery-confirm-button');

    expect(resetUnreadableCanopyCloudAccount).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({
        status: 'reset',
        account: signedOutAccount(),
        backupFileName: 'b',
      });
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    await settle();
  });

  it('leaves a readable signed-out account on the ordinary sign-in path', async () => {
    loadCanopyCloudAccount.mockResolvedValue(signedOutAccount());

    await renderPanel();

    expect(find('cloud-account-recovery-notice')).toBeNull();
    expect(find('settings-account-canopy-cloud-oauth')).not.toBeNull();
  });
});

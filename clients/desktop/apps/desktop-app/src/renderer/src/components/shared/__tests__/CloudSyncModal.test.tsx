/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useGitHubStore, type Toast } from '@/stores/githubStore';
import { CloudSyncModal } from '../CloudSyncModal';

jest.mock('@/components/shared/DialogModal', () => ({
  DialogModal: function MockDialogModal({
    children,
    dataTestId,
    onClose,
    closeOnBackdrop,
    closeOnEscape,
    showCloseButton = true,
  }: {
    children: ReactNode;
    dataTestId?: string;
    onClose: () => void;
    closeOnBackdrop?: boolean;
    closeOnEscape?: boolean;
    showCloseButton?: boolean;
  }): JSX.Element {
    return (
      <div
        data-testid={dataTestId}
        data-close-on-backdrop={String(closeOnBackdrop)}
        data-close-on-escape={String(closeOnEscape)}
      >
        {showCloseButton ? (
          <button
            type="button"
            onClick={onClose}
            data-testid="mock-dialog-close"
          >
            Close
          </button>
        ) : null}
        {children}
      </div>
    );
  },
}));

/**
 * The privacy/telemetry controls this modal used to embed are gone — the gate
 * is a conversion surface now, and `settings/__tests__/PrivacyTab.test.tsx`
 * already owns every telemetry-lock and subscription-gate behaviour that used
 * to be asserted here twice.
 */
describe('CloudSyncModal', () => {
  let container: HTMLElement;
  let root: Root;
  const loadCanopyCloudAccount = jest.fn();
  const startCanopyCloudOAuthLogin = jest.fn();
  let addedToasts: Toast[];

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    addedToasts = [];
    loadCanopyCloudAccount.mockResolvedValue(disconnectedAccount());
    startCanopyCloudOAuthLogin.mockResolvedValue({
      status: {
        authenticated: false,
        account: null,
        capabilities: [],
        missingCapabilities: [],
        error: null,
      },
      account: disconnectedAccount(),
    });
    useGitHubStore.setState({
      addToast: (message, type, onClick, meta): void => {
        addedToasts.push({
          id: `toast-${addedToasts.length}`,
          message,
          type,
          onClick,
          createdAt: 0,
          meta,
        });
      },
    });
    Object.assign(window, {
      api: {
        loadPreferences: jest.fn(() =>
          Promise.resolve(
            makeTestPreferences({ telemetrySharingPromptSeen: true }),
          ),
        ),
        savePreferences: jest.fn(() => Promise.resolve(makeTestPreferences())),
        loadCanopyCloudAccount,
        loadCanopyCloudApiKey: jest.fn(() => Promise.resolve('')),
        saveCanopyCloudApiKey: jest.fn(() =>
          Promise.resolve({
            status: {
              authenticated: false,
              account: null,
              capabilities: [],
              missingCapabilities: [],
              error: null,
              organizations: [],
              teams: [],
            },
            account: disconnectedAccount(),
          }),
        ),
        clearCanopyCloudApiKey: jest.fn(() =>
          Promise.resolve(disconnectedAccount()),
        ),
        startCanopyCloudOAuthLogin,
        cancelCanopyCloudOAuthLogin: jest.fn(() => Promise.resolve()),
        disconnectCanopyCloudAccount: jest.fn(() =>
          Promise.resolve(disconnectedAccount()),
        ),
      } as Partial<CanopyApi> as CanopyApi,
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
  });

  it('leads with one primary sign-in action and demotes the API key to a link', async () => {
    await renderModal();

    const cta = container.querySelector(
      '[data-testid="settings-account-canopy-cloud-oauth-login"]',
    );
    expect(cta?.textContent?.trim()).toBe('Sign in with Canopy');
    expect(cta?.className).toContain('w-full');

    // The manual fallback is an escape hatch below the CTA, not a peer of it.
    const apiKeyLink = container.querySelector(
      '[data-testid="settings-account-canopy-cloud-mode-api-key"]',
    );
    expect(apiKeyLink?.textContent?.trim()).toBe('Use an API key instead');
    // The segmented OAuth | API Key control is gone.
    expect(
      container.querySelector(
        '[data-testid="settings-account-canopy-cloud-mode-toggle"]',
      ),
    ).toBeNull();
    // Shared defaults are accurate for ordinary signed-out users.
    expect(container.textContent).toContain(
      'Keep your work synced to your account',
    );
    expect(container.textContent ?? '').not.toMatch(/guest/i);
    expect(container.textContent).toContain(
      'Opens your browser. Takes about ten seconds.',
    );
  });

  it('uses guest-specific reassurance only when the caller confirms a guest entry point', async () => {
    await renderModal({ guestBenefits: true });

    expect(container.textContent).toContain(
      "Keep the work you've done as a guest",
    );
    expect(
      container.querySelector(
        '[data-testid="settings-account-canopy-cloud-mode-api-key"]',
      ),
    ).toBeNull();
  });

  it('derives guest-safe copy and controls from the loaded account', async () => {
    loadCanopyCloudAccount.mockResolvedValue(guestAccount());

    await renderModal();

    expect(container.textContent).toContain(
      "Keep the work you've done as a guest",
    );
    expect(
      container.querySelector(
        '[data-testid="settings-account-canopy-cloud-mode-api-key"]',
      ),
    ).toBeNull();
  });

  it('swaps to the API-key panel with a submit button, hiding the OAuth CTA', async () => {
    await renderModal();

    const apiKeyLink = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-account-canopy-cloud-mode-api-key"]',
    );
    await act(async () => {
      apiKeyLink?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(
      container.querySelector(
        '[data-testid="settings-account-canopy-cloud-api-key-input"]',
      ),
    ).not.toBeNull();
    // Regression guard for the reported bug: selecting API Key used to remove
    // every submit affordance and silently autosave on a debounce.
    const submit = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-account-canopy-cloud-api-key-submit"]',
    );
    expect(submit).not.toBeNull();
    expect(submit?.getAttribute('type')).toBe('submit');
    expect(
      container.querySelector(
        '[data-testid="settings-account-canopy-cloud-oauth-login"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="settings-account-canopy-cloud-mode-oauth"]',
      )?.textContent,
    ).toContain('Back to sign in');
  });

  it('closes and fires a persistent Account toast when the user signs in', async () => {
    const onClose = jest.fn();
    startCanopyCloudOAuthLogin.mockResolvedValue({
      status: {
        authenticated: true,
        account: connectedAccount().account,
        capabilities: ['portal-v1'],
        missingCapabilities: [],
        error: null,
      },
      account: connectedAccount(),
    });

    await renderModal({ onClose, toastMessage: 'You can now share this run.' });

    const cta = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-account-canopy-cloud-oauth-login"]',
    );
    await act(async () => {
      cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(addedToasts).toHaveLength(1);
    expect(addedToasts[0]?.message).toBe('You can now share this run.');
    expect(addedToasts[0]?.type).toBe('success');
    expect(addedToasts[0]?.meta?.category).toBe('Account');
    expect(addedToasts[0]?.meta?.title).toBe('Sign in successful');
    expect(addedToasts[0]?.meta?.persistent).toBe(true);
    expect(addedToasts[0]?.meta?.forceInApp).toBe(true);
  });

  it('warns instead of claiming guest work was synced when OAuth merge fails open', async () => {
    startCanopyCloudOAuthLogin.mockResolvedValue({
      ...connectedResult(),
      guestDataMerged: false,
    });

    await renderModal({
      guestBenefits: true,
      toastMessage: 'Your guest work is synced.',
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-account-canopy-cloud-oauth-login"]',
        )
        ?.click();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(addedToasts).toHaveLength(1);
    expect(addedToasts[0]?.type).toBe('warning');
    expect(addedToasts[0]?.message).toContain("couldn't sync your guest work");
    expect(addedToasts[0]?.message).not.toContain('Your guest work is synced.');
    expect(addedToasts[0]?.meta?.forceInApp).toBe(true);
  });

  it('treats an explicit merge failure as conclusive without caller guest context', async () => {
    startCanopyCloudOAuthLogin.mockResolvedValue({
      ...connectedResult(),
      guestDataMerged: false,
    });

    await renderModal({ toastMessage: 'Your work is synced.' });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-account-canopy-cloud-oauth-login"]',
        )
        ?.click();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(addedToasts).toHaveLength(1);
    expect(addedToasts[0]?.type).toBe('warning');
    expect(addedToasts[0]?.message).toContain("couldn't sync your guest work");
  });

  it('warns when a confirmed guest OAuth response omits the merge outcome', async () => {
    startCanopyCloudOAuthLogin.mockResolvedValue(connectedResult());

    await renderModal({
      guestBenefits: true,
      toastMessage: 'Your guest work is synced.',
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-account-canopy-cloud-oauth-login"]',
        )
        ?.click();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(addedToasts).toHaveLength(1);
    expect(addedToasts[0]?.type).toBe('warning');
    expect(addedToasts[0]?.message).toContain("couldn't sync your guest work");
    expect(addedToasts[0]?.message).not.toContain('Your guest work is synced.');
  });

  it('closes without a toast when its account read finds another surface already connected', async () => {
    const onClose = jest.fn();
    loadCanopyCloudAccount.mockResolvedValue(connectedAccount());

    await renderModal({ onClose });

    // The gate performs its own authoritative re-check from `onClose`, so this
    // recovers the race without announcing a sign-in performed elsewhere.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(addedToasts).toHaveLength(0);
  });

  it('keeps the caller lead visible when a saved manual key opens the API-key pane', async () => {
    loadCanopyCloudAccount.mockResolvedValue(manualConnectedAccount());

    await renderModal({ description: 'Sign in before sharing this run.' });

    expect(container.textContent).toContain('Sign in before sharing this run.');
    expect(
      container.querySelector(
        '[data-testid="settings-account-canopy-cloud-api-key"]',
      ),
    ).not.toBeNull();
  });

  it('does not render the API-key pane when the caller disables that fallback', async () => {
    loadCanopyCloudAccount.mockResolvedValue(manualConnectedAccount());

    await renderModal({ guestBenefits: true });

    expect(
      container.querySelector(
        '[data-testid="settings-account-canopy-cloud-api-key"]',
      ),
    ).toBeNull();
    expect(
      container.querySelector(
        '[data-testid="settings-account-canopy-cloud-oauth"]',
      ),
    ).not.toBeNull();
  });

  it('mentions when OAuth replaced a stored manual API key in the success toast', async () => {
    loadCanopyCloudAccount.mockResolvedValue(manualConnectedAccount());
    startCanopyCloudOAuthLogin.mockResolvedValue(connectedResult());

    await renderModal({ toastMessage: "You're connected." });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-account-canopy-cloud-mode-oauth"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-account-canopy-cloud-oauth-login"]',
        )
        ?.click();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(addedToasts[0]?.message).toContain("You're connected.");
    expect(addedToasts[0]?.message).toContain(
      'Stored API key was replaced by OAuth sign-in.',
    );
  });

  it('keeps a failed sign-in in the modal with an inline notice, never a toast', async () => {
    const onClose = jest.fn();
    startCanopyCloudOAuthLogin.mockRejectedValue(new Error('denied'));

    await renderModal({ onClose });

    const cta = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-account-canopy-cloud-oauth-login"]',
    );
    await act(async () => {
      cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const alert = container.querySelector(
      '[data-testid="cloud-auth-panel-error"]',
    );
    expect(alert?.getAttribute('role')).toBe('status');
    expect(alert?.getAttribute('aria-live')).toBe('polite');
    expect(alert?.textContent).toContain('Unable to complete');
    expect(document.activeElement).toBe(cta);
    expect(onClose).not.toHaveBeenCalled();
    expect(addedToasts).toHaveLength(0);
  });

  it('removes every ambient close path while browser OAuth is pending', async () => {
    let resolveLogin:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    startCanopyCloudOAuthLogin.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );

    await renderModal();
    const cta = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-account-canopy-cloud-oauth-login"]',
    );
    await act(async () => {
      cta?.click();
      await Promise.resolve();
    });

    const modal = container.querySelector('[data-testid="cloud-sync-modal"]');
    expect(modal?.getAttribute('data-close-on-backdrop')).toBe('false');
    expect(modal?.getAttribute('data-close-on-escape')).toBe('false');
    expect(
      container.querySelector('[data-testid="mock-dialog-close"]'),
    ).toBeNull();
    const cancelButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-account-canopy-cloud-oauth-cancel"]',
    );
    expect(cancelButton).not.toBeNull();
    expect(document.activeElement).toBe(cancelButton);

    await act(async () => {
      resolveLogin?.(connectedResult());
      await Promise.resolve();
    });
  });

  it('keeps every ambient close path blocked until connect completion settles', async () => {
    let resolveLogin:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    startCanopyCloudOAuthLogin.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );
    const onClose = jest.fn();

    await renderModal({ onClose });
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-account-canopy-cloud-oauth-login"]',
        )
        ?.click();
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    const modal = container.querySelector('[data-testid="cloud-sync-modal"]');
    expect(modal?.getAttribute('data-close-on-backdrop')).toBe('false');
    expect(modal?.getAttribute('data-close-on-escape')).toBe('false');
    expect(
      container.querySelector('[data-testid="mock-dialog-close"]'),
    ).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      resolveLogin?.(connectedResult());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(addedToasts).toHaveLength(1);
  });

  it('blocks ambient close paths while an API key is validating', async () => {
    let resolveSave:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    window.api.saveCanopyCloudApiKey = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    await renderModal();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-account-canopy-cloud-mode-api-key"]',
        )
        ?.click();
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-account-canopy-cloud-api-key-input"]',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- native setter must be called with the input as `this` to bypass React's value tracker
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    await act(async () => {
      valueSetter?.call(input, 'canopy_test_key');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    const submit = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-account-canopy-cloud-api-key-submit"]',
    );
    await act(async () => {
      submit?.focus();
      submit?.click();
      await Promise.resolve();
    });

    const modal = container.querySelector('[data-testid="cloud-sync-modal"]');
    expect(modal?.getAttribute('data-close-on-backdrop')).toBe('false');
    expect(modal?.getAttribute('data-close-on-escape')).toBe('false');
    expect(
      container.querySelector('[data-testid="mock-dialog-close"]'),
    ).toBeNull();
    expect(
      container.querySelector<HTMLInputElement>(
        '[data-testid="settings-account-canopy-cloud-api-key-input"]',
      )?.disabled,
    ).toBe(true);
    expect(submit?.disabled).toBe(false);
    expect(submit?.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(submit);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-testid="settings-account-canopy-cloud-mode-oauth"]',
      )?.disabled,
    ).toBe(true);

    await act(async () => {
      resolveSave?.(connectedResult());
      await Promise.resolve();
    });
  });

  it('restores focus to the API-key field after validation fails', async () => {
    let rejectSave: ((error: Error) => void) | null = null;
    window.api.saveCanopyCloudApiKey = jest.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = reject;
        }),
    );

    await renderModal();
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="settings-account-canopy-cloud-mode-api-key"]',
        )
        ?.click();
      await Promise.resolve();
    });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="settings-account-canopy-cloud-api-key-input"]',
    );
    // eslint-disable-next-line @typescript-eslint/unbound-method -- native setter must be called with the input as `this` to bypass React's value tracker
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set;
    const submit = container.querySelector<HTMLButtonElement>(
      '[data-testid="settings-account-canopy-cloud-api-key-submit"]',
    );
    await act(async () => {
      valueSetter?.call(input, 'invalid-key');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
      submit?.focus();
      submit?.click();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(submit);

    await act(async () => {
      rejectSave?.(new Error('invalid'));
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });

    expect(document.activeElement).toBe(input);
  });

  async function renderModal(
    props: {
      onClose?: () => void;
      toastMessage?: string;
      guestBenefits?: boolean;
      description?: string;
    } = {},
  ): Promise<void> {
    await act(async () => {
      root.render(
        <CloudSyncModal
          onClose={props.onClose ?? jest.fn()}
          toastMessage={props.toastMessage}
          guestBenefits={props.guestBenefits}
          description={props.description}
        />,
      );
      for (let i = 0; i < 8; i += 1) {
        await Promise.resolve();
      }
    });
  }
});

function disconnectedAccount(): CanopyCloudAccountPublicState {
  return {
    hasApiKey: false,
    authMode: null,
    credentialSource: null,
    capabilities: [],
    storageAvailable: true,
  };
}

function connectedAccount(): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    authMode: 'oauth',
    credentialSource: 'oauth_desktop',
    capabilities: ['portal-v1'],
    storageAvailable: true,
    account: {
      id: 'acct-1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'ADMIN',
    },
  };
}

function guestAccount(): CanopyCloudAccountPublicState {
  return {
    ...connectedAccount(),
    authMode: 'guest',
    credentialSource: 'guest',
    capabilities: [],
    account: {
      id: 'guest-1',
      name: 'Guest',
      email: 'guest+test@guest.canopy.invalid',
      role: 'DEVELOPER',
    },
  };
}

function manualConnectedAccount(): CanopyCloudAccountPublicState {
  return {
    ...connectedAccount(),
    authMode: 'api_key',
    credentialSource: 'manual',
  };
}

function connectedResult(): Awaited<
  ReturnType<CanopyApi['startCanopyCloudOAuthLogin']>
> {
  return {
    status: {
      authenticated: true,
      account: connectedAccount().account ?? null,
      capabilities: ['portal-v1'],
      missingCapabilities: [],
      error: null,
      organizations: [],
      teams: [],
    },
    account: connectedAccount(),
  };
}

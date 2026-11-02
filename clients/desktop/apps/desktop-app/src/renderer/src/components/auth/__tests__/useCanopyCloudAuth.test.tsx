/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CanopyApi,
  CanopyCloudAccountPublicState,
} from '@canopy/desktop-shared/types';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { makeTestPreferences } from '@/test-utils/preferences';
import { useCanopyCloudConnected } from '@/hooks/useCanopyCloudConnected';
import {
  useCanopyCloudAuth,
  type CanopyCloudConnectSuccess,
} from '../useCanopyCloudAuth';

/**
 * `onConnectSuccess` is what closes the sign-in modal and fires its toast, so
 * the invariant that matters most is the negative one: a credential that was
 * already in secure storage when the hook mounted is NOT a sign-in the user
 * just performed, and must never announce.
 */
describe('useCanopyCloudAuth — connect announcements', () => {
  let container: HTMLElement;
  let root: Root;
  let announcements: CanopyCloudConnectSuccess[];
  const loadCanopyCloudAccount = jest.fn();
  const loadCanopyCloudApiKey = jest.fn();
  const startCanopyCloudOAuthLogin = jest.fn();
  const cancelCanopyCloudOAuthLogin = jest.fn();
  const saveCanopyCloudApiKey = jest.fn();
  const clearCanopyCloudApiKey = jest.fn();
  const resetUnreadableCanopyCloudAccount = jest.fn();
  const accountChanged = jest.fn();

  function MountedAccountConsumer(): JSX.Element {
    const connected = useCanopyCloudConnected();
    return (
      <output data-testid="consumer-connected">{String(connected)}</output>
    );
  }

  function Harness({
    autoSaveApiKey = false,
    withAccountConsumer = false,
  }: {
    autoSaveApiKey?: boolean;
    withAccountConsumer?: boolean;
  }): JSX.Element {
    const auth = useCanopyCloudAuth({
      onConnectSuccess: (result) => announcements.push(result),
      autoSaveApiKey,
    });
    return (
      <div>
        {withAccountConsumer && <MountedAccountConsumer />}
        <output data-testid="storage-state">
          {auth.secureStorageFailure?.state}
        </output>
        <output data-testid="auth-error">{auth.errorMessage}</output>
        <output data-testid="auth-connected">{String(auth.connected)}</output>
        <output data-testid="account-unreadable">
          {String(auth.accountUnreadable)}
        </output>
        {auth.accountUnreadable && (
          <button
            data-testid="reset-account"
            onClick={(): void => void auth.resetUnreadableAccount()}
          />
        )}
        <button
          data-testid="storage-retry"
          onClick={(): void => void auth.retrySecureStorage()}
        />
        <button
          data-testid="oauth"
          onClick={(): void => void auth.handleStartOAuthLogin()}
        />
        <button
          data-testid="cancel-oauth"
          onClick={(): void => void auth.handleCancelOAuthLogin()}
        />
        <output data-testid="oauth-pending">{String(auth.oauthPending)}</output>
        <output data-testid="validating">{String(auth.validating)}</output>
        <input
          data-testid="key"
          value={auth.apiKeyInput}
          onChange={auth.handleApiKeyInputChange}
        />
        <button
          data-testid="submit"
          onClick={(): void => void auth.handleSubmitApiKey()}
        />
        <button
          data-testid="api-mode"
          onClick={(): void => auth.setMode('api_key')}
        />
        <output data-testid="mode">{auth.mode}</output>
        <output data-testid="account-source">
          {auth.account?.credentialSource ?? 'none'}
        </output>
      </div>
    );
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    announcements = [];
    window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, accountChanged);
    loadCanopyCloudAccount.mockResolvedValue(disconnectedAccount());
    loadCanopyCloudApiKey.mockResolvedValue('');
    startCanopyCloudOAuthLogin.mockResolvedValue(connectedResult());
    cancelCanopyCloudOAuthLogin.mockResolvedValue(undefined);
    saveCanopyCloudApiKey.mockResolvedValue(connectedResult());
    Object.assign(window, {
      api: {
        loadPreferences: jest.fn(() => Promise.resolve(makeTestPreferences())),
        savePreferences: jest.fn<
          ReturnType<CanopyApi['savePreferences']>,
          Parameters<CanopyApi['savePreferences']>
        >(() => Promise.resolve(makeTestPreferences())),
        loadCanopyCloudAccount,
        loadCanopyCloudApiKey,
        saveCanopyCloudApiKey,
        clearCanopyCloudApiKey,
        startCanopyCloudOAuthLogin,
        cancelCanopyCloudOAuthLogin,
        resetUnreadableCanopyCloudAccount,
        disconnectCanopyCloudAccount: jest.fn(() =>
          Promise.resolve(disconnectedAccount()),
        ),
      } as Partial<CanopyApi> as CanopyApi,
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    window.removeEventListener(
      CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT,
      accountChanged,
    );
    container.remove();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it.each(['oauth', 'submit'])(
    'offers reset for a readable decrypt failure and reconnects through %s',
    async (connectAction) => {
      loadCanopyCloudAccount.mockResolvedValue({
        ...disconnectedAccount(),
        read: 'error',
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_DECRYPT_FAILED',
          operation: 'read',
          state: 'secure',
          backend: 'keychain',
          retryable: false,
        },
      });
      resetUnreadableCanopyCloudAccount.mockImplementation(() => {
        loadCanopyCloudAccount.mockResolvedValue(disconnectedAccount());
        return Promise.resolve({
          status: 'reset',
          account: disconnectedAccount(),
        });
      });
      await mount();
      expect(text('account-unreadable')).toBe('true');
      expect(
        container.querySelector('[data-testid="reset-account"]'),
      ).not.toBeNull();

      await click('reset-account');
      expect(resetUnreadableCanopyCloudAccount).toHaveBeenCalledTimes(1);
      expect(text('account-unreadable')).toBe('false');
      if (connectAction === 'submit') {
        await click('api-mode');
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="key"]',
        );
        await act(async () => {
          setNativeValue(input, 'csk_valid');
          input?.dispatchEvent(new Event('input', { bubbles: true }));
          await Promise.resolve();
        });
      }
      await click(connectAction);
      expect(announcements).toHaveLength(1);
      expect(announcements[0]?.mode).toBe(
        connectAction === 'oauth' ? 'oauth' : 'api_key',
      );
    },
  );

  it.each(['locked', 'unavailable'] as const)(
    'does not offer account reset while the backend is %s',
    async (state) => {
      loadCanopyCloudAccount.mockResolvedValue({
        ...disconnectedAccount(),
        storageAvailable: false,
        read: 'unavailable',
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          operation: 'read',
          state,
          backend: null,
          retryable: true,
        },
      });
      await mount();
      expect(text('account-unreadable')).toBe('false');
      expect(
        container.querySelector('[data-testid="reset-account"]'),
      ).toBeNull();
      expect(resetUnreadableCanopyCloudAccount).not.toHaveBeenCalled();
    },
  );

  it('distinguishes initial locked storage without a stored token from unavailable storage', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      ...disconnectedAccount(),
      storageAvailable: false,
      secureStorageStatus: {
        version: 1,
        state: 'locked',
        backend: 'gnome_libsecret',
        writeAvailable: false,
      },
    });
    await mount();
    expect(text('storage-state')).toBe('locked');
    expect(text('account-unreadable')).toBe('false');
  });

  it('surfaces an independently failed saved-key read and recovers it without a write', async () => {
    loadCanopyCloudAccount.mockResolvedValue(manualAccount());
    loadCanopyCloudApiKey.mockRejectedValueOnce(
      new Error('storage read failed'),
    );
    await mount();
    expect(text('storage-state')).toBe('unknown');
    loadCanopyCloudApiKey.mockResolvedValue('csk_recovered');
    await click('storage-retry');
    expect(text('storage-state')).toBe('');
    expect(saveCanopyCloudApiKey).not.toHaveBeenCalled();
  });

  it('refreshes a mounted account consumer after read recovery without replacing the API-key draft', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      ...disconnectedAccount(),
      read: 'unavailable',
      storageAvailable: false,
    });
    await mount({ withAccountConsumer: true });
    await click('api-mode');
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_unsaved_recovery_draft');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    expect(text('consumer-connected')).toBe('false');
    expect(accountChanged).not.toHaveBeenCalled();

    loadCanopyCloudAccount.mockResolvedValue({
      ...connectedAccount(),
      read: 'ok',
    });
    loadCanopyCloudApiKey.mockResolvedValue('csk_recovered_saved_key');
    await click('storage-retry');

    expect(text('consumer-connected')).toBe('true');
    expect(accountChanged).toHaveBeenCalledTimes(1);
    expect(text('auth-connected')).toBe('true');
    expect(text('storage-state')).toBe('');
    expect(text('mode')).toBe('api_key');
    expect(input?.value).toBe('csk_unsaved_recovery_draft');
    expect(saveCanopyCloudApiKey).not.toHaveBeenCalled();
    expect(startCanopyCloudOAuthLogin).not.toHaveBeenCalled();
    expect(announcements).toHaveLength(0);
  });

  it.each([
    { read: 'unavailable', storageAvailable: false },
    { read: 'error', storageAvailable: true },
    { read: 'ok', storageAvailable: false },
    {
      read: 'ok',
      storageAvailable: true,
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        operation: 'read',
        state: 'locked',
        backend: null,
        retryable: true,
      },
    },
  ] as const)(
    'does not broadcast an unsuccessful read recovery: %o',
    async (next) => {
      loadCanopyCloudAccount.mockResolvedValue({
        ...disconnectedAccount(),
        read: 'unavailable',
        storageAvailable: false,
      });
      await mount();
      loadCanopyCloudAccount.mockResolvedValue({
        ...disconnectedAccount(),
        ...next,
      });

      await click('storage-retry');

      expect(accountChanged).not.toHaveBeenCalled();
      expect(announcements).toHaveLength(0);
    },
  );

  it('does not broadcast recovery if the saved-key read fails', async () => {
    await mount();
    loadCanopyCloudAccount.mockResolvedValue(connectedAccount());
    loadCanopyCloudApiKey.mockRejectedValueOnce(new Error('read failed'));

    await click('storage-retry');

    expect(accountChanged).not.toHaveBeenCalled();
    expect(text('auth-error')).not.toBe('');
  });

  it.each(['save', 'clear'])(
    'releases a debounced %s interrupted by storage and replays it after recovery',
    async (operation) => {
      jest.useFakeTimers();
      if (operation === 'clear') {
        loadCanopyCloudAccount.mockResolvedValue(manualAccount());
        loadCanopyCloudApiKey.mockResolvedValue('csk_saved');
        clearCanopyCloudApiKey.mockResolvedValue(disconnectedAccount());
      }
      await mount({ autoSaveApiKey: true });
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="key"]',
      );
      act(() => {
        setNativeValue(input, operation === 'save' ? 'csk_pending' : '');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      loadCanopyCloudAccount.mockResolvedValue({
        ...disconnectedAccount(),
        read: 'unavailable',
        storageAvailable: false,
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          operation: 'read',
          state: 'locked',
          backend: null,
          retryable: true,
        },
      });
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      await act(async () => {
        jest.advanceTimersByTime(600);
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      expect(text('storage-state')).toBe('locked');
      expect(text('validating')).toBe('false');
      expect(saveCanopyCloudApiKey).not.toHaveBeenCalled();
      expect(clearCanopyCloudApiKey).not.toHaveBeenCalled();
      loadCanopyCloudAccount.mockResolvedValue(
        operation === 'clear' ? manualAccount() : disconnectedAccount(),
      );
      await click('storage-retry');
      if (operation === 'save')
        expect(saveCanopyCloudApiKey).toHaveBeenCalledWith({
          apiKey: 'csk_pending',
        });
      else expect(clearCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      expect(text('validating')).toBe('false');
    },
  );

  it('preserves an edit made during a read retry even when the recovered account is a guest', async () => {
    loadCanopyCloudAccount.mockResolvedValue({
      ...disconnectedAccount(),
      read: 'unavailable',
      storageAvailable: false,
    });
    await mount();
    let resolveRead:
      | ((value: CanopyCloudAccountPublicState) => void)
      | undefined;
    loadCanopyCloudAccount.mockReturnValueOnce(
      new Promise<CanopyCloudAccountPublicState>((resolve) => {
        resolveRead = resolve;
      }),
    );
    await click('storage-retry');
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_new_draft');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      resolveRead?.(guestConnectedResult().account);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(input?.value).toBe('csk_new_draft');
    expect(saveCanopyCloudApiKey).not.toHaveBeenCalled();
  });

  it('does not flush a second copy of an in-flight debounced write on unmount', async () => {
    jest.useFakeTimers();
    let resolveSave:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | undefined;
    saveCanopyCloudApiKey.mockReturnValueOnce(
      new Promise<ReturnType<typeof connectedResult>>((resolve) => {
        resolveSave = resolve;
      }),
    );
    await mount({ autoSaveApiKey: true });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    act(() => {
      setNativeValue(input, 'csk_pending');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    const callsAtUnmount = saveCanopyCloudApiKey.mock.calls.length;
    await act(async () => {
      resolveSave?.(connectedResult());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    root = createRoot(container);
    loadCanopyCloudAccount.mockResolvedValue(connectedAccount());
    await mount();
    expect(callsAtUnmount).toBe(1);
    expect(accountChanged).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['new account', false, 'csk_newer', false, false],
    ['saved account', true, 'csk_newer', false, false],
    ['new account', false, '', false, false],
    ['saved account', true, '', false, false],
    ['failed prior save', true, 'csk_newer', true, false],
    ['failed prior save', true, '', true, false],
    ['failed newer key', true, 'csk_newer', false, true],
    ['failed newer clear', true, '', false, true],
  ] as const)(
    'flushes the newer draft on unmount after an in-flight save: %s, saved=%s, draft=%s, rejected=%s, flushRejected=%s',
    async (_label, initiallySaved, newerDraft, priorRejects, flushRejects) => {
      jest.useFakeTimers();
      saveCanopyCloudApiKey.mockReset();
      clearCanopyCloudApiKey.mockReset();
      let persistedKey = initiallySaved ? 'csk_saved' : '';
      if (initiallySaved) {
        loadCanopyCloudAccount.mockResolvedValue(manualAccount());
        loadCanopyCloudApiKey.mockResolvedValue(persistedKey);
      }
      let finishSave:
        | ((result: ReturnType<typeof connectedResult>) => void)
        | undefined;
      let rejectSave: ((error: Error) => void) | undefined;
      const priorSave = new Promise<ReturnType<typeof connectedResult>>(
        (resolve, reject) => {
          finishSave = resolve;
          rejectSave = reject;
        },
      );
      saveCanopyCloudApiKey
        .mockImplementationOnce(async ({ apiKey }: { apiKey: string }) => {
          const result = await priorSave;
          persistedKey = apiKey;
          return result;
        })
        .mockImplementationOnce(({ apiKey }: { apiKey: string }) => {
          if (flushRejects)
            return Promise.reject(new Error('newer save failed'));
          persistedKey = apiKey;
          return Promise.resolve(connectedResult());
        });
      clearCanopyCloudApiKey.mockImplementation(() => {
        if (flushRejects)
          return Promise.reject(new Error('newer clear failed'));
        persistedKey = '';
        return Promise.resolve(disconnectedAccount());
      });
      await mount({ autoSaveApiKey: true });
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="key"]',
      );
      act(() => {
        setNativeValue(input, 'csk_first');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(600);
      });
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      act(() => {
        setNativeValue(input, newerDraft);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        root.unmount();
      });
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      expect(clearCanopyCloudApiKey).not.toHaveBeenCalled();
      await act(async () => {
        if (priorRejects) rejectSave?.(new Error('first save failed'));
        else finishSave?.(connectedResult());
        for (let i = 0; i < 16; i += 1) await Promise.resolve();
      });
      root = createRoot(container);
      expect(persistedKey).toBe(flushRejects ? 'csk_first' : newerDraft);
      if (newerDraft) {
        expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(2);
        expect(saveCanopyCloudApiKey).toHaveBeenLastCalledWith({
          apiKey: newerDraft,
        });
        expect(clearCanopyCloudApiKey).not.toHaveBeenCalled();
      } else {
        expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
        expect(clearCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      }
      expect(accountChanged).toHaveBeenCalledTimes(
        (priorRejects ? 0 : 1) + (flushRejects ? 0 : 1),
      );
      expect(announcements).toHaveLength(0);
    },
  );

  it.each([
    ['unmount draft', 'csk_stale', 'save'],
    ['unmount draft', '', 'save'],
    ['unmount draft', 'csk_stale', 'OAuth'],
    ['unmount draft', '', 'OAuth'],
    ['queued clear', '', 'save'],
  ] as const)(
    'does not let a stale %s (%j) overwrite a newer surface %s',
    async (staleWrite, staleDraft, newerWrite) => {
      jest.useFakeTimers();
      saveCanopyCloudApiKey.mockReset();
      clearCanopyCloudApiKey.mockReset();
      // The account store serializes writes in arrival order, so the last
      // submitted write is the persisted credential.
      let persistedKey = '';
      let finishFirstSave:
        | ((result: ReturnType<typeof connectedResult>) => void)
        | undefined;
      saveCanopyCloudApiKey
        .mockImplementationOnce(({ apiKey }: { apiKey: string }) => {
          persistedKey = apiKey;
          return new Promise<ReturnType<typeof connectedResult>>((resolve) => {
            finishFirstSave = resolve;
          });
        })
        .mockImplementation(({ apiKey }: { apiKey: string }) => {
          persistedKey = apiKey;
          return Promise.resolve(connectedResult());
        });
      clearCanopyCloudApiKey.mockImplementation(() => {
        persistedKey = '';
        return Promise.resolve(disconnectedAccount());
      });
      startCanopyCloudOAuthLogin.mockImplementation(() => {
        persistedKey = 'oauth';
        return Promise.resolve(connectedResult());
      });
      await mount({ autoSaveApiKey: true });
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="key"]',
      );
      act(() => {
        setNativeValue(input, 'csk_first');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(600);
        setNativeValue(input, staleDraft);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        // A queued clear is registered while mounted; an unmount draft is not.
        if (staleWrite === 'queued clear') jest.advanceTimersByTime(600);
        root.unmount();
      });
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);

      // Reopen Settings and complete a newer write before the first settles.
      root = createRoot(container);
      await mount({ autoSaveApiKey: true });
      if (newerWrite === 'save') {
        const reopened = container.querySelector<HTMLInputElement>(
          '[data-testid="key"]',
        );
        await act(async () => {
          setNativeValue(reopened, 'csk_newest');
          reopened?.dispatchEvent(new Event('input', { bubbles: true }));
          jest.advanceTimersByTime(600);
          for (let i = 0; i < 8; i += 1) await Promise.resolve();
        });
      } else {
        await click('oauth');
      }
      const newest = newerWrite === 'save' ? 'csk_newest' : 'oauth';
      expect(persistedKey).toBe(newest);

      await act(async () => {
        finishFirstSave?.(connectedResult());
        for (let i = 0; i < 16; i += 1) await Promise.resolve();
      });

      expect(persistedKey).toBe(newest);
      expect(clearCanopyCloudApiKey).not.toHaveBeenCalled();
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(
        newerWrite === 'save' ? 2 : 1,
      );
    },
  );

  it.each([
    ['queued', 'csk_stale'],
    ['queued', ''],
    ['submitted', 'csk_stale'],
  ])(
    'preserves a reopened draft before debounce when the %s cleanup (%j) settles',
    async (cleanupState, staleDraft) => {
      jest.useFakeTimers();
      saveCanopyCloudApiKey.mockReset();
      clearCanopyCloudApiKey.mockReset();
      let persistedKey = '';
      loadCanopyCloudAccount.mockImplementation(() =>
        Promise.resolve(persistedKey ? manualAccount() : disconnectedAccount()),
      );
      loadCanopyCloudApiKey.mockImplementation(() =>
        Promise.resolve(persistedKey),
      );
      let finishFirstSave: (() => void) | undefined;
      let finishCleanup: (() => void) | undefined;
      saveCanopyCloudApiKey
        .mockImplementationOnce(
          ({ apiKey }: { apiKey: string }) =>
            new Promise<ReturnType<typeof connectedResult>>((resolve) => {
              finishFirstSave = (): void => {
                persistedKey = apiKey;
                resolve(connectedResult());
              };
            }),
        )
        .mockImplementation(({ apiKey }: { apiKey: string }) => {
          if (cleanupState === 'submitted' && apiKey === staleDraft) {
            return new Promise<ReturnType<typeof connectedResult>>(
              (resolve) => {
                finishCleanup = (): void => {
                  persistedKey = apiKey;
                  resolve(connectedResult());
                };
              },
            );
          }
          persistedKey = apiKey;
          return Promise.resolve(connectedResult());
        });
      await mount({ autoSaveApiKey: true });
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="key"]',
      );
      act(() => {
        setNativeValue(input, 'csk_first');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(600);
        setNativeValue(input, staleDraft);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        root.unmount();
      });
      if (cleanupState === 'submitted') {
        await act(async () => {
          finishFirstSave?.();
          for (let i = 0; i < 16; i += 1) await Promise.resolve();
        });
        expect(finishCleanup).toBeDefined();
      }
      root = createRoot(container);
      await mount({ autoSaveApiKey: true });
      const reopened = container.querySelector<HTMLInputElement>(
        '[data-testid="key"]',
      );
      act(() => {
        setNativeValue(reopened, 'csk_newest');
        reopened?.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(100);
      });
      await act(async () => {
        if (cleanupState === 'submitted') finishCleanup?.();
        else finishFirstSave?.();
        for (let i = 0; i < 16; i += 1) await Promise.resolve();
      });
      expect(reopened?.value).toBe('csk_newest');
      expect(text('validating')).toBe('true');
      expect(announcements).toHaveLength(0);
      expect(clearCanopyCloudApiKey).not.toHaveBeenCalled();
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(
        cleanupState === 'submitted' ? 2 : 1,
      );
      await act(async () => {
        jest.advanceTimersByTime(500);
        for (let i = 0; i < 16; i += 1) await Promise.resolve();
      });
      expect(saveCanopyCloudApiKey).toHaveBeenLastCalledWith({
        apiKey: 'csk_newest',
      });
      expect(persistedKey).toBe('csk_newest');
      expect(reopened?.value).toBe('csk_newest');
      expect(text('validating')).toBe('false');
      expect(announcements).toHaveLength(1);
    },
  );

  it.each([
    'before debounce',
    'after debounce',
    'unmount while queued',
    'edit while queued',
    'edit back while queued',
    'renewed mounted',
    'renewed unmount before debounce',
    'renewed unmount after debounce',
  ])('clears an initial in-flight save while mounted: %s', async (timing) => {
    jest.useFakeTimers();
    saveCanopyCloudApiKey.mockReset();
    clearCanopyCloudApiKey.mockReset();
    let persistedKey = '';
    let finishSave:
      | ((result: ReturnType<typeof connectedResult>) => void)
      | undefined;
    const priorSave = new Promise<ReturnType<typeof connectedResult>>(
      (resolve) => {
        finishSave = resolve;
      },
    );
    saveCanopyCloudApiKey.mockImplementationOnce(async () => {
      const result = await priorSave;
      persistedKey = 'csk_first';
      return result;
    });
    clearCanopyCloudApiKey.mockImplementation(() => {
      persistedKey = '';
      return Promise.resolve(disconnectedAccount());
    });
    await mount({ autoSaveApiKey: true });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    act(() => {
      setNativeValue(input, 'csk_first');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      jest.advanceTimersByTime(600);
      setNativeValue(input, '');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    if (timing !== 'before debounce') {
      act(() => {
        jest.advanceTimersByTime(600);
      });
      expect(clearCanopyCloudApiKey).not.toHaveBeenCalled();
    }
    if (timing.startsWith('renewed')) {
      act(() => {
        setNativeValue(input, 'csk_intermediate');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        setNativeValue(input, '');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        if (timing !== 'renewed unmount before debounce')
          jest.advanceTimersByTime(600);
        if (timing !== 'renewed mounted') root.unmount();
      });
    }
    if (timing === 'unmount while queued') act(() => root.unmount());
    if (timing === 'edit while queued' || timing === 'edit back while queued') {
      act(() => {
        setNativeValue(
          input,
          timing === 'edit back while queued' ? 'csk_first' : 'csk_new_draft',
        );
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        if (timing === 'edit back while queued') root.unmount();
      });
    }
    await act(async () => {
      finishSave?.(connectedResult());
      for (let i = 0; i < 16; i += 1) await Promise.resolve();
      if (timing === 'before debounce') {
        jest.advanceTimersByTime(600);
        for (let i = 0; i < 16; i += 1) await Promise.resolve();
      }
    });
    if (
      timing === 'unmount while queued' ||
      timing === 'edit back while queued' ||
      timing.startsWith('renewed unmount')
    )
      root = createRoot(container);
    if (timing === 'edit while queued' || timing === 'edit back while queued') {
      expect(persistedKey).toBe('csk_first');
      expect(clearCanopyCloudApiKey).not.toHaveBeenCalled();
      if (timing === 'edit back while queued') {
        expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      } else expect(input?.value).toBe('csk_new_draft');
    } else {
      expect(persistedKey).toBe('');
      expect(clearCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      if (
        timing !== 'unmount while queued' &&
        !timing.startsWith('renewed unmount')
      ) {
        expect(input?.value).toBe('');
        expect(text('validating')).toBe('false');
        expect(text('auth-connected')).toBe('false');
      }
    }
    expect(announcements).toHaveLength(0);
  });

  it.each(['OAuth', 'external read'])(
    'allows a fresh same-key draft after %s replacement',
    async (replacement) => {
      jest.useFakeTimers();
      saveCanopyCloudApiKey.mockReset().mockResolvedValue(connectedResult());
      await mount({ autoSaveApiKey: true });
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="key"]',
      );
      await act(async () => {
        setNativeValue(input, 'csk_reused');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(600);
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      if (replacement === 'OAuth') {
        await click('oauth');
        expect(startCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);
      } else {
        loadCanopyCloudAccount.mockResolvedValue(manualAccount());
        loadCanopyCloudApiKey.mockResolvedValue('csk_external');
        await act(async () => {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          for (let i = 0; i < 8; i += 1) await Promise.resolve();
        });
        expect(input?.value).toBe('csk_external');
      }
      act(() => {
        setNativeValue(input, 'csk_reused');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        root.unmount();
      });
      await act(async () => {
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      root = createRoot(container);
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['rejected', 'invalid'])(
    'does not repeat a completed %s draft on unmount',
    async (failure) => {
      jest.useFakeTimers();
      saveCanopyCloudApiKey.mockReset().mockResolvedValue(connectedResult());
      if (failure === 'rejected') {
        saveCanopyCloudApiKey.mockRejectedValueOnce(new Error('save failed'));
      } else {
        saveCanopyCloudApiKey.mockResolvedValueOnce({
          ...connectedResult(),
          account: disconnectedAccount(),
          status: {
            ...connectedResult().status,
            authenticated: false,
            error: 'Invalid API key.',
          },
        });
      }
      await mount({ autoSaveApiKey: true });
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="key"]',
      );
      await act(async () => {
        setNativeValue(input, 'csk_failed');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(600);
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      expect(text('auth-error')).not.toBe('');
      act(() => root.unmount());
      await act(async () => {
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      root = createRoot(container);
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      expect(accountChanged).not.toHaveBeenCalled();
    },
  );

  it('does not replace an edit made after an ambient account read started', async () => {
    await mount({ autoSaveApiKey: true });
    let resolveRead:
      | ((value: CanopyCloudAccountPublicState) => void)
      | undefined;
    loadCanopyCloudAccount.mockReturnValueOnce(
      new Promise<CanopyCloudAccountPublicState>((resolve) => {
        resolveRead = resolve;
      }),
    );
    act(() => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
    });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_new_draft');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      resolveRead?.(manualAccount());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    expect(input?.value).toBe('csk_new_draft');
  });

  it.each(['oauth', 'submit'])(
    'never announces when %s validates but discards the credential',
    async (action) => {
      const result = connectedResult();
      const discarded = {
        ...result,
        account: {
          ...disconnectedAccount(),
          storageAvailable: false,
          secureStorageFailure: {
            version: 1,
            code: 'SECURE_STORAGE_WRITE_REFUSED',
            operation: 'write',
            state: 'locked',
            backend: null,
            retryable: true,
          },
        },
      };
      startCanopyCloudOAuthLogin.mockResolvedValue(discarded);
      saveCanopyCloudApiKey.mockResolvedValue(discarded);
      await mount();
      if (action === 'submit') {
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="key"]',
        );
        await act(async () => {
          setNativeValue(input, 'csk_valid');
          input?.dispatchEvent(new Event('input', { bubbles: true }));
          await Promise.resolve();
        });
      }
      await click(action);
      expect(announcements).toHaveLength(0);
      expect(text('auth-connected')).toBe('false');
      expect(text('auth-error')).not.toBe('');
    },
  );

  it.each(['oauth', 'submit'])(
    'retries the original %s write after a probe failure',
    async (action) => {
      const failure = {
        version: 1,
        code: 'SECURE_STORAGE_PROBE_FAILED',
        operation: 'probe',
        state: 'unknown',
        backend: null,
        retryable: true,
      };
      const discarded = {
        ...connectedResult(),
        account: {
          ...disconnectedAccount(),
          storageAvailable: false,
          secureStorageFailure: failure,
        },
      };
      const save =
        action === 'oauth' ? startCanopyCloudOAuthLogin : saveCanopyCloudApiKey;
      save
        .mockResolvedValueOnce(discarded)
        .mockResolvedValueOnce(connectedResult());
      await mount();
      if (action === 'submit') {
        await click('api-mode');
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="key"]',
        );
        await act(async () => {
          setNativeValue(input, 'csk_valid');
          input?.dispatchEvent(new Event('input', { bubbles: true }));
          await Promise.resolve();
        });
      }
      await click(action);
      expect(announcements).toHaveLength(0);
      await click('storage-retry');
      expect(save).toHaveBeenCalledTimes(2);
      expect(announcements).toHaveLength(1);
    },
  );

  it.each(['oauth', 'submit'])(
    'retains the original %s write through a still-locked retry before unlock',
    async (action) => {
      const failure = {
        version: 1,
        code: 'SECURE_STORAGE_PROBE_FAILED',
        operation: 'probe',
        state: 'unknown',
        backend: null,
        retryable: true,
      };
      const discarded = {
        ...connectedResult(),
        account: {
          ...disconnectedAccount(),
          storageAvailable: false,
          secureStorageFailure: failure,
        },
      };
      const save =
        action === 'oauth' ? startCanopyCloudOAuthLogin : saveCanopyCloudApiKey;
      save
        .mockResolvedValueOnce(discarded)
        .mockResolvedValueOnce(connectedResult());
      await mount();
      if (action === 'submit') {
        await click('api-mode');
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="key"]',
        );
        await act(async () => {
          setNativeValue(input, 'csk_valid');
          input?.dispatchEvent(new Event('input', { bubbles: true }));
          await Promise.resolve();
        });
      }
      await click(action);
      expect(announcements).toHaveLength(0);
      loadCanopyCloudAccount.mockResolvedValue({
        ...disconnectedAccount(),
        storageAvailable: false,
        read: 'unavailable',
        secureStorageFailure: {
          ...failure,
          state: 'locked',
          operation: 'read',
        },
      });
      await click('storage-retry');
      expect(save).toHaveBeenCalledTimes(1);
      expect(announcements).toHaveLength(0);
      loadCanopyCloudAccount.mockResolvedValue(disconnectedAccount());
      await click('storage-retry');
      expect(save).toHaveBeenCalledTimes(2);
      expect(announcements).toHaveLength(1);
    },
  );

  it.each(['oauth', 'submit'])(
    'retains the pending %s write through an inconclusive account-changed read',
    async (action) => {
      const failure = {
        version: 1,
        code: 'SECURE_STORAGE_PROBE_FAILED',
        operation: 'probe',
        state: 'unknown',
        backend: null,
        retryable: true,
      };
      const save =
        action === 'oauth' ? startCanopyCloudOAuthLogin : saveCanopyCloudApiKey;
      save
        .mockResolvedValueOnce({
          ...connectedResult(),
          account: {
            ...disconnectedAccount(),
            storageAvailable: false,
            secureStorageFailure: failure,
          },
        })
        .mockResolvedValueOnce(connectedResult());
      await mount();
      if (action === 'submit') {
        await click('api-mode');
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="key"]',
        );
        await act(async () => {
          setNativeValue(input, 'csk_pending');
          input?.dispatchEvent(new Event('input', { bubbles: true }));
          await Promise.resolve();
        });
      }
      await click(action);
      expect(save).toHaveBeenCalledTimes(1);
      expect(announcements).toHaveLength(0);
      loadCanopyCloudAccount.mockResolvedValue({
        ...disconnectedAccount(),
        read: 'unavailable',
        storageAvailable: false,
        secureStorageFailure: {
          ...failure,
          operation: 'read',
          state: 'locked',
        },
      });
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        await Promise.resolve();
      });
      expect(text('storage-state')).toBe('locked');
      expect(save).toHaveBeenCalledTimes(1);
      loadCanopyCloudAccount.mockResolvedValue(disconnectedAccount());
      await click('storage-retry');
      expect(save).toHaveBeenCalledTimes(2);
      if (action === 'submit')
        expect(save).toHaveBeenLastCalledWith({ apiKey: 'csk_pending' });
      expect(announcements).toHaveLength(1);
    },
  );

  it('keeps the API validation error when no credential was saved', async () => {
    saveCanopyCloudApiKey.mockResolvedValue({
      ...connectedResult(),
      account: disconnectedAccount(),
      status: {
        ...connectedResult().status,
        authenticated: false,
        error: 'Invalid API key.',
      },
    });
    await mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_invalid');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await click('submit');
    expect(text('auth-error')).toBe('Invalid API key.');
    expect(announcements).toHaveLength(0);
  });

  it('does not restart a successful OAuth login when retrying a later read failure', async () => {
    await mount();
    await click('oauth');
    loadCanopyCloudAccount.mockResolvedValue({
      ...disconnectedAccount(),
      read: 'unavailable',
      storageAvailable: false,
      secureStorageFailure: {
        version: 1,
        code: 'SECURE_STORAGE_READ_UNAVAILABLE',
        operation: 'read',
        state: 'locked',
        backend: null,
        retryable: true,
      },
    });
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      await Promise.resolve();
      await Promise.resolve();
    });
    loadCanopyCloudAccount.mockResolvedValue(connectedAccount());
    await click('storage-retry');
    expect(startCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);
  });

  it('announces once for a user-initiated OAuth sign-in', async () => {
    await mount();
    await click('oauth');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.mode).toBe('oauth');
    expect(announcements[0]?.account.credentialSource).toBe('oauth_desktop');
  });

  it('announces once for a submitted API key', async () => {
    await mount();

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_valid');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await click('submit');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.mode).toBe('api_key');
  });

  it('never announces for a credential resolved at mount', async () => {
    loadCanopyCloudAccount.mockResolvedValue(connectedAccount());

    await mount();

    expect(announcements).toHaveLength(0);
    expect(accountChanged).not.toHaveBeenCalled();
  });

  it('does not announce twice when the same key is re-validated', async () => {
    await mount();

    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_valid');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await click('submit');
    await click('submit');

    expect(announcements).toHaveLength(1);
  });

  it('does not announce when the credential fails to validate', async () => {
    startCanopyCloudOAuthLogin.mockResolvedValue({
      status: {
        authenticated: false,
        account: null,
        capabilities: [],
        missingCapabilities: [],
        error: 'denied',
      },
      account: disconnectedAccount(),
    });

    await mount();
    await click('oauth');

    expect(announcements).toHaveLength(0);
  });

  it('does not consume the one-shot announcement when a guest-shaped result is returned', async () => {
    startCanopyCloudOAuthLogin
      .mockResolvedValueOnce(guestConnectedResult())
      .mockResolvedValueOnce(connectedResult());

    await mount();
    await click('oauth');
    expect(announcements).toHaveLength(0);

    await click('oauth');
    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.account.credentialSource).toBe('oauth_desktop');
  });

  it('does not report a normalized guest as a replaced manual API key', async () => {
    loadCanopyCloudAccount.mockResolvedValue(normalizedGuestAccount());
    startCanopyCloudOAuthLogin.mockResolvedValue(connectedResult());

    await mount();
    await click('oauth');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.replacedManualKey).toBe(false);
  });

  it('does not report typed but unsubmitted API-key text as a stored replacement', async () => {
    await mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_unsaved');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    await click('oauth');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.replacedManualKey).toBe(false);
  });

  it('does not report debounce-pending Settings input as a stored replacement', async () => {
    await mount({ autoSaveApiKey: true });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_unsaved');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    await click('oauth');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.replacedManualKey).toBe(false);
  });

  it('clears submit-only validation when the candidate changes in flight', async () => {
    let resolveSave:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    saveCanopyCloudApiKey.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    await mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_first');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await click('submit');
    expect(text('validating')).toBe('true');

    await act(async () => {
      setNativeValue(input, 'csk_second');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(text('validating')).toBe('false');
    await act(async () => {
      resolveSave?.(connectedResult());
      await Promise.resolve();
    });
    expect(announcements).toHaveLength(0);
  });

  it('does not start OAuth while an API-key validation owns the credential write', async () => {
    let resolveSave:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    saveCanopyCloudApiKey.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    await mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_first');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await click('submit');
    await click('oauth');

    expect(startCanopyCloudOAuthLogin).not.toHaveBeenCalled();
    await act(async () => {
      resolveSave?.(connectedResult());
      await Promise.resolve();
    });
  });

  it('does not submit an API key while a same-tick OAuth attempt owns authentication', async () => {
    let resolveLogin:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    startCanopyCloudOAuthLogin.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );
    await mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_first');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    const oauth = container.querySelector<HTMLButtonElement>(
      '[data-testid="oauth"]',
    );
    const submit = container.querySelector<HTMLButtonElement>(
      '[data-testid="submit"]',
    );
    await act(async () => {
      oauth?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      submit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(startCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);
    expect(saveCanopyCloudApiKey).not.toHaveBeenCalled();
    await act(async () => {
      resolveLogin?.(connectedResult());
      await Promise.resolve();
    });
  });

  it('announces an OAuth sign-in that finished after the initiating surface unmounted', async () => {
    let resolveLogin:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    startCanopyCloudOAuthLogin.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );
    await mount();
    await click('oauth');

    act(() => root.unmount());
    await act(async () => {
      resolveLogin?.(connectedResult());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    loadCanopyCloudAccount.mockResolvedValue(connectedAccount());
    root = createRoot(container);
    await mount();

    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.mode).toBe('oauth');
  });

  it('announces an API-key sign-in that finished after the initiating surface unmounted', async () => {
    let resolveSave:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    saveCanopyCloudApiKey.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    await mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_valid');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await click('submit');

    act(() => root.unmount());
    await act(async () => {
      resolveSave?.(connectedResult());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    loadCanopyCloudAccount.mockResolvedValue(connectedAccount());
    root = createRoot(container);
    await mount();

    expect(announcements).toHaveLength(1);
  });

  it('refreshes a newly minted guest and leaves manual API-key mode', async () => {
    let liveAccount = disconnectedAccount();
    loadCanopyCloudAccount.mockImplementation(() =>
      Promise.resolve(liveAccount),
    );
    await mount();
    await click('api-mode');
    expect(text('mode')).toBe('api_key');

    liveAccount = guestConnectedResult().account;
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(text('account-source')).toBe('guest');
    expect(text('mode')).toBe('oauth');
  });

  it('preserves a dirty API-key draft across an ambient account refresh', async () => {
    await mount({ autoSaveApiKey: true });
    await click('api-mode');
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_draft');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(input?.value).toBe('csk_draft');
    expect(text('mode')).toBe('api_key');
  });

  it.each([
    'read recovery',
    'ambient dirty-draft refresh',
    'ambient refresh after a stale save',
  ] as const)(
    'flushes a restored earlier key after a conclusive replacement during %s',
    async (refresh) => {
      jest.useFakeTimers();
      const staleSnapshot = refresh === 'ambient refresh after a stale save';
      let persistedKey = staleSnapshot ? 'csk_replacement' : '';
      let finishFirstSave: (() => void) | undefined;
      loadCanopyCloudAccount.mockImplementation(() =>
        Promise.resolve(persistedKey ? manualAccount() : disconnectedAccount()),
      );
      loadCanopyCloudApiKey.mockImplementation(() =>
        Promise.resolve(persistedKey),
      );
      saveCanopyCloudApiKey.mockImplementation(
        ({ apiKey }: { apiKey: string }) => {
          persistedKey = apiKey;
          return Promise.resolve({
            ...connectedResult(),
            account: manualAccount(),
          });
        },
      );
      if (staleSnapshot) {
        saveCanopyCloudApiKey.mockImplementationOnce(
          ({ apiKey }: { apiKey: string }) => {
            persistedKey = apiKey;
            return new Promise<ReturnType<typeof connectedResult>>(
              (resolve) => {
                finishFirstSave = (): void =>
                  resolve({ ...connectedResult(), account: manualAccount() });
              },
            );
          },
        );
      }
      await mount({ autoSaveApiKey: true });
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="key"]',
      );
      act(() => {
        setNativeValue(input, 'csk_original');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await act(async () => {
        jest.advanceTimersByTime(600);
        for (let i = 0; i < 16; i += 1) await Promise.resolve();
      });
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      expect(persistedKey).toBe('csk_original');
      if (staleSnapshot) {
        await act(async () => {
          setNativeValue(input, 'csk_draft');
          input?.dispatchEvent(new Event('input', { bubbles: true }));
          finishFirstSave?.();
          for (let i = 0; i < 16; i += 1) await Promise.resolve();
        });
      } else {
        expect(text('validating')).toBe('false');
      }

      if (refresh === 'ambient dirty-draft refresh') {
        act(() => {
          setNativeValue(input, 'csk_draft');
          input?.dispatchEvent(new Event('input', { bubbles: true }));
        });
      }
      persistedKey = 'csk_replacement';
      if (refresh === 'read recovery') {
        await click('storage-retry');
      } else {
        await act(async () => {
          window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
          for (let i = 0; i < 8; i += 1) await Promise.resolve();
        });
      }
      expect(input?.value).toBe(
        refresh === 'read recovery' ? 'csk_original' : 'csk_draft',
      );
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      expect(persistedKey).toBe('csk_replacement');
      act(() => {
        setNativeValue(input, 'csk_replacement');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        setNativeValue(input, 'csk_original');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(input?.value).toBe('csk_original');
      await act(async () => {
        root.unmount();
        for (let i = 0; i < 16; i += 1) await Promise.resolve();
      });
      root = createRoot(container);
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(2);
      expect(saveCanopyCloudApiKey).toHaveBeenLastCalledWith({
        apiKey: 'csk_original',
      });
      expect(persistedKey).toBe('csk_original');
      expect(clearCanopyCloudApiKey).not.toHaveBeenCalled();
    },
  );

  it.each(['csk_original', 'csk_replacement'])(
    'flushes %s after the prior in-flight write despite a confirmed replacement',
    async (latestDraft) => {
      jest.useFakeTimers();
      let persistedKey = 'csk_saved';
      let finishFirstSave: (() => void) | undefined;
      loadCanopyCloudAccount.mockImplementation(() =>
        Promise.resolve(manualAccount()),
      );
      loadCanopyCloudApiKey.mockImplementation(() =>
        Promise.resolve(persistedKey),
      );
      saveCanopyCloudApiKey
        .mockImplementationOnce(
          ({ apiKey }: { apiKey: string }) =>
            new Promise<ReturnType<typeof connectedResult>>((resolve) => {
              finishFirstSave = (): void => {
                persistedKey = apiKey;
                resolve({ ...connectedResult(), account: manualAccount() });
              };
            }),
        )
        .mockImplementationOnce(({ apiKey }: { apiKey: string }) => {
          persistedKey = apiKey;
          return Promise.resolve({
            ...connectedResult(),
            account: manualAccount(),
          });
        });
      await mount({ autoSaveApiKey: true });
      const input = container.querySelector<HTMLInputElement>(
        '[data-testid="key"]',
      );
      act(() => {
        setNativeValue(input, 'csk_original');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        jest.advanceTimersByTime(600);
      });
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      act(() => {
        setNativeValue(input, 'csk_draft');
        input?.dispatchEvent(new Event('input', { bubbles: true }));
      });
      persistedKey = 'csk_replacement';
      await act(async () => {
        window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      });
      expect(input?.value).toBe('csk_draft');
      act(() => {
        setNativeValue(input, latestDraft);
        input?.dispatchEvent(new Event('input', { bubbles: true }));
        root.unmount();
      });
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(1);
      await act(async () => {
        finishFirstSave?.();
        for (let i = 0; i < 16; i += 1) await Promise.resolve();
      });
      root = createRoot(container);
      expect(saveCanopyCloudApiKey).toHaveBeenCalledTimes(2);
      expect(saveCanopyCloudApiKey).toHaveBeenNthCalledWith(1, {
        apiKey: 'csk_original',
      });
      expect(saveCanopyCloudApiKey).toHaveBeenLastCalledWith({
        apiKey: latestDraft,
      });
      expect(persistedKey).toBe(latestDraft);
      expect(clearCanopyCloudApiKey).not.toHaveBeenCalled();
    },
  );

  it('preserves the last-known account across an inconclusive ambient refresh', async () => {
    let liveAccount: CanopyCloudAccountPublicState = connectedAccount();
    loadCanopyCloudAccount.mockImplementation(() =>
      Promise.resolve(liveAccount),
    );
    await mount();
    expect(text('account-source')).toBe('oauth_desktop');

    liveAccount = {
      ...disconnectedAccount(),
      read: 'error',
    };
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(text('account-source')).toBe('oauth_desktop');
    expect(text('mode')).toBe('oauth');
  });

  it('keeps the API-key editor selected after its own saved-key clear', async () => {
    jest.useFakeTimers();
    let liveAccount = manualAccount();
    let liveApiKey = 'csk_saved';
    loadCanopyCloudAccount.mockImplementation(() =>
      Promise.resolve(liveAccount),
    );
    loadCanopyCloudApiKey.mockImplementation(() => Promise.resolve(liveApiKey));
    clearCanopyCloudApiKey.mockImplementation(() => {
      liveAccount = disconnectedAccount();
      liveApiKey = '';
      return Promise.resolve(liveAccount);
    });

    await mount({ autoSaveApiKey: true });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, '');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      jest.advanceTimersByTime(600);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(clearCanopyCloudApiKey).toHaveBeenCalledTimes(1);
    expect(input?.value).toBe('');
    expect(text('mode')).toBe('api_key');
    jest.useRealTimers();
  });

  it('returns to OAuth when clearing a saved key restores a guest session', async () => {
    jest.useFakeTimers();
    let liveAccount = manualAccount();
    let liveApiKey = 'csk_saved';
    loadCanopyCloudAccount.mockImplementation(() =>
      Promise.resolve(liveAccount),
    );
    loadCanopyCloudApiKey.mockImplementation(() => Promise.resolve(liveApiKey));
    clearCanopyCloudApiKey.mockImplementation(() => {
      liveAccount = guestConnectedResult().account;
      liveApiKey = '';
      return Promise.resolve(liveAccount);
    });

    await mount({ autoSaveApiKey: true });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, '');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      jest.advanceTimersByTime(600);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(text('account-source')).toBe('guest');
    expect(text('mode')).toBe('oauth');
    expect(input?.value).toBe('');
  });

  it('releases validation when an authoritative refresh supersedes an in-flight key', async () => {
    let resolveSave:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    saveCanopyCloudApiKey.mockReturnValue(
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
    );
    let liveAccount = disconnectedAccount();
    loadCanopyCloudAccount.mockImplementation(() =>
      Promise.resolve(liveAccount),
    );
    await mount();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="key"]',
    );
    await act(async () => {
      setNativeValue(input, 'csk_pending');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await click('submit');
    expect(text('validating')).toBe('true');

    liveAccount = connectedAccount();
    await act(async () => {
      window.dispatchEvent(new Event(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
    const validatingAfterRefresh = text('validating');

    await act(async () => {
      resolveSave?.(connectedResult());
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    });
    expect(validatingAfterRefresh).toBe('false');
  });

  it('does not replay a retained OAuth completion against a disconnected account', async () => {
    let resolveLogin:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    startCanopyCloudOAuthLogin.mockReturnValue(
      new Promise((resolve) => {
        resolveLogin = resolve;
      }),
    );
    await mount();
    await click('oauth');

    act(() => root.unmount());
    await act(async () => {
      resolveLogin?.(connectedResult());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    loadCanopyCloudAccount.mockResolvedValue(disconnectedAccount());
    root = createRoot(container);
    await mount();

    expect(announcements).toHaveLength(0);
  });

  it('does not allow a replacement OAuth attempt until a cancelled attempt settles', async () => {
    let resolveFirstLogin:
      | ((value: ReturnType<typeof connectedResult>) => void)
      | null = null;
    startCanopyCloudOAuthLogin
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirstLogin = resolve;
        }),
      )
      .mockResolvedValueOnce(connectedResult());

    await mount();
    await click('oauth');
    expect(text('oauth-pending')).toBe('true');

    await click('cancel-oauth');
    expect(cancelCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);
    expect(text('oauth-pending')).toBe('true');

    await click('oauth');
    expect(startCanopyCloudOAuthLogin).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirstLogin?.(connectedResult());
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });

    expect(text('oauth-pending')).toBe('false');
    expect(announcements).toHaveLength(1);
  });

  it('announces a sign-in right away without an activity-sharing prompt', async () => {
    await mount();
    await click('oauth');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]?.mode).toBe('oauth');
    expect(window.api.savePreferences).not.toHaveBeenCalled();
  });

  async function mount(
    props: { autoSaveApiKey?: boolean; withAccountConsumer?: boolean } = {},
  ): Promise<void> {
    await act(async () => {
      root.render(<Harness {...props} />);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  }

  async function click(testId: string): Promise<void> {
    const button = container.querySelector<HTMLButtonElement>(
      `[data-testid="${testId}"]`,
    );
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    });
  }

  function text(testId: string): string | null | undefined {
    return container.querySelector(`[data-testid="${testId}"]`)?.textContent;
  }
});

function setNativeValue(input: HTMLInputElement | null, value: string): void {
  if (!input) return;
  /* eslint-disable @typescript-eslint/unbound-method */
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  )?.set;
  /* eslint-enable @typescript-eslint/unbound-method */
  if (setter) Reflect.apply(setter, input, [value]);
}

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

function manualAccount(): CanopyCloudAccountPublicState {
  return {
    ...connectedAccount(),
    authMode: 'api_key',
    credentialSource: 'manual',
  };
}

function connectedResult(): {
  status: {
    authenticated: boolean;
    account: CanopyCloudAccountPublicState['account'];
    capabilities: string[];
    missingCapabilities: string[];
    error: string | null;
  };
  account: CanopyCloudAccountPublicState;
} {
  return {
    status: {
      authenticated: true,
      account: connectedAccount().account,
      capabilities: ['portal-v1'],
      missingCapabilities: [],
      error: null,
    },
    account: connectedAccount(),
  };
}

function guestConnectedResult(): ReturnType<typeof connectedResult> {
  const account: CanopyCloudAccountPublicState = {
    ...connectedAccount(),
    authMode: 'guest',
    credentialSource: 'guest',
  };
  return {
    status: {
      authenticated: true,
      account: account.account,
      capabilities: ['portal-v1'],
      missingCapabilities: [],
      error: null,
    },
    account,
  };
}

function normalizedGuestAccount(): CanopyCloudAccountPublicState {
  return {
    ...connectedAccount(),
    authMode: 'guest',
    credentialSource: 'manual',
  };
}

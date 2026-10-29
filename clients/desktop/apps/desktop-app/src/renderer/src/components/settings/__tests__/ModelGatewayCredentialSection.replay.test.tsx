/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ModelGatewayCredentialSection } from '../ModelGatewayCredentialSection';
import { outermostReplayBlock } from '@/test-utils/replay';
import { MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT } from '@/lib/integrationConnectionEvents';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('ModelGatewayCredentialSection session replay', () => {
  let container: HTMLDivElement;
  let root: Root;
  let previousApi: PropertyDescriptor | undefined;

  beforeEach(() => {
    previousApi = Object.getOwnPropertyDescriptor(window, 'api');
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadModelGatewayCredential: jest.fn().mockResolvedValue({
          organizationId: 'org-acme',
          apiKey: 'sk-secret',
          baseUrlAtSave: 'https://gw.acme.test',
          storageAvailable: true,
        }),
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (previousApi) Object.defineProperty(window, 'api', previousApi);
    else Reflect.deleteProperty(window, 'api');
    jest.useRealTimers();
  });

  it.each([
    { name: 'valid key', key: 'sk-valid', valid: true, error: null },
    { name: 'cleared key', key: '', valid: false, error: null },
    {
      name: 'rejected persisted key',
      key: 'sk-rejected',
      valid: false,
      error: 'Gateway rejected this key.',
    },
  ])(
    'announces a persisted $name only after saving',
    async ({ key, valid, error }) => {
      jest.useFakeTimers();
      let finishSave = (): void => undefined;
      const saveResult = new Promise<{ valid: boolean; error: string | null }>(
        (resolve) => {
          finishSave = (): void => resolve({ valid, error });
        },
      );
      const save = jest.fn().mockReturnValue(saveResult);
      Object.assign(window.api, { saveModelGatewayCredential: save });
      const changed = jest.fn();
      window.addEventListener(MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT, changed);
      try {
        await act(async () => {
          root.render(
            <ModelGatewayCredentialSection
              gateway={{
                organizationId: 'org-acme',
                organizationName: 'Acme',
                baseUrl: 'https://gw.acme.test',
                enforced: false,
                modelIds: [],
              }}
            />,
          );
          await Promise.resolve();
        });
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="settings-model-gateway-key-input"]',
        );
        if (!input) throw new Error('Gateway key input missing');
        act(() => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set?.call(input, key);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          jest.advanceTimersByTime(600);
        });
        expect(save).toHaveBeenCalledWith({
          organizationId: 'org-acme',
          baseUrl: 'https://gw.acme.test',
          apiKey: key,
        });
        expect(changed).not.toHaveBeenCalled();
        await act(async () => {
          finishSave();
          await saveResult;
        });
        expect(changed).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener(
          MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT,
          changed,
        );
      }
    },
  );

  it.each(['storage-failure', 'ipc-rejection'])(
    'does not announce a discarded key after %s',
    async (failure) => {
      jest.useFakeTimers();
      const save = jest.fn();
      if (failure === 'ipc-rejection')
        save.mockRejectedValue(new Error('IPC failed'));
      else
        save.mockResolvedValue({
          valid: false,
          error: 'Unavailable',
          secureStorageFailure: {
            version: 1,
            code: 'SECURE_STORAGE_WRITE_REFUSED',
            operation: 'write',
            state: 'locked',
            backend: null,
            retryable: true,
          },
        });
      Object.assign(window.api, { saveModelGatewayCredential: save });
      const changed = jest.fn();
      window.addEventListener(MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT, changed);
      try {
        await act(async () => {
          root.render(
            <ModelGatewayCredentialSection
              gateway={{
                organizationId: 'org-acme',
                organizationName: 'Acme',
                baseUrl: 'https://gw.acme.test',
                enforced: false,
                modelIds: [],
              }}
            />,
          );
          await Promise.resolve();
        });
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="settings-model-gateway-key-input"]',
        );
        if (!input) throw new Error('Gateway key input missing');
        await act(async () => {
          Object.getOwnPropertyDescriptor(
            HTMLInputElement.prototype,
            'value',
          )?.set?.call(input, 'sk-discarded');
          input.dispatchEvent(new Event('input', { bubbles: true }));
          jest.advanceTimersByTime(600);
          await Promise.resolve();
        });
        expect(save).toHaveBeenCalledTimes(1);
        expect(changed).not.toHaveBeenCalled();
      } finally {
        window.removeEventListener(
          MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT,
          changed,
        );
      }
    },
  );

  it.each(['sk-recovered', ''])(
    'announces read recovery once, including an empty saved key (%s)',
    async (apiKey) => {
      const failure = {
        organizationId: 'org-acme',
        apiKey: '',
        storageAvailable: false,
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          operation: 'read',
          state: 'locked',
          backend: null,
          retryable: true,
        },
      };
      const load = jest
        .fn()
        .mockResolvedValueOnce(failure)
        .mockResolvedValueOnce(failure)
        .mockResolvedValue({
          organizationId: 'org-acme',
          apiKey,
          storageAvailable: true,
        });
      const save = jest.fn();
      Object.assign(window.api, {
        loadModelGatewayCredential: load,
        saveModelGatewayCredential: save,
      });
      const changed = jest.fn();
      window.addEventListener(MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT, changed);
      try {
        await act(async () => {
          await Promise.resolve();
          root.render(
            <ModelGatewayCredentialSection
              gateway={{
                organizationId: 'org-acme',
                organizationName: 'Acme',
                baseUrl: 'https://gw.acme.test',
                enforced: false,
                modelIds: [],
              }}
            />,
          );
        });
        expect(changed).not.toHaveBeenCalled();
        const retry = container.querySelector<HTMLButtonElement>(
          '[data-testid="secure-storage-retry"]',
        );
        if (!retry) throw new Error('Read retry missing');
        await act(async () => {
          await Promise.resolve();
          retry.click();
        });
        expect(changed).not.toHaveBeenCalled();
        expect(
          container.querySelector('[data-testid="secure-storage-notice"]'),
        ).not.toBeNull();
        await act(async () => {
          await Promise.resolve();
          retry.click();
        });
        expect(
          container.querySelector<HTMLInputElement>(
            '[data-testid="settings-model-gateway-key-input"]',
          )?.value,
        ).toBe(apiKey);
        expect(
          container.querySelector('[data-testid="secure-storage-notice"]'),
        ).toBeNull();
        expect(save).not.toHaveBeenCalled();
        expect(changed).toHaveBeenCalledTimes(1);
        // A normal remount must not masquerade as another recovery.
        await act(async () => {
          await Promise.resolve();
          root.render(null);
        });
        await act(async () => {
          await Promise.resolve();
          root.render(
            <ModelGatewayCredentialSection
              gateway={{
                organizationId: 'org-acme',
                organizationName: 'Acme',
                baseUrl: 'https://gw.acme.test',
                enforced: false,
                modelIds: [],
              }}
            />,
          );
        });
        expect(changed).toHaveBeenCalledTimes(1);
      } finally {
        window.removeEventListener(
          MODEL_GATEWAY_CREDENTIAL_CHANGED_EVENT,
          changed,
        );
      }
    },
  );

  it.each(['sk-stale', ''])(
    'orders a reopened section behind an unmount flush of %j',
    async (staleDraft) => {
      jest.useFakeTimers();
      // The main process saves one organization's key in arrival order, so the
      // last submitted save is the persisted key.
      let persistedKey = 'sk-saved';
      let finishFirstSave = (): void => undefined;
      const save = jest
        .fn()
        .mockImplementationOnce(({ apiKey }: { apiKey: string }) => {
          persistedKey = apiKey;
          return new Promise((resolve) => {
            finishFirstSave = (): void => resolve({ valid: true, error: null });
          });
        })
        .mockImplementation(({ apiKey }: { apiKey: string }) => {
          persistedKey = apiKey;
          return Promise.resolve({ valid: true, error: null });
        });
      Object.assign(window.api, {
        loadModelGatewayCredential: jest.fn(() =>
          Promise.resolve({
            organizationId: 'org-acme',
            apiKey: persistedKey,
            storageAvailable: true,
          }),
        ),
        saveModelGatewayCredential: save,
      });
      const gateway = {
        organizationId: 'org-acme',
        organizationName: 'Acme',
        baseUrl: 'https://gw.acme.test',
        enforced: false,
        modelIds: [],
      };
      const keyInput = (): HTMLInputElement => {
        const input = container.querySelector<HTMLInputElement>(
          '[data-testid="settings-model-gateway-key-input"]',
        );
        if (!input) throw new Error('Gateway key input missing');
        return input;
      };
      const type = (value: string): void => {
        const input = keyInput();
        Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )?.set?.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const settle = async (): Promise<void> => {
        for (let i = 0; i < 8; i += 1) await Promise.resolve();
      };
      await act(async () => {
        root.render(<ModelGatewayCredentialSection gateway={gateway} />);
        await settle();
      });
      act(() => {
        type('sk-first');
        jest.advanceTimersByTime(600);
        type(staleDraft);
        root.render(null);
      });
      expect(save).toHaveBeenCalledTimes(1);

      // Reopening must not offer the pre-flush key for editing while the
      // closed section's queued write can still land after a newer save.
      await act(async () => {
        root.render(<ModelGatewayCredentialSection gateway={gateway} />);
        await settle();
      });
      expect(keyInput().disabled).toBe(true);

      await act(async () => {
        finishFirstSave();
        await settle();
      });
      expect(keyInput().disabled).toBe(false);
      expect(keyInput().value).toBe(staleDraft);
      expect(persistedKey).toBe(staleDraft);

      await act(async () => {
        type('sk-newest');
        jest.advanceTimersByTime(600);
        await settle();
      });
      expect(save).toHaveBeenCalledTimes(3);
      expect(persistedKey).toBe('sk-newest');
    },
  );

  it('shows a storage notice rather than a working-key status for a failed read', async () => {
    Object.assign(window.api, {
      loadModelGatewayCredential: jest.fn().mockResolvedValue({
        organizationId: 'org-acme',
        apiKey: '',
        baseUrlAtSave: 'https://gw.acme.test',
        storageAvailable: false,
        secureStorageFailure: {
          version: 1,
          code: 'SECURE_STORAGE_READ_UNAVAILABLE',
          operation: 'read',
          state: 'locked',
          backend: null,
          retryable: true,
        },
      }),
    });
    await act(async () => {
      root.render(
        <ModelGatewayCredentialSection
          gateway={{
            organizationId: 'org-acme',
            organizationName: 'Acme',
            baseUrl: 'https://gw.acme.test',
            enforced: false,
            modelIds: [],
          }}
        />,
      );
      await Promise.resolve();
    });
    expect(
      container
        .querySelector('[data-testid="secure-storage-notice"]')
        ?.getAttribute('data-storage-state'),
    ).toBe('locked');
    expect(
      container.querySelector('[data-testid="secure-storage-retry"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('Your gateway key works.');
  });

  it('records the gateway row (the recorder masks the key input value)', async () => {
    await act(async () => {
      root.render(
        <ModelGatewayCredentialSection
          gateway={{
            organizationId: 'org-acme',
            organizationName: 'Acme',
            baseUrl: 'https://gw.acme.test',
            enforced: false,
            modelIds: [],
          }}
        />,
      );
      await Promise.resolve();
    });
    const section = container.querySelector(
      '[data-testid="settings-model-gateway-credential"]',
    );
    expect(section).not.toBeNull();
    const input = container.querySelector(
      '[data-testid="settings-model-gateway-key-input"]',
    );
    expect(input).not.toBeNull();
    expect(outermostReplayBlock(input)).toBeNull();
    expect(section?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});

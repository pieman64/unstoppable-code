/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ModelGatewayKeyBanner } from '../ModelGatewayKeyBanner';
import { useModelCatalogStore } from '@/stores/modelCatalogStore';

interface StubOptions {
  enforced: boolean;
  apiKey?: string;
  baseUrlAtSave?: string;
  lastError?: string;
}

const BASE_URL = 'https://gw.acme.test';
let notifyRuntimeCredentialChanged: ((organizationId: string) => void) | null;

function stubApi(options: StubOptions | null): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: {
      loadCanopyCloudAccount: () =>
        Promise.resolve(
          options === null
            ? { enforcedSettings: [] }
            : {
                enforcedSettings: [
                  {
                    organizationId: 'org-acme',
                    organizationName: 'Acme',
                    policies: [
                      {
                        kind: 'model-gateway',
                        baseUrl: BASE_URL,
                        models: [],
                        enforced: options.enforced,
                        promptCachePassthrough: true,
                      },
                    ],
                  },
                ],
              },
        ),
      onPreferencesChanged: () => (): void => {},
      onModelGatewayCredentialChanged: (
        callback: (organizationId: string) => void,
      ) => {
        notifyRuntimeCredentialChanged = callback;
        return (): void => {
          notifyRuntimeCredentialChanged = null;
        };
      },
      loadModelGatewayCredential: () =>
        Promise.resolve({
          organizationId: 'org-acme',
          apiKey: options?.apiKey ?? '',
          baseUrlAtSave: options?.baseUrlAtSave ?? BASE_URL,
          lastError: options?.lastError,
          storageAvailable: true,
        }),
    },
  });
}

describe('ModelGatewayKeyBanner', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    notifyRuntimeCredentialChanged = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useModelCatalogStore.setState({ activeOwner: undefined });
  });

  async function render(selectedGatewayOrganizationId?: string): Promise<void> {
    act(() => {
      root.render(
        createElement(ModelGatewayKeyBanner, { selectedGatewayOrganizationId }),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function banner(): HTMLElement | null {
    return container.querySelector(
      '[data-testid="chat-input-model-gateway-key-banner"]',
    );
  }

  it('stays silent when the account declares no gateway', async () => {
    stubApi(null);
    await render();
    expect(banner()).toBeNull();
  });

  it('stays silent for an additive gateway with no key — other models still work', async () => {
    stubApi({ enforced: false });
    await render();
    expect(banner()).toBeNull();
  });

  it('asks for a key when an additive gateway model is selected', async () => {
    stubApi({ enforced: false });
    await render('org-acme');
    expect(banner()?.getAttribute('data-gateway-key-state')).toBe('missing');
    expect(banner()?.textContent).toContain('Add your gateway key');
  });

  it('asks for a key when the gateway is the only route', async () => {
    stubApi({ enforced: true });
    await render();
    expect(banner()?.getAttribute('data-gateway-key-state')).toBe('missing');
    expect(banner()?.textContent).toContain('Acme');
  });

  it('speaks up for a rejected key even when the gateway is additive', async () => {
    stubApi({ enforced: false, apiKey: 'sk-x', lastError: 'HTTP 401' });
    await render();
    expect(banner()?.getAttribute('data-gateway-key-state')).toBe('rejected');
  });

  it('flags a key saved against an endpoint the admin has since moved', async () => {
    stubApi({
      enforced: false,
      apiKey: 'sk-x',
      baseUrlAtSave: 'https://old.acme.test',
    });
    await render();
    expect(banner()?.getAttribute('data-gateway-key-state')).toBe(
      'stale-endpoint',
    );
  });

  it('stays silent once a working key is stored for the current endpoint', async () => {
    stubApi({ enforced: true, apiKey: 'sk-x' });
    await render();
    expect(banner()).toBeNull();
  });

  it('re-reads immediately when Settings saves the gateway credential', async () => {
    const state: StubOptions = { enforced: true };
    stubApi(state);
    await render();
    expect(banner()?.getAttribute('data-gateway-key-state')).toBe('missing');

    state.apiKey = 'sk-working';
    await act(async () => {
      window.dispatchEvent(
        new Event('canopy:model-gateway-credential-changed'),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(banner()).toBeNull();
  });

  it('re-reads immediately when the runtime rejects a previously working key', async () => {
    const state: StubOptions = { enforced: true, apiKey: 'sk-revoked' };
    stubApi(state);
    await render();
    expect(banner()).toBeNull();

    state.lastError = 'Gateway returned HTTP 401.';
    await act(async () => {
      notifyRuntimeCredentialChanged?.('org-acme');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(banner()?.getAttribute('data-gateway-key-state')).toBe('rejected');
  });

  describe('with a known work owner', () => {
    it("asks for the key when the owning org's gateway is the only route", async () => {
      stubApi({ enforced: true });
      useModelCatalogStore.setState({
        activeOwner: { kind: 'organization', organizationId: 'org-acme' },
      });
      await render();
      expect(banner()?.getAttribute('data-gateway-key-state')).toBe('missing');
      expect(banner()?.textContent).toContain('Acme');
    });

    it("stays silent for Personal work, which no org's gateway governs", async () => {
      stubApi({ enforced: true, apiKey: 'sk-x', lastError: 'HTTP 401' });
      useModelCatalogStore.setState({ activeOwner: { kind: 'personal' } });
      await render();
      expect(banner()).toBeNull();
    });

    it("never names another organization's gateway", async () => {
      stubApi({ enforced: true });
      useModelCatalogStore.setState({
        activeOwner: { kind: 'organization', organizationId: 'org-other' },
      });
      await render();
      expect(banner()).toBeNull();
    });

    it('follows a selected gateway row even from Personal work', async () => {
      stubApi({ enforced: false });
      useModelCatalogStore.setState({ activeOwner: { kind: 'personal' } });
      await render('org-acme');
      expect(banner()?.getAttribute('data-gateway-key-state')).toBe('missing');
    });
  });
});

/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyApi, PreferencesData } from '@canopy/desktop-shared/types';
import { CONSENT_TOS_VERSION } from '@canopy/desktop-shared/constants/consent';
import { LegalConsentGate } from '../LegalConsentGate';

jest.mock('@/lib/brand', () => ({
  brand: {
    displayName: 'Mock App',
    assets: { logoSvg: '<svg><path d="M0 0"/></svg>' },
    web: { hostnames: ['app.example.com'] },
  },
  brandText: { appName: 'Mock App' },
}));

describe('LegalConsentGate', () => {
  let container: HTMLElement;
  let root: Root;
  const savePreferences = jest.fn<
    Promise<unknown>,
    [Partial<PreferencesData>]
  >();
  const getCanopyCloudBaseUrl = jest.fn<Promise<string | null>, []>();
  const openExternal = jest.fn();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    savePreferences.mockResolvedValue({});
    getCanopyCloudBaseUrl.mockResolvedValue('https://app.example.com');
    openExternal.mockResolvedValue(undefined);
    Object.assign(window, {
      api: {
        savePreferences,
        getCanopyCloudBaseUrl,
        browser: { openExternal },
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

  function byTestId(id: string): HTMLElement | null {
    return container.querySelector(`[data-testid="${id}"]`);
  }

  async function flush(): Promise<void> {
    await act(async () => {
      for (let i = 0; i < 6; i += 1) {
        await Promise.resolve();
      }
    });
  }

  it('disables Continue until the user checks the agreement box', () => {
    act(() => {
      root.render(<LegalConsentGate onAccepted={jest.fn()} />);
    });
    const accept = byTestId('legal-consent-accept');
    expect(accept).not.toBeNull();
    expect(accept?.hasAttribute('disabled')).toBe(true);

    const checkbox = byTestId('legal-consent-checkbox');
    act(() => {
      if (checkbox instanceof HTMLInputElement) {
        // Native click runs the checkbox toggle + change path React tracks;
        // setting `.checked` directly is ignored by React's value tracker.
        checkbox.click();
      }
    });
    expect(byTestId('legal-consent-accept')?.hasAttribute('disabled')).toBe(
      false,
    );
  });

  it('persists acceptance and notifies the host on Continue', async () => {
    const onAccepted = jest.fn();
    act(() => {
      root.render(<LegalConsentGate onAccepted={onAccepted} />);
    });

    const checkbox = byTestId('legal-consent-checkbox');
    act(() => {
      if (checkbox instanceof HTMLInputElement) {
        // Native click runs the checkbox toggle + change path React tracks;
        // setting `.checked` directly is ignored by React's value tracker.
        checkbox.click();
      }
    });
    act(() => {
      byTestId('legal-consent-accept')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();

    expect(savePreferences).toHaveBeenCalledTimes(1);
    const savedArgs = savePreferences.mock.calls[0]?.[0];
    expect(typeof savedArgs?.legalConsentAcceptedAt).toBe('string');
    expect(savedArgs?.legalConsentTosVersion).toBe(CONSENT_TOS_VERSION);
    expect(onAccepted).toHaveBeenCalledTimes(1);
  });

  // Innermost element whose own text is the legal document name. Selected by
  // text rather than test id so the regression reproduces against the old
  // markup, where the unresolved fallback had no dedicated element.
  function legalName(name: string): HTMLElement | null {
    const candidates = Array.from(container.querySelectorAll('*')).filter(
      (el): el is HTMLElement =>
        el instanceof HTMLElement && (el.textContent ?? '').includes(name),
    );
    return candidates[candidates.length - 1] ?? null;
  }

  function isChecked(): boolean {
    const checkbox = byTestId('legal-consent-checkbox');
    return checkbox instanceof HTMLInputElement && checkbox.checked;
  }

  it.each([
    ['Terms of Service', 'https://app.example.com/terms'],
    ['Privacy Policy', 'https://app.example.com/privacy'],
  ])(
    'opens %s without checking the agreement box',
    async (name, expectedUrl) => {
      act(() => {
        root.render(<LegalConsentGate onAccepted={jest.fn()} />);
      });
      await flush();

      act(() => {
        legalName(name)?.click();
      });

      expect(openExternal).toHaveBeenCalledWith({ url: expectedUrl });
      expect(isChecked()).toBe(false);
      expect(byTestId('legal-consent-accept')?.hasAttribute('disabled')).toBe(
        true,
      );
    },
  );

  it.each(['Terms of Service', 'Privacy Policy'])(
    'does not check the agreement box when %s is clicked without a cloud URL',
    async (name) => {
      getCanopyCloudBaseUrl.mockResolvedValue(null);
      act(() => {
        root.render(<LegalConsentGate onAccepted={jest.fn()} />);
      });
      await flush();

      act(() => {
        legalName(name)?.click();
      });

      expect(openExternal).not.toHaveBeenCalled();
      expect(isChecked()).toBe(false);
    },
  );

  it('does not check the agreement box when a legal name is clicked before the cloud URL resolves', () => {
    getCanopyCloudBaseUrl.mockReturnValue(new Promise(() => undefined));
    act(() => {
      root.render(<LegalConsentGate onAccepted={jest.fn()} />);
    });

    act(() => {
      legalName('Terms of Service')?.click();
    });

    expect(isChecked()).toBe(false);
  });

  it('still checks the agreement box from its label text', () => {
    act(() => {
      root.render(<LegalConsentGate onAccepted={jest.fn()} />);
    });
    act(() => {
      byTestId('legal-consent-label')?.click();
    });
    expect(isChecked()).toBe(true);
  });

  it('names both legal documents in the checkbox accessible label', async () => {
    act(() => {
      root.render(<LegalConsentGate onAccepted={jest.fn()} />);
    });
    await flush();

    expect(byTestId('legal-consent-checkbox')?.getAttribute('aria-label')).toBe(
      'I have read and agree to the Terms of Service and Privacy Policy',
    );
  });

  it('does not persist or advance while the box is unchecked', async () => {
    const onAccepted = jest.fn();
    act(() => {
      root.render(<LegalConsentGate onAccepted={onAccepted} />);
    });
    act(() => {
      byTestId('legal-consent-accept')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
    await flush();
    expect(savePreferences).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });
});

/**
 * @jest-environment jsdom
 */
declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  SettingsOperationError,
  type SettingsOperationName,
} from '@canopy/protocol/settings';
import type { AuthSourcesResponse } from '@canopy/protocol/settings/account';
import { AccountPanel, SecurityPanel } from '../account-details-panel';
import {
  expectNoLegacyCardShell,
  expectNoSettingsCardHeading,
  expectSettingsCardHeading,
  expectSettingsCardShell,
} from '@canopy/ui-shared/components/settings/__tests__/helpers/settings-card-assertions';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';

const mockToDataURL = jest.fn<Promise<string>, [string]>();
const mockWriteText = jest.fn<Promise<void>, [string]>();

jest.mock('qrcode', () => ({
  toDataURL: (uri: string): Promise<string> => mockToDataURL(uri),
}));

const mockOpenOAuth = jest.fn();

type Handlers = Partial<Record<SettingsOperationName, FakeSettingsHandler>>;

function makeResponse(
  overrides: Partial<AuthSourcesResponse> = {},
): AuthSourcesResponse {
  return {
    user: {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      twoFactorEnabled: false,
    },
    sources: [
      {
        providerId: 'credential',
        accountId: 'acc-cred',
        label: 'Email and password',
        linkedAt: '2026-01-03T10:00:00.000Z',
        canUnlink: true,
      },
    ],
    ...overrides,
  };
}

describe('AccountPanel / SecurityPanel', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: mockWriteText.mockResolvedValue(undefined),
      },
    });
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.clearAllMocks();
    privacy = { blockClassName: '', maskClassName: '' };
  });

  let client: FakeSettingsClient = createFakeSettingsClient();
  let privacy = { blockClassName: '', maskClassName: '' };

  /** Answers the auth-sources read with `response`; every write succeeds. */
  function installClient(
    response: AuthSourcesResponse,
    handlers: Handlers = {},
  ): FakeSettingsClient {
    client = createFakeSettingsClient({
      'account.security.authSources': () => response,
      'account.apiKeys.list': () => [],
      'account.security.unlinkAuthSource': () => ({ ok: true }),
      'account.security.setPassword': () => ({ ok: true }),
      'account.security.changePassword': () => ({ token: null, user: {} }),
      'account.security.twoFactor.verify': () => ({ ok: true }),
      'account.security.twoFactor.clearSession': () => null,
      'account.security.twoFactor.disable': () => ({ status: true }),
      ...handlers,
    });
    return client;
  }

  /** Every input the panel sent for `operation`, in order. */
  function inputsFor(operation: SettingsOperationName): unknown[] {
    return client.calls
      .filter((call) => call.operation === operation)
      .map((call) => call.input);
  }

  function hosted(node: ReactNode): ReactNode {
    const { host } = createTestSettingsHost({
      client,
      privacy,
      navigation: { openOAuth: mockOpenOAuth },
    });
    return <TestSettingsHost host={host}>{node}</TestSettingsHost>;
  }

  async function renderAndLoad(): Promise<void> {
    act(() => {
      root.render(
        hosted(
          <SecurityPanel
            brandDisplayName="Canopy"
            emailPasswordAuthEnabled={true}
          />,
        ),
      );
    });
    // The initial load is deferred via setTimeout(0); let that macrotask fire
    // and then flush the fetch microtasks.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function findButton(label: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Button not found: ${label}`);
    return button;
  }

  /** The login-method `<li>` whose display label is exactly `label`. */
  function rowForLabel(label: string): HTMLLIElement {
    const row = Array.from(container.querySelectorAll('li')).find(
      (li) => li.querySelector('p')?.textContent?.trim() === label,
    );
    if (!row) throw new Error(`Login-method row not found: ${label}`);
    return row;
  }

  function clickButton(label: string): void {
    act(() => {
      findButton(label).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
    });
  }

  async function clickButtonAsync(label: string): Promise<void> {
    await act(async () => {
      findButton(label).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  function setInput(selector: string, value: string): void {
    const input = container.querySelector<HTMLInputElement>(selector);
    if (!input) throw new Error(`Input not found: ${selector}`);
    Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value);
    act(() => {
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  async function submitForm(label: string): Promise<void> {
    const form = findButton(label).closest('form');
    if (!form) throw new Error(`Form not found for button: ${label}`);
    await act(async () => {
      form.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function renderAccount(): Promise<void> {
    act(() => {
      root.render(
        hosted(
          <AccountPanel
            initialName="Ada Lovelace"
            initialImage={null}
            role="ADMIN"
            email="ada@example.com"
          />,
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('shows the global role on the profile card', async () => {
    installClient(makeResponse());
    await renderAccount();

    const roleEl = container.querySelector('[data-testid="account-role"]');
    expect(roleEl).not.toBeNull();
    expect(roleEl?.textContent).toBe('Admin');
  });

  it('shows the sign-in email on the account-basics tile', async () => {
    installClient(makeResponse());
    await renderAccount();

    const emailEl = container.querySelector('[data-testid="account-email"]');
    expect(emailEl).not.toBeNull();
    expect(emailEl?.textContent).toBe('ada@example.com');
  });

  it('does not render the public profile or billing sections on the account tab', async () => {
    // Those surfaces moved to their own tabs/routes; the Account tab is
    // identity-only now.
    installClient(makeResponse());
    await renderAccount();

    expect(
      container.querySelector('[data-testid="account-public-profile-section"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="account-billing-section"]'),
    ).toBeNull();
  });

  it('draws the account as one Profile section of grouped rows', async () => {
    // The same text-only heading and grouped box every settings page uses.
    installClient(makeResponse());
    await renderAccount();

    expectSettingsCardShell(container, 'account-profile-section');
    expectSettingsCardHeading(container, 'Profile');
    const section = container.querySelector(
      '[data-testid="account-profile-section"]',
    );
    // Photo, Name, Email and Role are rows in the one box.
    const rows = Array.from(
      section?.querySelectorAll('.settings-card-row') ?? [],
    );
    expect(rows).toHaveLength(4);
    ['Photo', 'Name', 'Email', 'Role'].forEach((label, index) => {
      expect(rows[index]?.textContent?.startsWith(label)).toBe(true);
    });
    expect(
      container
        .querySelector('[data-testid="profile-name-input"]')
        ?.getAttribute('value'),
    ).toBe('Ada Lovelace');
    expectNoLegacyCardShell(container);
  });

  it('does not restate the Account page title as a card heading', async () => {
    // The page header already says "Account"; the identity card is "Basic info".
    installClient(makeResponse());
    await renderAccount();

    expectNoSettingsCardHeading(container, 'Account');
  });

  it('gives the security cards the shared settings-card shell', async () => {
    installClient(makeResponse());
    await renderAndLoad();

    expectSettingsCardShell(container, 'account-api-keys-section');
    for (const title of ['Sign-in methods', 'API keys']) {
      expectSettingsCardHeading(container, title);
    }
    expectNoLegacyCardShell(container);
  });

  it('renders the API keys section on a successful auth-sources load', async () => {
    installClient(makeResponse());
    await renderAndLoad();

    const apiKeysSection = container.querySelector(
      '[data-testid="account-api-keys-section"]',
    );
    expect(apiKeysSection).not.toBeNull();
    expect(apiKeysSection?.textContent).toContain('API keys');
  });

  it('still renders the API keys section when the auth-sources fetch fails', async () => {
    // API key management manages its own fetch/state and must remain visible
    // even when the auth-sources request fails — an auth-sources load failure
    // must not hide this panel.
    installClient(makeResponse(), {
      'account.security.authSources': () => {
        throw new SettingsOperationError({ code: 'failed', status: 500 });
      },
    });

    await renderAndLoad();

    // The auth-sources failure surfaces its error state...
    expect(container.textContent).toContain("Couldn't load this.");
    // ...but the API keys section is rendered outside that status gate.
    const apiKeysSection = container.querySelector(
      '[data-testid="account-api-keys-section"]',
    );
    expect(apiKeysSection).not.toBeNull();
    expect(apiKeysSection?.textContent).toContain('API keys');
  });

  it('renders the login methods from the auth-sources response', async () => {
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'google',
            accountId: 'acc-google',
            label: 'Google',
            linkedAt: '2026-01-02T10:00:00.000Z',
            canUnlink: true,
          },
          {
            providerId: 'credential',
            accountId: 'acc-cred',
            label: 'Email and password',
            linkedAt: '2026-01-03T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
    );
    await renderAndLoad();

    expect(container.textContent).toContain('Sign-in methods');
    expect(container.textContent).toContain('Google');
    expect(container.textContent).toContain('Email and password');
    // Google renders its real brand logo (Google-blue glyph path), not the
    // neutral globe fallback; email/password keeps the UI Kit mail mark.
    expect(container.querySelector('path[fill="#4285F4"]')).not.toBeNull();
    expect(
      container.querySelector('[data-testid="auth-source-mail-icon"]'),
    ).not.toBeNull();
    expect(container.querySelector('.lucide-globe')).toBeNull();
    expect(container.querySelector('.lucide-github')).toBeNull();
  });

  it('renders the SSO source with the neutral SSO icon, not the globe fallback', async () => {
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'sso-server',
            // Namespaced `issuer#sub` tuple — contractually opaque, and never
            // rendered.
            accountId: 'https%3A%2F%2Fsso.example.com#opaque-subject-42',
            label: 'Single Sign-On',
            linkedAt: '2026-01-04T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
    );
    await renderAndLoad();

    expect(container.textContent).toContain('Single Sign-On');
    const row = rowForLabel('Single Sign-On');
    // Explicitly the SSO mark: without the `sso-server` switch case this row
    // would silently render the `Globe` default and still "pass".
    expect(
      row.querySelector('[data-testid="single-sign-on-icon"]'),
    ).not.toBeNull();
    // The shared SSO key must remain distinct from the globe fallback.
    expect(row.querySelector('svg[data-glyph="key-round"]')).not.toBeNull();
    expect(row.querySelector('svg[data-glyph="globe"]')).toBeNull();
    // And not the Unstoppable Domains mark or its brand colors.
    expect(row.querySelector('path[fill="#0D67FE"]')).toBeNull();
    expect(row.querySelector('path[fill="#00C9FF"]')).toBeNull();
  });

  it('never renders the opaque accountId for an SSO source', async () => {
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'sso-server',
            accountId: 'https%3A%2F%2Fsso.example.com#opaque-subject-42',
            label: 'Single Sign-On',
            linkedAt: '2026-01-04T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
    );
    await renderAndLoad();

    // The row shows `label` and `linkedAt` only. `accountId` is used as the
    // React key and in the DELETE body; neither reaches the DOM.
    expect(container.textContent).not.toContain('opaque-subject-42');
    expect(container.innerHTML).not.toContain('opaque-subject-42');
    expect(container.innerHTML).not.toContain('sso.example.com');
  });

  it('keeps every existing provider row on its original icon and label', async () => {
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'google',
            accountId: 'acc-google',
            label: 'Google',
            linkedAt: '2026-01-02T10:00:00.000Z',
            canUnlink: true,
          },
          {
            providerId: 'github',
            accountId: 'acc-github',
            label: 'GitHub',
            linkedAt: '2026-01-02T11:00:00.000Z',
            canUnlink: true,
          },
          {
            providerId: 'unstoppable-domains',
            accountId: 'acc-ud',
            label: 'Unstoppable Domains',
            linkedAt: '2026-01-02T12:00:00.000Z',
            canUnlink: true,
          },
          {
            providerId: 'credential',
            accountId: 'acc-cred',
            label: 'Email and password',
            linkedAt: '2026-01-03T10:00:00.000Z',
            canUnlink: true,
          },
          {
            providerId: 'sso-server',
            accountId: 'acc-sso',
            label: 'Single Sign-On',
            linkedAt: '2026-01-04T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
    );
    await renderAndLoad();

    // Google keeps its brand-blue path, UD keeps its brand-blue path, GitHub
    // renders the official Octicon mark at 16px, credential keeps the UI Kit
    // mail mark.
    expect(
      rowForLabel('Google').querySelector('path[fill="#4285F4"]'),
    ).not.toBeNull();
    const githubMark = rowForLabel('GitHub').querySelector(
      'svg[data-glyph="mark-github"]',
    );
    expect(githubMark?.getAttribute('width')).toBe('16px');
    expect(githubMark?.getAttribute('height')).toBe('16px');
    expect(
      rowForLabel('Unstoppable Domains').querySelector('path[fill="#0D67FE"]'),
    ).not.toBeNull();
    expect(
      rowForLabel('Email and password').querySelector(
        '[data-testid="auth-source-mail-icon"]',
      ),
    ).not.toBeNull();

    // The SSO mark is used for exactly one row, and it is not reused for UD.
    expect(
      container.querySelectorAll('[data-testid="single-sign-on-icon"]'),
    ).toHaveLength(1);
    expect(
      rowForLabel('Single Sign-On').querySelector(
        '[data-testid="single-sign-on-icon"]',
      ),
    ).not.toBeNull();
    expect(
      rowForLabel('Unstoppable Domains').querySelector(
        '[data-testid="single-sign-on-icon"]',
      ),
    ).toBeNull();

    // No recognized provider falls through to the neutral globe.
    for (const label of [
      'Google',
      'GitHub',
      'Unstoppable Domains',
      'Single Sign-On',
    ]) {
      expect(
        rowForLabel(label).querySelector('svg[data-glyph="globe"]'),
      ).toBeNull();
    }
    expect(
      Array.from(
        rowForLabel('GitHub').querySelectorAll('[data-app-icon="true"]'),
        (icon) => icon.getAttribute('data-glyph'),
      ),
    ).toEqual(['mark-github']);
  });

  it('still falls back to the globe for an unrecognized provider', async () => {
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'some-future-provider',
            accountId: 'acc-future',
            label: 'some-future-provider',
            linkedAt: '2026-01-05T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
    );
    await renderAndLoad();

    // The `Globe` default still catches ids Canopy does not name; adding the
    // `sso-server` case must not have disturbed it.
    const row = rowForLabel('some-future-provider');
    expect(row.querySelector('svg[data-glyph="globe"]')).not.toBeNull();
    expect(
      row.querySelector('[data-testid="auth-source-mail-icon"]'),
    ).toBeNull();
    expect(row.querySelector('[data-testid="single-sign-on-icon"]')).toBeNull();
  });

  it('disables removal of the last remaining login source', async () => {
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'credential',
            accountId: 'acc-cred',
            label: 'Email and password',
            linkedAt: '2026-01-03T10:00:00.000Z',
            canUnlink: false,
          },
        ],
      }),
    );
    await renderAndLoad();

    expect(container.textContent).toContain(
      'Add another method before removing',
    );
    const removeButton = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Remove',
    );
    expect(removeButton).toBeUndefined();
  });

  it('links Google through the host OAuth port', async () => {
    installClient(makeResponse());
    await renderAndLoad();

    clickButton('Link Google');

    // The host owns the provider round trip (web: Better Auth `linkSocial`
    // with the `/account` callbacks; desktop: the system browser).
    expect(mockOpenOAuth).toHaveBeenCalledWith('google');
    expect(mockOpenOAuth).toHaveBeenCalledTimes(1);
  });

  it('offers GitHub linking through the same port when it is not linked', async () => {
    installClient(makeResponse());
    await renderAndLoad();

    clickButton('Link GitHub');

    expect(mockOpenOAuth).toHaveBeenCalledWith('github');
  });

  it('changes the password through Better Auth for credential users', async () => {
    installClient(makeResponse());
    await renderAndLoad();

    clickButton('Change password');
    setInput('input[autocomplete="current-password"]', 'old-password-123');
    setInput('input[autocomplete="new-password"]', 'new-password-456');
    await submitForm('Save password');

    expect(inputsFor('account.security.changePassword')).toEqual([
      {
        currentPassword: 'old-password-123',
        newPassword: 'new-password-456',
      },
    ]);
    // The form closes and clears both fields once the change lands.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.textContent).toContain('Password saved.');
  });

  it('shows load copy, never the server text, and Retry reloads the sign-in methods', async () => {
    let failing = true;
    installClient(makeResponse(), {
      'account.security.authSources': () => {
        if (failing)
          throw new SettingsOperationError({
            code: 'failed',
            status: 500,
            message: 'SENTINEL-SERVER-BODY',
          });
        return makeResponse();
      },
    });
    await renderAndLoad();

    expect(container.textContent).toContain("Couldn't load this.");
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');

    failing = false;
    await clickButtonAsync('Try again');

    expect(inputsFor('account.security.authSources')).toHaveLength(2);
    expect(container.textContent).toContain('Sign-in methods');
    expect(container.textContent).not.toContain("Couldn't load this.");
  });

  it('shows the password error and keeps the form when the change fails', async () => {
    installClient(makeResponse(), {
      'account.security.changePassword': () => {
        throw new SettingsOperationError({ code: 'failed', status: 400 });
      },
    });
    await renderAndLoad();

    clickButton('Change password');
    setInput('input[autocomplete="current-password"]', 'old-password-123');
    setInput('input[autocomplete="new-password"]', 'new-password-456');
    await submitForm('Save password');

    expect(container.textContent).toContain(
      "Couldn't save the password. Try again.",
    );
    expect(
      container.querySelector('input[autocomplete="new-password"]'),
    ).not.toBeNull();
  });

  it('sets a password through the set-password route for OAuth-only users', async () => {
    installClient(
      makeResponse({
        user: {
          name: 'Ada Lovelace',
          email: 'ada@example.com',
          twoFactorEnabled: false,
        },
        sources: [
          {
            providerId: 'google',
            accountId: 'acc-google',
            label: 'Google',
            linkedAt: '2026-01-02T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
    );
    await renderAndLoad();

    clickButton('Set password');
    setInput('input[autocomplete="new-password"]', 'brand-new-password');
    await submitForm('Save password');

    expect(inputsFor('account.security.setPassword')).toEqual([
      { newPassword: 'brand-new-password' },
    ]);
    expect(inputsFor('account.security.changePassword')).toEqual([]);
  });

  it('hides password controls when email/password auth is disabled', async () => {
    installClient(makeResponse());
    act(() => {
      root.render(
        hosted(
          <SecurityPanel
            brandDisplayName="Canopy"
            emailPasswordAuthEnabled={false}
          />,
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).not.toContain('Change password');
    expect(container.textContent).not.toContain('Set password');
    expect(container.textContent).not.toContain('Email and password');
  });

  it('removes a login source after confirmation', async () => {
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'google',
            accountId: 'acc-google',
            label: 'Google',
            linkedAt: '2026-01-02T10:00:00.000Z',
            canUnlink: true,
          },
          {
            providerId: 'credential',
            accountId: 'acc-cred',
            label: 'Email and password',
            linkedAt: '2026-01-03T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
    );
    await renderAndLoad();

    clickButton('Remove'); // reveal confirmation
    await clickButtonAsync('Remove'); // confirm

    expect(inputsFor('account.security.unlinkAuthSource')).toEqual([
      { providerId: 'google', accountId: 'acc-google' },
    ]);
    // A successful removal re-reads the sign-in methods.
    expect(inputsFor('account.security.authSources')).toHaveLength(2);
  });

  it("surfaces the route's last-method guard when removal is refused", async () => {
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'google',
            accountId: 'acc-google',
            label: 'Google',
            linkedAt: '2026-01-02T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
      {
        'account.security.unlinkAuthSource': () => {
          throw new SettingsOperationError({
            code: 'failed',
            status: 400,
            message: 'SENTINEL-SERVER-BODY',
          });
        },
      },
    );
    await renderAndLoad();

    clickButton('Remove');
    await clickButtonAsync('Remove');

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      'Add another sign-in method before removing this one.',
    );
    expect(container.textContent).not.toContain('SENTINEL-SERVER-BODY');
  });

  it('shows the generic removal error, never the server text, for other failures', async () => {
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'google',
            accountId: 'acc-google',
            label: 'Google',
            linkedAt: '2026-01-02T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
      {
        'account.security.unlinkAuthSource': () => {
          throw new SettingsOperationError({
            code: 'failed',
            status: 500,
            message: 'SENTINEL-SERVER-BODY',
          });
        },
      },
    );
    await renderAndLoad();

    clickButton('Remove');
    await clickButtonAsync('Remove');

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't remove this sign-in method. Try again.",
    );
  });

  it('renders the 2FA QR after enable returns a totpURI', async () => {
    mockToDataURL.mockResolvedValue('data:image/png;base64,QR');
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'google',
            accountId: 'acc-google',
            label: 'Google',
            linkedAt: '2026-01-02T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
      {
        'account.security.twoFactor.enable': () => ({
          totpURI: 'otpauth://totp/Canopy:ada?secret=ABC',
          backupCodes: ['code-1', 'code-2'],
        }),
      },
    );
    await renderAndLoad();

    // OAuth-only user → no password step; Enable goes straight to provisioning.
    await clickButtonAsync('Enable 2FA');

    expect(inputsFor('account.security.twoFactor.enable')).toEqual([
      { issuer: 'Canopy' },
    ]);
    expect(mockToDataURL).toHaveBeenCalledWith(
      'otpauth://totp/Canopy:ada?secret=ABC',
    );
    const qr = container.querySelector(
      'img[alt="Two-factor authentication QR code"]',
    );
    expect(qr).not.toBeNull();
    expect(qr?.getAttribute('src')).toBe('data:image/png;base64,QR');
    expect(container.textContent).toContain('Scan this QR code');
  });

  it('copies backup codes as a newline-delimited list', async () => {
    mockToDataURL.mockResolvedValue('data:image/png;base64,QR');
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'google',
            accountId: 'acc-google',
            label: 'Google',
            linkedAt: '2026-01-02T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
      {
        'account.security.twoFactor.enable': () => ({
          totpURI: 'otpauth://totp/Canopy:ada?secret=ABC',
          backupCodes: ['code-1', 'code-2', 'code-3'],
        }),
      },
    );
    await renderAndLoad();

    await clickButtonAsync('Enable 2FA');
    setInput('input[autocomplete="one-time-code"]', '123456');
    await submitForm('Verify and finish');
    await clickButtonAsync('Copy');

    expect(inputsFor('account.security.twoFactor.verify')).toEqual([
      { code: '123456' },
    ]);
    expect(mockWriteText).toHaveBeenCalledWith('code-1\ncode-2\ncode-3');
    expect(container.textContent).toContain('Copied');

    // `Done` drops the backup codes from the panel.
    await clickButtonAsync('Done');
    expect(container.textContent).not.toContain('code-1');
  });

  it('keeps the user on the verify step when the code is rejected', async () => {
    mockToDataURL.mockResolvedValue('data:image/png;base64,QR');
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'google',
            accountId: 'acc-google',
            label: 'Google',
            linkedAt: '2026-01-02T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
      {
        'account.security.twoFactor.enable': () => ({
          totpURI: 'otpauth://totp/Canopy:ada?secret=ABC',
          backupCodes: ['code-1'],
        }),
        'account.security.twoFactor.verify': () => {
          throw new SettingsOperationError({ code: 'failed', status: 400 });
        },
      },
    );
    await renderAndLoad();

    await clickButtonAsync('Enable 2FA');
    setInput('input[autocomplete="one-time-code"]', '000000');
    await submitForm('Verify and finish');

    expect(container.textContent).toContain('Invalid verification code.');
    expect(container.textContent).toContain('Scan this QR code');
  });

  it('marks secrets and identity for replay privacy', async () => {
    privacy = { blockClassName: 'dd-privacy-hidden', maskClassName: '' };
    mockToDataURL.mockResolvedValue('data:image/png;base64,QR');
    installClient(
      makeResponse({
        sources: [
          {
            providerId: 'google',
            accountId: 'acc-google',
            label: 'Google',
            linkedAt: '2026-01-02T10:00:00.000Z',
            canUnlink: true,
          },
        ],
      }),
      {
        'account.security.twoFactor.enable': () => ({
          totpURI: 'otpauth://totp/Canopy:ada?secret=ABC',
          backupCodes: ['code-1'],
        }),
      },
    );
    await renderAndLoad();
    await clickButtonAsync('Enable 2FA');

    const qrBlock = container.querySelector(
      '[data-testid="two-factor-qr-block"]',
    );
    expect(qrBlock?.classList.contains('dd-privacy-hidden')).toBe(true);
    expect(
      qrBlock?.querySelector('img[alt="Two-factor authentication QR code"]'),
    ).not.toBeNull();
    const setupKey = Array.from(container.querySelectorAll('code')).find(
      (code) => code.textContent?.includes('secret=ABC'),
    );
    expect(setupKey?.classList.contains('dd-privacy-hidden')).toBe(true);
  });

  it('marks the account email for replay privacy', async () => {
    privacy = { blockClassName: 'dd-privacy-hidden', maskClassName: '' };
    installClient(makeResponse());
    await renderAccount();

    const email = container.querySelector('[data-testid="account-email"]');
    expect(email?.classList.contains('dd-privacy-hidden')).toBe(true);
    expect(
      container
        .querySelector('[data-testid="profile-name-input"]')
        ?.closest('.dd-privacy-hidden'),
    ).toBeInstanceOf(HTMLElement);
  });

  it('adds no class token when the host records no replay', async () => {
    installClient(makeResponse());
    await renderAccount();

    const email = container.querySelector('[data-testid="account-email"]');
    expect(email?.className).not.toContain('dd-privacy-hidden');
    expect(email?.className.split(' ')).toContain('truncate');
  });

  it('reenables the idle 2FA action after disabling succeeds', async () => {
    const enabledResponse = makeResponse({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        twoFactorEnabled: true,
      },
      sources: [
        {
          providerId: 'google',
          accountId: 'acc-google',
          label: 'Google',
          linkedAt: '2026-01-02T10:00:00.000Z',
          canUnlink: false,
        },
      ],
    });
    const disabledResponse = makeResponse({
      user: {
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        twoFactorEnabled: false,
      },
      sources: [
        {
          providerId: 'google',
          accountId: 'acc-google',
          label: 'Google',
          linkedAt: '2026-01-02T10:00:00.000Z',
          canUnlink: false,
        },
      ],
    });
    let getCount = 0;
    installClient(enabledResponse, {
      'account.security.authSources': () => {
        getCount += 1;
        return getCount === 1 ? enabledResponse : disabledResponse;
      },
    });

    await renderAndLoad();
    clickButton('Disable 2FA');
    await submitForm('Disable 2FA');

    const enableButton = findButton('Enable 2FA');
    expect(enableButton.disabled).toBe(false);
    expect(inputsFor('account.security.twoFactor.disable')).toEqual([{}]);
    // Disabling also clears the two-factor completion cookie.
    expect(inputsFor('account.security.twoFactor.clearSession')).toEqual([{}]);
  });
});

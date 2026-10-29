/**
 * @jest-environment jsdom
 */
import { renderToString } from 'react-dom/server';
import {
  accountNavItem,
  type AccountNavKey,
} from '../../navigation/account-nav-items';
import {
  TestSettingsHost,
  createTestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import { AccountPageHeader } from '../account-page-header';

function renderHeader(pathname: string, freeAccess = false): HTMLElement {
  const { host } = createTestSettingsHost({ pathname });
  const container = document.createElement('div');
  container.innerHTML = renderToString(
    <TestSettingsHost host={host}>
      <AccountPageHeader freeAccess={freeAccess} />
    </TestSettingsHost>,
  );
  return container;
}

describe('AccountPageHeader', () => {
  it('renders nothing on the external-agent consent page', () => {
    expect(renderHeader('/account/external-agents/consent').innerHTML).toBe('');
  });

  it('renders nothing on an external-agent confirmation page', () => {
    expect(
      renderHeader('/account/external-agents/confirm/action-1').innerHTML,
    ).toBe('');
  });

  it.each<[string, AccountNavKey]>([
    ['/account', 'account'],
    ['/account/profile', 'profile'],
    ['/account/digests', 'digests'],
    ['/account/notifications', 'notifications'],
    ['/account/integrations', 'integrations'],
    ['/account/external-agents', 'externalAgents'],
    ['/account/security', 'security'],
    ['/account/billing', 'billing'],
    // Detail routes keep the name of the page they belong to, like the rail.
    ['/account/digests/digest-1', 'digests'],
    ['/account/external-agents/agent-1', 'externalAgents'],
    ['/account/billing/invoices/in_1', 'billing'],
    // Anything the rail cannot place falls back to the account page itself.
    ['/account/unknown', 'account'],
    // A host without a pathname reports an empty one.
    ['', 'account'],
  ])('names %s as the %s page', (pathname, key) => {
    const container = renderHeader(pathname);
    const item = accountNavItem(key);

    const header = container.querySelector('[data-testid="page-header"]');
    const title = header?.querySelector('[data-testid="page-header-title"]');
    expect(title?.tagName).toBe('H1');
    expect(title?.textContent).toBe(item.label);
    expect(
      header?.querySelector('[data-testid="page-header-description"]')
        ?.textContent,
    ).toBe(item.description);
  });

  // The archive's sole action sits in the header, beside the page name.
  it('puts Digest settings in the Digests archive header', () => {
    const header = renderHeader('/account/digests').querySelector(
      '[data-testid="page-header"]',
    );
    const link = header?.querySelector(
      '[data-testid="account-digest-settings-link"]',
    );
    expect(link?.textContent).toBe('Digest settings');
    expect(link?.getAttribute('href')).toBe('/account/notifications');
  });

  it.each(['/account', '/account/security', '/account/digests/digest-1'])(
    'gives %s no header action',
    (pathname) => {
      const header = renderHeader(pathname).querySelector(
        '[data-testid="page-header"]',
      );
      expect(header?.querySelector('a, button')).toBeNull();
    },
  );
});

it.each(['/account/billing', '/account/billing/invoices/in_1'])(
  'names %s AI Credits with credit-only copy in free access',
  (pathname) => {
    const container = renderHeader(pathname, true);
    expect(
      container.querySelector('[data-testid="page-header-title"]')?.textContent,
    ).toBe('AI Credits');
    expect(
      container.querySelector('[data-testid="page-header-description"]')
        ?.textContent,
    ).toBe('Your AI Credit balance, payment methods and top-ups.');
  },
);

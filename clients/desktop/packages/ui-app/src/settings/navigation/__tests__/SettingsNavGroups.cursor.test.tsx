/**
 * @jest-environment jsdom
 */
import { renderToString } from 'react-dom/server';
import { SettingsNavGroups } from '../SettingsNavGroups';
import type { SettingsNavGroup } from '../settings-nav-model';

function Icon(): null {
  return null;
}

const GROUPS: readonly SettingsNavGroup<string>[] = [
  {
    id: 'account',
    label: 'Account',
    rows: [
      {
        key: 'account-profile',
        label: 'Public profile',
        icon: Icon,
        href: '/account/profile',
        disabled: false,
        attention: false,
      },
      {
        key: 'account-billing',
        label: 'AI Credits',
        icon: Icon,
        href: '/account/billing',
        disabled: true,
        attention: false,
      },
    ],
  },
];

function renderRows(): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = renderToString(
    <SettingsNavGroups
      groups={GROUPS}
      currentKey={null}
      LinkComponent={(props) => <a {...props} />}
      testIdPrefix="settings-nav-"
    />,
  );
  return container;
}

describe('SettingsNavGroups cursor', () => {
  // Rows are links, which browsers give a hand cursor. Settings rows use the
  // arrow like the rest of the app's menus and the button rows beside them.
  it('gives link rows the default cursor', () => {
    const row = renderRows().querySelector(
      '[data-testid="settings-nav-account-profile"]',
    );
    expect(row?.tagName).toBe('A');
    expect(row?.classList.contains('cursor-default')).toBe(true);
    expect(row?.classList.contains('cursor-pointer')).toBe(false);
  });

  it('keeps the not-allowed cursor on disabled rows', () => {
    const row = renderRows().querySelector(
      '[data-testid="settings-nav-account-billing"]',
    );
    expect(row?.classList.contains('cursor-not-allowed')).toBe(true);
    expect(row?.classList.contains('cursor-default')).toBe(false);
  });
});

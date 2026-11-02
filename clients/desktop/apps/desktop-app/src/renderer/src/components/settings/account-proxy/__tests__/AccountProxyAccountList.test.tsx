/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AccountProxyAccount } from '@canopy/desktop-shared/types/account-proxy';
import { AccountProxyAccountList } from '../AccountProxyAccountList';

const ACCOUNT: AccountProxyAccount = {
  authIndex: 'a1f3c2d4a1f3c2d4',
  provider: 'claude',
  label: 'sam@example.com',
  source: 'sign-in',
  fileName: 'claude-sam@example.com.json',
  planType: null,
  status: 'active',
  statusMessage: null,
  availableAt: null,
  limits: [],
};

const CLAUDE_ACCOUNT_WITH_USAGE = {
  ...ACCOUNT,
  limits: [{ id: 'weekly' as const, usedPercent: 40, resetsAt: null }],
  usage: {
    rateLimits: [
      {
        limitId: 'seven_day_opus',
        limitName: '7-day Opus',
        primary: {
          usedPercent: 52,
          resetsAt: '2026-10-20T18:00:00.000Z',
          windowDurationMins: 10_080,
        },
        credits: { usedUsd: 1.25, remainingUsd: 8.75, totalUsd: 10 },
      },
    ],
    source: 'live' as const,
    lastUpdatedAt: '2026-10-20T14:30:00.000Z',
  },
};

const CODEX_ACCOUNT_WITH_USAGE = {
  ...ACCOUNT,
  authIndex: 'b2f3c2d4b2f3c2d4',
  provider: 'codex',
  label: 'codex@example.com',
  fileName: 'codex-account.json',
  limits: [{ id: 'five-hour' as const, usedPercent: 64, resetsAt: null }],
  usage: {
    rateLimits: [
      {
        limitId: 'codex',
        limitName: 'Codex',
        primary: {
          usedPercent: 22,
          resetsAt: '2026-10-20T18:00:00.000Z',
          windowDurationMins: 300,
        },
        credits: { remainingUsd: 12_500 },
      },
    ],
    source: 'passive' as const,
    lastUpdatedAt: '2026-10-20T14:30:00.000Z',
    errorInfo: { kind: 'network' as const, detail: 'Bearer private-value' },
  },
};

const GEMINI_ACCOUNT_WITH_USAGE = {
  ...ACCOUNT,
  authIndex: 'c3f3c2d4c3f3c2d4',
  provider: 'gemini',
  label: 'gemini@example.com',
  fileName: 'gemini-account.json',
  limits: [{ id: 'weekly' as const, usedPercent: 40, resetsAt: null }],
  usage: {
    rateLimits: [
      {
        limitId: 'gemini',
        limitName: 'Gemini quota',
        primary: { usedPercent: 10 },
      },
    ],
    source: 'live' as const,
  },
};

function render(
  accounts: readonly AccountProxyAccount[] = [ACCOUNT],
  actionsDisabled = false,
): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <AccountProxyAccountList
      accounts={accounts}
      variant="row"
      actionsDisabled={actionsDisabled}
    />,
  );
  return host;
}

function descriptionText(row: Element | null): string {
  return (
    row
      ?.querySelector('[data-settings-row-label]')
      ?.parentElement?.querySelector('.text-pretty')?.textContent ?? ''
  );
}

describe('AccountProxyAccountList', () => {
  it('keeps account emails out of attributes, which session replay records', () => {
    const host = render();
    expect(
      host.querySelector(
        '[data-testid="account-proxy-account-menu-a1f3c2d4a1f3c2d4"]',
      ),
    ).not.toBeNull();
    for (const element of Array.from(host.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.value).not.toContain('sam@example.com');
      }
    }
    // The visible label is the only place the email appears, and it is
    // blocked from replay.
    const label = Array.from(host.querySelectorAll('span[id]')).find(
      (span) => span.textContent === 'sam@example.com',
    );
    expect(label?.className).toContain('ph-no-capture');
  });

  it('leads each account action with an icon and ends with Remove in its own group', () => {
    Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
      root.render(
        <AccountProxyAccountList accounts={[ACCOUNT]} variant="row" />,
      );
    });
    act(() => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="account-proxy-account-menu-a1f3c2d4a1f3c2d4"]',
        )
        ?.click();
    });
    const toggle = document.querySelector(
      '[data-testid="account-proxy-account-toggle"]',
    );
    const remove = document.querySelector(
      '[data-testid="account-proxy-account-remove"]',
    );
    expect(toggle?.firstElementChild?.querySelector('svg')).toBeInstanceOf(
      Element,
    );
    expect(remove?.firstElementChild?.querySelector('svg')).toBeInstanceOf(
      Element,
    );
    expect(remove?.previousElementSibling?.getAttribute('role')).toBe(
      'separator',
    );
    expect(remove?.nextElementSibling).toBeNull();
    act(() => root.unmount());
    host.remove();
  });

  it('offers no account actions while the server rejects the key', () => {
    const host = render([ACCOUNT], true);
    expect(
      host.querySelector(
        '[data-testid="account-proxy-account-menu-a1f3c2d4a1f3c2d4"]',
      ),
    ).toBeNull();
  });

  it('renders Claude and Codex usage details without duplicating legacy limits', () => {
    const host = render([
      CLAUDE_ACCOUNT_WITH_USAGE,
      CODEX_ACCOUNT_WITH_USAGE,
      GEMINI_ACCOUNT_WITH_USAGE,
    ]);
    const claude = host.querySelector(
      '[data-testid="account-proxy-account-a1f3c2d4a1f3c2d4"]',
    );
    const codex = host.querySelector(
      '[data-testid="account-proxy-account-b2f3c2d4b2f3c2d4"]',
    );
    const gemini = host.querySelector(
      '[data-testid="account-proxy-account-c3f3c2d4c3f3c2d4"]',
    );

    expect(claude?.textContent).toContain('7-day Opus');
    expect(claude?.textContent).toContain('52%');
    expect(claude?.textContent).toMatch(/Resets |Reset time has passed/);
    expect(claude?.textContent).toContain('$1.25 spent');
    expect(claude?.textContent).toContain('$8.75 left');
    expect(claude?.textContent).toContain('Updated ');
    expect(claude?.textContent).not.toContain('Weekly limit');
    expect(descriptionText(claude)).toBe('Claude');
    expect(claude?.querySelector('details')).not.toBeNull();
    expect(claude?.querySelector('details')?.hasAttribute('open')).toBe(false);
    expect(claude?.querySelector('summary')?.textContent).toBe('Usage');

    expect(codex?.textContent).toContain('5-hour window');
    expect(codex?.textContent).toContain('22%');
    expect(codex?.textContent).toContain(
      'Check your connection, then try reaching Codex again.',
    );
    expect(codex?.textContent).toContain('12,500 credits left');
    expect(codex?.textContent).not.toContain('Bearer private-value');
    expect(codex?.textContent).not.toContain('five-hour limit');
    expect(descriptionText(codex)).toBe('Codex');
    expect(codex?.querySelector('details')).not.toBeNull();
    expect(codex?.querySelector('details')?.hasAttribute('open')).toBe(false);

    expect(gemini?.textContent).toContain('Weekly limit 40%');
    expect(gemini?.textContent).not.toContain('Gemini quota');
    expect(descriptionText(gemini)).toBe('Gemini · Weekly limit 40%');
    expect(gemini?.querySelector('details')).toBeNull();
  });
});

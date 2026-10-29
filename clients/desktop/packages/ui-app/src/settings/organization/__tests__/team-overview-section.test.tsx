/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrganizationDetail } from '@canopy/protocol/settings';
import { TestSettingsHost } from '../../__tests__/helpers/test-settings-host';
import { TeamOverviewSection } from '../team-overview-section';

function makeDetail(
  overrides: Partial<OrganizationDetail> = {},
): OrganizationDetail {
  return {
    id: 'org-123',
    name: 'Acme',
    viewerRole: 'MEMBER',
    members: [
      {
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        image: null,
        role: 'OWNER',
        subTeamIds: [],
      },
    ],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: false,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
    ...overrides,
  };
}

describe('TeamOverviewSection count links', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(detail: OrganizationDetail): void {
    act(() => {
      root.render(
        <TestSettingsHost>
          <TeamOverviewSection detail={detail} onDetailChange={() => {}} />
        </TestSettingsHost>,
      );
    });
  }

  it('links the member count to the members route', () => {
    render(makeDetail());
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="team-overview-member-count"]',
    );
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/organization/org-123/members');
    expect(link?.textContent).toContain('1 member');
  });

  it('links the team count to the teams route even with zero teams', () => {
    render(makeDetail({ subTeams: [] }));
    const link = container.querySelector<HTMLAnchorElement>(
      '[data-testid="team-overview-group-count"]',
    );
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toBe('/organization/org-123/teams');
    expect(link?.textContent).toContain('0 teams');
  });
});

describe('TeamOverviewSection errors', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  async function render(): Promise<HTMLElement> {
    await act(async () => {
      root.render(
        <TestSettingsHost>
          <TeamOverviewSection
            detail={makeDetail({ viewerRole: 'OWNER' })}
            onDetailChange={() => {}}
          />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
    const header = container.querySelector<HTMLElement>(
      '[data-testid="team-overview-section"]',
    );
    if (header === null) throw new Error('No overview header');
    return header;
  }

  it('shows a failed rename below the block, never inside it', async () => {
    const header = await render();
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="team-name-edit"]')
        ?.click();
    });
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="team-name-input"]',
    );
    if (input === null) throw new Error('No name input');
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(input, 'Renamed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      input.form?.dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const banner = header.nextElementSibling;
    expect(banner).not.toBeNull();
    expect(banner?.textContent).not.toBe('');
    expect(header.contains(banner)).toBe(false);
  });

  it('shows a rejected logo below the block, not under the logo', async () => {
    const header = await render();
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="org-logo-input"]',
    );
    if (input === null) throw new Error('No logo input');
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const message = 'Choose a PNG, JPEG, or GIF image up to 5 MB.';
    expect(header.textContent).not.toContain(message);
    expect(header.querySelector('[role="alert"]')).toBeNull();
    expect(header.nextElementSibling?.textContent).toContain(message);
  });
});

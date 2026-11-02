/**
 * @jest-environment jsdom
 */
// The members list's look: team names are the shared Badge (a hand-made
// `bg-secondary` chip vanished on the `bg-secondary` group surface), and the
// rows are one grid so the role and action columns line up down the list
// (Remove and Leave take one width).

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrganizationDetail } from '@canopy/protocol/settings';
import {
  SETTINGS_GROUP_GRID_CLASS,
  SETTINGS_GROUP_GRID_ROW_CLASS,
} from '@canopy/ui-shared/components/settings/SettingsCard';
import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';
import { TeamMembersSection } from '../team-members-section';
import { OrganizationTestHost } from './helpers/members-section-harness';

function buildDetail(): OrganizationDetail {
  return {
    id: 'org-1',
    name: 'Acme',
    viewerRole: 'OWNER',
    members: [
      {
        id: 'member-1',
        name: 'Ada Lovelace',
        email: 'ada@example.com',
        role: 'MEMBER',
        image: null,
        subTeamIds: ['team-design'],
      },
      {
        id: 'member-2',
        name: 'Grace Hopper',
        email: 'grace@example.com',
        role: 'OWNER',
        image: null,
        subTeamIds: ['team-design', 'team-growth'],
      },
    ],
    subTeams: [
      { id: 'team-design', name: 'Design', memberCount: 2 },
      { id: 'team-growth', name: 'Growth', memberCount: 1 },
    ],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
  };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  const client = createFakeSettingsClient({
    'organization.invitations.list': () => ({ enabled: true, invites: [] }),
  });
  await act(async () => {
    root = createRoot(container);
    root.render(
      <OrganizationTestHost client={client}>
        <TeamMembersSection
          detail={buildDetail()}
          viewerEmail="grace@example.com"
          onDetailChange={jest.fn()}
          onLeft={jest.fn()}
          adding={false}
          onAddingChange={jest.fn()}
        />
      </OrganizationTestHost>,
    );
    await Promise.resolve();
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

function rows(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="team-member-row"]'),
  );
}

it('draws each team name as the shared neutral Badge', () => {
  const badges = rows().map((row) =>
    Array.from(row.querySelectorAll<HTMLElement>('[data-badge-tone]')).map(
      (badge) => [badge.textContent, badge.dataset.badgeTone],
    ),
  );
  expect(badges).toEqual([
    [['Design', 'neutral']],
    [
      ['Design', 'neutral'],
      ['Growth', 'neutral'],
    ],
  ]);
  // No hand-made chip on the group surface.
  expect(container.innerHTML).not.toContain('rounded-full bg-secondary px-2');
});

it('lays the rows out as subgrids of one list grid so Remove and Leave share a column', () => {
  const list = container.querySelector<HTMLElement>('ul[aria-label="Members"]');
  if (!list) throw new Error('Members list was not rendered');
  for (const token of SETTINGS_GROUP_GRID_CLASS.split(' '))
    expect(list.classList.contains(token)).toBe(true);
  expect(list.className).toContain('sm:grid-cols-[minmax(0,1fr)_auto_auto]');

  const [ada, grace] = rows();
  for (const row of [ada, grace])
    expect(row?.className).toBe(SETTINGS_GROUP_GRID_ROW_CLASS);

  // Each action is a direct grid item of its row's subgrid (through a
  // `sm:contents` wrapper), in the same trailing column.
  const remove = ada?.querySelector('[data-testid="team-member-remove"]');
  const leave = grace?.querySelector('[data-testid="team-leave"]');
  expect(remove).toBeInstanceOf(HTMLButtonElement);
  expect(leave).toBeInstanceOf(HTMLButtonElement);
  expect(remove?.parentElement?.className).toContain('sm:contents');
  expect(leave?.parentElement?.className).toContain('sm:contents');
  expect(remove?.previousElementSibling).toBe(
    remove?.parentElement?.firstElementChild,
  );
  expect(leave?.previousElementSibling).toBe(
    leave?.parentElement?.firstElementChild,
  );
});

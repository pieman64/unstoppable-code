/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  SidebarFeedMenuItem,
  SidebarInviteTeamMenuItem,
  SidebarStatisticsMenuItem,
  invitableOrganization,
} from '../AccountMenuActivityItem';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const ORG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PERSONAL: WorkspaceContext = { kind: 'personal' };
const ORGANIZATION: WorkspaceContext = {
  kind: 'organization',
  organizationId: ORG,
};

describe('invitableOrganization', () => {
  it.each([
    ['OWNER', true],
    ['ADMIN', true],
    ['MEMBER', false],
  ] as const)('returns the selected organization to an %s: %s', (role, ok) => {
    const acme = { id: ORG, name: 'Acme', role };
    expect(invitableOrganization(ORGANIZATION, [acme])).toBe(ok ? acme : null);
  });

  it('returns null in Personal and for an organization that is not listed', () => {
    const acme = { id: ORG, name: 'Acme', role: 'OWNER' } as const;
    expect(invitableOrganization(PERSONAL, [acme])).toBeNull();
    expect(invitableOrganization(ORGANIZATION, [])).toBeNull();
  });
});

describe('SidebarFeedMenuItem, SidebarStatisticsMenuItem and SidebarInviteTeamMenuItem', () => {
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

  it('opens the given Timeline path', () => {
    const onOpenPath = jest.fn<void, [string]>();
    act(() => {
      root.render(
        <div role="menu">
          <SidebarFeedMenuItem
            path={`/organization/${ORG}`}
            onOpenPath={onOpenPath}
          />
        </div>,
      );
    });
    const row = container.querySelector<HTMLElement>(
      '[data-testid="account-personal-activity-row"]',
    );
    expect(row?.textContent).toBe('Timeline');
    act(() => row?.click());
    expect(onOpenPath.mock.calls).toEqual([[`/organization/${ORG}`]]);
  });

  it('opens the given Statistics path', () => {
    const onOpenPath = jest.fn<void, [string]>();
    act(() => {
      root.render(
        <div role="menu">
          <SidebarStatisticsMenuItem
            path={`/organization/${ORG}/statistics`}
            onOpenPath={onOpenPath}
          />
        </div>,
      );
    });
    const row = container.querySelector<HTMLElement>(
      '[data-testid="account-context-statistics-row"]',
    );
    expect(row?.textContent).toBe('Statistics');
    act(() => row?.click());
    expect(onOpenPath.mock.calls).toEqual([
      [`/organization/${ORG}/statistics`],
    ]);
  });

  it.each([
    ['create-team', 'account-create-team-row'],
    ['invite', 'account-invite-team-row'],
  ] as const)(
    'reads Invite your team for %s and runs its action',
    (kind, testId) => {
      const onClick = jest.fn();
      act(() => {
        root.render(
          <div role="menu">
            <SidebarInviteTeamMenuItem kind={kind} onClick={onClick} />
          </div>,
        );
      });
      const row = container.querySelector<HTMLElement>(
        `[data-testid="${testId}"]`,
      );
      expect(row?.textContent).toBe('Invite your team');
      act(() => row?.click());
      expect(onClick).toHaveBeenCalledTimes(1);
    },
  );
});

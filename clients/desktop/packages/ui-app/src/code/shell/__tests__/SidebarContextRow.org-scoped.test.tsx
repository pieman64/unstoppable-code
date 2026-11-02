/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  WorkspaceContext,
  WorkspaceContextOrganization,
} from '@canopy/protocol/workspace-context';
import {
  SidebarContextRow,
  type SidebarContextOrgScopedActions,
  type SidebarContextRowProps,
} from '../SidebarContextRow';
import {
  resolveSidebarContextActions,
  sidebarContextSwitcherAvailable,
} from '../sidebar-context-actions';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const PERSONAL_ORG = '44444444-4444-4444-8444-444444444444';
const ACME = '11111111-1111-4111-8111-111111111111';

function memberships(
  role: WorkspaceContextOrganization['role'],
): WorkspaceContextOrganization[] {
  return [{ id: ACME, name: 'Acme', role }];
}

const CREATE_ORGANIZATION_PATH = '/organization?create=1';

const ACME_CONTEXT: WorkspaceContext = {
  kind: 'organization',
  organizationId: ACME,
};

describe('sidebarContextSwitcherAvailable', () => {
  it.each([
    [true, true, true],
    [true, false, false],
    [false, true, false],
    [false, false, false],
  ])(
    'flag on: %s, signed in: %s => %s',
    (orgProjectsEnabled, authenticated, expected) => {
      expect(
        sidebarContextSwitcherAvailable({ orgProjectsEnabled, authenticated }),
      ).toBe(expected);
    },
  );
});

describe('resolveSidebarContextActions (CAN-4057)', () => {
  it.each([{ kind: 'personal' } as const, ACME_CONTEXT])(
    'hides every action while unauthenticated, even with a stale membership: %p',
    (context) => {
      expect(
        resolveSidebarContextActions({
          context,
          organizations: memberships('OWNER'),
          personalOrganizationId: PERSONAL_ORG,
          freeAccess: true,
          authenticated: false,
        }),
      ).toEqual({
        feedPath: null,
        statisticsPath: null,
        invite: null,
        creditsOrganizationId: null,
        settingsPath: null,
        createOrganizationPath: null,
      });
    },
  );
  it('gives a provisioned Personal its Feed, Statistics, create-team and Create an organization, but no team-only settings', () => {
    expect(
      resolveSidebarContextActions({
        context: { kind: 'personal' },
        organizations: memberships('OWNER'),
        personalOrganizationId: PERSONAL_ORG,
        freeAccess: true,
      }),
    ).toEqual({
      feedPath: `/organization/${PERSONAL_ORG}`,
      statisticsPath: `/organization/${PERSONAL_ORG}/statistics`,
      invite: { kind: 'create-team', personalOrganizationId: PERSONAL_ORG },
      creditsOrganizationId: null,
      settingsPath: null,
      createOrganizationPath: CREATE_ORGANIZATION_PATH,
    });
  });

  it.each([null, 'not-a-uuid'])(
    'offers only Create an organization for personal organization %p',
    (personalOrganizationId) => {
      expect(
        resolveSidebarContextActions({
          context: { kind: 'personal' },
          organizations: memberships('OWNER'),
          personalOrganizationId,
          freeAccess: true,
        }),
      ).toEqual({
        feedPath: null,
        statisticsPath: null,
        invite: null,
        creditsOrganizationId: null,
        settingsPath: null,
        createOrganizationPath: CREATE_ORGANIZATION_PATH,
      });
    },
  );

  it.each([
    ['MEMBER', false, false, false, false],
    ['MEMBER', true, false, false, false],
    ['ADMIN', false, true, false, true],
    ['ADMIN', true, true, true, true],
    ['OWNER', false, true, false, true],
    ['OWNER', true, true, true, true],
  ] as const)(
    'for an %s (free access %p): invite %p, credits %p, statistics %p',
    (role, freeAccess, invite, credits, statistics) => {
      const actions = resolveSidebarContextActions({
        context: ACME_CONTEXT,
        organizations: memberships(role),
        personalOrganizationId: PERSONAL_ORG,
        freeAccess,
      });
      expect(actions.feedPath).toBe(`/organization/${ACME}`);
      expect(actions.statisticsPath).toBe(
        statistics ? `/organization/${ACME}/statistics` : null,
      );
      expect(actions.settingsPath).toBe(`/organization/${ACME}/settings`);
      expect(actions.invite?.kind ?? null).toBe(invite ? 'invite' : null);
      expect(actions.creditsOrganizationId).toBe(credits ? ACME : null);
      expect(actions.createOrganizationPath).toBe(CREATE_ORGANIZATION_PATH);
    },
  );

  it('never falls back to Personal for an organization that is not listed, but still offers Create an organization', () => {
    expect(
      resolveSidebarContextActions({
        context: ACME_CONTEXT,
        organizations: [],
        personalOrganizationId: PERSONAL_ORG,
        freeAccess: true,
      }),
    ).toEqual({
      feedPath: null,
      statisticsPath: null,
      invite: null,
      creditsOrganizationId: null,
      settingsPath: null,
      createOrganizationPath: CREATE_ORGANIZATION_PATH,
    });
  });
});

describe('SidebarContextRow organization actions (CAN-4057)', () => {
  let container: HTMLElement;
  let root: Root;
  let onSelect: jest.Mock;
  let onOpenPath: jest.Mock;
  let onCreateTeam: jest.Mock;
  let onInviteToTeam: jest.Mock;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect = jest.fn();
    onOpenPath = jest.fn();
    onCreateTeam = jest.fn();
    onInviteToTeam = jest.fn();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render({
    orgScoped,
    ...props
  }: Omit<Partial<SidebarContextRowProps>, 'orgScoped'> & {
    orgScoped?: Partial<SidebarContextOrgScopedActions>;
  } = {}): void {
    act(() => {
      root.render(
        <SidebarContextRow
          context={{ kind: 'personal' }}
          organizations={memberships('OWNER')}
          onSelect={onSelect}
          placement="top"
          {...props}
          orgScoped={{
            personalOrganizationId: PERSONAL_ORG,
            freeAccess: true,
            onOpenPath,
            onCreateTeam,
            onInviteToTeam,
            ...orgScoped,
          }}
        />,
      );
    });
  }

  function query(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }
  function trigger(): HTMLButtonElement {
    const element = query('sidebar-context-row');
    if (!(element instanceof HTMLButtonElement)) throw new Error('no trigger');
    return element;
  }
  function openMenu(): void {
    act(() => trigger().click());
  }
  /** The menu's rows and dividers in order, by test id or role. */
  function menuShape(): string[] {
    const menu = query('sidebar-context-menu');
    return Array.from(
      menu?.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemradio"], [role="separator"]',
      ) ?? [],
    ).map((element) =>
      element.getAttribute('role') === 'separator'
        ? '---'
        : (element.getAttribute('data-testid') ?? '?'),
    );
  }

  it('lists the contexts and Create an organization, then Feed, Statistics and invite for Personal', () => {
    render();
    openMenu();
    expect(menuShape()).toEqual([
      'sidebar-context-option-personal',
      `sidebar-context-option-${ACME}`,
      'sidebar-context-create-organization',
      '---',
      'account-personal-activity-row',
      'account-context-statistics-row',
      'account-create-team-row',
    ]);
  });

  it('gives the action rows the action-menu look and leaves the context choices as a picker', () => {
    render();
    openMenu();
    for (const testId of [
      'account-personal-activity-row',
      'account-create-team-row',
      'sidebar-context-create-organization',
    ]) {
      expect(query(testId)?.className).toContain('text-xs');
    }
    expect(query('sidebar-context-option-personal')?.className).toContain(
      'text-s',
    );
    expect(query('sidebar-context-option-personal')?.className).not.toContain(
      'text-xs',
    );
  });

  it('focuses the checked context row on open', () => {
    render();
    openMenu();
    expect(document.activeElement).toBe(
      query('sidebar-context-option-personal'),
    );
    act(() => trigger().click());
    render({ context: ACME_CONTEXT });
    openMenu();
    expect(document.activeElement).toBe(
      query(`sidebar-context-option-${ACME}`),
    );
  });

  it('offers Personal its actions, and no Organization settings, without organizations', () => {
    render({ organizations: [] });
    expect(trigger().textContent).toBe('Personal');
    openMenu();
    expect(menuShape()).toEqual([
      'sidebar-context-option-personal',
      'sidebar-context-create-organization',
      '---',
      'account-personal-activity-row',
      'account-context-statistics-row',
      'account-create-team-row',
    ]);
    expect(
      query('sidebar-context-option-personal')?.getAttribute('aria-checked'),
    ).toBe('true');
    expect(query('sidebar-context-organization-settings')).toBeNull();
  });

  it('shows only the contexts and Create an organization for an unprovisioned Personal', () => {
    render({ orgScoped: { personalOrganizationId: null } });
    openMenu();
    expect(menuShape()).toEqual([
      'sidebar-context-option-personal',
      `sidebar-context-option-${ACME}`,
      'sidebar-context-create-organization',
    ]);
  });

  it('shows no Create an organization while unauthenticated', () => {
    render({ orgScoped: { authenticated: false } });
    openMenu();
    expect(menuShape()).toEqual([
      'sidebar-context-option-personal',
      `sidebar-context-option-${ACME}`,
    ]);
  });

  it('renders Create an organization as an action and opens the create dialog path', () => {
    render();
    openMenu();
    const row = query('sidebar-context-create-organization');
    expect(row?.getAttribute('role')).toBe('menuitem');
    expect(row?.hasAttribute('aria-checked')).toBe(false);
    expect(row?.textContent).toBe('Create an organization');
    act(() => row?.click());
    expect(onOpenPath).toHaveBeenCalledWith(CREATE_ORGANIZATION_PATH);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it.each([
    [
      'MEMBER',
      [
        'account-personal-activity-row',
        'sidebar-context-organization-settings',
      ],
    ],
    [
      'ADMIN',
      [
        'account-personal-activity-row',
        'account-context-statistics-row',
        'account-invite-team-row',
        'sidebar-context-menu-item-ai-credits',
        'sidebar-context-organization-settings',
      ],
    ],
    [
      'OWNER',
      [
        'account-personal-activity-row',
        'account-context-statistics-row',
        'account-invite-team-row',
        'sidebar-context-menu-item-ai-credits',
        'sidebar-context-organization-settings',
      ],
    ],
  ] as const)('orders the actions for an %s', (role, actions) => {
    render({ context: ACME_CONTEXT, organizations: memberships(role) });
    openMenu();
    expect(menuShape()).toEqual([
      'sidebar-context-option-personal',
      `sidebar-context-option-${ACME}`,
      'sidebar-context-create-organization',
      '---',
      ...actions,
    ]);
  });

  it('hides the pool row for an OWNER without free access', () => {
    render({ context: ACME_CONTEXT, orgScoped: { freeAccess: false } });
    openMenu();
    expect(query('sidebar-context-menu-item-ai-credits')).toBeNull();
  });

  it('suppresses every action but Create an organization for an organization that is not listed', () => {
    render({ context: ACME_CONTEXT, organizations: [] });
    openMenu();
    expect(menuShape()).toEqual([
      'sidebar-context-option-personal',
      'sidebar-context-create-organization',
    ]);
    act(() => trigger().click());
    render({
      context: {
        kind: 'organization',
        organizationId: '99999999-9999-4999-8999-999999999999',
      },
    });
    openMenu();
    expect(menuShape()).toEqual([
      'sidebar-context-option-personal',
      `sidebar-context-option-${ACME}`,
      'sidebar-context-create-organization',
    ]);
  });

  it('leaves out a team row the host cannot open', () => {
    render({ orgScoped: { onCreateTeam: undefined } });
    openMenu();
    expect(query('account-create-team-row')).toBeNull();
    expect(query('account-personal-activity-row')).not.toBeNull();
  });

  it.each(['OWNER', 'ADMIN'] as const)(
    'closes the menu before each action for %s and targets the selected organization',
    (role) => {
      render({ context: ACME_CONTEXT, organizations: memberships(role) });
      for (const [testId, check] of [
        [
          'account-personal-activity-row',
          (): void =>
            expect(onOpenPath).toHaveBeenCalledWith(`/organization/${ACME}`),
        ],
        [
          'account-context-statistics-row',
          (): void =>
            expect(onOpenPath).toHaveBeenCalledWith(
              `/organization/${ACME}/statistics`,
            ),
        ],
        [
          'account-invite-team-row',
          (): void =>
            expect(onInviteToTeam).toHaveBeenCalledWith(memberships(role)[0]),
        ],
        [
          'sidebar-context-menu-item-ai-credits',
          (): void =>
            expect(onOpenPath).toHaveBeenCalledWith(
              `/organization/${ACME}/settings?tab=billing`,
            ),
        ],
        [
          'sidebar-context-organization-settings',
          (): void =>
            expect(onOpenPath).toHaveBeenCalledWith(
              `/organization/${ACME}/settings`,
            ),
        ],
      ] as const) {
        openMenu();
        act(() => query(testId)?.click());
        expect(trigger().getAttribute('aria-expanded')).toBe('false');
        check();
      }
      expect(onSelect).not.toHaveBeenCalled();
    },
  );

  it('opens Create a team from Personal', () => {
    render();
    openMenu();
    act(() => query('account-create-team-row')?.click());
    expect(onCreateTeam).toHaveBeenCalledTimes(1);
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('reads the pool each time the menu opens and shows only its balance', () => {
    const refresh = jest.fn();
    const credits = { organizationId: ACME, balanceCredits: 1250, refresh };
    render({ context: ACME_CONTEXT, orgScoped: { credits } });
    expect(refresh).not.toHaveBeenCalled();
    openMenu();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(
      query('sidebar-context-menu-item-ai-credits-balance')?.textContent,
    ).toBe('1.3K');
    act(() => trigger().click());
    openMenu();
    expect(refresh).toHaveBeenCalledTimes(2);

    // A balance keyed to another organization is never shown here.
    render({
      context: ACME_CONTEXT,
      orgScoped: {
        credits: { ...credits, organizationId: PERSONAL_ORG },
      },
    });
    expect(query('sidebar-context-menu-item-ai-credits')).not.toBeNull();
    expect(query('sidebar-context-menu-item-ai-credits-balance')).toBeNull();
  });

  it.each(['OWNER', 'ADMIN'] as const)(
    'shows %s a known zero and no number while unknown',
    (role) => {
      const refresh = jest.fn();
      render({
        context: ACME_CONTEXT,
        organizations: memberships(role),
        orgScoped: {
          credits: { organizationId: ACME, balanceCredits: 0, refresh },
        },
      });
      openMenu();
      expect(
        query('sidebar-context-menu-item-ai-credits-balance')?.textContent,
      ).toBe('0');
      render({
        context: ACME_CONTEXT,
        organizations: memberships(role),
        orgScoped: {
          credits: { organizationId: ACME, balanceCredits: null, refresh },
        },
      });
      expect(query('sidebar-context-menu-item-ai-credits')?.textContent).toBe(
        'AI Credits',
      );
      expect(query('sidebar-context-menu-item-ai-credits-balance')).toBeNull();
    },
  );

  it('keeps the row for OWNER to ADMIN, then removes it on demotion to MEMBER', () => {
    render({ context: ACME_CONTEXT });
    openMenu();
    expect(query('sidebar-context-menu-item-ai-credits')).not.toBeNull();
    render({ context: ACME_CONTEXT, organizations: memberships('ADMIN') });
    expect(query('sidebar-context-menu-item-ai-credits')).not.toBeNull();
    render({ context: ACME_CONTEXT, organizations: memberships('MEMBER') });
    expect(query('sidebar-context-menu-item-ai-credits')).toBeNull();
    expect(query('account-invite-team-row')).toBeNull();
  });

  it('uses the selected Admin organization independently of collection order and encodes its billing destination', () => {
    const id = 'team/with space';
    render({
      context: { kind: 'organization', organizationId: id },
      organizations: [
        ...memberships('OWNER'),
        { id, name: 'Team', role: 'ADMIN' },
      ],
    });
    openMenu();
    act(() => query('sidebar-context-menu-item-ai-credits')?.click());
    expect(onOpenPath).toHaveBeenCalledWith(
      '/organization/team%2Fwith%20space/settings?tab=billing',
    );
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  it('reports each open and close', () => {
    const onOpenChange = jest.fn();
    render({ onOpenChange });
    openMenu();
    act(() => trigger().click());
    expect(onOpenChange.mock.calls).toEqual([[true], [false]]);
  });
});

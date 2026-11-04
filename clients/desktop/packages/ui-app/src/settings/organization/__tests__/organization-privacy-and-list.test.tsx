/**
 * @jest-environment jsdom
 */
// Hosted organization surfaces on a host that records session replay: people
// (names, emails, avatars) and organization logos carry the host's block
// class, images render through the host's image component, and the
// Organizations list renders server-prefilled rows without reading again,
// under one header whose "New organization" action shows only for a loaded,
// non-empty list.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  IncomingTeamInvitation,
  OrganizationSummary,
} from '@canopy/protocol/settings';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import type { SettingsImageProps, SettingsUiHost } from '../../host';
import { MemberAvatar } from '../MemberAvatar';
import { OrganizationListPage } from '../OrganizationListPage';
import { OrganizationLogo } from '../OrganizationLogo';
import { TeamMembersSection } from '../team-members-section';
import { TeamPanel } from '../team-panel';
import {
  buildOrganizationDetail,
  OrganizationTestHost,
} from './helpers/members-section-harness';

const BLOCK = 'replay-block';
const PRIVACY = { blockClassName: BLOCK, maskClassName: 'replay-mask' };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  jest.clearAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

async function render(node: JSX.Element, host: SettingsUiHost): Promise<void> {
  await act(async () => {
    root.render(<TestSettingsHost host={host}>{node}</TestSettingsHost>);
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** A host image that reports load errors, like `next/image` and `<img>`. */
function hostWithErroringImage(): SettingsUiHost {
  const base = createTestSettingsHost({ privacy: PRIVACY }).host;
  function ErroringImage({
    src,
    alt,
    className,
    onError,
    'data-testid': testId,
  }: SettingsImageProps): JSX.Element {
    return (
      <img
        src={src}
        alt={alt}
        className={className}
        data-host-image="true"
        data-testid={testId}
        onError={onError}
      />
    );
  }
  return { ...base, Image: ErroringImage };
}

describe('avatars and logos', () => {
  // Avatars carry the shared replay block class themselves (inert on a host
  // without session replay), not the host's.
  it('renders a member image through the host image, blocked from replay', async () => {
    const host = hostWithErroringImage();
    await render(
      <MemberAvatar name="Grace Hopper" image="https://example.com/a.png" />,
      host,
    );
    const img = container.querySelector('img');
    expect(img?.getAttribute('data-host-image')).toBe('true');
    expect(img?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);

    // A failed load still falls back to the initials, still blocked.
    await act(async () => {
      img?.dispatchEvent(new Event('error', { bubbles: true }));
      await Promise.resolve();
    });
    const placeholder = container.querySelector('[role="img"]');
    expect(container.querySelector('img')).toBeNull();
    expect(placeholder?.textContent).toBe('GH');
    expect(placeholder?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
  });

  it('blocks an organization logo and its initials', async () => {
    const host = hostWithErroringImage();
    await render(
      <>
        <OrganizationLogo name="Acme" logoUrl="https://example.com/logo.png" />
        <OrganizationLogo name="Globex" logoUrl={null} />
      </>,
      host,
    );
    const logos = container.querySelectorAll('[data-testid="org-logo"]');
    expect(logos).toHaveLength(2);
    logos.forEach((logo) =>
      expect(logo.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true),
    );
    expect(
      container.querySelector('img')?.getAttribute('data-host-image'),
    ).toBe('true');
  });
});

describe('Members privacy', () => {
  it('blocks member names and emails', async () => {
    const client = createFakeSettingsClient({
      'organization.invitations.list': () => ({
        enabled: true,
        invites: [
          {
            id: 'invite-1',
            code: 'code-1',
            status: 'ACTIVE',
            organizationId: 'org-1',
            organizationTeamName: null,
            role: 'MEMBER',
            invitedEmail: 'new@example.com',
            seatPaymentState: 'READY',
          },
        ],
      }),
    });
    await act(async () => {
      root.render(
        <OrganizationTestHost client={client} host={{ privacy: PRIVACY }}>
          <TeamMembersSection
            detail={buildOrganizationDetail({
              members: [
                {
                  id: 'u-1',
                  name: 'Grace Hopper',
                  email: 'grace@example.com',
                  image: null,
                  role: 'OWNER',
                  subTeamIds: [],
                },
              ],
            })}
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
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const blocked = Array.from(container.querySelectorAll(`.${BLOCK}`)).map(
      (element) => element.textContent ?? '',
    );
    expect(blocked.some((text) => text.includes('Grace Hopper'))).toBe(true);
    expect(blocked.some((text) => text.includes('grace@example.com'))).toBe(
      true,
    );
    expect(blocked).toContain('new@example.com');
  });
});

describe('Organizations list', () => {
  const ORGANIZATIONS: OrganizationSummary[] = [
    {
      id: 'org-1',
      name: 'Acme',
      role: 'OWNER',
      memberCount: 2,
      subTeamCount: 1,
      logoUrl: null,
    },
  ];
  const INVITATIONS: IncomingTeamInvitation[] = [
    {
      id: 'invite-1',
      organizationName: 'Globex',
      organizationTeamName: null,
      role: 'MEMBER',
      invitedByName: 'Ada Lovelace',
      createdAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-11-01T00:00:00.000Z',
      enforcedSettings: [],
    },
  ];

  function host(
    client: FakeSettingsClient,
    push = jest.fn(),
    refresh = jest.fn(),
    selectOrganization = jest.fn(),
  ): SettingsUiHost {
    return createTestSettingsHost({
      client,
      privacy: PRIVACY,
      router: { push, refresh },
      selectOrganization,
    }).host;
  }

  async function clickAndSettle(selector: string): Promise<void> {
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>(selector)?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  it('renders prefilled memberships and invitations without reading on mount', async () => {
    const client = createFakeSettingsClient();
    const push = jest.fn();
    const selectOrganization = jest.fn();
    await render(
      <TeamPanel
        initialOrganizations={ORGANIZATIONS}
        initialInvitations={INVITATIONS}
        onCreate={jest.fn()}
      />,
      host(client, push, jest.fn(), selectOrganization),
    );

    expect(client.calls).toEqual([]);
    expect(
      container.querySelectorAll('[data-testid="team-panel-org"]'),
    ).toHaveLength(1);
    const inviter = Array.from(container.querySelectorAll(`.${BLOCK}`)).find(
      (element) => element.textContent?.includes('Ada Lovelace'),
    );
    expect(inviter).toBeDefined();

    expect(selectOrganization).not.toHaveBeenCalled();

    // Opening an organization shows its Feed and selects it in the app's
    // sidebar, so leaving settings lands in it.
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('[data-testid="team-panel-org"]')
        ?.click();
      await Promise.resolve();
    });
    expect(push).toHaveBeenCalledWith('/organization/org-1');
    expect(selectOrganization).toHaveBeenCalledTimes(1);
    expect(selectOrganization).toHaveBeenCalledWith('org-1');
  });

  // CAN-4553: accepting adds a membership, so the host's organization
  // switcher re-reads as well as this list. Declining changes only the list.
  it('accepts an invitation, refreshing the list and the host once', async () => {
    const accepted: OrganizationSummary = {
      id: 'org-2',
      name: 'Globex',
      role: 'MEMBER',
      memberCount: 4,
      subTeamCount: 0,
      logoUrl: null,
    };
    const client = createFakeSettingsClient({
      'organization.invitations.respond': () => ({ ok: true }),
      'organization.list': () => ({
        organizations: [...ORGANIZATIONS, accepted],
      }),
      'organization.invitations.incoming': () => ({ invitations: [] }),
    });
    const push = jest.fn();
    const refresh = jest.fn();
    const selectOrganization = jest.fn();
    await render(
      <TeamPanel
        initialOrganizations={ORGANIZATIONS}
        initialInvitations={INVITATIONS}
        onCreate={jest.fn()}
      />,
      host(client, push, refresh, selectOrganization),
    );

    await clickAndSettle('[data-testid="team-invitation-accept"]');

    expect(client.calls.map((call) => call.operation)).toEqual([
      'organization.invitations.respond',
      'organization.list',
      'organization.invitations.incoming',
    ]);
    expect(client.calls[0]?.input).toEqual({
      inviteId: 'invite-1',
      action: 'accept',
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    // Accepting stays on the list, and selects the joined organization in
    // the app's sidebar: the membership the refresh added.
    expect(push).not.toHaveBeenCalled();
    expect(selectOrganization).toHaveBeenCalledTimes(1);
    expect(selectOrganization).toHaveBeenCalledWith('org-2');
    expect(
      container.querySelectorAll('[data-testid="team-panel-org"]'),
    ).toHaveLength(2);
    expect(
      container.querySelector('[data-testid="team-invitations"]'),
    ).toBeNull();
  });

  // CAN-3672: the invitation's organization id outranks names, so a
  // concurrent same-named addition never gets selected instead.
  it('selects the invitation organization id among several new memberships', async () => {
    const summary = (id: string): OrganizationSummary => ({
      id,
      name: 'Globex',
      role: 'MEMBER',
      memberCount: 1,
      subTeamCount: 0,
      logoUrl: null,
    });
    const client = createFakeSettingsClient({
      'organization.invitations.respond': () => ({ ok: true }),
      'organization.list': () => ({
        organizations: [
          ...ORGANIZATIONS,
          summary('org-other'),
          summary('org-joined'),
        ],
      }),
      'organization.invitations.incoming': () => ({ invitations: [] }),
    });
    const selectOrganization = jest.fn();
    await render(
      <TeamPanel
        initialOrganizations={ORGANIZATIONS}
        initialInvitations={INVITATIONS.map((invite) => ({
          ...invite,
          organizationId: 'org-joined',
        }))}
        onCreate={jest.fn()}
      />,
      host(client, jest.fn(), jest.fn(), selectOrganization),
    );

    await clickAndSettle('[data-testid="team-invitation-accept"]');

    expect(selectOrganization).toHaveBeenCalledTimes(1);
    expect(selectOrganization).toHaveBeenCalledWith('org-joined');
  });

  it('selects nothing for an older invitation when two same-named memberships arrive', async () => {
    const summary = (id: string): OrganizationSummary => ({
      id,
      name: 'Globex',
      role: 'MEMBER',
      memberCount: 1,
      subTeamCount: 0,
      logoUrl: null,
    });
    const client = createFakeSettingsClient({
      'organization.invitations.respond': () => ({ ok: true }),
      'organization.list': () => ({
        organizations: [...ORGANIZATIONS, summary('org-a'), summary('org-b')],
      }),
      'organization.invitations.incoming': () => ({ invitations: [] }),
    });
    const selectOrganization = jest.fn();
    await render(
      <TeamPanel
        initialOrganizations={ORGANIZATIONS}
        initialInvitations={INVITATIONS}
        onCreate={jest.fn()}
      />,
      host(client, jest.fn(), jest.fn(), selectOrganization),
    );

    await clickAndSettle('[data-testid="team-invitation-accept"]');

    expect(selectOrganization).not.toHaveBeenCalled();
  });

  it('does not refresh the host when accepting is refused', async () => {
    const client = createFakeSettingsClient({
      'organization.invitations.respond': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 410,
          message: 'This invitation has expired.',
        });
      },
    });
    const refresh = jest.fn();
    const selectOrganization = jest.fn();
    await render(
      <TeamPanel
        initialOrganizations={ORGANIZATIONS}
        initialInvitations={INVITATIONS}
        onCreate={jest.fn()}
      />,
      host(client, jest.fn(), refresh, selectOrganization),
    );

    await clickAndSettle('[data-testid="team-invitation-accept"]');

    expect(refresh).not.toHaveBeenCalled();
    expect(selectOrganization).not.toHaveBeenCalled();
    // Local copy, never the server's text (CAN-4558).
    expect(container.textContent).toContain(
      "Couldn't accept the invitation. Try again.",
    );
    expect(container.textContent).not.toContain('This invitation has expired.');
  });

  it('declines an invitation only after confirming, then refreshes', async () => {
    const client = createFakeSettingsClient({
      'organization.invitations.respond': () => ({ ok: true }),
      'organization.list': () => ({ organizations: ORGANIZATIONS }),
      'organization.invitations.incoming': () => ({ invitations: [] }),
    });
    const refresh = jest.fn();
    const selectOrganization = jest.fn();
    await render(
      <TeamPanel
        initialOrganizations={ORGANIZATIONS}
        initialInvitations={INVITATIONS}
        onCreate={jest.fn()}
      />,
      host(client, jest.fn(), refresh, selectOrganization),
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="team-invitation-decline"]',
        )
        ?.click();
      await Promise.resolve();
    });
    expect(client.calls).toEqual([]);
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="confirm-dialog-confirm"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(client.calls.map((call) => call.operation)).toEqual([
      'organization.invitations.respond',
      'organization.list',
      'organization.invitations.incoming',
    ]);
    expect(client.calls[0]?.input).toEqual({
      inviteId: 'invite-1',
      action: 'decline',
    });
    expect(
      container.querySelector('[data-testid="team-invitations"]'),
    ).toBeNull();
    // Declining adds no membership, so the host neither re-reads nor selects.
    expect(refresh).not.toHaveBeenCalled();
    expect(selectOrganization).not.toHaveBeenCalled();
  });

  /** The Organizations page, prefilled when both lists are given. */
  function listPage(
    organizations?: OrganizationSummary[],
    invitations?: IncomingTeamInvitation[],
  ): JSX.Element {
    return (
      <OrganizationListPage
        route={{ scope: 'organizations' }}
        page={{
          kind: 'organization.list',
          data: { organizations, invitations },
        }}
      />
    );
  }

  function byTestId(testId: string): Element | null {
    return container.querySelector(`[data-testid="${testId}"]`);
  }

  it('renders one Organizations heading, from the shared page header', async () => {
    await render(
      listPage(ORGANIZATIONS, INVITATIONS),
      host(createFakeSettingsClient()),
    );

    const headings = Array.from(
      container.querySelectorAll('h1, h2, h3, h4, h5, h6'),
    ).filter((heading) => heading.textContent?.trim() === 'Organizations');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.tagName).toBe('H1');
    expect(headings[0]?.getAttribute('data-testid')).toBe('page-header-title');
    expect(byTestId('page-header-description')?.textContent).toBe(
      'Open an organization, answer an invitation, or start a new one.',
    );
    // The list body has no card chrome of its own.
    expect(byTestId('team-panel')?.className).not.toContain('bg-card');
  });

  it('shows New organization in the header for a loaded, non-empty list', async () => {
    const client = createFakeSettingsClient();
    const push = jest.fn();
    await render(listPage(ORGANIZATIONS, []), host(client, push));

    const create = byTestId('team-panel-create');
    expect(create?.closest('[data-testid="page-header-actions"]')).not.toBe(
      null,
    );
    expect(create?.textContent).toBe('New organization');
    expect(byTestId('team-panel-create-empty')).toBeNull();

    // It opens the page's create dialog.
    await act(async () => {
      if (create instanceof HTMLButtonElement) create.click();
      await Promise.resolve();
    });
    expect(
      document.body.querySelector('[data-testid="create-team-dialog"]'),
    ).not.toBeNull();
  });

  it('shows New organization only once a read list has loaded', async () => {
    // The list read stays pending until the test resolves it, so the
    // loading frame is asserted before the read can settle.
    let resolveList: (value: {
      organizations: OrganizationSummary[];
    }) => void = () => {};
    const listRead = new Promise<{ organizations: OrganizationSummary[] }>(
      (resolve) => {
        resolveList = resolve;
      },
    );
    const client = createFakeSettingsClient({
      'organization.list': () => listRead,
      'organization.invitations.incoming': () => ({ invitations: [] }),
    });
    await act(async () => {
      root.render(
        <TestSettingsHost host={host(client)}>{listPage()}</TestSettingsHost>,
      );
      await Promise.resolve();
    });
    // The panel issues its read from a timer its mount effect schedules.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Still loading: the reserved actions slot is empty.
    expect(client.calls.map((call) => call.operation)).toContain(
      'organization.list',
    );
    expect(byTestId('page-header-actions')).not.toBeNull();
    expect(byTestId('team-panel-create')).toBeNull();

    await act(async () => {
      resolveList({ organizations: ORGANIZATIONS });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(byTestId('team-panel-create')).not.toBeNull();
  });

  it('hides New organization when the list fails to load', async () => {
    const client = createFakeSettingsClient({
      'organization.invitations.incoming': () => ({ invitations: [] }),
    });
    await render(listPage(), host(client));

    expect(client.calls.map((call) => call.operation)).toContain(
      'organization.list',
    );
    expect(byTestId('team-panel-create')).toBeNull();
    expect(byTestId('team-panel-create-empty')).toBeNull();
  });

  it('with no organizations but pending invitations, lists the invitations above the one call to action', async () => {
    await render(listPage([], INVITATIONS), host(createFakeSettingsClient()));

    const invitations = byTestId('team-invitations');
    const empty = byTestId('team-panel-create-empty');
    expect(
      container.querySelectorAll('[data-testid="team-invitation-row"]'),
    ).toHaveLength(1);
    expect(empty).not.toBeNull();
    expect(byTestId('team-panel-create')).toBeNull();
    expect(
      container.querySelectorAll('[data-testid="team-panel-org"]'),
    ).toHaveLength(0);
    if (invitations === null || empty === null)
      throw new Error('Missing invitations or empty state');
    expect(
      invitations.compareDocumentPosition(empty) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

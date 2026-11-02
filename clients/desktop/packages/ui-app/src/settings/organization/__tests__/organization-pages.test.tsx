/**
 * @jest-environment jsdom
 */
// Each hosted organization page module renders what its web route renders:
// the organization page shell on the route's tab, fed from the page data,
// with page-owned one-shot flags read from the host's search params.

import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  OrganizationTeamPageData,
  SettingsRoute,
} from '@canopy/protocol/settings';
import {
  createTestSettingsHost,
  TestSettingsHost,
} from '../../__tests__/helpers/test-settings-host';
import type { TeamPageProps } from '../team-page';
import type { TeamPanelProps } from '../team-panel';
import type { MemberProfilePageProps } from '../profile/MemberProfilePage';

const mockTeamPage = jest.fn<null, [TeamPageProps]>(() => null);
const mockTeamPanel = jest.fn<null, [TeamPanelProps]>(() => null);
const mockMemberProfilePage = jest.fn<null, [MemberProfilePageProps]>(
  () => null,
);

jest.mock('../team-page', () => ({
  TeamPage: (props: TeamPageProps): null => mockTeamPage(props),
}));
jest.mock('../team-panel', () => ({
  TeamPanel: (props: TeamPanelProps): null => mockTeamPanel(props),
}));
const mockCreateTeamDialog = jest.fn<null, []>(() => null);
jest.mock('../create-team-dialog', () => ({
  CreateTeamDialog: (): null => mockCreateTeamDialog(),
}));
jest.mock('../profile/MemberProfilePage', () => ({
  MemberProfilePage: (props: MemberProfilePageProps): null =>
    mockMemberProfilePage(props),
}));

import { OrganizationDigestsPage } from '../../digests/OrganizationDigestsPage';
import { OrganizationDigestArchive } from '../../digests/OrganizationDigestArchive';
import { OrganizationFeedItemPage } from '../OrganizationFeedItemPage';
import { OrganizationFeedPage } from '../OrganizationFeedPage';
import { OrganizationGroupsPage } from '../OrganizationGroupsPage';
import { OrganizationListPage } from '../OrganizationListPage';
import { OrganizationMemberPage } from '../OrganizationMemberPage';
import { OrganizationMembersPage } from '../OrganizationMembersPage';
import { OrganizationProjectsPage } from '../OrganizationProjectsPage';
import { OrganizationSettingsPage } from '../OrganizationSettingsPage';
import { OrganizationStatisticsPage } from '../OrganizationStatisticsPage';
import { teamPagePropsFromData } from '../team-page-props';
import { buildOrganizationDetail } from './helpers/members-section-harness';

const DATA: OrganizationTeamPageData = {
  detail: buildOrganizationDetail(),
  organizations: [
    {
      id: 'org-1',
      name: 'Acme',
      role: 'OWNER',
      memberCount: 1,
      subTeamCount: 0,
      logoUrl: null,
    },
  ],
  viewerEmail: 'owner@example.com',
  billingEnabled: true,
  billingNeedsAttention: false,
  memoryEnabled: true,
  digestsEnabled: true,
  projectsEnabled: true,
  freeAccess: true,
  lapsed: {
    trialEndedAt: '2026-05-01T00:00:00.000Z',
    lapseReason: 'trial_ended',
    requiredPlanName: 'Business',
  },
  mobileBrowser: true,
};

const ORG_ROUTE: SettingsRoute = {
  scope: 'organization',
  organizationId: 'org-1',
  page: 'feed',
};

function render(node: ReactNode, search = ''): void {
  const { host } = createTestSettingsHost({ search });
  renderToStaticMarkup(<TestSettingsHost host={host}>{node}</TestSettingsHost>);
}

function lastTeamPageProps(): TeamPageProps {
  const props = mockTeamPage.mock.calls.at(-1)?.[0];
  if (props === undefined) throw new Error('TeamPage did not render');
  return props;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('teamPagePropsFromData', () => {
  it('maps every page-data field TeamPage takes', () => {
    expect(teamPagePropsFromData(DATA)).toEqual({
      initialDetail: DATA.detail,
      viewerEmail: 'owner@example.com',
      billingEnabled: true,
      memoryEnabled: true,
      projectsEnabled: true,
      freeAccess: true,
      lapsed: DATA.lapsed,
      mobileBrowser: true,
    });
  });
});

describe('organization page modules', () => {
  it.each([
    [
      'statistics',
      (): ReactNode => (
        <OrganizationStatisticsPage
          route={ORG_ROUTE}
          page={{ kind: 'organization.statistics', data: DATA }}
        />
      ),
    ],
    [
      'groups',
      (): ReactNode => (
        <OrganizationGroupsPage
          route={ORG_ROUTE}
          page={{ kind: 'organization.groups', data: DATA }}
        />
      ),
    ],
    [
      'projects',
      (): ReactNode => (
        <OrganizationProjectsPage
          route={ORG_ROUTE}
          page={{ kind: 'organization.projects', data: DATA }}
        />
      ),
    ],
    [
      'settings',
      (): ReactNode => (
        <OrganizationSettingsPage
          route={ORG_ROUTE}
          page={{ kind: 'organization.settings', data: DATA }}
        />
      ),
    ],
  ] as const)(
    'renders TeamPage on the %s tab from its page data',
    (tab, page) => {
      render(page());
      expect(lastTeamPageProps()).toEqual({
        ...teamPagePropsFromData(DATA),
        activeTab: tab,
      });
    },
  );

  it('passes the web-only External agents flag to the settings tab', () => {
    render(
      <OrganizationSettingsPage
        route={ORG_ROUTE}
        page={{
          kind: 'organization.settings',
          data: { ...DATA, externalAgentsEnabled: true },
        }}
      />,
    );
    expect(lastTeamPageProps()).toMatchObject({
      activeTab: 'settings',
      externalAgentsEnabled: true,
    });
  });

  it.each([
    ['', false],
    ['joined=1', true],
    ['joined=1&joined=0', true],
    ['joined=0', false],
  ])('renders the Feed with ?%s as justJoined=%s', (search, justJoined) => {
    render(
      <OrganizationFeedPage
        route={ORG_ROUTE}
        page={{ kind: 'organization.feed', data: DATA }}
      />,
      search,
    );
    expect(lastTeamPageProps()).toEqual({
      ...teamPagePropsFromData(DATA),
      activeTab: 'feed',
      justJoined,
    });
  });

  it('anchors a feed permalink on its item', () => {
    render(
      <OrganizationFeedItemPage
        route={ORG_ROUTE}
        page={{
          kind: 'organization.feedItem',
          data: { ...DATA, highlightItemId: 'item-9' },
        }}
      />,
    );
    expect(lastTeamPageProps()).toMatchObject({
      activeTab: 'feed',
      highlightItemId: 'item-9',
      initialDetail: DATA.detail,
    });
  });

  // `?invite=1` opens the invite dialog on arrival exactly as the web route
  // read it: one `invite` value equal to `1`.
  it.each([
    ['invite=1', true],
    ['', false],
    ['invite=0', false],
    ['invite=1&invite=1', false],
  ])('renders Members with ?%s as inviteOnLoad=%s', (search, inviteOnLoad) => {
    render(
      <OrganizationMembersPage
        route={ORG_ROUTE}
        page={{ kind: 'organization.members', data: DATA }}
      />,
      search,
    );
    expect(lastTeamPageProps()).toEqual({
      ...teamPagePropsFromData(DATA),
      activeTab: 'members',
      inviteOnLoad,
    });
  });

  it('renders Digests with the shared archive from its page data', () => {
    const archive = { digests: [], request: null };
    render(
      <OrganizationDigestsPage
        route={ORG_ROUTE}
        page={{ kind: 'organization.digests', data: { ...DATA, archive } }}
      />,
    );
    const props = lastTeamPageProps();
    expect(props.activeTab).toBe('digests');
    expect(props.initialDetail).toBe(DATA.detail);
    const content: unknown = props.digestContent;
    expect(
      isValidElement(content) && content.type === OrganizationDigestArchive,
    ).toBe(true);
    expect(isValidElement(content) ? content.props : null).toEqual({
      organizationId: 'org-1',
      archive,
    });
  });

  it('renders no Digests body while the organization is lapsed', () => {
    render(
      <OrganizationDigestsPage
        route={ORG_ROUTE}
        page={{
          kind: 'organization.digests',
          data: { ...DATA, archive: null },
        }}
      />,
    );
    expect(lastTeamPageProps().digestContent).toBeNull();
  });

  it('renders the member profile from its page data', () => {
    const data = {
      org: { id: 'org-1', name: 'Acme' },
      member: {
        id: 'user-2',
        name: 'Grace',
        email: 'grace@example.com',
        image: null,
        role: 'MEMBER' as const,
        memberSinceIso: '2026-01-01T00:00:00.000Z',
      },
      viewerCanViewStats: true,
      editContext: null,
      orgLapsed: false,
      orgTrialEndedAt: null,
      orgLapseReason: null,
      requiredPlanName: null,
      viewerCanEditOrg: true,
      showDigestsTab: true,
      isOwnProfile: false,
      mobileBrowser: false,
    };
    render(
      <OrganizationMemberPage
        route={ORG_ROUTE}
        page={{ kind: 'organization.member', data }}
      />,
    );
    expect(mockMemberProfilePage.mock.calls.at(-1)?.[0]).toEqual(data);
  });

  it('renders the Organizations list, reading through the table when not prefilled', () => {
    render(
      <OrganizationListPage
        route={{ scope: 'organizations' }}
        page={{ kind: 'organization.list', data: {} }}
      />,
    );
    const props = mockTeamPanel.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({
      initialOrganizations: undefined,
      initialInvitations: undefined,
    });
    // The page owns creation and the header action.
    expect(typeof props?.onCreate).toBe('function');
    expect(typeof props?.onStateChange).toBe('function');
  });

  // `?create=1` (the sidebar switcher's Create an organization, CAN-4554)
  // opens the create dialog only for one `create` value equal to `1`.
  it.each([
    ['create=1', true],
    ['', false],
    ['create=0', false],
    ['create=true', false],
    ['create=1&create=1', false],
  ])(
    'renders the Organizations list with ?%s opening create: %s',
    (search, createOnLoad) => {
      render(
        <OrganizationListPage
          route={{ scope: 'organizations' }}
          page={{ kind: 'organization.list', data: {} }}
        />,
        search,
      );
      // The page owns the create dialog, so the flag opens it here.
      expect(mockCreateTeamDialog.mock.calls.length > 0).toBe(createOnLoad);
    },
  );

  it('hands server-prefilled memberships and invitations to the list', () => {
    render(
      <OrganizationListPage
        route={{ scope: 'organizations' }}
        page={{
          kind: 'organization.list',
          data: { organizations: DATA.organizations, invitations: [] },
        }}
      />,
    );
    const props = mockTeamPanel.mock.calls.at(-1)?.[0];
    expect(props).toMatchObject({
      initialOrganizations: DATA.organizations,
      initialInvitations: [],
    });
    // The page owns creation and the header action.
    expect(typeof props?.onCreate).toBe('function');
    expect(typeof props?.onStateChange).toBe('function');
  });
});

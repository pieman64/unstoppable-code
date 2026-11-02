/**
 * @jest-environment jsdom
 */
import { renderToString } from 'react-dom/server';
import type { ComponentProps, JSX, ReactNode } from 'react';
import type { OrganizationDetail } from '@canopy/protocol/settings';
import { createFakeSettingsClient } from '../../__tests__/helpers/test-settings-host';
import {
  OrganizationTestHost,
  seatChargeSlot,
} from './helpers/members-section-harness';

import { TeamPage } from '../team-page';

const client = createFakeSettingsClient();
const webSlots = {
  seatCharge: seatChargeSlot(() => new Promise<never>(() => {})),
};

/**
 * The web host: with the seat-charge slot the Members invite stays inline,
 * as it is on the web.
 */
function WebOrganizationHost({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <OrganizationTestHost client={client} slots={webSlots}>
      {children}
    </OrganizationTestHost>
  );
}

type TeamPageProps = ComponentProps<typeof TeamPage>;

function buildDetail(
  overrides: Partial<OrganizationDetail> = {},
): OrganizationDetail {
  return {
    id: 'org-1',
    name: 'Acme',
    viewerRole: 'MEMBER',
    members: [],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: false,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
    ...overrides,
  };
}

function renderShell(overrides: Partial<TeamPageProps> = {}): HTMLElement {
  const props: TeamPageProps = {
    initialDetail: buildDetail(),
    viewerEmail: 'member@example.com',
    billingEnabled: false,
    memoryEnabled: false,
    projectsEnabled: false,
    mobileBrowser: false,
    activeTab: 'feed',
    ...overrides,
  };
  const container = document.createElement('div');
  container.innerHTML = renderToString(
    <WebOrganizationHost>
      <TeamPage {...props} />
    </WebOrganizationHost>,
  );
  return container;
}

describe('TeamPage joined notice', () => {
  it('names the organization the viewer just joined', () => {
    const notice = renderShell({
      justJoined: true,
      initialDetail: buildDetail({ name: 'Globex' }),
    }).querySelector('[data-testid="team-joined-notice"]');

    expect(notice).not.toBeNull();
    expect(notice?.textContent).toBe("You've joined Globex.");
    // Announced, not just decorative -- the join is the whole point of the
    // navigation that landed the viewer here.
    expect(notice?.getAttribute('role')).toBe('status');
  });

  it('is absent on an ordinary visit', () => {
    expect(
      renderShell().querySelector('[data-testid="team-joined-notice"]'),
    ).toBeNull();
  });

  it('is absent when justJoined is explicitly false', () => {
    expect(
      renderShell({ justJoined: false }).querySelector(
        '[data-testid="team-joined-notice"]',
      ),
    ).toBeNull();
  });

  it('uses a ring rather than an inert border for its outline (CAN-2734)', () => {
    const notice = renderShell({ justJoined: true }).querySelector(
      '[data-testid="team-joined-notice"]',
    );

    const className = notice?.getAttribute('class') ?? '';
    expect(className).toContain('ring-1');
    // `border-*` colors are overridden by an unlayered global rule, so a
    // border here would silently paint the neutral line color instead.
    expect(className).not.toMatch(/(^|\s)border/);
  });
});

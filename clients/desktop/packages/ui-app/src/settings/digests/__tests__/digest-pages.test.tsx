/** @jest-environment jsdom */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// The lapsed panel is the organization area's component; these tests only
// assert what the digest page hands it.
jest.mock('../../organization/team-lapsed-state', () => ({
  TeamLapsedState: (props: {
    orgId: string;
    orgName: string;
    lapseReason: string | null;
    canEdit: boolean;
  }): JSX.Element => (
    <div
      data-testid="team-lapsed-state"
      data-org-id={props.orgId}
      data-org-name={props.orgName}
      data-lapse-reason={props.lapseReason ?? 'none'}
      data-can-edit={String(props.canEdit)}
    />
  ),
}));

import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { DigestArchiveItem } from '@canopy/protocol/settings';
import { AccountDigestPage } from '../AccountDigestPage';
import { AccountDigestsPage } from '../AccountDigestsPage';
import { OrganizationDigestArchive } from '../OrganizationDigestArchive';
import { OrganizationDigestPage } from '../OrganizationDigestPage';
import { OrganizationMemberDigestPage } from '../OrganizationMemberDigestPage';
import {
  TestSettingsHost,
  createFakeSettingsClient,
  createTestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';

const PR_URL = 'https://github.com/unstoppabledomains/canopy/pull/2388';
const PRIVACY = {
  blockClassName: 'replay-block',
  maskClassName: 'replay-mask',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
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

async function renderInHost(
  node: ReactNode,
  client: FakeSettingsClient = createFakeSettingsClient(),
): Promise<void> {
  const { host } = createTestSettingsHost({
    client,
    privacy: PRIVACY,
    brand: { id: 'acme', displayName: 'Acme Brand', internalName: 'acme' },
  });
  await act(async () => {
    root.render(<TestSettingsHost host={host}>{node}</TestSettingsHost>);
    await Promise.resolve();
  });
}

function byTestId(id: string): HTMLElement | null {
  const node = container.querySelector(`[data-testid="${id}"]`);
  return node instanceof HTMLElement ? node : null;
}

function hrefs(): string[] {
  return Array.from(container.querySelectorAll('a')).map(
    (anchor) => anchor.getAttribute('href') ?? '',
  );
}

function archiveRow(
  overrides: Partial<DigestArchiveItem> = {},
): DigestArchiveItem {
  return {
    externalId: 'digest-1',
    cadence: 'WEEKLY',
    periodStart: '2026-06-08T00:00:00.000Z',
    periodEnd: '2026-06-15T00:00:00.000Z',
    headline: 'Shipped the thing',
    variant: 'FULL',
    status: 'READY',
    billedCredits: null,
    createdAt: '2026-06-15T00:00:00.000Z',
    ...overrides,
  };
}

const CREDITS = {
  spendable: true,
  balanceCredits: 4,
  fundingKey: 4,
  fundingLabel: null,
};

const REPORT = {
  externalId: 'digest-2',
  subjectType: 'ORGANIZATION',
  cadence: 'WEEKLY',
  periodStart: '2026-08-14T00:00:00.000Z',
  periodEnd: '2026-08-21T00:00:00.000Z',
  headline: 'A productive week',
  executiveSummaryMarkdown: 'Summary.',
  bodyMarkdown: `See [canopy#2388](${PR_URL}).`,
  metrics: {
    contributors: [
      {
        userExternalId: 'user-1',
        userName: 'Ada Lovelace',
        turnCount: 10,
        totalCostUsd: 1,
        impactScore: 5,
      },
    ],
  },
  variant: 'FULL',
};

describe('AccountDigestsPage', () => {
  function page(
    billing:
      | { status: 'ok'; billing: typeof CREDITS }
      | { status: 'unavailable' },
    digests: DigestArchiveItem[] = [archiveRow()],
  ): Parameters<typeof AccountDigestsPage>[0] {
    return {
      route: { scope: 'account', page: 'digests' },
      page: { kind: 'account.digests', data: { digests, billing } },
    };
  }

  it('renders the request form, the archive and its links', async () => {
    await renderInHost(
      <AccountDigestsPage {...page({ status: 'ok', billing: CREDITS })} />,
    );

    expect(byTestId('account-digests-page')).not.toBeNull();
    expect(byTestId('account-digest-request')).not.toBeNull();
    expect(byTestId('account-digest-archive-heading')?.textContent).toBe(
      'Past digests',
    );
    expect(byTestId('digest-list-item-digest-1')?.getAttribute('href')).toBe(
      '/account/digests/digest-1',
    );
    // Nothing in flight, so nothing polls.
    expect(byTestId('digest-refresh-now')).toBeNull();
  });

  it('requests through the account operation', async () => {
    const client = createFakeSettingsClient({
      'account.digests.request': () => ({
        status: 'enqueued',
        digestExternalId: 'd-9',
      }),
    });
    await renderInHost(
      <AccountDigestsPage {...page({ status: 'ok', billing: CREDITS })} />,
      client,
    );

    const setValue = (testId: string, value: string): void => {
      const node = byTestId(testId);
      if (!(node instanceof HTMLInputElement)) throw new Error(testId);
      const descriptor = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      );
      descriptor?.set?.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    };
    await act(async () => {
      setValue('account-digest-request-start', '2026-06-01');
      await Promise.resolve();
    });
    await act(async () => {
      setValue('account-digest-request-end', '2026-06-02');
      await Promise.resolve();
    });
    await act(async () => {
      container
        .querySelector('form')
        ?.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true }),
        );
      await Promise.resolve();
    });

    expect(client.calls.map((call) => call.operation)).toEqual([
      'account.digests.request',
    ]);
  });

  it('stands in the unavailable notice and keeps the archive when billing failed', async () => {
    await renderInHost(
      <AccountDigestsPage {...page({ status: 'unavailable' })} />,
    );

    expect(byTestId('account-digest-request')).toBeNull();
    expect(byTestId('account-digest-request-unavailable')).not.toBeNull();
    expect(byTestId('digest-list')).not.toBeNull();
  });

  it('names the brand in the empty archive message', async () => {
    await renderInHost(
      <AccountDigestsPage {...page({ status: 'unavailable' }, [])} />,
    );

    expect(container.textContent).toContain(
      'No digests yet. Once a period with Acme Brand activity closes, your digest will appear here.',
    );
  });

  it('auto-refreshes while a requested digest is still generating', async () => {
    await renderInHost(
      <AccountDigestsPage
        {...page({ status: 'ok', billing: CREDITS }, [
          archiveRow({ status: 'GENERATING', cadence: 'ON_DEMAND' }),
        ])}
      />,
    );

    expect(byTestId('digest-refresh-now')).not.toBeNull();
  });
});

describe('AccountDigestPage', () => {
  function page(
    sharePath: string | undefined,
  ): Parameters<typeof AccountDigestPage>[0] {
    return {
      route: { scope: 'account', page: 'digests', digestId: 'digest-2' },
      page: {
        kind: 'account.digest',
        data: {
          digest: {
            ...REPORT,
            subjectType: 'USER',
            sharingEnabled: true,
            ...(sharePath === undefined ? {} : { sharePath }),
          },
          audiences: [],
          neighbors: { olderDigestId: 'digest-1', newerDigestId: null },
        },
      },
    };
  }

  it('renders the share trigger, the interactive report and navigation', async () => {
    await renderInHost(<AccountDigestPage {...page('/share/digests/slug')} />);

    expect(byTestId('digest-share-trigger')).not.toBeNull();
    expect(hrefs()).toEqual(
      expect.arrayContaining([
        '/account/digests',
        PR_URL,
        '/account/digests/digest-1',
        '/account/notifications',
      ]),
    );
    // No newer neighbor renders as plain text, not a link.
    expect(byTestId('digest-detail-navigation')?.textContent).toContain(
      'Newer →',
    );
    expect(hrefs().filter((href) => href.includes('digest-3'))).toEqual([]);
  });

  it('omits the share trigger when the share link was withheld', async () => {
    await renderInHost(<AccountDigestPage {...page(undefined)} />);

    expect(byTestId('digest-share-trigger')).toBeNull();
  });

  it('blocks the report body from session replay', async () => {
    await renderInHost(<AccountDigestPage {...page('/share/digests/slug')} />);

    expect(
      byTestId('digest-report-headline')?.classList.contains('replay-block'),
    ).toBe(true);
  });
});

describe('OrganizationDigestPage', () => {
  function page(options: {
    canEdit: boolean;
    lapsed?: boolean;
    share?: { sharePath: string; sharingEnabled: boolean } | null;
  }): Parameters<typeof OrganizationDigestPage>[0] {
    const lapsed = options.lapsed === true;
    return {
      route: {
        scope: 'organization',
        organizationId: 'org-1',
        page: 'digests',
        digestId: 'digest-2',
      },
      page: {
        kind: 'organization.digest',
        data: {
          organization: { id: 'org-1', name: 'Acme', viewerRole: 'OWNER' },
          canEdit: options.canEdit,
          lapsed: lapsed
            ? {
                trialEndedAt: null,
                lapseReason: 'trial_ended',
                requiredPlanName: null,
              }
            : null,
          report: lapsed
            ? null
            : {
                digest: REPORT,
                neighbors: { olderId: null, newerId: 'digest-3' },
                share: options.share ?? null,
              },
        },
      },
    };
  }

  it.each([false, true])(
    'sits in the shared settings column (lapsed: %s)',
    async (lapsed) => {
      await renderInHost(
        <OrganizationDigestPage {...page({ canEdit: true, lapsed })} />,
      );
      expectSharedColumn();
    },
  );

  it('renders the lapsed panel and no report while the org is lapsed', async () => {
    await renderInHost(
      <OrganizationDigestPage {...page({ canEdit: true, lapsed: true })} />,
    );

    const lapsed = byTestId('team-lapsed-state');
    expect(lapsed?.dataset.orgId).toBe('org-1');
    expect(lapsed?.dataset.orgName).toBe('Acme');
    expect(lapsed?.dataset.lapseReason).toBe('trial_ended');
    expect(lapsed?.dataset.canEdit).toBe('true');
    expect(byTestId('digest-report')).toBeNull();
  });

  it('gives editors the share trigger and the cadence settings link', async () => {
    await renderInHost(
      <OrganizationDigestPage
        {...page({
          canEdit: true,
          share: { sharePath: '/share/digests/slug', sharingEnabled: false },
        })}
      />,
    );

    expect(byTestId('digest-share-trigger')).not.toBeNull();
    expect(hrefs()).toEqual(
      expect.arrayContaining([
        '/organization/org-1/digests',
        '/organization/org-1/digests/digest-3',
        '/organization/org-1/settings',
        // Interactive report: member names link to their profiles.
        '/organization/org-1/members/user-1',
      ]),
    );
  });

  it('shows a member no share trigger and no settings link', async () => {
    await renderInHost(
      <OrganizationDigestPage {...page({ canEdit: false })} />,
    );

    expect(byTestId('digest-share-trigger')).toBeNull();
    expect(hrefs()).not.toContain('/organization/org-1/settings');
  });

  it('shares through the organization operation', async () => {
    const client = createFakeSettingsClient({
      'organization.digests.sharing.update': () => ({
        sharingEnabled: true,
        sharePath: '/share/digests/slug',
      }),
    });
    await renderInHost(
      <OrganizationDigestPage
        {...page({
          canEdit: true,
          share: { sharePath: '/share/digests/slug', sharingEnabled: false },
        })}
      />,
      client,
    );

    await act(async () => {
      byTestId('digest-share-trigger')?.click();
      await Promise.resolve();
    });
    const toggle = document.body.querySelector(
      '[data-testid="digest-sharing-toggle"]',
    );
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('no toggle');
    await act(async () => {
      toggle.click();
      await Promise.resolve();
    });

    expect(client.calls).toEqual([
      {
        operation: 'organization.digests.sharing.update',
        input: {
          organizationId: 'org-1',
          digestId: 'digest-2',
          action: 'set-sharing',
          sharingEnabled: true,
        },
      },
    ]);
  });

  it('blocks member names from session replay', async () => {
    await renderInHost(
      <OrganizationDigestPage {...page({ canEdit: false })} />,
    );

    const row = container.querySelector(
      '[data-testid="digest-contributor-row"]',
    );
    expect(row?.querySelector('.replay-block')?.textContent).toBe(
      'Ada Lovelace',
    );
  });
});

/**
 * The drill-down sits in the shared settings column, as its outermost
 * element, with the report at reading width inside it.
 */
function expectSharedColumn(): void {
  const column = byTestId('settings-page-column');
  expect(column).not.toBeNull();
  expect(container.firstElementChild).toBe(column);
  expect(column?.className).toContain('max-w-5xl');
  expect(column?.firstElementChild?.className).toContain('max-w-3xl');
}

describe('OrganizationMemberDigestPage', () => {
  const props: Parameters<typeof OrganizationMemberDigestPage>[0] = {
    route: {
      scope: 'organization',
      organizationId: 'org-1',
      page: 'members',
      userId: 'user-1',
      digestId: 'digest-2',
    },
    page: {
      kind: 'organization.memberDigest',
      data: {
        org: { id: 'org-1', name: 'Acme' },
        member: { id: 'user-1', name: 'Ada Lovelace' },
        digest: { ...REPORT, subjectType: 'USER' },
        neighbors: { olderId: 'digest-1', newerId: null },
      },
    },
  };

  it('sits in the shared settings column', async () => {
    await renderInHost(<OrganizationMemberDigestPage {...props} />);
    expectSharedColumn();
  });

  it('links back to the profile digests tab and walks featured neighbors', async () => {
    await renderInHost(<OrganizationMemberDigestPage {...props} />);

    const back = byTestId('featured-digest-back');
    expect(back?.getAttribute('href')).toBe(
      '/organization/org-1/members/user-1?tab=digests',
    );
    expect(back?.textContent).toBe('← Back to Ada Lovelace’s digests');
    expect(back?.querySelector('.replay-block')?.textContent).toBe(
      'Ada Lovelace',
    );
    expect(hrefs()).toContain(
      '/organization/org-1/members/user-1/digests/digest-1',
    );
  });

  it('renders the featured report inert, with no cadence settings', async () => {
    await renderInHost(<OrganizationMemberDigestPage {...props} />);

    expect(hrefs()).not.toContain(PR_URL);
    expect(byTestId('digest-detail-navigation')?.textContent).not.toContain(
      'Digest cadence settings',
    );
    expect(byTestId('digest-share-trigger')).toBeNull();
  });
});

describe('OrganizationDigestArchive', () => {
  it('renders nothing while the org is lapsed', async () => {
    await renderInHost(
      <OrganizationDigestArchive organizationId="org-1" archive={null} />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('renders the archive without a form for a member', async () => {
    await renderInHost(
      <OrganizationDigestArchive
        organizationId="org-1"
        archive={{ digests: [archiveRow()], request: null }}
      />,
    );

    expect(byTestId('org-digests-page')).not.toBeNull();
    expect(byTestId('team-digest-request')).toBeNull();
    expect(byTestId('team-digest-request-unavailable')).toBeNull();
    expect(byTestId('org-digest-archive-heading')?.textContent).toBe(
      'Past digests',
    );
    expect(byTestId('digest-list-item-digest-1')?.getAttribute('href')).toBe(
      '/organization/org-1/digests/digest-1',
    );
  });

  it('shows the unavailable notice when the billing read failed', async () => {
    await renderInHost(
      <OrganizationDigestArchive
        organizationId="org-1"
        archive={{ digests: [], request: { status: 'unavailable' } }}
      />,
    );

    expect(byTestId('team-digest-request-unavailable')).not.toBeNull();
    expect(container.textContent).toContain(
      'No digests yet. Once a period with shared organization activity closes, the digest will appear here.',
    );
  });

  it('mounts the request form for an editor and auto-refreshes pending work', async () => {
    await renderInHost(
      <OrganizationDigestArchive
        organizationId="org-1"
        archive={{
          digests: [archiveRow({ status: 'PENDING', cadence: 'ON_DEMAND' })],
          request: { status: 'ok', credits: CREDITS },
        }}
      />,
    );

    expect(byTestId('team-digest-request')).not.toBeNull();
    expect(byTestId('digest-refresh-now')).not.toBeNull();
  });
});

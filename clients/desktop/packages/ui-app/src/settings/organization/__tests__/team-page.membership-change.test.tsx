/**
 * @jest-environment jsdom
 */
// CAN-4553: leaving or deleting an organization removes the membership, so
// after the write succeeds the page lands on the organization index and then
// refreshes the host, whose workspace organization switcher re-reads. A
// refused write neither navigates nor refreshes, and a refresh failure after
// a confirmed write is not reported as a failed write.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';
import type { SettingsLogger, SettingsRouter } from '../../host';
import { useMembershipChangeFollowUp } from '../membership-change';
import { TeamPage, type TeamPageProps } from '../team-page';
import {
  buildOrganizationDetail,
  OrganizationTestHost,
} from './helpers/members-section-harness';

let container: HTMLDivElement;
let root: Root;
let client: FakeSettingsClient;
let routerCalls: string[];
let router: Partial<SettingsRouter>;

function makeClient(
  handlers: Partial<Record<string, FakeSettingsHandler>> = {},
): FakeSettingsClient {
  return createFakeSettingsClient({
    'organization.invitations.list': () => ({ enabled: true, invites: [] }),
    ...handlers,
  });
}

beforeEach(() => {
  routerCalls = [];
  router = {
    push: (href): void => {
      routerCalls.push(`push ${href}`);
    },
    refresh: (): void => {
      routerCalls.push('refresh');
    },
  };
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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function click(testId: string): Promise<void> {
  const el = document.body.querySelector<HTMLElement>(
    `[data-testid="${testId}"]`,
  );
  if (el === null) throw new Error(`Missing [data-testid="${testId}"]`);
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await flush();
}

async function renderPage(overrides: Partial<TeamPageProps>): Promise<void> {
  const props: TeamPageProps = {
    initialDetail: buildOrganizationDetail(),
    organizations: [],
    viewerEmail: 'viewer@example.com',
    billingEnabled: false,
    memoryEnabled: false,
    projectsEnabled: false,
    billingNeedsAttention: false,
    mobileBrowser: false,
    activeTab: 'members',
    ...overrides,
  };
  await act(async () => {
    root.render(
      <OrganizationTestHost client={client} host={{ router }}>
        <TeamPage {...props} />
      </OrganizationTestHost>,
    );
    await Promise.resolve();
  });
  await flush();
}

const MEMBER_DETAIL = buildOrganizationDetail({
  viewerRole: 'MEMBER',
  members: [
    {
      id: 'u-viewer',
      name: 'Viewer',
      email: 'viewer@example.com',
      image: null,
      role: 'MEMBER',
      subTeamIds: [],
    },
  ],
});

describe('leaving an organization', () => {
  it('lands on the index, then refreshes the host once', async () => {
    client = makeClient({ 'organization.leave': () => ({ ok: true }) });
    await renderPage({ initialDetail: MEMBER_DETAIL });

    await click('team-leave');
    await click('confirm-dialog-confirm');

    expect(
      client.calls.find((call) => call.operation === 'organization.leave')
        ?.input,
    ).toEqual({ organizationId: MEMBER_DETAIL.id });
    expect(routerCalls).toEqual(['push /organization', 'refresh']);
  });

  it('neither navigates nor refreshes when the leave is refused', async () => {
    client = makeClient({
      'organization.leave': () => {
        throw new SettingsOperationError({
          code: 'failed',
          status: 409,
          message: 'The last owner cannot leave.',
        });
      },
    });
    await renderPage({ initialDetail: MEMBER_DETAIL });

    await click('team-leave');
    await click('confirm-dialog-confirm');

    expect(routerCalls).toEqual([]);
    // Local copy, never the server's text (CAN-4558).
    expect(container.textContent).toContain(
      'An organization needs at least one owner. Make someone else an owner first.',
    );
    expect(container.textContent).not.toContain('The last owner cannot leave.');
  });
});

describe('deleting an organization', () => {
  it('lands on the index, then refreshes the host once', async () => {
    client = makeClient({ 'organization.delete': () => undefined });
    await renderPage({ activeTab: 'settings' });

    await click('team-delete');
    await click('team-delete-confirm');

    expect(
      client.calls.some((call) => call.operation === 'organization.delete'),
    ).toBe(true);
    expect(routerCalls).toEqual(['push /organization', 'refresh']);
  });

  it('neither navigates nor refreshes when the delete is refused', async () => {
    client = makeClient({
      'organization.delete': () => {
        throw new SettingsOperationError({ code: 'failed', status: 409 });
      },
    });
    await renderPage({ activeTab: 'settings' });

    await click('team-delete');
    await click('team-delete-confirm');

    expect(routerCalls).toEqual([]);
  });
});

describe('useMembershipChangeFollowUp', () => {
  function Probe({ destination }: { destination?: string }): JSX.Element {
    const follow = useMembershipChangeFollowUp();
    return (
      <button data-testid="probe" onClick={() => follow(destination)}>
        follow
      </button>
    );
  }

  async function renderProbe(
    destination: string | undefined,
    logger: SettingsLogger,
  ): Promise<void> {
    const host = { ...createTestSettingsHost({ router }).host };
    host.logger = (): SettingsLogger => logger;
    await act(async () => {
      root.render(
        <TestSettingsHost host={host}>
          <Probe destination={destination} />
        </TestSettingsHost>,
      );
      await Promise.resolve();
    });
  }

  const quietLogger = (): SettingsLogger => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  });

  it('refreshes in place without a destination', async () => {
    await renderProbe(undefined, quietLogger());
    await click('probe');
    expect(routerCalls).toEqual(['refresh']);
  });

  it('logs a refresh failure instead of throwing it at the caller', async () => {
    const warn = jest.fn();
    const logger = { ...quietLogger(), warn };
    router.refresh = (): void => {
      throw new Error('refresh failed');
    };
    await renderProbe('/organization', logger);
    await click('probe');

    expect(routerCalls).toEqual(['push /organization']);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

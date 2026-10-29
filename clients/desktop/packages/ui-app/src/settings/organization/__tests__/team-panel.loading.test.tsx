/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// CAN-4558: the Organizations list shows a list skeleton while it has nothing
// to show, never "Loading organizations..." text, and a refresh with the list
// already on screen keeps the list instead of swapping back to the skeleton.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  IncomingTeamInvitation,
  OrganizationSummary,
} from '@canopy/protocol/settings';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { TeamPanel } from '../team-panel';

const ORG: OrganizationSummary = {
  id: 'org-1',
  name: 'Acme Engineering',
  role: 'OWNER',
  memberCount: 3,
  subTeamCount: 1,
  logoUrl: null,
};

const INVITE: IncomingTeamInvitation = {
  id: 'invite-1',
  organizationName: 'Globex',
  organizationTeamName: null,
  role: 'MEMBER',
  invitedByName: 'Hank Scorpio',
  createdAt: '2026-10-01T00:00:00.000Z',
  expiresAt: '2026-11-01T00:00:00.000Z',
};

let container: HTMLDivElement;
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

function skeleton(): Element | null {
  return container.querySelector('[data-testid="settings-skeleton-list"]');
}

async function render(
  client: FakeSettingsClient,
  prefill?: {
    organizations: OrganizationSummary[];
    invitations: IncomingTeamInvitation[];
  },
): Promise<void> {
  await act(async () => {
    root.render(
      <TestSettingsHost host={createTestSettingsHost({ client }).host}>
        <TeamPanel
          initialOrganizations={prefill?.organizations}
          initialInvitations={prefill?.invitations}
          onCreate={() => undefined}
        />
      </TestSettingsHost>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('shows a square-avatar list skeleton, not loading text, on first load', async () => {
  const client = createFakeSettingsClient({
    'organization.list': () => new Promise<never>(() => undefined),
    'organization.invitations.incoming': () => ({ invitations: [] }),
  });
  await render(client);

  const status = skeleton();
  expect(status?.getAttribute('role')).toBe('status');
  expect(status?.querySelector('.size-8.rounded-md')).not.toBeNull();
  expect(container.textContent).not.toContain('Loading organizations');
  expect(container.querySelector('[data-testid="team-panel-org"]')).toBeNull();
});

it('keeps the listed organizations while a refresh is in flight', async () => {
  let resolveList: ((value: unknown) => void) | undefined;
  const client = createFakeSettingsClient({
    'organization.invitations.respond': () => undefined,
    'organization.invitations.incoming': () => ({ invitations: [] }),
    'organization.list': () =>
      new Promise((resolve) => {
        resolveList = resolve;
      }),
  });
  await render(client, { organizations: [ORG], invitations: [INVITE] });
  expect(skeleton()).toBeNull();

  const accept = container.querySelector(
    '[data-testid="team-invitation-accept"]',
  );
  if (!(accept instanceof HTMLElement)) throw new Error('Missing accept');
  await act(async () => {
    accept.click();
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // The refresh read is pending: the list stays and no skeleton replaces it.
  expect(resolveList).toBeDefined();
  expect(skeleton()).toBeNull();
  expect(
    container.querySelector('[data-testid="team-panel-org"]')?.textContent,
  ).toContain('Acme Engineering');

  await act(async () => {
    resolveList?.({
      organizations: [ORG, { ...ORG, id: 'org-2', name: 'Globex' }],
    });
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(
    container.querySelectorAll('[data-testid="team-panel-org"]'),
  ).toHaveLength(2);
  expect(skeleton()).toBeNull();
});

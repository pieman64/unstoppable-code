/**
 * @jest-environment jsdom
 */
// Focus restoration for the two destructive confirmations in this section.
//
// Both remove the row that holds the button which opened the dialog, so by the
// time the dialog closes the element focus would return to is detached and
// `HTMLElement.focus()` on it is a silent no-op. Without `restoreFocusRef`,
// focus lands on `<body>` inside a page the user was mid-task on. These tests
// fail if that wiring is removed.

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrganizationDetail } from '@canopy/protocol/settings';
import {
  createFakeSettingsClient,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { TeamMembersSection } from '../team-members-section';
import { OrganizationTestHost } from './helpers/members-section-harness';

// Drive the real removal path: the section calls `removeMember` and hands the
// returned detail to `onDetailChange`, which is what unmounts the row (and with
// it, the button focus would otherwise return to).
const removeMemberMock = jest.fn();

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
        subTeamIds: [],
      },
      {
        id: 'member-2',
        name: 'Grace Hopper',
        email: 'grace@example.com',
        role: 'OWNER',
        image: null,
        subTeamIds: [],
      },
    ],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let client: FakeSettingsClient;

function membersList(): HTMLElement {
  const list = container.querySelector('ul[aria-label="Members"]');
  if (!(list instanceof HTMLElement))
    throw new Error('Members list was not rendered');
  return list;
}

function queryButton(testId: string): HTMLButtonElement | null {
  const value = document.body.querySelector(`[data-testid="${testId}"]`);
  return value instanceof HTMLButtonElement ? value : null;
}

function requireButton(testId: string): HTMLButtonElement {
  const value = queryButton(testId);
  if (!value) throw new Error(`${testId} was not rendered`);
  return value;
}

beforeEach(() => {
  jest.clearAllMocks();
  removeMemberMock.mockImplementation(() =>
    Promise.resolve({
      ...buildDetail(),
      members: buildDetail().members.filter(
        (member) => member.id !== 'member-1',
      ),
    }),
  );
  client = createFakeSettingsClient({
    'organization.invitations.list': () => ({ enabled: true, invites: [] }),
    'organization.members.remove': (input): unknown => removeMemberMock(input),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

// The real page owns `detail` and re-renders the section with the member gone.
// A stub `onDetailChange` would leave the row — and therefore the trigger —
// mounted, which is precisely the case `restoreFocusRef` does NOT cover, so the
// test would pass against broken wiring.
function Harness(): ReactNode {
  const [detail, setDetail] = useState(buildDetail());
  return (
    <TeamMembersSection
      detail={detail}
      viewerEmail="grace@example.com"
      onDetailChange={setDetail}
      onLeft={jest.fn()}
      adding={false}
      onAddingChange={jest.fn()}
    />
  );
}

async function mount(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      <OrganizationTestHost client={client}>
        <Harness />
      </OrganizationTestHost>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TeamMembersSection focus restoration', () => {
  it('returns focus to the Members list after removing a member', async () => {
    await mount();

    // `team-member-remove` renders once per removable member; Ada is the only
    // non-viewer MEMBER in the fixture, so the first is hers.
    const trigger = requireButton('team-member-remove');
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
    await act(async () => {
      requireButton('confirm-dialog-confirm').click();
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // The premise: the opener really is gone, so restoration cannot fall back
    // to it. If this ever fails the test below stops proving anything.
    expect(trigger.isConnected).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(membersList());
    expect(removeMemberMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'member-1',
    });
  });
});

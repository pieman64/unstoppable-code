/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// CAN-4558: organization settings never render a route's `{ error }` text.
// Loads show load copy with Retry; actions show `Couldn't <action>.` or the
// known case's own copy.

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  OrganizationDetail,
  OrganizationSummary,
} from '@canopy/protocol/settings';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
  type FakeSettingsHandler,
} from '../../__tests__/helpers/test-settings-host';
import {
  chooseSettingsOption,
  settingsSelectTrigger,
} from '../../__tests__/helpers/settings-select';
import { CreateTeamDialog } from '../create-team-dialog';
import { TeamMembersSection } from '../team-members-section';
import { TeamBrandingSettingsSection } from '../team-branding-settings-section';
import { TeamPanel } from '../team-panel';
import { TeamSubTeamsSection } from '../team-subteams-section';
import { failWith } from './helpers/settings-responses';

const SENTINEL = 'SENTINEL-SERVER-BODY';

const ORG: OrganizationSummary = {
  id: 'org-1',
  name: 'Acme Engineering',
  role: 'OWNER',
  memberCount: 3,
  subTeamCount: 1,
  logoUrl: null,
};

function makeDetail(
  overrides: Partial<OrganizationDetail> = {},
): OrganizationDetail {
  return {
    id: 'org-1',
    name: 'Acme',
    viewerRole: 'OWNER',
    members: [
      {
        id: 'u1',
        name: 'Ada',
        email: 'ada@example.com',
        image: null,
        role: 'OWNER',
        subTeamIds: [],
      },
      {
        id: 'u2',
        name: 'Bob',
        email: 'bob@example.com',
        image: null,
        role: 'ADMIN',
        subTeamIds: [],
      },
    ],
    subTeams: [],
    usageStatsMinRole: 'ADMIN',
    canViewUsageStats: true,
    logoUrl: null,
    githubConnection: { connected: false, accountLogin: null },
    ...overrides,
  };
}

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

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function render(
  client: FakeSettingsClient,
  children: ReactNode,
): Promise<void> {
  await act(async () => {
    root.render(
      <TestSettingsHost host={createTestSettingsHost({ client }).host}>
        {children}
      </TestSettingsHost>,
    );
    await Promise.resolve();
  });
  await flush();
}

function byTestId(testId: string): HTMLElement {
  const found = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(found instanceof HTMLElement)) throw new Error(`Missing ${testId}`);
  return found;
}

function buttonByText(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label,
  );
  if (found === undefined) throw new Error(`Missing button: ${label}`);
  return found;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
  await flush();
}

async function type(testId: string, value: string): Promise<void> {
  const input = byTestId(testId);
  if (!(input instanceof HTMLInputElement)) throw new Error('Not an input');
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function submitFormOf(testId: string): Promise<void> {
  const form = byTestId(testId).closest('form');
  if (!(form instanceof HTMLFormElement)) throw new Error('Not in a form');
  await act(async () => {
    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    await Promise.resolve();
  });
  await flush();
}

describe('Organizations list', () => {
  it('shows load copy with Retry, never the server text, and Retry reloads', async () => {
    let fail = true;
    const refuse = failWith(500, { error: SENTINEL });
    const list: FakeSettingsHandler = (input) =>
      fail ? refuse(input) : { organizations: [ORG] };
    const client = createFakeSettingsClient({
      'organization.list': list,
      'organization.invitations.incoming': () => ({ invitations: [] }),
    });
    await render(client, <TeamPanel onCreate={() => undefined} />);

    expect(container.textContent).toContain("Couldn't load this.");
    expect(container.textContent).not.toContain(SENTINEL);

    fail = false;
    await click(buttonByText('Try again'));

    expect(container.textContent).not.toContain("Couldn't load this.");
    expect(byTestId('team-panel-org').textContent).toContain(
      'Acme Engineering',
    );
  });
});

describe('Create organization', () => {
  it('names the organization limit for a 409', async () => {
    const client = createFakeSettingsClient({
      'organization.create': failWith(
        409,
        { error: SENTINEL },
        { write: true },
      ),
    });
    await render(
      client,
      <CreateTeamDialog onClose={jest.fn()} onCreated={jest.fn()} />,
    );
    await type('create-team-name-input', 'Globex');
    await submitFormOf('create-team-submit');

    const dialog = byTestId('create-team-dialog').textContent ?? '';
    expect(dialog).toContain(
      "You've reached the limit of organizations you can own.",
    );
    expect(dialog).not.toContain(SENTINEL);
  });

  it('shows the generic action copy for any other refusal', async () => {
    const client = createFakeSettingsClient({
      'organization.create': failWith(
        500,
        { error: SENTINEL },
        { write: true },
      ),
    });
    await render(
      client,
      <CreateTeamDialog onClose={jest.fn()} onCreated={jest.fn()} />,
    );
    await type('create-team-name-input', 'Globex');
    await submitFormOf('create-team-submit');

    const dialog = byTestId('create-team-dialog').textContent ?? '';
    expect(dialog).toContain("Couldn't create the organization. Try again.");
    expect(dialog).not.toContain(SENTINEL);
  });
});

describe('Organization rename', () => {
  it('shows the rename copy, never the server text, for a 500', async () => {
    const client = createFakeSettingsClient({
      'organization.rename': failWith(
        500,
        { error: SENTINEL },
        { write: true },
      ),
    });
    await render(
      client,
      <TeamBrandingSettingsSection
        detail={makeDetail()}
        onDetailChange={jest.fn()}
      />,
    );
    await type('team-name-input', 'Globex');
    await submitFormOf('team-name-input');

    expect(container.textContent).toContain(
      "Couldn't rename the organization. Try again.",
    );
    expect(container.textContent).not.toContain(SENTINEL);
  });
});

describe('Teams', () => {
  it('names the duplicate for a 409 on create', async () => {
    const client = createFakeSettingsClient({
      'organization.teams.create': failWith(
        409,
        { error: SENTINEL },
        { write: true },
      ),
    });
    await render(
      client,
      <TeamSubTeamsSection
        detail={makeDetail()}
        onDetailChange={jest.fn()}
        creating
        onCreatingChange={jest.fn()}
      />,
    );
    await type('team-subteam-name-input', 'Design');
    await submitFormOf('team-subteam-name-input');

    expect(container.textContent).toContain(
      'A team with that name already exists. Choose another name.',
    );
    expect(container.textContent).not.toContain(SENTINEL);
  });
});

describe('Members', () => {
  it('explains the last-owner rule for a 409 on a role change', async () => {
    const client = createFakeSettingsClient({
      'organization.invitations.list': () => ({ enabled: true, invites: [] }),
      'organization.members.updateRole': failWith(
        409,
        { error: SENTINEL },
        { write: true },
      ),
    });
    await render(
      client,
      <TeamMembersSection
        detail={makeDetail()}
        viewerEmail="ada@example.com"
        onDetailChange={jest.fn()}
        onLeft={jest.fn()}
        adding={false}
        onAddingChange={jest.fn()}
      />,
    );
    const bobRow = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="team-member-row"]'),
    ).find((row) => row.textContent?.includes('Bob'));
    if (!bobRow) throw new Error('Bob row missing');
    const bobRole = settingsSelectTrigger(
      bobRow,
      '[data-testid="team-member-role"]',
    );
    // Named "Role for Bob" through in-page elements, never a copied label.
    expect(
      (bobRole.getAttribute('aria-labelledby') ?? '')
        .split(' ')
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .join(' '),
    ).toBe('Role for Bob');
    await chooseSettingsOption(bobRole, 'MEMBER');
    await flush();

    expect(container.textContent).toContain(
      'An organization needs at least one owner. Make someone else an owner first.',
    );
    expect(container.textContent).not.toContain(SENTINEL);
  });
});

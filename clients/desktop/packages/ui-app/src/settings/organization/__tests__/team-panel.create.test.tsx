/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// CAN-3926: "Organization creation should simply create the org and lead to
// inviting teammates." The create flow asks for a name only (no plan, trial,
// card, or checkout step) and lands the new owner on Members with the invite
// dialog auto-opened (`?invite=1`, covered for free-access seat quotes in
// `team-members-section.seat-charge.test.tsx`). The flow has no billing branch,
// so it is the same with free access on or off.
//
// CAN-4553: the new organization joins the host's workspace switcher right
// away, so after landing on Members the panel refreshes the host once, and
// selects the new organization in the app's sidebar.
//
// CAN-4554: the sidebar switcher's Create an organization opens the list
// with `?create=1`, which opens the same dialog; closing it replaces the URL
// with the bare list and creating replaces it with Members, so Back never
// reopens it.

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { OrganizationDetail } from '@canopy/protocol/settings';
import { SettingsOperationError } from '@canopy/protocol/settings/errors';
import {
  createFakeSettingsClient,
  createTestSettingsHost,
  TestSettingsHost,
  type FakeSettingsClient,
} from '../../__tests__/helpers/test-settings-host';
import { OrganizationListPage } from '../OrganizationListPage';

const routerCalls: string[] = [];
const mockPush = jest.fn((href: string) => routerCalls.push(`push ${href}`));
const mockRefresh = jest.fn(() => routerCalls.push('refresh'));
const mockReplace = jest.fn((href: string) =>
  routerCalls.push(`replace ${href}`),
);
const mockCreateOrganization = jest.fn();
const mockSelectOrganization = jest.fn();

const CREATED: OrganizationDetail = {
  id: 'org-new',
  name: 'Acme Engineering',
  viewerRole: 'OWNER',
  members: [],
  subTeams: [],
  usageStatsMinRole: 'ADMIN',
  canViewUsageStats: true,
  logoUrl: null,
  githubConnection: { connected: false, accountLogin: null },
};

let container: HTMLDivElement;
let root: Root;
let client: FakeSettingsClient;

beforeEach(() => {
  jest.clearAllMocks();
  routerCalls.length = 0;
  mockCreateOrganization.mockResolvedValue(CREATED);
  client = createFakeSettingsClient({
    'organization.list': () => ({ organizations: [] }),
    'organization.invitations.incoming': () => ({ invitations: [] }),
    'organization.create': (input): unknown => mockCreateOrganization(input),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function byTestId(testId: string): HTMLElement {
  const el = document.body.querySelector(`[data-testid="${testId}"]`);
  if (!(el instanceof HTMLElement)) throw new Error(`Missing ${testId}`);
  return el;
}

function typeInto(input: HTMLElement, value: string): void {
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('Expected an input');
  }
  const setter = (target: HTMLInputElement, next: string): void => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(target, next);
  };
  setter(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('creates the organization from a name alone and lands on inviting teammates', async () => {
  await act(async () => {
    root.render(
      <TestSettingsHost
        host={
          createTestSettingsHost({
            client,
            router: { push: mockPush, refresh: mockRefresh },
            selectOrganization: mockSelectOrganization,
          }).host
        }
      >
        <OrganizationListPage
          route={{ scope: 'organizations' }}
          page={{ kind: 'organization.list', data: {} }}
        />
      </TestSettingsHost>,
    );
    await Promise.resolve();
  });
  await flush();

  await act(async () => {
    byTestId('team-panel-create-empty').click();
    await Promise.resolve();
  });
  const dialog = byTestId('create-team-dialog');
  // A name is the only thing asked for: no plan, trial, card, or payment.
  expect(dialog.querySelectorAll('input')).toHaveLength(1);
  for (const word of ['trial', 'card', 'plan', 'Subscribe', 'pay', '$']) {
    expect(dialog.textContent).not.toContain(word);
  }

  await act(async () => {
    typeInto(byTestId('create-team-name-input'), '  Acme Engineering ');
    await Promise.resolve();
  });
  await act(async () => {
    byTestId('create-team-submit').click();
    await Promise.resolve();
  });
  await flush();

  expect(mockCreateOrganization).toHaveBeenCalledWith({
    name: 'Acme Engineering',
  });
  expect(mockPush).toHaveBeenCalledTimes(1);
  expect(mockPush).toHaveBeenCalledWith(
    '/organization/org-new/members?invite=1',
  );
  // The refresh follows the push, so it re-reads the destination page.
  expect(routerCalls).toEqual([
    'push /organization/org-new/members?invite=1',
    'refresh',
  ]);
  expect(mockSelectOrganization).toHaveBeenCalledTimes(1);
  expect(mockSelectOrganization).toHaveBeenCalledWith('org-new');
});

it('neither navigates nor refreshes the host when creation is refused', async () => {
  mockCreateOrganization.mockRejectedValue(
    new SettingsOperationError({
      code: 'failed',
      status: 409,
      message: 'An organization with that name already exists.',
    }),
  );
  await act(async () => {
    root.render(
      <TestSettingsHost
        host={
          createTestSettingsHost({
            client,
            router: { push: mockPush, refresh: mockRefresh },
            selectOrganization: mockSelectOrganization,
          }).host
        }
      >
        <OrganizationListPage
          route={{ scope: 'organizations' }}
          page={{ kind: 'organization.list', data: {} }}
        />
      </TestSettingsHost>,
    );
    await Promise.resolve();
  });
  await flush();

  await act(async () => {
    byTestId('team-panel-create-empty').click();
    await Promise.resolve();
  });
  await act(async () => {
    typeInto(byTestId('create-team-name-input'), 'Acme Engineering');
    await Promise.resolve();
  });
  await act(async () => {
    byTestId('create-team-submit').click();
    await Promise.resolve();
  });
  await flush();

  expect(mockCreateOrganization).toHaveBeenCalledTimes(1);
  expect(routerCalls).toEqual([]);
  expect(mockSelectOrganization).not.toHaveBeenCalled();
  // A refused create shows local copy, never the server's text (CAN-4558).
  expect(document.body.textContent).toContain(
    "You've reached the limit of organizations you can own.",
  );
  expect(document.body.textContent).not.toContain(
    'An organization with that name already exists.',
  );
});

function renderPanel(createOnLoad?: boolean): void {
  root.render(
    <TestSettingsHost
      host={
        createTestSettingsHost({
          client,
          router: {
            push: mockPush,
            replace: mockReplace,
            refresh: mockRefresh,
          },
          search: createOnLoad === true ? 'create=1' : '',
          selectOrganization: mockSelectOrganization,
        }).host
      }
    >
      <OrganizationListPage
        route={{ scope: 'organizations' }}
        page={{ kind: 'organization.list', data: {} }}
      />
    </TestSettingsHost>,
  );
}

async function mountPanel(createOnLoad?: boolean): Promise<void> {
  await act(async () => {
    renderPanel(createOnLoad);
    await Promise.resolve();
  });
  await flush();
}

function dialogOpen(): boolean {
  return (
    document.body.querySelector('[data-testid="create-team-dialog"]') !== null
  );
}

/** The dialog has no Cancel (CAN-4558); its X closes it. */
function closeButton(): HTMLButtonElement {
  const button = byTestId('create-team-dialog').querySelector(
    'button[aria-label="Close"]',
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error('Missing Close');
  return button;
}

async function createAcme(): Promise<void> {
  await act(async () => {
    typeInto(byTestId('create-team-name-input'), 'Acme Engineering');
    await Promise.resolve();
  });
  await act(async () => {
    byTestId('create-team-submit').click();
    await Promise.resolve();
  });
  await flush();
}

describe('?create=1 (CAN-4554)', () => {
  it('opens the create dialog on arrival, before any click', async () => {
    await mountPanel(true);
    expect(dialogOpen()).toBe(true);
  });

  it('opens when the flag appears after mount and stays open when it clears', async () => {
    await mountPanel(false);
    expect(dialogOpen()).toBe(false);
    await act(async () => {
      renderPanel(true);
      await Promise.resolve();
    });
    expect(dialogOpen()).toBe(true);
    await act(async () => {
      renderPanel(false);
      await Promise.resolve();
    });
    expect(dialogOpen()).toBe(true);
  });

  it('replaces the flag away once when the dialog closes', async () => {
    await mountPanel(true);
    await act(async () => {
      closeButton().click();
      await Promise.resolve();
    });
    expect(dialogOpen()).toBe(false);
    expect(routerCalls).toEqual(['replace /organization']);
    await act(async () => {
      renderPanel(false);
      await Promise.resolve();
    });
    expect(routerCalls).toEqual(['replace /organization']);
    expect(mockSelectOrganization).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('replaces the flag with Members in one navigation', async () => {
    await mountPanel(true);
    await createAcme();
    expect(routerCalls).toEqual([
      'replace /organization/org-new/members?invite=1',
      'refresh',
    ]);
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockSelectOrganization).toHaveBeenCalledTimes(1);
    expect(mockSelectOrganization).toHaveBeenCalledWith('org-new');
  });

  it('leaves the URL alone for a dialog opened by the button', async () => {
    await mountPanel(false);
    await act(async () => {
      byTestId('team-panel-create-empty').click();
      await Promise.resolve();
    });
    await createAcme();
    expect(routerCalls).toEqual([
      'push /organization/org-new/members?invite=1',
      'refresh',
    ]);
    expect(mockReplace).not.toHaveBeenCalled();
  });
});

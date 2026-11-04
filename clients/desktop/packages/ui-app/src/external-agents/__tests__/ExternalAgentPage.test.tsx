/**
 * @jest-environment jsdom
 */
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { domFireEvent, screen, within } from './dom-test-kit';
import type {
  CanopyCapabilities,
  CanopyClient,
  CommandMap,
  CommandName,
  QueryMap,
  QueryName,
  Unsubscribe,
} from '@canopy/app-core';
import type {
  ExternalAgentAccessGroup,
  ExternalAgentAccessUpdate,
  ExternalAgentActivityItem,
  ExternalAgentConnectionDetail,
  ExternalAgentDesktop,
  ExternalAgentDesktopList,
  ExternalAgentWaitingAction,
  ExternalAgentsOverview,
} from '@canopy/protocol/external-agents';
import type {
  ExternalAgentsClient,
  ExternalAgentsResult,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { ExternalAgentPage } from '../ExternalAgentPage';
import { desktopConnectionHint } from '../external-agents-parts';
import { externalAgentConfirmationPath } from '../paths';

const CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  overviewNotifications: false,
  externalAgents: true,
};

const ACCOUNT_GROUPS: readonly ExternalAgentAccessGroup[] = [
  {
    id: 'account',
    label: 'Account',
    description: 'Read your account profile.',
    writable: false,
    writeUnavailableReason: null,
    minimum: 'read',
    unavailableReason: null,
    destructive: false,
    destructiveTools: [],
    tools: [
      {
        name: 'account.read_profile',
        title: 'Read profile',
        access: 'read',
        defaultOff: false,
        markers: {
          spendsCredits: false,
          sendsEmail: false,
          publicEffect: false,
          actsOnRemote: false,
        },
        hosts: null,
      },
    ],
  },
  {
    id: 'org',
    label: 'Organizations',
    description: 'Read and update organization data.',
    writable: true,
    writeUnavailableReason: null,
    minimum: 'off',
    unavailableReason: null,
    destructive: true,
    destructiveTools: ['org_member_remove', 'org_team_remove'],
    tools: [
      {
        name: 'org.list',
        title: 'List organizations',
        access: 'read',
        defaultOff: false,
        markers: {
          spendsCredits: false,
          sendsEmail: false,
          publicEffect: false,
          actsOnRemote: false,
        },
        hosts: null,
      },
      {
        name: 'org.update',
        title: 'Update organization',
        access: 'write',
        defaultOff: false,
        markers: {
          spendsCredits: false,
          sendsEmail: false,
          publicEffect: false,
          actsOnRemote: false,
        },
        hosts: null,
      },
    ],
  },
];

const LIBRARY_GROUP: ExternalAgentAccessGroup = {
  id: 'library',
  label: 'Library',
  description: 'Read and update library items.',
  writable: true,
  writeUnavailableReason: null,
  minimum: 'off',
  unavailableReason: null,
  destructive: true,
  destructiveTools: ['library_item_remove'],
  tools: [
    {
      name: 'library.list',
      title: 'List library items',
      access: 'read',
      defaultOff: false,
      markers: {
        spendsCredits: false,
        sendsEmail: false,
        publicEffect: false,
        actsOnRemote: false,
      },
      hosts: null,
    },
  ],
};

const TASK_GROUPS: readonly ExternalAgentAccessGroup[] = [
  {
    id: 'tasks',
    label: 'Tasks',
    description:
      'Read and update projects and tasks in the cloud and on devices.',
    writable: true,
    writeUnavailableReason: null,
    minimum: 'off',
    unavailableReason: null,
    destructive: false,
    destructiveTools: [],
    tools: [
      {
        name: 'task_list',
        title: 'List tasks',
        access: 'read',
        defaultOff: false,
        markers: {
          spendsCredits: false,
          sendsEmail: false,
          publicEffect: false,
          actsOnRemote: false,
        },
        hosts: { managed: true, connected: true },
      },
      {
        name: 'task_create',
        title: 'Start a task',
        access: 'write',
        defaultOff: false,
        markers: {
          spendsCredits: false,
          sendsEmail: false,
          publicEffect: false,
          actsOnRemote: true,
        },
        hosts: { managed: true, connected: true },
      },
    ],
  },
];

const FAILED_ACTIVITY: ExternalAgentActivityItem = {
  at: '2026-10-15T10:05:00.000Z',
  tool: 'org.list',
  toolTitle: 'List organizations',
  targets: [],
  outcome: 'error',
  outcomeCode: 'ACCESS_DENIED',
};
const roots: Root[] = [];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

async function render(
  children: ReactNode,
): Promise<{ readonly container: HTMLElement }> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async (): Promise<void> => {
    root.render(children);
    for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  });
  return { container };
}

const fireEvent = {
  async click(target: Element): Promise<void> {
    await act(async (): Promise<void> => {
      domFireEvent.click(target);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
  },
  async change(
    target: Element,
    options: { readonly target: { readonly value: string } },
  ): Promise<void> {
    await act(async (): Promise<void> => {
      domFireEvent.change(target, options);
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
  },
};

/** Opens the Access ends dropdown and chooses the option with `value`. */
async function chooseAccessEnds(value: string): Promise<void> {
  await fireEvent.click(screen.getByTestId('external-agent-access-ends'));
  const option = document.querySelector(
    `[role="listbox"] [role="option"][data-value="${value}"]`,
  );
  if (!option) throw new Error(`missing Access ends option ${value}`);
  await fireEvent.click(option);
}

afterEach((): void => {
  act((): void => roots.forEach((root) => root.unmount()));
  roots.length = 0;
  document.body.replaceChildren();
});

function result<T>(value: T): ExternalAgentsResult<T> {
  return { ok: true, value };
}

function failure<T>(
  error:
    | 'not_found'
    | 'conflict'
    | 'expired'
    | 'invalid_policy'
    | 'unavailable',
): ExternalAgentsResult<T> {
  return { ok: false, error };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = (): void => {};
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function detail(
  overrides: Partial<ExternalAgentConnectionDetail> = {},
): ExternalAgentConnectionDetail {
  const server = overrides.server ?? 'account';
  const groups = server === 'tasks' ? TASK_GROUPS : ACCOUNT_GROUPS;
  const current: ExternalAgentConnectionDetail['current'] =
    server === 'tasks'
      ? {
          groups: { tasks: 'write' },
          disabledTools: [],
          enabledDefaultOff: [],
          organizations: { mode: 'all', organizationIds: [] },
          hosts: {
            managed: true,
            connected: { mode: 'all', remoteIds: [] },
            exposeNames: false,
          },
        }
      : {
          groups: { account: 'read', org: 'read' },
          disabledTools: [],
          enabledDefaultOff: [],
          organizations: {
            mode: 'selected',
            organizationIds: ['org-1'],
          },
          hosts: {
            managed: false,
            connected: { mode: 'selected', remoteIds: [] },
            exposeNames: false,
          },
        };
  return {
    id: 'connection-1',
    server,
    clientName: 'Claude Desktop',
    verified: true,
    status: 'active',
    createdAt: '2026-10-12T15:00:00.000Z',
    lastUsedAt: '2026-10-15T10:00:00.000Z',
    expiresAt: null,
    access:
      server === 'tasks'
        ? {
            read: [],
            write: ['tasks'],
            destructive: [],
            organizations: null,
            desktops: 'all',
            managed: true,
          }
        : {
            read: ['account', 'org'],
            write: [],
            destructive: [],
            organizations: 1,
            desktops: null,
            managed: null,
          },
    revision: 1,
    from: 'claude.ai',
    returnsTo: '127.0.0.1:50123',
    loopback: true,
    groups: [...groups],
    current,
    organizations:
      server === 'account'
        ? [
            {
              id: 'org-1',
              name: 'Northwind Labs',
              roleLine: 'You are an admin.',
              unavailableReason: null,
              personal: false,
            },
            {
              id: 'org-2',
              name: 'Personal',
              roleLine: 'Your Personal organization.',
              unavailableReason: null,
              personal: true,
            },
          ]
        : [],
    remoteControlEnabled: server === 'tasks',
    maxTools: 80,
    activity: [FAILED_ACTIVITY],
    confirmationClasses:
      server === 'tasks'
        ? ['task', 'pipeline']
        : ['profile', 'settings', 'membership', 'sharing', 'content'],
    confirmation: {
      profile: 'act',
      settings: 'act',
      membership: 'act',
      sharing: 'act',
      content: 'act',
      task: 'act',
      pipeline: 'act',
    },
    waiting: [],
    textContentCompatibility: false,
    ...overrides,
  };
}

function tasksDetail(
  remoteIds: readonly string[] = [],
  overrides: Partial<ExternalAgentConnectionDetail> = {},
): ExternalAgentConnectionDetail {
  const initial = detail({ ...overrides, server: 'tasks' });
  return {
    ...initial,
    current: {
      ...initial.current,
      hosts: {
        managed: true,
        connected: { mode: 'selected', remoteIds: [...remoteIds] },
        exposeNames: false,
      },
    },
  };
}

function pairedDesktop(
  remoteId: string,
  name: string,
  hostname: string | null,
): ExternalAgentDesktop {
  return {
    remoteId,
    hostCode: '7k3q9x2m4p',
    name,
    hostname,
    connection: 'active',
    lastSeenAt: null,
  };
}

function choiceInput(testId: string): HTMLInputElement {
  const element = screen.getByTestId(testId);
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`Expected a checkbox: ${testId}`);
  }
  return element;
}

function waitingAction(
  overrides: Partial<ExternalAgentWaitingAction> = {},
): ExternalAgentWaitingAction {
  const now = Date.now();
  return {
    pendingActionId: 'pending/one?',
    connectionId: 'connection-1',
    clientName: 'Claude Desktop',
    server: 'account',
    action: 'Update organization settings',
    requestedAt: new Date(now - 120_000).toISOString(),
    decisionExpiresAt: new Date(now + 480_000).toISOString(),
    ...overrides,
  };
}

interface FakeExternalAgentsClient extends ExternalAgentsClient {
  readonly getOverview: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentsOverview>>,
    []
  >;
  readonly getConnection: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
    [string]
  >;
  readonly listDesktops: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentDesktopList>>,
    []
  >;
  readonly updateAccess: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
    [string, ExternalAgentAccessUpdate]
  >;
  readonly pause: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
    [string, number]
  >;
  readonly resume: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
    [string, number]
  >;
  readonly remove: jest.Mock<Promise<ExternalAgentsResult<null>>, [string]>;
}

function fakeExternalAgentsClient(
  initialDetail: ExternalAgentConnectionDetail = detail(),
): FakeExternalAgentsClient {
  return {
    getOverview: jest
      .fn<Promise<ExternalAgentsResult<ExternalAgentsOverview>>, []>()
      .mockResolvedValue(
        result({
          notices: [],
          waiting: [],
          servers: [],
          cursorClientId: 'cursor-id',
          connections: [],
        }),
      ),
    getConnection: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string]
      >()
      .mockResolvedValue(result(initialDetail)),
    listDesktops: jest
      .fn<Promise<ExternalAgentsResult<ExternalAgentDesktopList>>, []>()
      .mockResolvedValue(result({ desktops: [] })),
    updateAccess: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string, ExternalAgentAccessUpdate]
      >()
      .mockResolvedValue(result(initialDetail)),
    pause: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string, number]
      >()
      .mockResolvedValue(result(initialDetail)),
    resume: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string, number]
      >()
      .mockResolvedValue(result(initialDetail)),
    remove: jest
      .fn<Promise<ExternalAgentsResult<null>>, [string]>()
      .mockResolvedValue(result(null)),
    getPendingAction: () =>
      Promise.resolve({ ok: false, error: 'unavailable' }),
    decidePendingAction: () =>
      Promise.resolve({ ok: false, error: 'unavailable' }),
    getWaitingCount: () => Promise.resolve({ ok: true, value: 0 }),
  };
}

function mockCanopyClient(externalAgents: ExternalAgentsClient): CanopyClient {
  return {
    capabilities: CAPABILITIES,
    externalAgents,
    query<K extends QueryName>(): Promise<QueryMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    command<K extends CommandName>(): Promise<CommandMap[K]['result']> {
      return Promise.reject(new Error('unused'));
    },
    subscribe(): Unsubscribe {
      return (): void => {};
    },
  };
}

function renderPage(
  externalAgents: ExternalAgentsClient,
  connectionId = 'connection-1',
  onOpenPath: (path: string) => void = (): void => {},
): Promise<{ readonly container: HTMLElement }> {
  return render(
    <CanopyClientProvider client={mockCanopyClient(externalAgents)}>
      <ExternalAgentPage connectionId={connectionId} onOpenPath={onOpenPath} />
    </CanopyClientProvider>,
  );
}

async function clickWriteLevel(): Promise<void> {
  const group = screen.getByTestId('agent-access-group-org');
  await fireEvent.click(within(group).getByRole('button', { name: 'Write' }));
}

describe('ExternalAgentPage', () => {
  it('finishes loading when development mode mounts it twice', async () => {
    await render(
      <StrictMode>
        <CanopyClientProvider
          client={mockCanopyClient(fakeExternalAgentsClient(detail()))}
        >
          <ExternalAgentPage
            connectionId="connection-1"
            onOpenPath={(): void => {}}
          />
        </CanopyClientProvider>
      </StrictMode>,
    );

    expect(await screen.findByTestId('external-agent-page')).toHaveAttribute(
      'data-status',
      'active',
    );
    expect(screen.queryByTestId('external-agent-loading')).toBeNull();
  });

  it('renders identity, connection facts, access, and activity without argument values', async () => {
    await renderPage(
      fakeExternalAgentsClient(detail({ activity: [FAILED_ACTIVITY] })),
    );

    const page = await screen.findByTestId('external-agent-page');
    expect(page).toHaveAttribute('data-status', 'active');
    expect(
      within(page).getByRole('heading', { name: 'Claude Desktop', level: 2 }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('external-agent-identity')).toHaveTextContent(
      'Account and organizations · Verified',
    );
    expect(screen.getByText('claude.ai')).toBeInTheDocument();
    expect(
      screen.getByTestId('external-agent-loopback-note'),
    ).toHaveTextContent('Any app running on it could receive the result.');
    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Last used')).toBeInTheDocument();
    expect(screen.getByTestId('external-agent-access')).toBeInTheDocument();
    expect(screen.getByTestId('external-agent-activity-row')).toHaveTextContent(
      'List organizations',
    );
    expect(screen.getByTestId('external-agent-activity-row')).toHaveTextContent(
      'Failed',
    );
    expect(screen.queryByTestId('external-agent-waiting')).toBeNull();
    expect(screen.getByText('Failed')).toHaveAttribute(
      'title',
      'ACCESS_DENIED',
    );
    expect(page.textContent).not.toContain('ARGUMENT_VALUE');
    expect(page.textContent).not.toContain('2026-10-12T15:00:00.000Z');
  });

  it('shows waiting requests with timing and opens the confirmation page', async () => {
    const onOpenPath = jest.fn<void, [string]>();
    const waiting = waitingAction();
    await renderPage(
      fakeExternalAgentsClient(detail({ waiting: [waiting] })),
      'connection-1',
      onOpenPath,
    );

    const section = await screen.findByTestId('external-agent-waiting');
    expect(section).toHaveTextContent('This agent asked to do something');
    const row = await screen.findByTestId('external-agents-waiting-row');
    expect(row).toHaveAttribute(
      'data-pending-action-id',
      waiting.pendingActionId,
    );
    expect(row).toHaveTextContent('Asked');
    expect(row).toHaveTextContent('Expires');
    expect(row).not.toHaveTextContent('Claude Desktop');

    await fireEvent.click(
      within(row).getByRole('button', {
        name: 'Review: Update organization settings',
      }),
    );
    expect(onOpenPath).toHaveBeenCalledWith(
      externalAgentConfirmationPath(waiting.pendingActionId),
    );
  });

  it('hides waiting requests when paused or empty', async () => {
    await renderPage(
      fakeExternalAgentsClient(
        detail({ status: 'paused', waiting: [waitingAction()] }),
      ),
    );
    expect(
      await screen.findByTestId('external-agent-paused-notice'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('external-agent-waiting')).toBeNull();

    await renderPage(fakeExternalAgentsClient(detail({ waiting: [] })));
    expect(screen.queryByTestId('external-agent-waiting')).toBeNull();
  });

  it('renders confirmation settings in server order with the current modes', async () => {
    const initial = detail();
    await renderPage(
      fakeExternalAgentsClient(
        detail({
          confirmationClasses: ['membership', 'profile', 'content'],
          confirmation: {
            ...initial.confirmation,
            membership: 'ask_first',
            content: 'ask_first',
          },
        }),
      ),
    );

    const section = await screen.findByTestId(
      'external-agent-confirmation-settings',
    );
    const actButtons = Array.from(
      section.querySelectorAll<HTMLElement>('[data-testid$="-act"]'),
    );
    expect(
      actButtons.map((button) => button.getAttribute('data-testid')),
    ).toEqual([
      'external-agent-confirmation-membership-act',
      'external-agent-confirmation-profile-act',
      'external-agent-confirmation-content-act',
    ]);
    expect(
      within(section).getByTestId(
        'external-agent-confirmation-membership-ask_first',
      ),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(section).getByTestId('external-agent-confirmation-profile-act'),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(section).not.toHaveTextContent('Destructive');
  });

  it('saves edited group access with the loaded revision and keep expiry', async () => {
    const initial = detail();
    const client = fakeExternalAgentsClient(initial);
    client.updateAccess.mockResolvedValue(
      result(
        detail({
          revision: 2,
          current: {
            ...initial.current,
            groups: { account: 'read', org: 'write' },
          },
        }),
      ),
    );
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    await clickWriteLevel();
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(await screen.findByTestId('external-agent-outcome')).toHaveAttribute(
      'data-outcome',
      'saved',
    );
    const updateCall = client.updateAccess.mock.calls[0];
    if (updateCall === undefined) throw new Error('Expected an access update');
    const [connectionId, update] = updateCall;
    expect(connectionId).toBe('connection-1');
    expect(update.revision).toBe(1);
    expect(update.access.groups.org).toBe('write');
    expect(update.expiry).toEqual({ kind: 'keep' });
    expect(update).not.toHaveProperty('confirmation');
  });

  it('loads destructive access for Organizations and warns when unverified', async () => {
    await renderPage(
      fakeExternalAgentsClient(
        detail({
          verified: false,
          current: {
            ...detail().current,
            groups: { account: 'read', org: 'destructive' },
          },
        }),
      ),
    );

    expect(
      screen.getByTestId('agent-access-destructive-switch-org'),
    ).toHaveAttribute('aria-checked', 'true');
    expect(
      screen.getByTestId('agent-access-destructive-warning-org'),
    ).toHaveTextContent(
      "This agent isn't verified. Allow this only if you trust it.",
    );
  });

  it('saves Library destructive access through the shared editor', async () => {
    const initial = detail({
      groups: [...ACCOUNT_GROUPS, LIBRARY_GROUP],
      current: {
        ...detail().current,
        groups: { account: 'read', org: 'read', library: 'write' },
      },
    });
    const client = fakeExternalAgentsClient(initial);
    client.updateAccess.mockResolvedValue(result(initial));
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    await fireEvent.click(
      screen.getByTestId('agent-access-destructive-switch-library'),
    );
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    const updateCall = client.updateAccess.mock.calls[0];
    if (updateCall === undefined) throw new Error('Expected an access update');
    expect(updateCall[1].access.groups.library).toBe('destructive');
  });

  it('hides and clears destructive access when an organization group is lowered', async () => {
    const initial = detail({
      current: {
        ...detail().current,
        groups: { account: 'read', org: 'destructive' },
      },
    });
    const client = fakeExternalAgentsClient(initial);
    client.updateAccess.mockResolvedValue(
      result({
        ...initial,
        current: {
          ...initial.current,
          groups: { account: 'read', org: 'read' },
        },
      }),
    );
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    await fireEvent.click(
      within(screen.getByTestId('agent-access-group-org')).getByRole('button', {
        name: 'Read',
      }),
    );
    expect(
      screen.queryByTestId('agent-access-destructive-switch-org'),
    ).not.toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    const updateCall = client.updateAccess.mock.calls[0];
    if (updateCall === undefined) throw new Error('Expected an access update');
    expect(updateCall[1].access.groups.org).toBe('read');
  });

  it('saves only the changed confirmation class', async () => {
    const client = fakeExternalAgentsClient();
    await renderPage(client);

    await screen.findByTestId('external-agent-confirmation-settings');
    expect(screen.getByTestId('external-agent-save')).toBeDisabled();
    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-profile-ask_first'),
    );
    expect(screen.getByTestId('external-agent-save')).not.toBeDisabled();
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(await screen.findByTestId('external-agent-outcome')).toHaveAttribute(
      'data-outcome',
      'saved',
    );
    const updateCall = client.updateAccess.mock.calls[0];
    if (updateCall === undefined) throw new Error('Expected an access update');
    expect(updateCall[1].confirmation).toEqual({ profile: 'ask_first' });
  });

  it('disables confirmation choices while an action is pending', async () => {
    const client = fakeExternalAgentsClient();
    const pending =
      deferred<ExternalAgentsResult<ExternalAgentConnectionDetail>>();
    client.updateAccess.mockReturnValue(pending.promise);
    await renderPage(client);

    await screen.findByTestId('external-agent-confirmation-settings');
    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-profile-ask_first'),
    );
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(
      screen.getByTestId('external-agent-confirmation-profile-act'),
    ).toBeDisabled();
    expect(
      screen.getByTestId('external-agent-confirmation-profile-ask_first'),
    ).toBeDisabled();

    pending.resolve(
      result(
        detail({
          confirmation: { ...detail().confirmation, profile: 'ask_first' },
        }),
      ),
    );
    await act(async (): Promise<void> => {
      await pending.promise;
      await Promise.resolve();
    });
  });

  it('discards confirmation changes back to the loaded modes', async () => {
    await renderPage(fakeExternalAgentsClient());

    await screen.findByTestId('external-agent-confirmation-settings');
    const askFirst = screen.getByTestId(
      'external-agent-confirmation-profile-ask_first',
    );
    await fireEvent.click(askFirst);
    expect(askFirst).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(screen.getByTestId('external-agent-discard'));

    expect(
      screen.getByTestId('external-agent-confirmation-profile-act'),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(askFirst).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('external-agent-save')).toBeDisabled();
  });

  it('saves only a changed text compatibility choice and warns about its cost', async () => {
    const client = fakeExternalAgentsClient();
    await renderPage(client);

    const toggle = await screen.findByTestId(
      'external-agent-text-content-compatibility',
    );
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.getByTestId('external-agent-compatibility'),
    ).toHaveTextContent('can increase the token cost of every tool result');
    expect(screen.getByTestId('external-agent-save')).toBeDisabled();

    await fireEvent.click(toggle);
    await fireEvent.click(screen.getByTestId('external-agent-discard'));
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('external-agent-save')).toBeDisabled();

    await fireEvent.click(toggle);
    await fireEvent.click(screen.getByTestId('external-agent-save'));
    expect(await screen.findByTestId('external-agent-outcome')).toHaveAttribute(
      'data-outcome',
      'saved',
    );
    const updateCall = client.updateAccess.mock.calls[0];
    if (updateCall === undefined) throw new Error('Expected an access update');
    expect(updateCall[1].textContentCompatibility).toBe(true);
    expect(updateCall[1].confirmation).toBeUndefined();
  });

  it('shows text compatibility on when the connection has it on', async () => {
    await renderPage(
      fakeExternalAgentsClient(detail({ textContentCompatibility: true })),
    );

    expect(
      await screen.findByTestId('external-agent-text-content-compatibility'),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('hides confirmation settings when no classes are offered', async () => {
    await renderPage(
      fakeExternalAgentsClient(detail({ confirmationClasses: [] })),
    );

    await screen.findByTestId('external-agent-page');
    expect(
      screen.queryByTestId('external-agent-confirmation-settings'),
    ).toBeNull();
  });

  it('saves a selected expiry in days from now', async () => {
    const client = fakeExternalAgentsClient();
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    await chooseAccessEnds('30');
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(await screen.findByTestId('external-agent-outcome')).toHaveAttribute(
      'data-outcome',
      'saved',
    );
    expect(client.updateAccess).toHaveBeenCalledWith(
      'connection-1',
      expect.objectContaining({
        revision: 1,
        expiry: { kind: 'days', days: 30 },
      }),
    );
  });

  it('reloads after a conflict and uses the new revision for the next save', async () => {
    const initial = detail();
    const latest = detail({ revision: 2 });
    const client = fakeExternalAgentsClient(initial);
    client.getConnection
      .mockResolvedValueOnce(result(initial))
      .mockResolvedValueOnce(result(latest));
    client.updateAccess.mockResolvedValueOnce(failure('conflict'));
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    await clickWriteLevel();
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(await screen.findByTestId('external-agent-outcome')).toHaveAttribute(
      'data-outcome',
      'conflict',
    );
    expect(screen.getByTestId('external-agent-outcome')).toHaveTextContent(
      'The page now shows its latest access. Make your changes again.',
    );
    await clickWriteLevel();
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    await screen.findByText('Saved.');
    expect(client.updateAccess).toHaveBeenNthCalledWith(
      2,
      'connection-1',
      expect.objectContaining({ revision: 2 }),
    );
  });

  it('explains an invalid policy after a rejected save', async () => {
    const client = fakeExternalAgentsClient();
    client.updateAccess.mockResolvedValue(failure('invalid_policy'));
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    await clickWriteLevel();
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(
      await screen.findByTestId('external-agent-outcome'),
    ).toHaveTextContent(
      'Check the groups you chose and keep it to 80 tools or fewer, then save again.',
    );
  });

  it('keeps Pause unavailable while access edits are unsaved', async () => {
    const client = fakeExternalAgentsClient();
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    expect(screen.getByTestId('external-agent-pause')).not.toBeDisabled();
    await clickWriteLevel();
    expect(screen.getByTestId('external-agent-pause')).toBeDisabled();
    expect(client.pause).not.toHaveBeenCalled();
  });

  it('keeps both Resume buttons unavailable while access edits are unsaved', async () => {
    const client = fakeExternalAgentsClient(detail({ status: 'paused' }));
    await renderPage(client);

    const notice = await screen.findByTestId('external-agent-paused-notice');
    const noticeResume = within(notice).getByRole('button', { name: 'Resume' });
    expect(noticeResume).not.toBeDisabled();
    await clickWriteLevel();
    expect(noticeResume).toBeDisabled();
    expect(screen.getByTestId('external-agent-resume')).toBeDisabled();
    await fireEvent.click(noticeResume);
    expect(client.resume).not.toHaveBeenCalled();
  });

  it('keeps Pause and Resume available when device access is unavailable', async () => {
    const client = fakeExternalAgentsClient(
      detail({
        server: 'tasks',
        remoteControlEnabled: false,
      }),
    );
    client.pause.mockResolvedValue(
      result(
        detail({
          server: 'tasks',
          remoteControlEnabled: false,
          status: 'paused',
        }),
      ),
    );
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    expect(
      screen.getByTestId('external-agent-devices-unavailable'),
    ).toHaveTextContent('Devices aren’t available yet.');
    expect(screen.getByTestId('external-agent-pause')).not.toBeDisabled();
    await fireEvent.click(screen.getByTestId('external-agent-discard'));
    expect(screen.getByTestId('external-agent-pause')).not.toBeDisabled();
    await fireEvent.click(screen.getByTestId('external-agent-pause'));
    const notice = await screen.findByTestId('external-agent-paused-notice');
    expect(
      within(notice).getByRole('button', { name: 'Resume' }),
    ).not.toBeDisabled();
    expect(screen.getByTestId('external-agent-resume')).not.toBeDisabled();
  });

  it('pauses and resumes the connection', async () => {
    const client = fakeExternalAgentsClient();
    client.pause.mockResolvedValue(result(detail({ status: 'paused' })));
    client.resume.mockResolvedValue(
      result(detail({ status: 'active', revision: 2 })),
    );
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    await fireEvent.click(screen.getByTestId('external-agent-pause'));
    expect(
      await screen.findByTestId('external-agent-paused-notice'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('external-agent-outcome')).toHaveAttribute(
      'data-outcome',
      'paused',
    );
    await fireEvent.click(screen.getByTestId('external-agent-resume'));
    expect(await screen.findByTestId('external-agent-outcome')).toHaveAttribute(
      'data-outcome',
      'resumed',
    );
    expect(client.pause).toHaveBeenCalledWith('connection-1', 1);
    expect(client.resume).toHaveBeenCalledWith('connection-1', 1);
  });

  it('asks before removing an agent and opens the list after confirmation', async () => {
    const onOpenPath = jest.fn<void, [string]>();
    const client = fakeExternalAgentsClient();
    await renderPage(client, 'connection-1', onOpenPath);

    await screen.findByTestId('external-agent-page');
    await fireEvent.click(screen.getByTestId('external-agent-remove'));
    expect(
      await screen.findByTestId('external-agent-remove-dialog'),
    ).toHaveTextContent(
      'Claude Desktop stops working with your account at once.',
    );
    await fireEvent.click(screen.getByTestId('external-agent-remove-confirm'));

    expect(client.remove).toHaveBeenCalledWith('connection-1');
    expect(onOpenPath).toHaveBeenCalledWith('/account/external-agents');
  });

  it('keeps expired access read-only and hides every action', async () => {
    await renderPage(fakeExternalAgentsClient(detail({ status: 'expired' })));

    const page = await screen.findByTestId('external-agent-page');
    expect(page).toHaveAttribute('data-status', 'expired');
    expect(
      screen.getByTestId('external-agent-expired-notice'),
    ).toHaveTextContent(
      'To use this agent again, connect it again from the agent.',
    );
    expect(screen.queryByTestId('external-agent-save')).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('external-agent-pause'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('external-agent-resume'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('external-agent-remove'),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByTestId('agent-access-group-org')).getByRole('button', {
        name: 'Write',
      }),
    ).toBeDisabled();
    expect(
      screen.getByTestId('external-agent-confirmation-profile-act'),
    ).toBeDisabled();
  });

  it('shows one Tasks group and Hosts only while Tasks access is on', async () => {
    await renderPage(fakeExternalAgentsClient(tasksDetail()));

    await screen.findByTestId('external-agent-page');
    const taskGroup = screen.getByTestId('agent-access-group-tasks');
    expect(taskGroup).toHaveTextContent('Tasks');
    expect(screen.queryByTestId('agent-access-group-cloud')).toBeNull();
    expect(screen.queryByTestId('agent-access-group-remote')).toBeNull();
    const hosts = screen.getByTestId('external-agent-hosts');
    expect(hosts).toBeInTheDocument();
    expect(
      screen.getByTestId('external-agent-host-choices'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('external-agent-hosts-managed')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(
      screen.getByTestId('external-agent-hosts-managed-row'),
    ).toHaveTextContent('Cloud agents · linux-managed');
    await fireEvent.click(
      screen.getByTestId('external-agent-devices-selected'),
    );
    expect(
      screen.getByTestId('external-agent-devices-empty'),
    ).toHaveTextContent('You haven’t paired a device yet.');
    expect(
      screen.getByTestId('external-agent-devices-all'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('external-agent-hosts-managed')).toHaveAttribute(
      'role',
      'switch',
    );

    await fireEvent.click(
      within(taskGroup).getByRole('button', { name: 'Read' }),
    );
    expect(screen.getByTestId('external-agent-hosts')).toBeInTheDocument();
    await fireEvent.click(
      within(taskGroup).getByRole('button', { name: 'Off' }),
    );
    expect(screen.queryByTestId('external-agent-hosts')).toBeNull();
  });

  it('saves the Cloud agents host switch as hosts.managed', async () => {
    const client = fakeExternalAgentsClient(tasksDetail());
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    const managed = screen.getByTestId('external-agent-hosts-managed');
    expect(managed).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(screen.getByTestId('external-agent-devices-all'));
    await fireEvent.click(managed);
    expect(managed).toHaveAttribute('aria-checked', 'false');
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(client.updateAccess.mock.calls[0]?.[1].access.hosts).toEqual({
      managed: false,
      connected: { mode: 'all', remoteIds: [] },
      exposeNames: false,
    });
  });

  it('blocks a Tasks grant with no hosts and lets the person restore a host', async () => {
    const client = fakeExternalAgentsClient(tasksDetail());
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    expect(screen.queryByTestId('external-agent-hosts-required')).toBeNull();
    await fireEvent.click(
      within(screen.getByTestId('agent-access-group-tasks')).getByRole(
        'button',
        { name: 'Read' },
      ),
    );
    expect(screen.getByTestId('external-agent-save')).not.toBeDisabled();
    await fireEvent.click(screen.getByTestId('external-agent-hosts-managed'));
    expect(
      screen.getByTestId('external-agent-hosts-required'),
    ).toHaveTextContent('Choose at least one host.');
    expect(screen.getByTestId('external-agent-save')).toBeDisabled();
    await fireEvent.click(screen.getByTestId('external-agent-hosts-managed'));
    expect(screen.queryByTestId('external-agent-hosts-required')).toBeNull();
    expect(screen.getByTestId('external-agent-save')).not.toBeDisabled();
  });

  it('hides Show device names on Account', async () => {
    await renderPage(fakeExternalAgentsClient(detail()));
    await screen.findByTestId('external-agent-page');
    expect(screen.queryByTestId('external-agent-expose-names')).toBeNull();
  });

  it('confirms Show device names before saving the Tasks host preference', async () => {
    const client = fakeExternalAgentsClient(tasksDetail());
    await renderPage(client);
    await screen.findByTestId('external-agent-page');
    const exposeNames = screen.getByTestId('external-agent-expose-names');
    expect(exposeNames).toHaveAttribute('aria-checked', 'false');
    await fireEvent.click(exposeNames);
    expect(
      await screen.findByTestId('external-agent-expose-names-dialog'),
    ).toHaveTextContent('Device names often include your name.');
    await fireEvent.click(
      screen.getByTestId('external-agent-expose-names-cancel'),
    );
    expect(exposeNames).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByTestId('external-agent-save')).toBeDisabled();

    await fireEvent.click(exposeNames);
    await fireEvent.click(
      screen.getByTestId('external-agent-expose-names-confirm'),
    );
    expect(exposeNames).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(screen.getByTestId('external-agent-save'));
    expect(
      client.updateAccess.mock.calls[0]?.[1].access.hosts.exposeNames,
    ).toBe(true);
  });

  it('turns off Show device names without opening a confirmation dialog', async () => {
    const initial = tasksDetail();
    const client = fakeExternalAgentsClient({
      ...initial,
      current: {
        ...initial.current,
        hosts: { ...initial.current.hosts, exposeNames: true },
      },
    });
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    const exposeNames = screen.getByTestId('external-agent-expose-names');
    expect(exposeNames).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(exposeNames);
    expect(exposeNames).toHaveAttribute('aria-checked', 'false');
    expect(
      screen.queryByTestId('external-agent-expose-names-dialog'),
    ).toBeNull();
    await fireEvent.click(screen.getByTestId('external-agent-save'));
    expect(
      client.updateAccess.mock.calls[0]?.[1].access.hosts.exposeNames,
    ).toBe(false);
  });

  it('loads selectable device rows with their host IDs and the stable-ID note', async () => {
    const client = fakeExternalAgentsClient(tasksDetail());
    const workDesktop = pairedDesktop(
      'c0ffee00-0000-4000-8000-000000000011',
      'Work desktop',
      'work.example',
    );
    const homeDesktop = pairedDesktop(
      'c0ffee00-0000-4000-8000-000000000012',
      'Home desktop',
      'home.example',
    );
    const desktops = [workDesktop, homeDesktop];
    client.listDesktops.mockResolvedValue(result({ desktops }));
    await render(
      <StrictMode>
        <CanopyClientProvider client={mockCanopyClient(client)}>
          <ExternalAgentPage
            connectionId="connection-1"
            onOpenPath={(): void => {}}
          />
        </CanopyClientProvider>
      </StrictMode>,
    );

    await screen.findByTestId('external-agent-device-choices');
    await fireEvent.click(
      screen.getByTestId('external-agent-devices-selected'),
    );
    const choices = screen.getByTestId('external-agent-device-choices');
    expect(client.listDesktops).toHaveBeenCalledTimes(1);
    expect(
      within(choices).getByTestId(
        'external-agent-device-c0ffee00-0000-4000-8000-000000000011',
      ),
    ).toBeInTheDocument();
    expect(
      within(choices).getByTestId(
        'external-agent-device-c0ffee00-0000-4000-8000-000000000012',
      ),
    ).toBeInTheDocument();
    expect(choices.querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
    expect(within(choices).getByText('Work desktop')).toBeInTheDocument();
    expect(within(choices).getByText('Home desktop')).toBeInTheDocument();
    expect(
      within(choices).getByTestId(
        'external-agent-device-host-id-c0ffee00-0000-4000-8000-000000000011',
      ),
    ).toHaveTextContent('7k3q9x2m4p');
    expect(choices.textContent).toContain('Work desktop · 7k3q9x2m4p');
    expect(
      screen.getByTestId('external-agent-host-ids-note'),
    ).toHaveTextContent(
      'Host IDs stay the same unless the app is reinstalled.',
    );
    expect(
      within(choices).getByText(
        `work.example · ${desktopConnectionHint(workDesktop)}`,
      ),
    ).toBeInTheDocument();
    expect(
      within(choices).getByText(
        `home.example · ${desktopConnectionHint(homeDesktop)}`,
      ),
    ).toBeInTheDocument();
  });

  it('removes an unavailable selected device from the saved access', async () => {
    const unavailableId = 'c0ffee00-0000-4000-8000-000000000013';
    const client = fakeExternalAgentsClient(tasksDetail([unavailableId]));
    await renderPage(client);

    await screen.findByTestId(
      `external-agent-device-unavailable-${unavailableId}`,
    );
    await fireEvent.click(
      screen.getByTestId(`external-agent-device-remove-${unavailableId}`),
    );
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(client.updateAccess).toHaveBeenCalledTimes(1);
    expect(
      client.updateAccess.mock.calls[0]?.[1].access.hosts.connected,
    ).toEqual({
      mode: 'selected',
      remoteIds: [],
    });
  });

  it('gives each unavailable device a distinct remove name', async () => {
    const client = fakeExternalAgentsClient(
      tasksDetail([
        'c0ffee00-0000-4000-8000-000000000015',
        'c0ffee00-0000-4000-8000-000000000016',
      ]),
    );
    await renderPage(client);

    await screen.findByTestId(
      'external-agent-device-unavailable-c0ffee00-0000-4000-8000-000000000016',
    );
    expect(
      screen
        .getByTestId(
          'external-agent-device-remove-c0ffee00-0000-4000-8000-000000000015',
        )
        .getAttribute('aria-label'),
    ).toBe('Remove unavailable device 1');
    expect(
      screen
        .getByTestId(
          'external-agent-device-remove-c0ffee00-0000-4000-8000-000000000016',
        )
        .getAttribute('aria-label'),
    ).toBe('Remove unavailable device 2');
  });

  it('saves a checked device as a selected host grant', async () => {
    const desktopId = 'c0ffee00-0000-4000-8000-000000000014';
    const client = fakeExternalAgentsClient(tasksDetail());
    client.listDesktops.mockResolvedValue(
      result({
        desktops: [pairedDesktop(desktopId, 'Work desktop', 'work.example')],
      }),
    );
    await renderPage(client);

    await screen.findByTestId('external-agent-device-choices');
    await fireEvent.click(
      screen.getByTestId('external-agent-devices-selected'),
    );
    const checkbox = await screen.findByTestId(
      `external-agent-device-${desktopId}`,
    );
    await fireEvent.click(checkbox);
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(
      client.updateAccess.mock.calls[0]?.[1].access.hosts.connected,
    ).toEqual({
      mode: 'selected',
      remoteIds: [desktopId],
    });
  });

  it('saves all devices with an empty remote id list', async () => {
    const client = fakeExternalAgentsClient(tasksDetail());
    await renderPage(client);

    await screen.findByTestId('external-agent-device-choices');
    await fireEvent.click(screen.getByTestId('external-agent-devices-all'));
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(
      client.updateAccess.mock.calls[0]?.[1].access.hosts.connected,
    ).toEqual({
      mode: 'all',
      remoteIds: [],
    });
  });

  it('saves No devices as a selected empty device list', async () => {
    const initial = tasksDetail();
    const client = fakeExternalAgentsClient({
      ...initial,
      current: {
        ...initial.current,
        hosts: {
          ...initial.current.hosts,
          connected: { mode: 'all', remoteIds: [] },
        },
      },
    });
    await renderPage(client);

    await screen.findByTestId('external-agent-device-choices');
    await fireEvent.click(screen.getByTestId('external-agent-devices-none'));
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(
      client.updateAccess.mock.calls[0]?.[1].access.hosts.connected,
    ).toEqual({
      mode: 'selected',
      remoteIds: [],
    });
  });

  it('keeps desktop-list errors recoverable without blocking other edits', async () => {
    const client = fakeExternalAgentsClient(tasksDetail());
    const listRequest =
      deferred<ExternalAgentsResult<ExternalAgentDesktopList>>();
    client.listDesktops.mockReturnValueOnce(listRequest.promise);
    await renderPage(client);

    await screen.findByTestId('external-agent-device-choices');
    await fireEvent.click(
      screen.getByTestId('external-agent-devices-selected'),
    );
    expect(choiceInput('external-agent-devices-selected').checked).toBe(true);
    await screen.findByTestId('external-agent-devices-loading');
    await act(async (): Promise<void> => {
      listRequest.resolve(failure('unavailable'));
      await listRequest.promise;
      for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
    });
    expect(client.listDesktops).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByTestId('external-agent-devices-error'),
    ).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('external-agent-devices-retry'));
    expect(client.listDesktops).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByTestId('external-agent-devices-empty'),
    ).toBeInTheDocument();
    await chooseAccessEnds('30');
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    expect(client.updateAccess).toHaveBeenCalledWith(
      'connection-1',
      expect.objectContaining({ expiry: { kind: 'days', days: 30 } }),
    );
  });

  it('shows devices unavailable and does not list devices when Remote Control is off', async () => {
    const client = fakeExternalAgentsClient(
      detail({
        server: 'tasks',
        remoteControlEnabled: false,
      }),
    );
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    expect(
      screen.getByTestId('external-agent-devices-unavailable'),
    ).toHaveTextContent('Devices aren’t available yet.');
    expect(client.listDesktops).not.toHaveBeenCalled();
  });

  it('does not load desktops for an Account-server connection', async () => {
    const client = fakeExternalAgentsClient(detail({ server: 'account' }));
    await renderPage(client);

    await screen.findByTestId('external-agent-page');

    expect(client.listDesktops).not.toHaveBeenCalled();
  });

  it('explains unavailable organizations while keeping saved choices enabled', async () => {
    const unavailableReason = 'The owner does not allow outside agents.';
    await renderPage(
      fakeExternalAgentsClient(
        detail({
          organizations: [
            {
              id: 'org-1',
              name: 'Northwind Labs',
              roleLine: 'You are an admin.',
              unavailableReason,
              personal: false,
            },
            {
              id: 'org-2',
              name: 'Former team',
              roleLine: 'You are a member.',
              unavailableReason,
              personal: false,
            },
            {
              id: 'org-3',
              name: 'Available organization',
              roleLine: 'You are an owner.',
              unavailableReason: null,
              personal: false,
            },
          ],
        }),
      ),
    );

    await screen.findByTestId('external-agent-page');
    const savedUnavailable = choiceInput('external-agent-organization-org-1');
    const unselectedUnavailable = choiceInput(
      'external-agent-organization-org-2',
    );
    const available = choiceInput('external-agent-organization-org-3');

    expect(savedUnavailable.disabled).toBe(false);
    expect(savedUnavailable.checked).toBe(true);
    expect(unselectedUnavailable.disabled).toBe(true);
    expect(available.disabled).toBe(false);
    expect(
      screen.getByText('Northwind Labs').parentElement?.textContent,
    ).toContain(unavailableReason);
    expect(
      screen.getByText('Former team').parentElement?.textContent,
    ).toContain(unavailableReason);
    expect(
      screen.getByText('Northwind Labs').parentElement?.textContent,
    ).not.toContain('You are an admin.');
    expect(
      screen.getByText('Former team').parentElement?.textContent,
    ).not.toContain('You are a member.');
    expect(
      screen.getByText('Available organization').parentElement?.textContent,
    ).toContain('You are an owner.');

    await fireEvent.click(savedUnavailable);
    expect(savedUnavailable.disabled).toBe(false);
    expect(savedUnavailable.checked).toBe(false);

    await fireEvent.click(savedUnavailable);
    expect(savedUnavailable.disabled).toBe(false);
    expect(savedUnavailable.checked).toBe(true);
  });

  it('keeps a Tasks connection’s selected organizations when only the expiry changes', async () => {
    const tasks = detail({ server: 'tasks' });
    const client = fakeExternalAgentsClient({
      ...tasks,
      current: {
        ...tasks.current,
        organizations: { mode: 'selected', organizationIds: ['org-1'] },
      },
    });
    await renderPage(client);

    await screen.findByTestId('external-agent-page');
    await chooseAccessEnds('30');
    await fireEvent.click(screen.getByTestId('external-agent-save'));

    const [connectionId, update] = client.updateAccess.mock.calls[0];
    expect(connectionId).toBe('connection-1');
    expect(update.access.organizations).toEqual({
      mode: 'selected',
      organizationIds: ['org-1'],
    });
    expect(update.expiry).toEqual({ kind: 'days', days: 30 });
  });

  it('shows a not-found state with a way back to the list', async () => {
    const onOpenPath = jest.fn<void, [string]>();
    const client = fakeExternalAgentsClient();
    client.getConnection.mockResolvedValue(failure('not_found'));
    await renderPage(client, 'missing', onOpenPath);

    expect(
      await screen.findByTestId('external-agent-not-found'),
    ).toHaveTextContent('This agent isn’t connected anymore.');
    await fireEvent.click(
      screen.getByRole('button', { name: 'Back to External agents' }),
    );
    expect(onOpenPath).toHaveBeenCalledWith('/account/external-agents');
  });
});

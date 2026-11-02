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
  ExternalAgentConnectionSummary,
  ExternalAgentConnectionDetail,
  ExternalAgentAccessUpdate,
  ExternalAgentNotice,
  ExternalAgentWaitingAction,
  ExternalAgentsOverview,
} from '@canopy/protocol/external-agents';
import type {
  ExternalAgentsClient,
  ExternalAgentsResult,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { ExternalAgentsPage } from '../ExternalAgentsPage';
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

const ACCOUNT_URL = 'https://account.example.test/api/v1/mcp/account';
const TASKS_URL = 'https://account.example.test/api/v1/mcp/tasks';
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
};

afterEach((): void => {
  act((): void => roots.forEach((root) => root.unmount()));
  roots.length = 0;
  document.body.replaceChildren();
  localStorage.clear();
});

function result<T>(value: T): ExternalAgentsResult<T> {
  return { ok: true, value };
}

function failure<T>(error: 'unavailable'): ExternalAgentsResult<T> {
  return { ok: false, error };
}

function connection(
  overrides: Partial<ExternalAgentConnectionSummary> = {},
): ExternalAgentConnectionSummary {
  return {
    id: 'connection-1',
    server: 'account',
    clientName: 'Claude',
    verified: true,
    status: 'active',
    createdAt: '2026-10-12T15:00:00.000Z',
    lastUsedAt: '2026-10-15T10:00:00.000Z',
    expiresAt: null,
    access: {
      read: ['account', 'org'],
      write: ['digests'],
      destructive: [],
      organizations: 1,
      desktops: null,
      managed: null,
    },
    ...overrides,
  };
}

function notice(
  overrides: Partial<ExternalAgentNotice> = {},
): ExternalAgentNotice {
  return {
    kind: 'connected',
    connectionId: 'connection-1',
    clientName: 'Claude',
    server: 'account',
    at: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

function waitingAction(
  overrides: Partial<ExternalAgentWaitingAction> = {},
): ExternalAgentWaitingAction {
  const now = Date.now();
  return {
    pendingActionId: 'pending/one?',
    connectionId: 'connection-1',
    clientName: 'Claude',
    server: 'account',
    action: 'Update your profile',
    requestedAt: new Date(now - 120_000).toISOString(),
    decisionExpiresAt: new Date(now + 480_000).toISOString(),
    ...overrides,
  };
}

function overview(
  overrides: Partial<ExternalAgentsOverview> = {},
): ExternalAgentsOverview {
  return {
    notices: [],
    waiting: [],
    servers: [
      { server: 'account', url: ACCOUNT_URL },
      { server: 'tasks', url: TASKS_URL },
    ],
    cursorClientId: 'cursor-client-42',
    connections: [],
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
  value: ExternalAgentsOverview = overview(),
): FakeExternalAgentsClient {
  return {
    getOverview: jest
      .fn<Promise<ExternalAgentsResult<ExternalAgentsOverview>>, []>()
      .mockResolvedValue(result(value)),
    getConnection: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string]
      >()
      .mockResolvedValue(failure<ExternalAgentConnectionDetail>('unavailable')),
    listDesktops: () => Promise.resolve({ ok: true, value: { desktops: [] } }),
    updateAccess: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string, ExternalAgentAccessUpdate]
      >()
      .mockResolvedValue(failure<ExternalAgentConnectionDetail>('unavailable')),
    pause: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string, number]
      >()
      .mockResolvedValue(failure<ExternalAgentConnectionDetail>('unavailable')),
    resume: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string, number]
      >()
      .mockResolvedValue(failure<ExternalAgentConnectionDetail>('unavailable')),
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

function mockCanopyClient(externalAgents?: ExternalAgentsClient): CanopyClient {
  return {
    capabilities: CAPABILITIES,
    ...(externalAgents === undefined ? {} : { externalAgents }),
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
  externalAgents?: ExternalAgentsClient,
  onOpenPath: (path: string) => void = (): void => {},
): Promise<{ readonly container: HTMLElement }> {
  return render(
    <CanopyClientProvider client={mockCanopyClient(externalAgents)}>
      <ExternalAgentsPage onOpenPath={onOpenPath} />
    </CanopyClientProvider>,
  );
}

describe('ExternalAgentsPage', () => {
  it('finishes loading when development mode mounts it twice', async () => {
    const externalAgents = fakeExternalAgentsClient(
      overview({ connections: [connection()] }),
    );
    await render(
      <StrictMode>
        <CanopyClientProvider client={mockCanopyClient(externalAgents)}>
          <ExternalAgentsPage onOpenPath={(): void => {}} />
        </CanopyClientProvider>
      </StrictMode>,
    );

    expect(await screen.findByTestId('external-agent-row')).toBeInTheDocument();
    // The divider draws on a plain wrapper; the button fills the padded row.
    const row = screen.getByTestId('external-agent-row');
    expect(row.parentElement?.tagName).toBe('DIV');
    expect(row.parentElement?.className ?? '').not.toMatch(/rounded/);
    expect(row.className).toMatch(/-my-3/);
    expect(row.className).toMatch(/\bpy-3\b/);
    expect(screen.queryByTestId('external-agents-loading')).toBeNull();
  });

  it('shows the unavailable state when the client has no external-agents support', async () => {
    await render(
      <CanopyClientProvider client={mockCanopyClient()}>
        <ExternalAgentsPage onOpenPath={(): void => {}} />
      </CanopyClientProvider>,
    );

    expect(
      screen.getByTestId('external-agents-unavailable'),
    ).toBeInTheDocument();
  });

  it('shows the unavailable state when the host does not offer the capability', async () => {
    await render(
      <CanopyClientProvider
        client={{
          ...mockCanopyClient(fakeExternalAgentsClient()),
          capabilities: { ...CAPABILITIES, externalAgents: false },
        }}
      >
        <ExternalAgentsPage onOpenPath={(): void => {}} />
      </CanopyClientProvider>,
    );

    expect(
      screen.getByTestId('external-agents-unavailable'),
    ).toBeInTheDocument();
  });

  it('shows only the connect and setup sections when there are no connections', async () => {
    await renderPage(fakeExternalAgentsClient());

    const page = await screen.findByTestId('external-agents-page');
    expect(
      within(page).getByRole('heading', { name: 'Connect an agent' }),
    ).toBeInTheDocument();
    expect(
      within(page).queryByTestId('external-agents-list'),
    ).not.toBeInTheDocument();
    expect(
      within(page).queryByTestId('external-agents-waiting'),
    ).not.toBeInTheDocument();
    expect(
      Array.from(
        page.querySelectorAll<HTMLElement>('section'),
        (section) => section.dataset.testid,
      ),
    ).toEqual(['external-agents-connect', 'external-agents-setup']);
  });

  it('shows waiting requests with timing and opens the confirmation page', async () => {
    const onOpenPath = jest.fn<void, [string]>();
    const waiting = waitingAction();
    await renderPage(
      fakeExternalAgentsClient(overview({ waiting: [waiting] })),
      onOpenPath,
    );

    const section = await screen.findByTestId('external-agents-waiting');
    expect(section).toHaveTextContent('Waiting for you');
    const row = await screen.findByTestId('external-agents-waiting-row');
    expect(row).toHaveAttribute(
      'data-pending-action-id',
      waiting.pendingActionId,
    );
    expect(row).toHaveTextContent('Claude · Account and organizations.');
    expect(row).toHaveTextContent('Asked');
    expect(row).toHaveTextContent('Expires');

    await fireEvent.click(
      within(row).getByRole('button', { name: 'Review: Update your profile' }),
    );
    expect(onOpenPath).toHaveBeenCalledWith(
      externalAgentConfirmationPath(waiting.pendingActionId),
    );
  });

  it('shows server addresses in server order and copies a Cursor snippet with both URLs and the client id', async () => {
    await renderPage(fakeExternalAgentsClient());

    const account = await screen.findByTestId('external-agents-server-account');
    const tasks = screen.getByTestId('external-agents-server-tasks');
    expect(
      account.compareDocumentPosition(tasks) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(account).getByText(ACCOUNT_URL)).toBeInTheDocument();
    expect(
      within(account).getByRole('button', { name: 'Copy' }),
    ).toBeInTheDocument();
    expect(within(tasks).getByText(TASKS_URL)).toBeInTheDocument();
    expect(
      within(tasks).getByRole('button', { name: 'Copy' }),
    ).toBeInTheDocument();

    await fireEvent.click(screen.getByTestId('external-agents-cursor-toggle'));
    const snippet = screen.getByTestId('external-agents-cursor-snippet');
    expect(snippet.textContent).toContain(ACCOUNT_URL);
    expect(snippet.textContent).toContain(TASKS_URL);
    expect(snippet.textContent).toContain('cursor-client-42');
    expect(
      screen.getByTestId('external-agents-cursor-copy'),
    ).toHaveAccessibleName('Copy entries');
  });

  it('gives each CLI agent a copyable command for every server', async () => {
    await renderPage(fakeExternalAgentsClient());

    await screen.findByTestId('external-agents-claude-code');
    for (const [agent, name] of [
      ['claude-code', 'Claude Code'],
      ['codex', 'Codex'],
      ['opencode', 'OpenCode'],
      ['hermes', 'Hermes'],
      ['openclaw', 'OpenClaw'],
    ] as const) {
      const section = screen.getByTestId(`external-agents-${agent}`);
      expect(within(section).getByText(name)).toBeInTheDocument();
      await fireEvent.click(
        screen.getByTestId(`external-agents-${agent}-toggle`),
      );
      for (const [server, url] of [
        ['account', ACCOUNT_URL],
        ['tasks', TASKS_URL],
      ] as const) {
        const block = screen.getByTestId(`external-agents-${agent}-${server}`);
        // OpenCode's per-server command signs in; its URLs are in the config.
        if (agent !== 'opencode') expect(block.textContent).toContain(url);
        expect(block.textContent).toContain(server);
        expect(
          screen.getByTestId(`external-agents-${agent}-${server}-copy`),
        ).toBeInTheDocument();
      }
    }
    // OpenClaw can't sign in yet, and its section says so.
    expect(
      screen.getByTestId('external-agents-openclaw').textContent,
    ).toContain('OpenClaw can’t sign in here yet');
    const config = screen.getByTestId('external-agents-opencode-config');
    expect(config.textContent).toContain(ACCOUNT_URL);
    expect(config.textContent).toContain(TASKS_URL);
  });

  it('collapses each agent setup to its name until the toggle opens it', async () => {
    await renderPage(fakeExternalAgentsClient());

    const setup = await screen.findByTestId('external-agents-setup');
    expect(
      within(setup).getByRole('heading', {
        name: 'Set up your preferred agent',
      }),
    ).toBeInTheDocument();
    expect(setup.textContent).toContain(
      'Click to see your agent’s specific setup steps.',
    );
    const toggle = within(setup).getByTestId('external-agents-codex-toggle');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle.textContent).toBe('Codex');
    expect(
      document.querySelector('[data-testid="external-agents-codex-account"]'),
    ).toBeNull();

    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(
      screen.getByTestId('external-agents-codex-account'),
    ).toBeInTheDocument();

    await fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      document.querySelector('[data-testid="external-agents-codex-account"]'),
    ).toBeNull();
  });

  it('heads each agent-specific setup with its name and tells Muse users the client ID', async () => {
    await renderPage(fakeExternalAgentsClient());

    const cursor = await screen.findByTestId('external-agents-cursor');
    expect(within(cursor).getByText('Cursor')).toBeInTheDocument();
    expect(cursor.textContent).not.toContain('Using Cursor?');

    const muse = screen.getByTestId('external-agents-muse');
    expect(within(muse).getByText('Meta Muse')).toBeInTheDocument();
    await fireEvent.click(screen.getByTestId('external-agents-muse-toggle'));
    expect(muse.textContent).toContain('custom connector');
    expect(muse.textContent).toContain('meta-muse');
    expect(
      screen.getByTestId('external-agents-muse-copy'),
    ).toHaveAccessibleName('Copy client ID');
  });

  it('shows summaries and status pills and opens an encoded connection path when a row is clicked', async () => {
    const onOpenPath = jest.fn<void, [string]>();
    const connections = [
      connection({ id: 'paused-id', status: 'paused' }),
      connection({ id: 'expired-id', status: 'expired' }),
      connection({ id: 'id with / slash', verified: false, lastUsedAt: null }),
    ];
    await renderPage(
      fakeExternalAgentsClient(overview({ connections })),
      onOpenPath,
    );

    const rows = await screen.findAllByTestId('external-agent-row');
    expect(rows).toHaveLength(3);
    const pausedRow = findRow(rows, 'paused-id');
    const expiredRow = findRow(rows, 'expired-id');
    const unverifiedRow = findRow(rows, 'id with / slash');
    expect(
      within(pausedRow).getByTestId('external-agent-row-status'),
    ).toHaveTextContent('Paused');
    expect(
      within(expiredRow).getByTestId('external-agent-row-status'),
    ).toHaveTextContent('Expired');
    expect(within(unverifiedRow).getByText('Unverified')).toBeInTheDocument();
    expect(within(unverifiedRow).getByText(/Not used yet/)).toBeInTheDocument();
    expect(
      within(pausedRow).getByText(
        'Reads account and organizations. Writes digests. 1 organization.',
      ),
    ).toBeInTheDocument();

    await fireEvent.click(unverifiedRow);
    expect(onOpenPath).toHaveBeenCalledWith(
      '/account/external-agents/id%20with%20%2F%20slash',
    );
  });

  it('shows the Tasks host summary with managed host and device count', async () => {
    const tasksConnection = connection({
      id: 'tasks-connection',
      server: 'tasks',
      access: {
        read: [],
        write: ['tasks'],
        destructive: [],
        organizations: null,
        desktops: 2,
        managed: true,
      },
    });
    await renderPage(
      fakeExternalAgentsClient(overview({ connections: [tasksConnection] })),
    );

    const row = await screen.findByTestId('external-agent-row');
    expect(
      within(row).getByText('Writes tasks on linux-managed and 2 devices.'),
    ).toBeInTheDocument();
  });

  it('renders notice copy with a Review action that opens the connection', async () => {
    const onOpenPath = jest.fn<void, [string]>();
    await renderPage(
      fakeExternalAgentsClient(
        overview({ notices: [notice({ kind: 'widened' })] }),
      ),
      onOpenPath,
    );

    const newNotice = await screen.findByTestId('external-agents-notice');
    expect(newNotice).toHaveTextContent('Access widened.');
    expect(newNotice).toHaveTextContent(
      'Claude can now do more with Account and organizations.',
    );
    await fireEvent.click(
      within(newNotice).getByRole('button', { name: 'Review' }),
    );
    expect(onOpenPath).toHaveBeenCalledWith(
      '/account/external-agents/connection-1',
    );
  });

  it('dismisses a notice and keeps it dismissed on the next visit', async () => {
    const notices = [
      notice(),
      notice({ kind: 'widened', at: '2026-10-15T11:00:00.000Z' }),
    ];
    await renderPage(fakeExternalAgentsClient(overview({ notices })));

    const [connected] = await screen.findAllByTestId('external-agents-notice');
    await fireEvent.click(
      within(connected).getByRole('button', {
        name: 'Dismiss: Claude can now use Account and organizations.',
      }),
    );

    const remaining = await screen.findAllByTestId('external-agents-notice');
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toHaveTextContent('Access widened.');

    act((): void => roots.forEach((root) => root.unmount()));
    roots.length = 0;
    document.body.replaceChildren();
    await renderPage(fakeExternalAgentsClient(overview({ notices })));

    const revisited = await screen.findAllByTestId('external-agents-notice');
    expect(revisited).toHaveLength(1);
    expect(revisited[0]).toHaveTextContent('Access widened.');
  });

  it('shows an error and retries a failed overview load', async () => {
    const client = fakeExternalAgentsClient();
    client.getOverview
      .mockResolvedValueOnce(failure('unavailable'))
      .mockResolvedValueOnce(result(overview()));
    await renderPage(client);

    expect(
      await screen.findByTestId('external-agents-error'),
    ).toHaveTextContent('Couldn’t load your agents.');
    await fireEvent.click(screen.getByTestId('external-agents-retry'));

    expect(
      await screen.findByTestId('external-agents-server-account'),
    ).toBeInTheDocument();
    expect(client.getOverview).toHaveBeenCalledTimes(2);
  });
});

function findRow(rows: readonly HTMLElement[], id: string): HTMLElement {
  const row = rows.find(
    (candidate) => candidate.getAttribute('data-connection-id') === id,
  );
  if (row === undefined) throw new Error(`Missing row ${id}`);
  return row;
}

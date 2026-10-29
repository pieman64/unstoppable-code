/**
 * @jest-environment jsdom
 */
import { act, StrictMode, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
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
  ExternalAgentConnectionDetail,
  ExternalAgentPendingAction,
  ExternalAgentToolResult,
  ExternalAgentsOverview,
} from '@canopy/protocol/external-agents';
import type {
  ExternalAgentsClient,
  ExternalAgentsResult,
} from '@canopy/app-core';
import { CanopyClientProvider } from '@canopy/app-state';
import { domFireEvent, screen } from './dom-test-kit';
import { ExternalAgentConfirmationPage } from '../ExternalAgentConfirmationPage';

const CAPABILITIES: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'crud-only',
  routing: 'url',
  externalAgents: true,
};

const roots: Root[] = [];
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function success<T>(value: T): ExternalAgentsResult<T> {
  return { ok: true, value };
}

function failure<T>(
  error: 'not_found' | 'conflict' | 'expired' | 'unavailable',
): ExternalAgentsResult<T> {
  return { ok: false, error };
}

function toolResult(
  overrides: Partial<ExternalAgentToolResult> = {},
): ExternalAgentToolResult {
  return {
    resultType: 'complete',
    content: [{ type: 'text', text: 'Sam was removed from Northwind Labs.' }],
    structuredContent: {},
    isError: false,
    ...overrides,
  };
}

function pendingAction(
  overrides: Partial<ExternalAgentPendingAction> = {},
): ExternalAgentPendingAction {
  return {
    pendingActionId: 'pending-action-1',
    connectionId: 'connection-1',
    server: 'account',
    clientName: 'Claude Desktop',
    clientVerified: true,
    toolName: 'org_member_remove',
    confirmation: {
      class: 'destructive',
      action: 'Remove Sam Rivera from Northwind Labs',
      effects: [
        'Sam loses access to Northwind Labs and its projects.',
        'You can invite Sam again, but this cannot be undone from here.',
      ],
      resolvedTargets: [
        { resourceKind: 'organization', displayName: 'Northwind Labs' },
        { resourceKind: 'team_member', displayName: 'Sam Rivera' },
      ],
    },
    status: 'pending',
    arguments: { organizationId: 'org-1', memberId: 'member-1' },
    requestedAt: '2026-10-15T10:05:00.000Z',
    decisionExpiresAt: '2026-10-15T10:15:00.000Z',
    confirmedAt: null,
    terminalAt: null,
    outcomeExpiresAt: null,
    outcome: null,
    ...overrides,
  };
}

function connectionDetail(
  overrides: Partial<ExternalAgentConnectionDetail> = {},
): ExternalAgentConnectionDetail {
  return {
    id: 'connection-1',
    server: 'account',
    clientName: 'Claude Desktop',
    verified: true,
    status: 'active',
    createdAt: '2026-10-12T15:00:00.000Z',
    lastUsedAt: '2026-10-15T10:00:00.000Z',
    expiresAt: null,
    access: {
      read: [],
      write: [],
      destructive: [],
      organizations: null,
      desktops: null,
    },
    revision: 4,
    from: null,
    returnsTo: '127.0.0.1:50123',
    loopback: true,
    groups: [],
    current: {
      groups: { account: 'read' },
      disabledTools: [],
      enabledDefaultOff: [],
      organizations: { mode: 'selected', organizationIds: [] },
      remotes: { mode: 'selected', remoteIds: [] },
    },
    organizations: [],
    remoteControlEnabled: false,
    maxTools: 80,
    activity: [],
    confirmationClasses: [],
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
    [string, Parameters<ExternalAgentsClient['updateAccess']>[1]]
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
  readonly getPendingAction: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentPendingAction>>,
    [string]
  >;
  readonly decidePendingAction: jest.Mock<
    Promise<ExternalAgentsResult<ExternalAgentPendingAction>>,
    [string, 'confirm' | 'decline']
  >;
  readonly getWaitingCount: jest.Mock<
    Promise<ExternalAgentsResult<number>>,
    []
  >;
}

function fakeExternalAgentsClient(
  initialAction: ExternalAgentPendingAction = pendingAction(),
): FakeExternalAgentsClient {
  return {
    getOverview: jest
      .fn<Promise<ExternalAgentsResult<ExternalAgentsOverview>>, []>()
      .mockResolvedValue(
        success({
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
      .mockResolvedValue(success(connectionDetail())),
    listDesktops: () => Promise.resolve({ ok: true, value: { desktops: [] } }),
    updateAccess: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string, Parameters<ExternalAgentsClient['updateAccess']>[1]]
      >()
      .mockResolvedValue(success(connectionDetail())),
    pause: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string, number]
      >()
      .mockResolvedValue(success(connectionDetail({ status: 'paused' }))),
    resume: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentConnectionDetail>>,
        [string, number]
      >()
      .mockResolvedValue(success(connectionDetail())),
    remove: jest
      .fn<Promise<ExternalAgentsResult<null>>, [string]>()
      .mockResolvedValue(success(null)),
    getPendingAction: jest
      .fn<Promise<ExternalAgentsResult<ExternalAgentPendingAction>>, [string]>()
      .mockResolvedValue(success(initialAction)),
    decidePendingAction: jest
      .fn<
        Promise<ExternalAgentsResult<ExternalAgentPendingAction>>,
        [string, 'confirm' | 'decline']
      >()
      .mockResolvedValue(success(initialAction)),
    getWaitingCount: jest
      .fn<Promise<ExternalAgentsResult<number>>, []>()
      .mockResolvedValue(success(0)),
  };
}

function mockCanopyClient(
  externalAgents: ExternalAgentsClient | undefined,
  capabilities: CanopyCapabilities = CAPABILITIES,
): CanopyClient {
  return {
    capabilities,
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

async function renderPage(
  client: ExternalAgentsClient | undefined,
  options: {
    readonly capabilities?: CanopyCapabilities;
    readonly onOpenPath?: (path: string) => void;
    readonly strict?: boolean;
  } = {},
): Promise<{ readonly container: HTMLElement }> {
  const page = (
    <CanopyClientProvider
      client={mockCanopyClient(client, options.capabilities)}
    >
      <ExternalAgentConfirmationPage
        pendingActionId="pending-action-1"
        onOpenPath={options.onOpenPath ?? ((): void => {})}
      />
    </CanopyClientProvider>
  );
  return render(options.strict ? <StrictMode>{page}</StrictMode> : page);
}

function clearRenderedPages(): void {
  act((): void => roots.forEach((root) => root.unmount()));
  roots.length = 0;
  document.body.replaceChildren();
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
  jest.useRealTimers();
});

describe('ExternalAgentConfirmationPage', () => {
  it('loads in StrictMode and shows the request details with a collapsed exact request', async () => {
    const client = fakeExternalAgentsClient();
    await renderPage(client, { strict: true });

    const page = await screen.findByTestId('external-agent-confirmation');
    expect(page).toHaveAttribute('data-status', 'pending');
    expect(
      screen.getByRole('heading', {
        name: 'Remove Sam Rivera from Northwind Labs',
        level: 1,
      }),
    ).toBeInTheDocument();
    expect(page).toHaveTextContent(
      'Claude Desktop asked to do this for you. Nothing happens unless you confirm.',
    );
    expect(page).toHaveTextContent('Account and organizations');
    expect(page).toHaveTextContent('Organization');
    expect(page).toHaveTextContent('Northwind Labs');
    expect(page).toHaveTextContent('Team member');
    expect(page).toHaveTextContent('Sam Rivera');
    expect(page).toHaveTextContent('What happens');
    expect(page).toHaveTextContent(
      'Sam loses access to Northwind Labs and its projects.',
    );

    const asked = page.querySelector('[title*="2026"]');
    expect(asked).toBeInTheDocument();
    expect(asked?.textContent).toMatch(/ago|now|under a minute/);
    const expiration = page.querySelectorAll('[title]');
    expect(expiration.length).toBeGreaterThan(0);

    const toggle = screen.getByTestId(
      'external-agent-confirmation-request-toggle',
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(
      screen.queryByTestId('external-agent-confirmation-request'),
    ).toBeNull();
    await fireEvent.click(toggle);
    const exactRequest = screen.getByTestId(
      'external-agent-confirmation-request',
    );
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(exactRequest).toHaveTextContent('org_member_remove');
    expect(exactRequest.querySelector('pre')?.textContent).toBe(
      '{\n  "organizationId": "org-1",\n  "memberId": "member-1"\n}',
    );

    const confirm = screen.getByTestId('external-agent-confirmation-confirm');
    const decline = screen.getByTestId('external-agent-confirmation-decline');
    expect(confirm).not.toBeDisabled();
    expect(decline).not.toBeDisabled();
    expect(document.activeElement).not.toBe(confirm);
    expect(confirm.getAttribute('type')).toBe('button');
    expect(decline.getAttribute('type')).toBe('button');
    expect(confirm.className).toContain('bg-destructive');
    expect(page.querySelector('form')).toBeNull();
  });

  it('opens the connected agent page from its identity row', async () => {
    const onOpenPath = jest.fn<void, [string]>();
    await renderPage(fakeExternalAgentsClient(), { onOpenPath });
    await screen.findByTestId('external-agent-confirmation');
    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-agent-link'),
    );
    expect(onOpenPath).toHaveBeenCalledWith(
      '/account/external-agents/connection-1',
    );
  });

  it('confirms directly to a completed result', async () => {
    const client = fakeExternalAgentsClient();
    const completed = pendingAction({
      status: 'executed',
      outcome: toolResult(),
      terminalAt: '2026-10-15T10:06:00.000Z',
    });
    client.decidePendingAction.mockResolvedValueOnce(success(completed));
    await renderPage(client);
    await screen.findByTestId('external-agent-confirmation');

    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-confirm'),
    );

    expect(client.decidePendingAction).toHaveBeenCalledWith(
      'pending-action-1',
      'confirm',
    );
    const outcome = await screen.findByTestId(
      'external-agent-confirmation-outcome',
    );
    expect(outcome).toHaveAttribute('data-outcome', 'executed');
    expect(outcome).toHaveTextContent('Done.');
    expect(outcome).toHaveTextContent(
      'The agent will get the result the next time it asks.',
    );
    expect(
      screen.getByTestId('external-agent-confirmation-open-agents'),
    ).toBeInTheDocument();
    expect(outcome).toHaveTextContent('Sam was removed from Northwind Labs.');
  });

  it('disables both decisions while one is being sent', async () => {
    const client = fakeExternalAgentsClient();
    let resolveDecision:
      | ((value: ExternalAgentsResult<ExternalAgentPendingAction>) => void)
      | null = null;
    client.decidePendingAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDecision = resolve;
        }),
    );
    await renderPage(client);
    await screen.findByTestId('external-agent-confirmation');

    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-confirm'),
    );
    expect(
      screen.getByTestId('external-agent-confirmation-confirm'),
    ).toBeDisabled();
    expect(
      screen.getByTestId('external-agent-confirmation-decline'),
    ).toBeDisabled();

    const finish = resolveDecision;
    if (finish === null)
      throw new Error('Expected the decision request to start');
    await act(async (): Promise<void> => {
      finish(
        success(
          pendingAction({
            status: 'executed',
            outcome: toolResult(),
          }),
        ),
      );
      await Promise.resolve();
    });
    expect(
      await screen.findByTestId('external-agent-confirmation-outcome'),
    ).toHaveAttribute('data-outcome', 'executed');
  });

  it('explains when argument retention has removed the exact request', async () => {
    await renderPage(
      fakeExternalAgentsClient(pendingAction({ arguments: null })),
    );
    await screen.findByTestId('external-agent-confirmation');
    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-request-toggle'),
    );
    const request = screen.getByTestId('external-agent-confirmation-request');
    expect(request).toHaveTextContent('org_member_remove');
    expect(request).toHaveTextContent('The exact request is no longer kept.');
    expect(request.querySelector('pre')).toBeNull();
  });

  it('runs after Confirm, polls while running, and shows the result', async () => {
    const client = fakeExternalAgentsClient();
    const confirmed = pendingAction({
      status: 'confirmed',
      confirmedAt: '2026-10-15T10:05:30.000Z',
    });
    const completed = pendingAction({
      status: 'executed',
      outcome: toolResult(),
      terminalAt: '2026-10-15T10:06:00.000Z',
    });
    client.decidePendingAction.mockResolvedValueOnce(success(confirmed));
    await renderPage(client);
    await screen.findByTestId('external-agent-confirmation');
    client.getPendingAction.mockResolvedValueOnce(success(completed));
    jest.useFakeTimers();

    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-confirm'),
    );
    expect(
      screen.getByTestId('external-agent-confirmation-running'),
    ).toHaveTextContent('Running');
    expect(client.getPendingAction).toHaveBeenCalledTimes(1);

    await act(async (): Promise<void> => {
      await jest.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
    });
    expect(client.getPendingAction).toHaveBeenCalledTimes(2);
    expect(
      screen.getByTestId('external-agent-confirmation-outcome'),
    ).toHaveAttribute('data-outcome', 'executed');
    expect(
      screen.getByTestId('external-agent-confirmation-outcome'),
    ).toHaveTextContent('Sam was removed from Northwind Labs.');
  });

  it('offers Reload when the result poll times out and restarts polling on reload', async () => {
    const client = fakeExternalAgentsClient();
    client.decidePendingAction.mockResolvedValueOnce(
      success(pendingAction({ status: 'confirmed' })),
    );
    await renderPage(client);
    await screen.findByTestId('external-agent-confirmation');
    client.getPendingAction.mockResolvedValue(
      success(pendingAction({ status: 'confirmed' })),
    );
    jest.useFakeTimers();

    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-confirm'),
    );
    await act(async (): Promise<void> => {
      await jest.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
    });
    const reload = screen.getByTestId('external-agent-confirmation-reload');
    expect(
      screen.getByTestId('external-agent-confirmation-outcome'),
    ).toHaveTextContent('The result isn’t known yet.');

    client.getPendingAction.mockResolvedValueOnce(
      success(pendingAction({ status: 'confirmed' })),
    );
    await fireEvent.click(reload);
    expect(
      screen.getByTestId('external-agent-confirmation-outcome'),
    ).toHaveAttribute('data-outcome', 'confirmed');
    expect(
      screen.getByTestId('external-agent-confirmation-running'),
    ).toBeInTheDocument();

    client.getPendingAction.mockResolvedValueOnce(
      success(
        pendingAction({
          status: 'executed',
          outcome: toolResult(),
        }),
      ),
    );
    await act(async (): Promise<void> => {
      await jest.advanceTimersByTimeAsync(2_000);
      await Promise.resolve();
    });
    expect(
      screen.getByTestId('external-agent-confirmation-outcome'),
    ).toHaveAttribute('data-outcome', 'executed');
    expect(
      screen.getByTestId('external-agent-confirmation-outcome'),
    ).toHaveTextContent('Sam was removed from Northwind Labs.');
  });

  it('shows an executed error and a failed action reason', async () => {
    const executedError = fakeExternalAgentsClient(
      pendingAction({
        status: 'executed',
        outcome: toolResult({
          content: [{ type: 'text', text: 'The member was not removed.' }],
          structuredContent: { message: 'Sam still belongs to this team.' },
          isError: true,
        }),
      }),
    );
    await renderPage(executedError);
    const executedOutcome = await screen.findByTestId(
      'external-agent-confirmation-outcome',
    );
    expect(executedOutcome).toHaveAttribute('data-outcome', 'executed');
    expect(executedOutcome).toHaveTextContent('This action couldn’t run.');
    expect(executedOutcome).toHaveTextContent(
      'Sam still belongs to this team.',
    );
    expect(executedOutcome).not.toHaveTextContent(
      'Sam was removed from Northwind Labs.',
    );

    clearRenderedPages();
    const failed = fakeExternalAgentsClient(
      pendingAction({
        status: 'failed',
        outcome: toolResult({
          content: [{ type: 'text', text: 'The organization is read-only.' }],
          structuredContent: {},
          isError: true,
        }),
      }),
    );
    await renderPage(failed);
    const failedOutcome = await screen.findByTestId(
      'external-agent-confirmation-outcome',
    );
    expect(failedOutcome).toHaveAttribute('data-outcome', 'failed');
    expect(failedOutcome).toHaveTextContent('The organization is read-only.');
  });

  it('declines, offers to pause, and pauses using the current connection revision', async () => {
    const client = fakeExternalAgentsClient();
    let resolveConnection:
      | ((value: ExternalAgentsResult<ExternalAgentConnectionDetail>) => void)
      | null = null;
    client.getConnection.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveConnection = resolve;
        }),
    );
    client.decidePendingAction.mockResolvedValueOnce(
      success(pendingAction({ status: 'declined' })),
    );
    const onOpenPath = jest.fn<void, [string]>();
    await renderPage(client, { onOpenPath });
    await screen.findByTestId('external-agent-confirmation');

    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-decline'),
    );
    const outcome = await screen.findByTestId(
      'external-agent-confirmation-outcome',
    );
    expect(client.decidePendingAction).toHaveBeenCalledWith(
      'pending-action-1',
      'decline',
    );
    expect(outcome).toHaveTextContent('Declined.');
    expect(outcome).toHaveTextContent('Nothing was changed.');
    expect(
      screen.getByTestId('external-agent-confirmation-pause'),
    ).toHaveTextContent('Pause Claude Desktop');

    const pause = screen.getByTestId('external-agent-confirmation-pause');
    await fireEvent.click(pause);
    expect(pause).toBeDisabled();
    const finishConnection = resolveConnection;
    if (finishConnection === null) {
      throw new Error('Expected the connection request to start');
    }
    await act(async (): Promise<void> => {
      finishConnection(success(connectionDetail()));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(client.getConnection).toHaveBeenCalledWith('connection-1');
    expect(client.pause).toHaveBeenCalledWith('connection-1', 4);
    const paused = await screen.findByTestId(
      'external-agent-confirmation-paused',
    );
    expect(paused).toHaveTextContent(
      'Claude Desktop can’t read or change anything until you resume it.',
    );
    await fireEvent.click(screen.getByText('Open Claude Desktop'));
    expect(onOpenPath).toHaveBeenCalledWith(
      '/account/external-agents/connection-1',
    );
  });

  it('lets the person retry a failed pause', async () => {
    const client = fakeExternalAgentsClient();
    client.decidePendingAction.mockResolvedValueOnce(
      success(pendingAction({ status: 'declined' })),
    );
    client.getConnection
      .mockResolvedValueOnce(failure('unavailable'))
      .mockResolvedValueOnce(success(connectionDetail()));
    await renderPage(client);
    await screen.findByTestId('external-agent-confirmation');
    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-decline'),
    );
    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-pause'),
    );
    expect(
      await screen.findByTestId('external-agent-confirmation-pause-failed'),
    ).toHaveTextContent('Couldn’t pause Claude Desktop. Try again.');
    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-pause'),
    );
    expect(
      await screen.findByTestId('external-agent-confirmation-paused'),
    ).toBeInTheDocument();
    expect(client.getConnection).toHaveBeenCalledTimes(2);
  });

  it('does not offer to pause a decline loaded on a later visit', async () => {
    await renderPage(
      fakeExternalAgentsClient(pendingAction({ status: 'declined' })),
    );
    const outcome = await screen.findByTestId(
      'external-agent-confirmation-outcome',
    );
    expect(outcome).toHaveTextContent('The agent will be told you declined.');
    expect(
      screen.queryByTestId('external-agent-confirmation-pause'),
    ).toBeNull();
    expect(
      screen.getByTestId('external-agent-confirmation-open-agents'),
    ).toBeInTheDocument();
  });

  it.each([
    ['declined', 'confirmation_declined', 'Declined.'],
    ['expired', 'confirmation_expired', 'This request expired.'],
  ] as const)(
    'shows a %s request without a failure, even with its stored error result',
    async (status, code, title) => {
      const message = 'The confirmation did not go ahead.';
      await renderPage(
        fakeExternalAgentsClient(
          pendingAction({
            status,
            outcome: {
              resultType: 'complete',
              content: [{ type: 'text', text: message }],
              structuredContent: { kind: 'failed_precondition', code, message },
              isError: true,
            },
          }),
        ),
      );
      const outcome = await screen.findByTestId(
        'external-agent-confirmation-outcome',
      );
      expect(outcome).toHaveTextContent(title);
      expect(outcome).not.toHaveTextContent('This action couldn’t run.');
    },
  );

  it('shows an expired request and lets the person open External agents', async () => {
    await renderPage(
      fakeExternalAgentsClient(pendingAction({ status: 'expired' })),
    );
    const outcome = await screen.findByTestId(
      'external-agent-confirmation-outcome',
    );
    expect(outcome).toHaveTextContent('This request expired.');
    expect(outcome).toHaveTextContent('Nothing was changed.');
    expect(
      screen.queryByTestId('external-agent-confirmation-confirm'),
    ).toBeNull();
    expect(
      screen.getByTestId('external-agent-confirmation-open-agents'),
    ).toBeInTheDocument();
  });

  it('reloads after a conflict and shows the latest outcome', async () => {
    const latest = pendingAction({
      status: 'executed',
      outcome: toolResult(),
    });
    const client = fakeExternalAgentsClient();
    client.getPendingAction
      .mockResolvedValueOnce(success(pendingAction()))
      .mockResolvedValueOnce(success(latest));
    client.decidePendingAction.mockResolvedValueOnce(failure('conflict'));
    await renderPage(client);
    await screen.findByTestId('external-agent-confirmation');

    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-confirm'),
    );

    const outcome = await screen.findByTestId(
      'external-agent-confirmation-outcome',
    );
    expect(outcome).toHaveAttribute('data-outcome', 'conflict');
    expect(outcome).toHaveTextContent('Already decided.');
    expect(outcome).toHaveTextContent('Sam was removed from Northwind Labs.');
    expect(client.getPendingAction).toHaveBeenCalledTimes(2);
  });

  it('reports an expired decision that was not saved', async () => {
    const client = fakeExternalAgentsClient();
    client.getPendingAction
      .mockResolvedValueOnce(success(pendingAction()))
      .mockResolvedValueOnce(success(pendingAction({ status: 'expired' })));
    client.decidePendingAction.mockResolvedValueOnce(failure('expired'));
    await renderPage(client);
    await screen.findByTestId('external-agent-confirmation');

    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-confirm'),
    );

    const outcome = await screen.findByTestId(
      'external-agent-confirmation-outcome',
    );
    expect(outcome).toHaveAttribute('data-outcome', 'expired');
    expect(outcome).toHaveTextContent(
      'It expired before your choice was saved.',
    );
    expect(outcome).toHaveTextContent('Nothing was changed.');
  });

  it('reports an unavailable decision and leaves the choice available to retry', async () => {
    const client = fakeExternalAgentsClient();
    client.decidePendingAction.mockResolvedValueOnce(failure('unavailable'));
    await renderPage(client);
    await screen.findByTestId('external-agent-confirmation');

    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-confirm'),
    );

    const outcome = screen.getByTestId('external-agent-confirmation-outcome');
    expect(outcome).toHaveAttribute('data-outcome', 'unavailable');
    expect(outcome).toHaveTextContent('Couldn’t confirm this request.');
    expect(
      screen.getByTestId('external-agent-confirmation-confirm'),
    ).not.toBeDisabled();
    expect(
      screen.getByTestId('external-agent-confirmation-decline'),
    ).not.toBeDisabled();
  });

  it('shows no action details when the request is not found', async () => {
    const client = fakeExternalAgentsClient();
    client.getPendingAction.mockResolvedValue(failure('not_found'));
    const onOpenPath = jest.fn<void, [string]>();
    await renderPage(client, { onOpenPath });

    const notFound = await screen.findByTestId(
      'external-agent-confirmation-not-found',
    );
    expect(notFound).toHaveTextContent('This request isn’t available.');
    expect(notFound).toHaveTextContent(
      'Requests waiting for you are listed in External agents.',
    );
    const page = screen.getByTestId('external-agent-confirmation');
    expect(page).not.toHaveTextContent('Remove Sam Rivera');
    expect(page).not.toHaveTextContent('org_member_remove');
    expect(
      screen.getByTestId('external-agent-confirmation-open-agents'),
    ).toBeInTheDocument();
    await fireEvent.click(
      screen.getByTestId('external-agent-confirmation-open-agents'),
    );
    expect(onOpenPath).toHaveBeenCalledWith('/account/external-agents');
  });

  it('offers a retry after a load problem', async () => {
    const client = fakeExternalAgentsClient();
    client.getPendingAction
      .mockResolvedValueOnce(failure('unavailable'))
      .mockResolvedValueOnce(success(pendingAction()));
    await renderPage(client);

    expect(
      await screen.findByTestId('external-agent-confirmation-problem'),
    ).toHaveTextContent('Couldn’t load this request.');
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByTestId('external-agent-confirmation'),
    ).toHaveAttribute('data-status', 'pending');
    expect(client.getPendingAction).toHaveBeenCalledTimes(2);
  });

  it('shows a skeleton while loading', async () => {
    const client = fakeExternalAgentsClient();
    let resolveAction:
      | ((value: ExternalAgentsResult<ExternalAgentPendingAction>) => void)
      | null = null;
    client.getPendingAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAction = resolve;
        }),
    );
    await renderPage(client);
    expect(
      screen.getByTestId('external-agent-confirmation-loading'),
    ).toHaveAttribute('role', 'status');

    const finish = resolveAction;
    if (finish === null)
      throw new Error('Expected the action request to start');
    await act(async (): Promise<void> => {
      finish(success(pendingAction()));
      await Promise.resolve();
    });
    expect(
      await screen.findByTestId('external-agent-confirmation'),
    ).toHaveAttribute('data-status', 'pending');
  });

  it('uses the unavailable state when the capability or client is missing', async () => {
    await renderPage(fakeExternalAgentsClient(), {
      capabilities: { ...CAPABILITIES, externalAgents: false },
    });
    expect(
      await screen.findByTestId('external-agents-unavailable'),
    ).toBeInTheDocument();

    clearRenderedPages();
    await renderPage(undefined);
    expect(
      await screen.findByTestId('external-agents-unavailable'),
    ).toBeInTheDocument();
  });
});

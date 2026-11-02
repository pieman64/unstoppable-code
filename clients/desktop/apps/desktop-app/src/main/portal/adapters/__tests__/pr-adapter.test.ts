import type {
  PortalCommandEnvelope,
  PortalEventEnvelope,
} from '@canopy/desktop-shared/types';
import { handlePortalPrAction, handlePortalPrCreate } from '../pr-adapter';
import type { PortalAdapterContext } from '../types';
import { createPullRequest, runPrAction } from '../../../services/pr-service';
import { PortalServiceError } from '../../../services/portal-service-error';

jest.mock('../../../services/pr-service', () => ({
  createPullRequest: jest.fn(),
  refreshPullRequestState: jest.fn(),
  runPrAction: jest.fn(),
}));

const mockedRunPrAction = jest.mocked(runPrAction);
const mockedCreatePullRequest = jest.mocked(createPullRequest);

function command<TPayload>(
  payload: TPayload,
  type: PortalCommandEnvelope['type'] = 'portal.pr.action',
): PortalCommandEnvelope<TPayload> {
  return {
    id: 'cmd-1',
    sequence: 7,
    type,
    payload,
    createdAt: '2026-05-06T00:00:00.000Z',
    expiresAt: null,
  };
}

function adapterContext(
  events: PortalEventEnvelope[],
  getWindow?: PortalAdapterContext['getWindow'],
): PortalAdapterContext {
  return {
    getWindow: getWindow ?? ((): null => null),
    enqueueEvent: (event) => events.push(event),
    complete: (cmd, result): void => {
      events.push({
        type: 'portal.command.completed',
        commandId: cmd.id,
        payload: { result },
      } as PortalEventEnvelope);
    },
    fail: (cmd, code, message): void => {
      events.push({
        type: 'portal.command.failed',
        commandId: cmd.id,
        payload: { error: { code, message } },
      } as PortalEventEnvelope);
    },
  };
}

describe('PR portal adapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('dispatches portal.pr.create through the service and emits a PR delta', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedCreatePullRequest.mockResolvedValue({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
      state: 'open',
    });

    await handlePortalPrCreate(
      command(
        {
          workspaceLocalId: 'ws-1',
          worktreeLocalId: 'wt-1',
          title: 'Portal PR',
          body: 'Created from Remote Control.',
        },
        'portal.pr.create',
      ),
      adapterContext(events),
    );

    expect(mockedCreatePullRequest).toHaveBeenCalledWith({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      title: 'Portal PR',
      body: 'Created from Remote Control.',
    });
    expect(events.map((event) => event.type)).toEqual([
      'portal.state.delta',
      'portal.command.completed',
    ]);
  });

  it('dispatches portal.pr.action through the service and emits a PR delta', async () => {
    const events: PortalEventEnvelope[] = [];
    const getWindow = jest.fn(() => null);
    mockedRunPrAction.mockResolvedValue({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      number: 42,
      url: 'https://github.com/acme/repo/pull/42',
      state: 'open',
    });

    await handlePortalPrAction(
      command({
        action: 'push',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      }),
      adapterContext(events, getWindow),
    );

    expect(mockedRunPrAction).toHaveBeenCalledWith(
      {
        action: 'push',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      },
      { getWindow },
    );
    expect(events.map((event) => event.type)).toEqual([
      'portal.state.delta',
      'portal.command.completed',
    ]);
  });

  it('maps service failures to portal.command.failed', async () => {
    const events: PortalEventEnvelope[] = [];
    mockedRunPrAction.mockRejectedValue(
      new PortalServiceError('execution_failed', 'No auth'),
    );

    await handlePortalPrAction(
      command({
        action: 'push',
        workspaceLocalId: 'ws-1',
        worktreeLocalId: 'wt-1',
      }),
      adapterContext(events),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'portal.command.failed',
      payload: {
        error: { code: 'execution_failed', message: 'No auth' },
      },
    });
  });
});

it('forwards the GitHub desktop connection error unchanged', async () => {
  const events: PortalEventEnvelope[] = [];
  mockedRunPrAction.mockRejectedValue(
    new PortalServiceError(
      'github_not_connected',
      'Connect GitHub on the desktop, then retry.',
    ),
  );
  await handlePortalPrAction(
    command({
      workspaceLocalId: 'ws-1',
      worktreeLocalId: 'wt-1',
      action: 'push',
    }),
    adapterContext(events),
  );
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'portal.command.failed',
      payload: {
        error: {
          code: 'github_not_connected',
          message: 'Connect GitHub on the desktop, then retry.',
        },
      },
    }),
  );
});

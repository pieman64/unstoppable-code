import type { ProjectsSteerQueuedMessageAction } from '@canopy/desktop-shared/lib/chat-send-actions';
import { APP_ADVISOR_PROJECT_ID } from '@canopy/desktop-shared/types';
import { DiscoveryError } from '../../project-discovery/errors';
import { AgentSenderContextError } from '../sender-context';
import { dispatchAgentChatSteer } from '../steer-orchestration';
import type { TrustedSendCaller } from '../send-orchestration';
import type * as SenderContextModule from '../sender-context';

const mockResolve = jest.fn();
const mockIdentity = jest.fn();
const mockDispatch = jest.fn();
const mockPort = jest.fn();
jest.mock('../../project-discovery/chat-target', () => ({
  resolveAuthorizedChat: (...args: unknown[]): unknown => mockResolve(...args),
}));
jest.mock('../sender-context', () => {
  const actual =
    jest.requireActual<typeof SenderContextModule>('../sender-context');
  return {
    ...actual,
    resolveAgentSenderIdentity: (...args: unknown[]): unknown =>
      mockIdentity(...args),
  };
});
jest.mock('../../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: (): object => ({}),
}));
jest.mock('../../ipc/chat-state', () => ({
  getChatStateCommandPort: (): unknown => mockPort(),
}));
jest.mock('../../canopy-runtime/core-chat-command-adapter', () => ({
  createChatCommandDispatchOptions: (
    _port: unknown,
    _runtime: unknown,
    caller: unknown,
  ): object => ({ caller }),
  dispatchTrustedChatCommand: (...args: unknown[]): unknown =>
    mockDispatch(...args),
}));

const source = {
  projectId: 'source-project',
  worktreeId: 'source-task',
  chatId: 'source-chat',
};
const address = {
  projectId: 'target-project',
  taskId: 'target-task',
  chatId: 'target-chat',
};
const actor = {
  kind: 'project',
  projectType: 'code',
  projectId: source.projectId,
  taskId: source.worktreeId,
  chatId: source.chatId,
};
const action: ProjectsSteerQueuedMessageAction = {
  type: 'projects.steer_queued_message',
  ...address,
  queuedMessageId: 'queue-1',
};
const context: { caller: TrustedSendCaller } = {
  caller: { kind: 'project_root', source },
};
function resolvedTarget(tab: object = {}): object {
  return {
    address,
    scope: {
      workspaceId: address.projectId,
      worktreeId: address.taskId,
      chatId: address.chatId,
    },
    tab: { id: address.chatId, ...tab },
  };
}
beforeEach(() => {
  jest.resetAllMocks();
  mockResolve.mockResolvedValue(resolvedTarget());
  mockIdentity.mockResolvedValue(actor);
  mockDispatch.mockResolvedValue({ outcome: 'applied' });
  mockPort.mockReturnValue({ command: jest.fn() });
});
it.each(['applied', 'already_applied'])(
  'returns a steer receipt for %s and dispatches the separate actor',
  async (outcome) => {
    mockDispatch.mockResolvedValue({ outcome });
    const before = Date.now();
    const receipt = await dispatchAgentChatSteer(action, context);
    expect(receipt).toMatchObject({
      address,
      queuedMessageId: action.queuedMessageId,
      disposition: 'steered',
    });
    expect(Date.parse(receipt.steeredAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(receipt.steeredAt)).toBeLessThanOrEqual(Date.now());
    expect(mockIdentity).toHaveBeenCalledWith(source);
    expect(mockResolve).toHaveBeenCalledWith(address, {
      kind: 'project_agent',
      ...source,
    });
    const [envelope] = mockDispatch.mock.calls[0] as [{ commandId: unknown }];
    expect(typeof envelope.commandId).toBe('string');
    expect(mockDispatch).toHaveBeenCalledWith(
      {
        schemaVersion: 1,
        commandId: envelope.commandId,
        projectId: address.projectId,
        worktreeId: address.taskId,
        command: {
          type: 'chat.steer_queued_message',
          chatId: address.chatId,
          queuedMessageId: 'queue-1',
          agentSteeringActor: actor,
        },
      },
      {
        caller: {
          principalId: 'local-desktop-user',
          clientInstanceId: 'agent-chat-steer',
          authorityId: 'local-desktop',
          interfaceKind: 'mcp',
          grants: ['core.chat.write'],
        },
      },
    );
  },
);
it('allows self-steering because it creates no input', async () => {
  mockResolve.mockResolvedValue({
    ...resolvedTarget(),
    address: {
      projectId: source.projectId,
      taskId: source.worktreeId,
      chatId: source.chatId,
    },
    scope: {
      workspaceId: source.projectId,
      worktreeId: source.worktreeId,
      chatId: source.chatId,
    },
  });
  await expect(dispatchAgentChatSteer(action, context)).resolves.toMatchObject({
    disposition: 'steered',
  });
});
it('refuses rejected steering with missing_capability', async () => {
  mockDispatch.mockResolvedValue({ outcome: 'rejected' });
  await expect(dispatchAgentChatSteer(action, context)).rejects.toMatchObject({
    code: 'missing_capability',
    message: "The queued message can't be steered now. It stays queued.",
  });
});
it('maps thrown queue failures to missing_capability', async () => {
  mockDispatch.mockRejectedValue(new Error('Settings differ'));
  await expect(dispatchAgentChatSteer(action, context)).rejects.toMatchObject({
    code: 'missing_capability',
  });
});
it('maps a steering-agent refusal during dispatch to not_found', async () => {
  mockDispatch.mockRejectedValue(
    new AgentSenderContextError(
      'not_found',
      'The target chat is not available.',
    ),
  );
  await expect(dispatchAgentChatSteer(action, context)).rejects.toMatchObject({
    code: 'not_found',
  });
});
it('maps a missing queued row to not_found', async () => {
  mockDispatch.mockResolvedValue({ outcome: 'not_found' });
  await expect(dispatchAgentChatSteer(action, context)).rejects.toMatchObject({
    code: 'not_found',
  });
});
it.each(['owner_boundary', 'authorization_conflict'] as const)(
  'hides %s targets',
  async (code) => {
    mockResolve.mockRejectedValue(
      new AgentSenderContextError(code, 'Private owner'),
    );
    await expect(dispatchAgentChatSteer(action, context)).rejects.toMatchObject(
      { code: 'not_found', message: 'The target chat is not available.' },
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  },
);
it.each(['not_found', 'advisor_access_disabled'] as const)(
  'maps discovery %s',
  async (code) => {
    mockResolve.mockRejectedValue(new DiscoveryError(code, 'Private detail'));
    await expect(dispatchAgentChatSteer(action, context)).rejects.toMatchObject(
      { code },
    );
  },
);
it.each([
  { readOnly: true },
  { staleSessionDetected: false },
  { kind: 'file' },
])('refuses unavailable tabs %j', async (tab) => {
  mockResolve.mockResolvedValue(resolvedTarget(tab));
  await expect(dispatchAgentChatSteer(action, context)).rejects.toMatchObject({
    code: 'not_found',
  });
  expect(mockDispatch).not.toHaveBeenCalled();
});
it('refuses parse failures before target resolution', async () => {
  await expect(
    dispatchAgentChatSteer({ ...action, queuedMessageId: '' }, context),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(mockResolve).not.toHaveBeenCalled();
});
it('refuses inconsistent trusted callers', async () => {
  await expect(
    dispatchAgentChatSteer(action, {
      caller: {
        kind: 'project_root',
        source: { ...source, projectId: APP_ADVISOR_PROJECT_ID },
      },
    }),
  ).rejects.toMatchObject({ code: 'validation_failed' });
  expect(mockResolve).not.toHaveBeenCalled();
});
it('refuses when the command port is unavailable', async () => {
  mockPort.mockReturnValue(undefined);
  await expect(dispatchAgentChatSteer(action, context)).rejects.toMatchObject({
    code: 'target_not_ready',
  });
});
it('maps other outcomes to target_not_ready', async () => {
  mockDispatch.mockResolvedValue({ outcome: 'revision_conflict' });
  await expect(dispatchAgentChatSteer(action, context)).rejects.toMatchObject({
    code: 'target_not_ready',
  });
});

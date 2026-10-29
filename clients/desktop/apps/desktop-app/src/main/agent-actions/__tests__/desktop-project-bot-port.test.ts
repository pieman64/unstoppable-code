import { AgentPortError, type AgentActionCall } from '@canopy/agent-actions';
import type {
  ChatCreationAction,
  ChatSendAction,
} from '@canopy/desktop-shared/lib/chat-send-actions';
import type { AgentChatSendContext } from '../../agent-messaging/send-orchestration';
import type { CanopyInjectedToolRuntime } from '../../canopy-tools/core';
import type { DesktopAgentMessageAdmission } from '../desktop-environment-port';

const mockSend = jest.fn<
  Promise<object>,
  [ChatSendAction, AgentChatSendContext]
>();
jest.mock('../../agent-messaging/send-orchestration', (): object => ({
  ...jest.requireActual<object>('../../agent-messaging/send-orchestration'),
  dispatchAgentChatSend: mockSend,
}));
const mockCreate = jest.fn<
  Promise<object>,
  [ChatCreationAction, AgentChatSendContext]
>();
jest.mock('../../agent-messaging/creation-orchestration', (): object => ({
  dispatchAgentChatCreation: mockCreate,
}));
const mockPortAdmission = jest.fn<
  Promise<DesktopAgentMessageAdmission>,
  [object, AgentActionCall<CanopyInjectedToolRuntime>, object?]
>();
const mockStartedChatAdmission = jest.fn<
  Promise<void>,
  [object, AgentActionCall<CanopyInjectedToolRuntime>]
>();
jest.mock('../desktop-environment-port', (): object => ({
  createDesktopEnvironmentPort: (): object => ({
    agentMessageAdmission: mockPortAdmission,
    agentStartedChatMessageAdmission: mockStartedChatAdmission,
  }),
  desktopEnvironmentPortDeps: (): object => ({}),
}));

import {
  admitScheduledProjectMessage,
  createDesktopProjectBotPort,
  readmitQueuedProjectMessage,
  type DesktopAgentAdmissions,
} from '../desktop-project-bot-port';

function admissions(
  overrides: Partial<DesktopAgentAdmissions>,
): () => Promise<DesktopAgentAdmissions> {
  return () =>
    Promise.resolve({
      agentMessageAdmission: () =>
        Promise.reject(new Error('Unexpected message admission.')),
      agentChatStartAdmission: () =>
        Promise.reject(new Error('Unexpected start admission.')),
      agentStartedChatMessageAdmission: () =>
        Promise.reject(new Error('Unexpected started chat admission.')),
      ...overrides,
    });
}

const call: AgentActionCall<CanopyInjectedToolRuntime> = {
  host: {
    requestUserAnswers: () => Promise.resolve([]),
    loadScriptOutput: () => Promise.resolve({ found: false, lines: [] }),
  },
  scope: { workspaceId: 'source', worktreeId: 'task', chatId: 'chat' },
  toolUseId: 'tool',
};
const action: ChatSendAction = {
  type: 'projects.send_message',
  projectId: 'target',
  taskId: 'target-task',
  chatId: 'target-chat',
  text: 'Hello',
};
const target = {
  workspaceId: 'target',
  worktreeId: 'target-task',
  chatId: 'target-chat',
};

beforeEach(() => {
  // The orchestration reads the admission first, as the real send does.
  mockSend.mockReset().mockImplementation(async (_action, context) => {
    const admission = await context.admission?.(target);
    const refusal = admission?.refusal();
    if (refusal) throw refusal;
    return { disposition: 'started', messageId: 'input' };
  });
});

describe('desktop project and bot port admission', () => {
  it('reads the admission for the target chat with the trusted call', async () => {
    const admission = jest.fn().mockResolvedValue({
      check: (): undefined => undefined,
      refusal: (): undefined => undefined,
    });
    const port = createDesktopProjectBotPort(
      admissions({ agentMessageAdmission: admission }),
    );
    await expect(port.dispatch(action, call)).resolves.toMatchObject({
      ok: true,
    });
    expect(admission).toHaveBeenCalledWith(target, call);
  });

  it.each([
    ['invalid_target', 'invalid_target'],
    ['authorization_conflict', 'authorization_conflict'],
  ] as const)(
    'reports an up-front %s refusal as %s',
    async (code, expected) => {
      const port = createDesktopProjectBotPort(
        admissions({
          agentMessageAdmission: () =>
            Promise.reject(new AgentPortError(code, 'Refused.')),
        }),
      );
      await expect(port.dispatch(action, call)).resolves.toEqual({
        ok: false,
        error: { code: expected, message: 'Refused.' },
      });
    },
  );

  it('reports approvals that changed during the commit as retryable', async () => {
    const port = createDesktopProjectBotPort(
      admissions({
        agentMessageAdmission: () =>
          Promise.resolve({
            check: (): string => 'Refused.',
            refusal: () =>
              new AgentPortError('stale_ui_state', 'Approvals changed.', true),
          }),
      }),
    );
    await expect(port.dispatch(action, call)).resolves.toEqual({
      ok: false,
      error: {
        code: 'stale_ui_state',
        message: 'Approvals changed.',
        retryable: true,
      },
    });
  });

  it("reads a creation's start admission for the trusted call, typing its refusal", async () => {
    const start = jest
      .fn()
      .mockResolvedValueOnce({ approvalMode: 'ask' })
      .mockRejectedValueOnce(
        new AgentPortError('authorization_conflict', 'Broader.'),
      );
    mockCreate.mockImplementation(async (_action, context) => ({
      started: await context.startAdmission?.(
        { workspaceId: 'target', worktreeId: 'new-task' },
        true,
      ),
    }));
    const port = createDesktopProjectBotPort(
      admissions({ agentChatStartAdmission: start }),
    );
    const create: ChatCreationAction = {
      type: 'projects.create_task',
      projectId: 'target',
      initialMessage: 'Hello',
    };
    await expect(port.dispatch(create, call)).resolves.toEqual({
      ok: true,
      result: { started: { approvalMode: 'ask' } },
    });
    expect(start).toHaveBeenCalledWith(
      { workspaceId: 'target', worktreeId: 'new-task' },
      true,
      call,
    );
    await expect(port.dispatch(create, call)).resolves.toEqual({
      ok: false,
      error: { code: 'authorization_conflict', message: 'Broader.' },
    });
  });

  it('admits a scheduled delivery with the scheduling chat as the caller', async () => {
    mockPortAdmission.mockResolvedValue({
      check: (): undefined => undefined,
      refusal: (): undefined => undefined,
    });
    const sender = {
      workspaceId: 'source',
      worktreeId: 'task',
      chatId: 'chat',
    };
    const sent = { kind: 'chat' as const, selectedRepoId: 'repo' };
    await admitScheduledProjectMessage(sender, target, sent);
    expect(mockPortAdmission).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ scope: sender }),
      sent,
    );
    mockPortAdmission.mockRejectedValue(
      new AgentPortError('authorization_conflict', 'Broader.'),
    );
    await expect(
      admitScheduledProjectMessage(sender, target, sent),
    ).rejects.toMatchObject({ code: 'authorization_conflict' });
  });

  it('admits a queued scheduled delivery again against the chat as it is then', async () => {
    const sender = {
      workspaceId: 'source',
      worktreeId: 'task',
      chatId: 'chat',
    };
    mockPortAdmission.mockResolvedValue({
      check: (): undefined => undefined,
      refusal: (): undefined => undefined,
    });
    await readmitQueuedProjectMessage(sender, target);
    expect(mockPortAdmission).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ scope: sender }),
    );
    for (const [code, senderCode] of [
      ['invalid_target', 'target_not_ready'],
      ['not_found', 'not_found'],
      ['authorization_conflict', 'authorization_conflict'],
      ['stale_ui_state', 'authorization_conflict'],
    ] as const) {
      mockPortAdmission.mockRejectedValueOnce(
        new AgentPortError(code, 'Refused.'),
      );
      await expect(
        readmitQueuedProjectMessage(sender, target),
      ).rejects.toMatchObject({
        name: 'AgentSenderContextError',
        code: senderCode,
        message: 'Refused.',
      });
    }
  });

  it("admits a started chat's queued first message again as its start was admitted", async () => {
    const sender = {
      workspaceId: 'source',
      worktreeId: 'task',
      chatId: 'chat',
    };
    mockPortAdmission.mockClear();
    mockStartedChatAdmission.mockResolvedValue(undefined);
    await readmitQueuedProjectMessage(sender, target, true);
    expect(mockStartedChatAdmission).toHaveBeenCalledWith(
      target,
      expect.objectContaining({ scope: sender }),
    );
    expect(mockPortAdmission).not.toHaveBeenCalled();
    mockStartedChatAdmission.mockRejectedValueOnce(
      new AgentPortError('authorization_conflict', 'Broader.'),
    );
    await expect(
      readmitQueuedProjectMessage(sender, target, true),
    ).rejects.toMatchObject({
      name: 'AgentSenderContextError',
      code: 'authorization_conflict',
    });
  });
});

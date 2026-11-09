import type {
  McpQuestion,
  McpQuestionAnswer,
  PortalCommandEnvelope,
  PortalCommandPayloadMap,
} from '@canopy/desktop-shared/types';
import type { ExternalAgentSender } from '@canopy/protocol/portal';
import {
  createChatStateServiceFixture,
  type ChatStateServiceFixture,
} from './helpers/chat-state-service-fixture';
import {
  getDesktopChatWaits,
  resetDesktopChatWaitsForTest,
} from '../chat-waits/desktop-chat-waits';
import { createPendingRequest, rejectRequest } from '../mcp/pending-requests';
import { requestPortalComposerCommand } from '../ipc/portal-composer-command';
import { handlePortalChatAnswerQuestion } from '../portal/adapters/chat-adapter';
import type { PortalAdapterContext } from '../portal/adapters/types';

jest.mock('../ipc/portal-composer-command', () => ({
  requestPortalComposerCommand: jest.fn(),
}));
jest.mock('../observability', () => ({
  getObservabilityService: (): unknown => ({
    observeSteeringInput: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  }),
}));

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const QUESTIONS: McpQuestion[] = [
  { id: 'colour', question: 'Pick a colour', options: ['Red', 'Blue'] },
];
const ANSWERS: McpQuestionAnswer[] = [
  { questionId: 'colour', question: 'Pick a colour', selectedOptions: ['Red'] },
];
const SENDER: ExternalAgentSender = {
  kind: 'external_agent',
  connectionId: '123e4567-e89b-42d3-a456-426614174000',
  clientName: 'Web MCP Agent',
  verified: true,
  userId: '123e4567-e89b-42d3-a456-426614174001',
};
const composerCommand = jest.mocked(requestPortalComposerCommand);

let fixture: ChatStateServiceFixture;

interface ContextDouble extends PortalAdapterContext {
  completed: unknown[];
  failed: Array<{ code: string; retryable: boolean | undefined }>;
}

function contextDouble(
  overrides: Partial<PortalAdapterContext> = {},
): ContextDouble {
  const completed: unknown[] = [];
  const failed: Array<{ code: string; retryable: boolean | undefined }> = [];
  return {
    completed,
    failed,
    chatStatePort: fixture.service,
    getWindow: () => null,
    enqueueEvent: jest.fn(),
    complete: (_command, result) => {
      completed.push(result);
    },
    fail: (_command, code, _message, retryable) => {
      failed.push({ code, retryable });
    },
    ...overrides,
  };
}

function answerCommand(
  requestId: string,
  id = `portal-${requestId}`,
): PortalCommandEnvelope<
  PortalCommandPayloadMap['portal.chat.answer_question']
> {
  return {
    id,
    sequence: 1,
    type: 'portal.chat.answer_question',
    createdAt: '2026-11-06T00:00:00.000Z',
    expiresAt: null,
    payload: { ...SCOPE, chatId: 'chat-1', requestId, answers: ANSWERS },
  };
}

async function ask(
  requestId: string,
): Promise<{ answers: Promise<McpQuestionAnswer[]>; settled: jest.Mock }> {
  const settled = jest.fn();
  const answers = createPendingRequest(requestId, 'session', {
    scope: { ...SCOPE, chatId: 'chat-1' },
  });
  answers.then(settled, () => undefined);
  await fixture.service.upsertPendingQuestion(SCOPE, {
    requestId,
    chatId: 'chat-1',
    questions: QUESTIONS,
  });
  return { answers, settled };
}

beforeEach(async () => {
  composerCommand.mockReset();
  resetDesktopChatWaitsForTest({ noClientMode: 'wait' });
  fixture = createChatStateServiceFixture();
  await fixture.createChat(SCOPE);
});
afterEach(async () => {
  await fixture.dispose();
});

it('a Portal answer with no chat state service fails retryable and never reaches a window', async () => {
  await ask('q-no-port');
  const context = contextDouble({ chatStatePort: undefined });
  await handlePortalChatAnswerQuestion(answerCommand('q-no-port'), context);
  expect(context.failed).toEqual([
    { code: 'execution_failed', retryable: true },
  ]);
  expect(composerCommand).not.toHaveBeenCalled();
  expect(getDesktopChatWaits().isOpen('q-no-port')).toBe(true);
});

it('a Portal answer settles a live question once and completes with the command result', async () => {
  const { answers } = await ask('q-live');
  const context = contextDouble();
  await handlePortalChatAnswerQuestion(answerCommand('q-live'), context);
  expect(context.completed).toEqual([
    expect.objectContaining({ outcome: 'applied' }),
  ]);
  await expect(answers).resolves.toEqual(
    ANSWERS.map((answer) => ({ ...answer, answeredBy: 'person' })),
  );
  expect(composerCommand).not.toHaveBeenCalled();
});

it('a Portal answer from an external agent reaches the waiting tool as an agent answer (CAN-6024)', async () => {
  const { answers } = await ask('q-agent');
  const context = contextDouble({ origin: SENDER });
  await handlePortalChatAnswerQuestion(answerCommand('q-agent'), context);
  await expect(answers).resolves.toEqual(
    ANSWERS.map((answer) => ({ ...answer, answeredBy: 'agent' })),
  );
});

it('a Portal retry with the same command id completes from the receipt', async () => {
  const { settled } = await ask('q-retry');
  const context = contextDouble();
  const envelope = answerCommand('q-retry');
  await handlePortalChatAnswerQuestion(envelope, context);
  await handlePortalChatAnswerQuestion(envelope, context);
  expect(context.completed).toEqual([
    expect.objectContaining({ outcome: 'applied' }),
    expect.objectContaining({ outcome: 'already_applied' }),
  ]);
  await Promise.resolve();
  expect(settled).toHaveBeenCalledTimes(1);
});

it('a Portal answer to a question whose provider stopped waiting fails before any write', async () => {
  const { answers } = await ask('q-stopped');
  rejectRequest('q-stopped', 'ask_user_persistence_failed');
  await expect(answers).rejects.toThrow('ask_user_persistence_failed');
  const before = (await fixture.service.getState(SCOPE)).revision;
  const context = contextDouble();
  await handlePortalChatAnswerQuestion(answerCommand('q-stopped'), context);
  expect(context.failed).toEqual([
    { code: 'execution_failed', retryable: undefined },
  ]);
  expect((await fixture.service.getState(SCOPE)).revision).toBe(before);
});

it('a trusted-sender Portal answer keeps its sender provenance', async () => {
  await fixture.repository.transact(
    SCOPE,
    [
      {
        type: 'pending_question.upserted',
        question: {
          requestId: 'q-async',
          chatId: 'chat-1',
          delivery: 'async',
          questions: QUESTIONS,
        },
      },
    ],
    { source: 'provider', mutationId: 'seed-async-question' },
  );
  const context = contextDouble({ origin: SENDER });
  await handlePortalChatAnswerQuestion(answerCommand('q-async'), context);
  expect(context.completed).toEqual([
    expect.objectContaining({ outcome: 'applied' }),
  ]);
  const answerMessage = (
    await fixture.service.getState(SCOPE)
  ).tabsFile.tabs[0]?.messages.find((message) => message.role === 'user');
  expect(answerMessage?.agentSent).toEqual(SENDER);
});

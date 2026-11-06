import type { CanopyHandlerContext } from '@canopy/core-runtime';
import type {
  McpQuestion,
  McpQuestionAnswer,
} from '@canopy/desktop-shared/types';
import {
  createChatStateServiceFixture,
  type ChatStateServiceFixture,
} from '../../__tests__/helpers/chat-state-service-fixture';
import {
  getDesktopChatWaits,
  resetDesktopChatWaitsForTest,
} from '../../chat-waits/desktop-chat-waits';
import {
  answerChatQuestionFromRenderer,
  respondToChatQuestion,
  respondToLiveChatQuestion,
  trackSettledChatQuestions,
} from '../../chat-questions/respond';
import {
  createPendingRequest,
  rejectRequest,
} from '../../mcp/pending-requests';
import { setChatStateCommandPort } from '../../ipc/chat-state';
import {
  createCoreChatQuestionAdapter,
  QUESTION_ANSWER_SHAPE_MESSAGE,
  type CoreChatQuestionHost,
} from '../core-chat-question-adapter';

jest.mock('../../observability', () => ({
  getObservabilityService: (): unknown => ({
    observeSteeringInput: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  }),
}));

const SCOPE = { projectId: 'workspace-1', worktreeId: 'worktree-1' };
const QUESTIONS: McpQuestion[] = [
  { id: 'colour', question: 'Pick a colour', options: ['Red', 'Blue'] },
  { id: 'size', question: 'Pick a size', options: ['Small', 'Large'] },
];
const context: CanopyHandlerContext = {
  requestId: 'question',
  caller: {
    principalId: 'local-user',
    clientInstanceId: 'test',
    authorityId: 'local',
    interfaceKind: 'desktop',
    grants: ['core.chat.write'],
  },
  metadata: {},
  signal: new AbortController().signal,
};

const containing = (expected: object): unknown =>
  expect.objectContaining(expected);

let fixture: ChatStateServiceFixture;
let readFails = false;

function host(): CoreChatQuestionHost {
  const target = fixture.service;
  return {
    scopesForChat: (chatId) => Promise.resolve([{ ...SCOPE, chatId }]),
    getState: (scope) =>
      readFails
        ? Promise.reject(new Error('unreadable'))
        : target.getState(scope),
    liveScope: (questionId) => {
      const live = getDesktopChatWaits().scopeOf(questionId);
      return live
        ? {
            projectId: live.workspaceId,
            worktreeId: live.worktreeId,
            chatId: live.chatId,
          }
        : null;
    },
    respond: (request) => respondToChatQuestion({ ...request, port: target }),
  };
}

function respond(params: {
  questionId: string;
  answers?: Record<string, unknown>;
  dismissed?: boolean;
}): Promise<unknown> {
  const handler =
    createCoreChatQuestionAdapter(host())['core.chat.question.respond'];
  return Promise.resolve(
    handler({ chatId: 'chat-1', ...params } as never, context),
  );
}

async function ask(
  requestId: string,
  questions: McpQuestion[] = QUESTIONS,
  options: { timeoutMs?: number; onTimeout?: () => void } = {},
): Promise<{ answers: Promise<McpQuestionAnswer[]>; settled: jest.Mock }> {
  const settled = jest.fn();
  const answers = createPendingRequest(requestId, 'session-A', {
    scope: { ...SCOPE, chatId: 'chat-1' },
    ...options,
  });
  answers.then(settled, () => undefined);
  await fixture.service.upsertPendingQuestion(SCOPE, {
    requestId,
    chatId: 'chat-1',
    questions,
  });
  return { answers, settled };
}

async function revision(): Promise<number> {
  return (await fixture.service.getState(SCOPE)).revision;
}

async function record(requestId: string): Promise<unknown> {
  return (
    await fixture.service.getState(SCOPE)
  ).tabsFile.pendingQuestions?.find(
    (question) => question.requestId === requestId,
  );
}

const KEYED = {
  colour: { selectedOptions: ['Red'] },
  size: { selectedOptions: ['Large'] },
};
const STORED: McpQuestionAnswer[] = [
  { questionId: 'colour', question: 'Pick a colour', selectedOptions: ['Red'] },
  { questionId: 'size', question: 'Pick a size', selectedOptions: ['Large'] },
];
const invalidState = {
  payload: containing({
    kind: 'failed_precondition',
    code: 'core.chat.question.invalidState',
  }),
};

beforeEach(async () => {
  resetDesktopChatWaitsForTest();
  trackSettledChatQuestions();
  readFails = false;
  fixture = createChatStateServiceFixture();
  // The renderer IPC path settles through the installed port.
  setChatStateCommandPort(fixture.service);
  await fixture.createChat(SCOPE);
});
afterEach(async () => {
  setChatStateCommandPort(null);
  await fixture.dispose();
});

it('answers a live question through core.chat.question.respond and resumes the waiting provider once', async () => {
  const { answers, settled } = await ask('q-live');
  const result = await respond({ questionId: 'q-live', answers: KEYED });
  await expect(answers).resolves.toEqual(STORED);
  expect(settled).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({
    chatId: 'chat-1',
    workspaceId: SCOPE.projectId,
    worktreeId: SCOPE.worktreeId,
    revision: await revision(),
  });
});

it('the renderer IPC and core.chat.question.respond settle the same question once', async () => {
  const { answers, settled } = await ask('q-shared');
  await expect(
    respondToLiveChatQuestion('q-shared', { kind: 'answer', answers: STORED }),
  ).resolves.toMatchObject({ status: 'applied' });
  await expect(
    respond({
      questionId: 'q-shared',
      answers: {
        colour: { selectedOptions: ['Blue'] },
        size: { selectedOptions: ['Small'] },
      },
    }),
  ).rejects.toMatchObject(invalidState);
  await expect(answers).resolves.toEqual(STORED);
  expect(settled).toHaveBeenCalledTimes(1);
});

it('a renderer answer after another client answered is accepted without resuming the provider again', async () => {
  const { settled } = await ask('q-renderer-late');
  await respond({ questionId: 'q-renderer-late', answers: KEYED });
  const before = await revision();
  await expect(
    respondToLiveChatQuestion('q-renderer-late', {
      kind: 'answer',
      answers: STORED,
    }),
  ).resolves.toMatchObject({ status: 'already_settled' });
  await Promise.resolve();
  expect(settled).toHaveBeenCalledTimes(1);
  expect(await revision()).toBe(before);
});

it('a renderer answer while chat state is unavailable rejects and keeps the question waiting', async () => {
  const { settled } = await ask('q-renderer-unavailable');
  setChatStateCommandPort(null);
  await expect(
    answerChatQuestionFromRenderer('q-renderer-unavailable', STORED),
  ).rejects.toThrow('The chat state service is temporarily unavailable.');
  expect(getDesktopChatWaits().isOpen('q-renderer-unavailable')).toBe(true);
  expect(settled).not.toHaveBeenCalled();
  expect(await record('q-renderer-unavailable')).not.toHaveProperty(
    'answeredAt',
  );
  setChatStateCommandPort(fixture.service);
  await expect(
    answerChatQuestionFromRenderer('q-renderer-unavailable', STORED),
  ).resolves.toEqual({ accepted: true });
});

it('a failed answer write is unavailable and keeps the question waiting', async () => {
  const { answers, settled } = await ask('q-write-fails');
  const transact = jest
    .spyOn(fixture.repository, 'transactWith')
    .mockRejectedValueOnce(new Error('disk full'));
  await expect(
    respond({ questionId: 'q-write-fails', answers: KEYED }),
  ).rejects.toMatchObject({
    payload: containing({
      kind: 'unavailable',
      retry: { kind: 'same_request', delayMs: 1_000 },
    }),
  });
  transact.mockRejectedValueOnce(new Error('disk full'));
  await expect(
    answerChatQuestionFromRenderer('q-write-fails', STORED),
  ).rejects.toThrow('The chat state service is temporarily unavailable.');
  expect(getDesktopChatWaits().isOpen('q-write-fails')).toBe(true);
  expect(settled).not.toHaveBeenCalled();
  expect(await record('q-write-fails')).not.toHaveProperty('answeredAt');
  await expect(
    answerChatQuestionFromRenderer('q-write-fails', STORED),
  ).resolves.toEqual({ accepted: true });
  await expect(answers).resolves.toEqual(STORED);
});

it('a second answer gets invalidState and never resumes the provider again', async () => {
  const { settled } = await ask('q-twice');
  await respond({ questionId: 'q-twice', answers: KEYED });
  await expect(
    respond({
      questionId: 'q-twice',
      answers: {
        colour: { selectedOptions: ['Blue'] },
        size: { selectedOptions: ['Small'] },
      },
    }),
  ).rejects.toMatchObject(invalidState);
  await Promise.resolve();
  expect(settled).toHaveBeenCalledTimes(1);
  expect(await record('q-twice')).toMatchObject({
    answers: STORED,
  });
});

it('a late answer after cancellation is refused and writes nothing', async () => {
  const { answers } = await ask('q-cancelled');
  rejectRequest('q-cancelled', 'ask_user_cancelled');
  await expect(answers).rejects.toThrow('ask_user_cancelled');
  const before = await revision();
  await expect(
    respond({ questionId: 'q-cancelled', answers: KEYED }),
  ).rejects.toMatchObject(invalidState);
  expect(await revision()).toBe(before);
});

it('a late answer after timeout is not found', async () => {
  let consumed: Promise<void> = Promise.resolve();
  const { answers } = await ask('q-timeout', QUESTIONS, {
    timeoutMs: 5,
    onTimeout: () => {
      consumed = fixture.service.consumePendingQuestion(
        SCOPE,
        'chat-1',
        'q-timeout',
      );
    },
  });
  await expect(answers).rejects.toThrow('ask_user_timeout');
  await consumed;
  await expect(
    respond({ questionId: 'q-timeout', answers: KEYED }),
  ).rejects.toMatchObject({
    payload: containing({
      kind: 'not_found',
      code: 'core.chat.question.notFound',
    }),
  });
});

it('an answer to a question whose provider stopped waiting is refused before any write', async () => {
  const { answers } = await ask('q-stopped');
  rejectRequest('q-stopped', 'ask_user_persistence_failed');
  await expect(answers).rejects.toThrow('ask_user_persistence_failed');
  const before = await revision();
  await expect(
    respond({ questionId: 'q-stopped', answers: KEYED }),
  ).rejects.toMatchObject(invalidState);
  expect(await revision()).toBe(before);
  expect(await record('q-stopped')).not.toHaveProperty('answeredAt');
});

it('dismissal removes the card and rejects the waiting provider with cancelled', async () => {
  const { answers } = await ask('q-dismiss');
  await respond({ questionId: 'q-dismiss', dismissed: true });
  await expect(answers).rejects.toThrow('cancelled');
  expect(await record('q-dismiss')).toBeUndefined();
});

it('malformed answers are invalid_argument', async () => {
  await ask('q-malformed');
  const before = await revision();
  for (const params of [
    { answers: { colour: KEYED.colour } },
    { answers: { ...KEYED, extra: { selectedOptions: [] } } },
    { answers: KEYED, dismissed: true },
    { answers: { ...KEYED, colour: { selectedOptions: 'x' } } },
  ])
    await expect(
      respond({ questionId: 'q-malformed', ...params }),
    ).rejects.toMatchObject({
      payload: containing({
        kind: 'invalid_argument',
        message: QUESTION_ANSWER_SHAPE_MESSAGE,
      }),
    });
  expect(await revision()).toBe(before);
  expect(getDesktopChatWaits().isOpen('q-malformed')).toBe(true);
});

it('questions without ids are keyed by index', async () => {
  const { answers } = await ask('q-index', [
    { question: 'Pick a colour', options: ['Red', 'Blue'] },
    { question: 'Pick a size', options: ['Small', 'Large'] },
  ]);
  await respond({
    questionId: 'q-index',
    answers: {
      '0': { selectedOptions: ['Blue'] },
      '1': { selectedOptions: ['Small'] },
    },
  });
  await expect(answers).resolves.toEqual([
    { question: 'Pick a colour', selectedOptions: ['Blue'] },
    { question: 'Pick a size', selectedOptions: ['Small'] },
  ]);
});

it('a failed scope read is unavailable, never not_found', async () => {
  await ask('q-unreadable');
  readFails = true;
  await expect(
    respond({ questionId: 'q-unreadable', answers: KEYED }),
  ).rejects.toMatchObject({
    payload: containing({
      kind: 'unavailable',
      retry: { kind: 'same_request', delayMs: 1_000 },
    }),
  });
});

/** @jest-environment jsdom */
import { useChatStore } from '@/stores/chatStore';
import { createQuestionSandbox } from '../chatQuestionSandbox';

if (!globalThis.structuredClone) {
  globalThis.structuredClone = <T>(value: T): T =>
    JSON.parse(JSON.stringify(value)) as T;
}

it('isolates actions, drafts and question delivery from the live session store', async () => {
  const live = useChatStore.getState();
  const sandbox = createQuestionSandbox();
  const second = createQuestionSandbox();
  for (const [name, value] of Object.entries(useChatStore.getInitialState())) {
    if (typeof value === 'function')
      expect(sandbox.store.getState()[name as keyof typeof live]).not.toBe(
        value,
      );
  }
  const local = sandbox.store.getState();
  expect(local.selectedWorktree).toBeNull();
  local.saveTabDraft('draft', [
    { type: 'paragraph', children: [{ text: 'Local only' }] },
  ]);
  expect(second.store.getState().getTabDraft('draft')).toBeUndefined();
  expect(useChatStore.getState()).toBe(live);
  const question = Object.values(local.pendingQuestions)[0];
  const answers = [
    {
      question: question.questions[0].question,
      selectedOptions: [question.questions[0].options[0]],
    },
  ];
  const delivery = local.answerMcpQuestionAndWait(question.requestId, answers);
  expect(sandbox.machine.getState().phase).toBe('submitting');
  const failure = expect(delivery).rejects.toThrow(
    'Simulated delivery failure',
  );
  sandbox.dispatch({ type: 'fail' });
  await failure;
  const retry = local.answerMcpQuestionAndWait(question.requestId, answers);
  sandbox.dispatch({ type: 'resolve' });
  await retry;
  await sandbox.sendMessage('Another question');
  expect(sandbox.getTab().messages).toHaveLength(5);
  expect(sandbox.machine.getState().phase).toBe('pending');
  expect(useChatStore.getState()).toBe(live);
  expect(second.getTab().messages).toHaveLength(2);
  sandbox.dispose();
  second.dispose();
});

it('rejects stale requests after reset and redacts secrets in the transcript', async () => {
  const sandbox = createQuestionSandbox();
  sandbox.dispatch({ type: 'preset', id: 'secret' });
  const question = Object.values(sandbox.store.getState().pendingQuestions)[0];
  const promise = sandbox.store
    .getState()
    .answerMcpQuestionAndWait(question.requestId, [
      {
        question: question.questions[0].question,
        selectedOptions: [],
        freeformText: 'private-value',
      },
    ]);
  sandbox.dispatch({ type: 'resolve' });
  await promise;
  expect(JSON.stringify(sandbox.getTab().messages)).not.toContain(
    'private-value',
  );
  expect(JSON.stringify(sandbox.getTab().messages)).toContain('[hidden]');
  sandbox.dispatch({ type: 'reset' });
  await expect(
    sandbox.store.getState().dismissMcpQuestionAndWait(question.requestId),
  ).rejects.toThrow('Question unavailable');
  sandbox.dispose();
});

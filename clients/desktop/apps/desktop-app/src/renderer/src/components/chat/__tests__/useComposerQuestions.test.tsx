/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { PendingQuestion } from '@/stores/chatStore';
import { useComposerQuestions } from '../useComposerQuestions';

let mockQuestions: Record<string, PendingQuestion> = {};
jest.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (state: unknown) => unknown): unknown =>
    select({ pendingQuestions: mockQuestions }),
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  value: true,
  configurable: true,
});

test('scopes the dock and retains reserved answers until delivery succeeds', () => {
  const pending: PendingQuestion = {
    requestId: 'one',
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    questions: [{ question: 'Scope?', options: [] }],
  };
  mockQuestions = {
    one: pending,
    other: { ...pending, requestId: 'other', worktreeId: 'other' },
    answered: { ...pending, requestId: 'answered', answeredAt: 1 },
    dismissed: { ...pending, requestId: 'dismissed', dismissedAt: 1 },
  };
  let dock: ReturnType<typeof useComposerQuestions> | undefined;
  function Probe({ enabled = true, chatId = 'chat' }): null {
    dock = useComposerQuestions(chatId, 'project', 'worktree', enabled);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() => root.render(<Probe />));
    expect(dock?.questions.map((q) => q.requestId)).toEqual(['one']);
    act(() => dock?.onDeliveryChange('one', true));
    mockQuestions = { ...mockQuestions, one: { ...pending, answeredAt: 2 } };
    act(() => root.render(<Probe />));
    expect(dock?.questions.map((q) => q.requestId)).toEqual(['one']);
    act(() => root.render(<Probe chatId="other-chat" />));
    expect(dock?.questions).toEqual([]);
    act(() => root.render(<Probe />));
    act(() => dock?.onDeliveryChange('one', false));
    expect(dock?.questions).toEqual([]);
    mockQuestions = { one: pending };
    act(() => root.render(<Probe enabled={false} />));
    expect(dock?.questions).toEqual([]);
  } finally {
    act(() => root.unmount());
  }
});

/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AskUserQuestionCardProps } from '@canopy/ui-shared/components';
import type { PendingQuestion } from '@/stores/chatStore';
import { AskUserQuestionCard } from '../AskUserQuestion';
const mockAnswer = jest.fn();
jest.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (value: unknown) => unknown): unknown =>
    select({
      answerMcpQuestionAndWait: mockAnswer,
      dismissMcpQuestionAndWait: jest.fn(),
    }),
}));
jest.mock('@canopy/ui-shared/components', () => ({
  Markdown: (): null => null,
  AskUserQuestionCard: ({
    state,
    onSubmit,
    errorKind,
  }: AskUserQuestionCardProps): JSX.Element =>
    state.answered ? (
      <div>Answered</div>
    ) : (
      <div>
        <textarea defaultValue="Keep my answer" />
        <button
          onClick={() =>
            onSubmit([
              {
                question: 'Scope?',
                selectedOptions: [],
                freeformText: 'Keep my answer',
              },
            ])
          }
        >
          Submit
        </button>
        {errorKind && <span role="alert">Try again</span>}
      </div>
    ),
}));
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

describe('async question submission lifecycle', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    mockAnswer.mockReset();
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  it.each([false, true])(
    'keeps the form until transport settles (accepted=%s)',
    async (accepted) => {
      let resolve!: () => void;
      let reject!: (error: Error) => void;
      mockAnswer.mockReturnValue(
        new Promise<void>((yes, no) => {
          resolve = yes;
          reject = no;
        }),
      );
      const pending: PendingQuestion = {
        requestId: 'request',
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        delivery: 'async',
        questions: [{ question: 'Scope?', options: [], allowOther: true }],
      };
      const onDeliveryChange = jest.fn();
      const render = (value: PendingQuestion): void =>
        root.render(
          <AskUserQuestionCard
            pending={value}
            hideAnswered
            onDeliveryChange={onDeliveryChange}
          />,
        );
      act(() => render(pending));
      const field = host.querySelector('textarea');
      act(() => host.querySelector('button')?.click());
      act(() =>
        render({
          ...pending,
          answeredAt: 20,
          answers: [
            {
              question: 'Scope?',
              selectedOptions: [],
              freeformText: 'Keep my answer',
            },
          ],
        }),
      );
      expect(host.querySelector('textarea')).toBe(field);
      await act(async () => {
        if (accepted) resolve();
        else {
          render(pending);
          reject(new Error('Connection lost'));
        }
        await Promise.resolve();
      });
      expect(onDeliveryChange).toHaveBeenLastCalledWith('request', !accepted);
      if (accepted) expect(host.innerHTML).toBe('');
      else {
        expect(host.querySelector('textarea')).toBe(field);
        expect(host.querySelector('[role="alert"]')).not.toBeNull();
      }
    },
  );
});

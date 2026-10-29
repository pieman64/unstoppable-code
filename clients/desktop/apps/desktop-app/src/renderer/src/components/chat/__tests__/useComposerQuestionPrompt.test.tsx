/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PortalAskUserQuestion } from '@canopy/protocol/portal';
import {
  useComposerQuestionPrompt,
  type ComposerPendingQuestion,
  type ComposerQuestionPrompt,
} from '../useComposerQuestionPrompt';
import {
  readQuestionPromptProgress,
  resetQuestionPromptProgressForTests,
} from '../question-prompt-progress';

const mockAnswer = jest.fn(() => Promise.resolve());
const mockDismiss = jest.fn(() => Promise.resolve());
jest.mock('@/stores/chatStore', () => ({
  useChatStore: (select: (value: unknown) => unknown): unknown =>
    select({
      answerMcpQuestionAndWait: mockAnswer,
      dismissMcpQuestionAndWait: mockDismiss,
    }),
}));
jest.mock('@/stores/chat/surface-store', () => ({
  useChatSurfaceScope: (): undefined => undefined,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const questions: PortalAskUserQuestion[] = [
  {
    question: 'Continue?',
    options: ['Yes', 'No'],
    control: 'buttons',
    required: true,
  },
  { question: 'Project name', options: [], control: 'text' },
  {
    question: 'Environment',
    options: ['Staging', 'Production'],
    control: 'select',
  },
];

const pending: ComposerPendingQuestion = { requestId: 'one', questions };

describe('useComposerQuestionPrompt progress', () => {
  let host: HTMLDivElement;
  let root: Root;
  let latest: ComposerQuestionPrompt | null;

  function Probe(): null {
    latest = useComposerQuestionPrompt(pending, onDeliveryChange);
    return null;
  }
  const onDeliveryChange = jest.fn();

  function current(): ComposerQuestionPrompt {
    if (!latest) throw new Error('no prompt');
    return latest;
  }

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    latest = null;
    mockAnswer.mockClear();
    mockDismiss.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    resetQuestionPromptProgressForTests();
  });

  it('skip clears saved progress', async () => {
    act(() => root.render(<Probe />));
    act(() => current().prompt.pick('Yes'));
    expect(readQuestionPromptProgress('one')?.step).toBe(1);
    act(() => current().skip());
    expect(readQuestionPromptProgress('one')).toBeUndefined();
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockDismiss).toHaveBeenCalledWith('one');
    expect(readQuestionPromptProgress('one')).toBeUndefined();
  });

  it('submit clears saved progress', async () => {
    act(() => root.render(<Probe />));
    act(() => current().prompt.pick('Yes'));
    act(() => current().prompt.send('Atlas'));
    expect(readQuestionPromptProgress('one')?.step).toBe(2);
    act(() => current().prompt.pick('Production'));
    expect(mockAnswer).toHaveBeenCalledTimes(1);
    expect(readQuestionPromptProgress('one')).toBeUndefined();
    await act(async () => {
      await Promise.resolve();
    });
    expect(readQuestionPromptProgress('one')).toBeUndefined();
  });

  it('a retried answer clears progress saved after the failed delivery', async () => {
    mockAnswer.mockImplementationOnce(() => Promise.reject(new Error('down')));
    act(() => root.render(<Probe />));
    act(() => current().prompt.pick('Yes'));
    act(() => current().prompt.send('Atlas'));
    act(() => current().prompt.pick('Production'));
    await act(async () => {
      await Promise.resolve();
    });
    expect(current().errorKind).toBe('submit');
    // The form stays open after the failure, so going back saves again.
    act(() => current().prompt.back());
    expect(readQuestionPromptProgress('one')).toBeDefined();
    act(() => current().retry());
    expect(mockAnswer).toHaveBeenCalledTimes(2);
    expect(readQuestionPromptProgress('one')).toBeUndefined();
    await act(async () => {
      await Promise.resolve();
    });
    expect(readQuestionPromptProgress('one')).toBeUndefined();
  });
});

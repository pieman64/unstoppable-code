/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import {
  resetChatBackgroundWorkStoreForTests,
  useChatBackgroundWorkStore,
} from '@/stores/chatBackgroundWorkStore';
import type { DisplayBlock } from '../types';

type DelegateBlock = Extract<DisplayBlock, { type: 'delegated_agent_call' }>;

const mockTranscript = jest.fn((block: DelegateBlock): DelegateBlock => block);
jest.mock('../delegated-agent-transcript', () => ({
  useDelegatedAgentTranscript: (block: DelegateBlock): DelegateBlock =>
    mockTranscript(block),
}));

import { BackgroundTrayDelegateSteps } from '../BackgroundTrayDelegateSteps';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const BLOCK: DelegateBlock = {
  type: 'delegated_agent_call',
  agentBlockId: 'delegated-agent-child',
  delegationId: 'child',
  runGeneration: 1,
  sequence: 1,
  parentHarnessId: 'claude',
  parentTurnId: 'turn',
  parentToolCallId: 'call',
  createdAt: 1,
  selectedModelId: 'sol',
  runtimeModelId: 'gpt-6-sol',
  targetHarnessId: 'codex',
  description: 'Fix flaky checkout e2e',
  prompt: 'Fix it.',
  executionMode: 'background',
  status: 'running',
  outputTruncated: false,
  transcriptStore: 'chat-log-v1',
  subBlocks: [],
};

describe('BackgroundTrayDelegateSteps', () => {
  afterEach(() => resetChatBackgroundWorkStoreForTests());

  it("publishes a logged delegate's steps from its own transcript while listed", () => {
    mockTranscript.mockImplementation((block) => ({
      ...block,
      subBlocks: [
        { type: 'text', text: 'Looking' },
        {
          type: 'tool_use',
          toolUseId: 'read-1',
          toolName: 'Read',
          input: '{"file_path":"checkout.spec.ts"}',
        },
      ],
    }));
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(<BackgroundTrayDelegateSteps chatKey="chat" block={BLOCK} />),
    );
    expect(mockTranscript).toHaveBeenCalledWith(BLOCK);
    expect(
      useChatBackgroundWorkStore.getState().agentLive['chat\0managed:child'],
    ).toEqual({
      status: 'running',
      steps: [
        {
          id: 'read-1',
          toolName: 'Read',
          input: '{"file_path":"checkout.spec.ts"}',
        },
      ],
    });
    // Its row left the drawer: the steps go with it.
    act(() => root.unmount());
    expect(useChatBackgroundWorkStore.getState().agentLive).toEqual({});
  });

  it('publishes the approval its live snapshot reports, which the saved card drops', () => {
    mockTranscript.mockImplementation((block) => ({
      ...block,
      approvalPending: true,
    }));
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() =>
      root.render(<BackgroundTrayDelegateSteps chatKey="chat" block={BLOCK} />),
    );
    expect(
      useChatBackgroundWorkStore.getState().agentLive['chat\0managed:child']
        ?.status,
    ).toBe('approval');
    act(() => root.unmount());
  });
});

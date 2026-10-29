/** @jest-environment jsdom */

import type {
  SubagentNode,
  SubagentRecipient,
  SubagentTree,
} from '@canopy/agent-transcript';
import { useChatStore } from '@/stores/chatStore';
import { revealWorktreeChatPanel } from '@/lib/panels/plan-panel-open';
import { openSubagentChatPanel } from '@/lib/panels/subagent-panel-open';
import {
  useSubagentComposerStore,
  subagentDraftKey,
} from '@canopy/ui-app/subagents';
import type { SubagentHostScope } from '../subagent-scope';
import { sendToSubagentRecipient } from '../subagent-send-to-recipient';

jest.mock('@/lib/panels/plan-panel-open', () => ({
  revealWorktreeChatPanel: jest.fn(),
}));
jest.mock('@/lib/panels/subagent-panel-open', () => ({
  openSubagentChatPanel: jest.fn(),
}));

const scope: SubagentHostScope = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
};

type SendMessage = ReturnType<typeof useChatStore.getState>['sendMessage'];
type SendMessageOptions = Parameters<SendMessage>[4];

const sentMessages: Parameters<SendMessage>[] = [];
let sendMessageBehavior: (options: SendMessageOptions) => void = (): void => {};
const sendMessageMock: SendMessage = (...args): Promise<void> => {
  sentMessages.push(args);
  sendMessageBehavior(args[4]);
  return Promise.resolve();
};
const originalSendMessage = useChatStore.getState().sendMessage;

const managedMessage = jest.fn();
const revealRoot = jest.mocked(revealWorktreeChatPanel);
const openParent = jest.mocked(openSubagentChatPanel);

function node(
  id: string,
  title: string,
  status: SubagentNode['status'],
  parentId: string | null,
): SubagentNode {
  return {
    id,
    kind: 'managed',
    parentId,
    depth: parentId === null ? 1 : 2,
    title,
    status,
    childIds: [],
    liveDescendantCount: 0,
    approvalPending: false,
    runs: [{ runGeneration: 1, agentBlockId: `${id}-run-1` }],
  };
}

function tree(parentStatus: SubagentNode['status']): SubagentTree {
  const parent = node('parent', 'Parent agent', parentStatus, null);
  const selected = node('child', 'Selected agent', 'completed', 'parent');
  return {
    root: { id: 'root-chat', title: 'Root chat' },
    nodes: new Map([
      [parent.id, parent],
      [selected.id, selected],
    ]),
    rootChildIds: [parent.id],
    complete: true,
  };
}

function recipient(kind: SubagentRecipient['kind']): SubagentRecipient {
  if (kind === 'root') {
    return {
      id: 'root-chat',
      kind: 'root',
      title: 'Root chat',
      levelsUp: 2,
      canMessage: true,
    };
  }
  return {
    id: 'parent',
    kind: 'ancestor',
    title: 'Parent agent',
    levelsUp: 1,
    status: 'completed',
    canMessage: true,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  sentMessages.length = 0;
  sendMessageBehavior = (): void => {};
  useChatStore.setState({ sendMessage: sendMessageMock });
  useSubagentComposerStore.setState({ drafts: {} });
  revealRoot.mockReturnValue(true);
  openParent.mockResolvedValue({ status: 'placed' });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { managedDelegation: { message: managedMessage } },
  });
});

afterAll(() => {
  useChatStore.setState({ sendMessage: originalSendMessage });
});

describe('sendToSubagentRecipient', () => {
  it('sends to the root through the chat store, then reveals its chat panel', async () => {
    const result = await sendToSubagentRecipient({
      scope,
      rootChatId: 'root-chat',
      tree: tree('running'),
      recipient: recipient('root'),
      text: 'Message with the attached subagent reference.',
    });

    expect(result).toEqual({ ok: true });
    expect(sentMessages[0]?.[0]).toBe(
      'Message with the attached subagent reference.',
    );
    expect(sentMessages[0]?.[2]).toEqual({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'root-chat',
    });
    expect(sentMessages[0]?.[4]?.throwOnDispatchFailure).toBe(true);
    expect(revealRoot).toHaveBeenCalledWith(scope, 'root-chat');
  });

  it('returns a send failure without revealing the root after rejection or error', async () => {
    sendMessageBehavior = (options): void => {
      options?.onPreDispatchRejected?.();
    };
    const request = {
      scope,
      rootChatId: 'root-chat',
      tree: tree('running'),
      recipient: recipient('root'),
      text: 'Do not navigate on refusal.',
    };

    await expect(sendToSubagentRecipient(request)).resolves.toEqual({
      ok: false,
      error: "Couldn't send a message to the root chat.",
    });
    expect(revealRoot).not.toHaveBeenCalled();

    sendMessageBehavior = (options): void => {
      options?.onDispatchRejected?.();
    };
    await expect(sendToSubagentRecipient(request)).resolves.toEqual({
      ok: false,
      error: "Couldn't send a message to the root chat.",
    });
    expect(revealRoot).not.toHaveBeenCalled();

    sendMessageBehavior = (): void => {
      throw new Error('Chat is read only.');
    };
    await expect(sendToSubagentRecipient(request)).resolves.toEqual({
      ok: false,
      error: 'Chat is read only.',
    });
    expect(revealRoot).not.toHaveBeenCalled();
  });

  it('sends an idle managed parent a follow-up before opening its panel', async () => {
    managedMessage.mockResolvedValue({ ok: true });
    const result = await sendToSubagentRecipient(
      {
        scope,
        rootChatId: 'root-chat',
        tree: tree('completed'),
        recipient: recipient('ancestor'),
        text: 'Please check the test output.',
      },
      { createOperationId: (): string => 'operation-1' },
    );

    expect(result).toEqual({ ok: true });
    expect(managedMessage).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'worktree-1',
      chatId: 'root-chat',
      delegationId: 'parent',
      operation: 'follow_up',
      message: 'Please check the test output.',
      operationId: 'operation-1',
    });
    expect(openParent).toHaveBeenCalledWith(scope, {
      rootChatId: 'root-chat',
      subagentId: 'parent',
      subagentKind: 'managed',
      title: 'Parent agent',
    });
  });

  it('queues a message for a live managed parent in its persistent composer draft', async () => {
    const requestTree = tree('running');
    const result = await sendToSubagentRecipient({
      scope,
      rootChatId: 'root-chat',
      tree: requestTree,
      recipient: recipient('ancestor'),
      text: 'The selected child found a failing test.',
    });
    const key = subagentDraftKey('root-chat', 'parent');

    expect(result).toEqual({ ok: true });
    expect(managedMessage).not.toHaveBeenCalled();
    expect(useSubagentComposerStore.getState().drafts[key]).toMatchObject({
      recipientId: 'parent',
      queue: [
        {
          text: 'The selected child found a failing test.',
          state: 'queued',
        },
      ],
    });
    expect(openParent).toHaveBeenCalled();
  });

  it('does not open the parent panel when the follow-up is refused', async () => {
    managedMessage.mockResolvedValue({
      ok: false,
      code: 'not_found',
      error: 'Parent is no longer available.',
    });

    await expect(
      sendToSubagentRecipient(
        {
          scope,
          rootChatId: 'root-chat',
          tree: tree('completed'),
          recipient: recipient('ancestor'),
          text: 'Please check this.',
        },
        { createOperationId: (): string => 'operation-2' },
      ),
    ).resolves.toEqual({ ok: false, error: 'Parent is no longer available.' });
    expect(openParent).not.toHaveBeenCalled();
  });
  it('reports an accepted send as sent even when its chat cannot open', async () => {
    revealRoot.mockImplementation((): boolean => {
      throw new Error('Layout unavailable');
    });
    await expect(
      sendToSubagentRecipient({
        scope,
        rootChatId: 'root-chat',
        tree: tree('running'),
        recipient: recipient('root'),
        text: 'Sent once.',
      }),
    ).resolves.toEqual({ ok: true });

    openParent.mockResolvedValue({ status: 'failed' });
    await expect(
      sendToSubagentRecipient({
        scope,
        rootChatId: 'root-chat',
        tree: tree('running'),
        recipient: recipient('ancestor'),
        text: 'Queued once.',
      }),
    ).resolves.toEqual({ ok: true });
    expect(sentMessages).toHaveLength(1);
  });
});

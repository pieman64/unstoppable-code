import type {
  ChatSendMessageRequest,
  ChatRuntimeState,
  PersistedHostQueuedMessage,
} from '@canopy/desktop-shared/types';
import { projectChatStateChanges } from '../chat-state-projection';

const target = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-1',
};

function queuedMessage(
  id: string,
  request: Pick<
    ChatSendMessageRequest,
    'internalRow' | 'managedDelegationDeliveryId'
  >,
  extra: Pick<PersistedHostQueuedMessage, 'admitting' | 'dispatching'> = {},
): PersistedHostQueuedMessage {
  return {
    id,
    request: {
      ...target,
      userMessageId: id,
      text: `payload ${id}`,
      ...request,
    },
    origin: 'desktop',
    enqueuedAtMs: 1,
    ...extra,
  };
}

describe('projectChatStateChanges', () => {
  it('hides internal runtime queue payloads and only their evidenced ids', () => {
    const runtime: ChatRuntimeState = {
      status: 'streaming',
      activeTurn: { userMessageId: 'active', startedAt: 1 },
      queuedMessageIds: [
        'visible-row',
        'internal-row',
        'legacy-row',
        'unknown-row',
      ],
      queuedMessages: [
        queuedMessage('visible-row', {}),
        queuedMessage(
          'internal-row',
          {
            managedDelegationDeliveryId: 'internal-row',
            internalRow: {
              kind: 'delegation-request',
              delegationId: 'delegate-a',
              displayLine: 'Ask parent for input',
            },
          },
          { dispatching: true },
        ),
        queuedMessage(
          'legacy-row',
          { managedDelegationDeliveryId: 'legacy-delivery' },
          { admitting: true },
        ),
      ],
    };

    const [change] = projectChatStateChanges([
      { type: 'runtime.patched', chatId: 'chat-1', runtime },
    ]);

    expect(change).toMatchObject({
      type: 'runtime.patched',
      chatId: 'chat-1',
      runtime: {
        status: 'streaming',
        activeTurn: { userMessageId: 'active' },
        queuedMessageIds: ['visible-row', 'unknown-row'],
        queuedMessages: [{ id: 'visible-row' }],
      },
    });
    expect(runtime.queuedMessageIds).toEqual([
      'visible-row',
      'internal-row',
      'legacy-row',
      'unknown-row',
    ]);
    expect(runtime.queuedMessages).toHaveLength(3);
  });

  it('keeps unknown queued ids when there is no payload evidence', () => {
    const runtime: ChatRuntimeState = {
      status: 'queued',
      queuedMessageIds: ['unmatched-id'],
    };

    const [change] = projectChatStateChanges([
      { type: 'runtime.patched', chatId: 'chat-1', runtime },
    ]);

    expect(change).toMatchObject({
      type: 'runtime.patched',
      runtime: { queuedMessageIds: ['unmatched-id'] },
    });
  });
});

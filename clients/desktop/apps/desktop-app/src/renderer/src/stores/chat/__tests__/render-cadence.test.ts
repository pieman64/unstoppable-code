// Phase 12: only streamed content may reach React on the next frame; every
// lifecycle or structural change renders immediately.
import type {
  ChatRuntimeState,
  ChatStateChange,
  ChatStateChangedEvent,
} from '@canopy/desktop-shared/types';
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import { isStreamedContentEvent } from '../render-cadence';

const descriptor: TranscriptDescriptor = {
  format: 'complete-message-jsonl-v1',
  committedMessageCount: 1,
  committedByteLength: 1,
  transcriptRevision: 2,
  hasActiveSidecar: true,
};

const streaming: ChatRuntimeState = {
  status: 'streaming',
  queuedMessageIds: [],
  activeTurn: { userMessageId: 'u1', startedAt: 1 },
  lastActivityAt: 10,
};

function event(changes: ChatStateChange[]): ChatStateChangedEvent {
  return {
    schemaVersion: 1,
    eventId: 'e',
    occurredAt: '2026-10-01T00:00:00.000Z',
    projectId: 'p',
    worktreeId: 'w',
    baseRevision: 1,
    revision: 2,
    changes,
  };
}

const upsert: ChatStateChange = {
  type: 'message.upserted',
  chatId: 'chat',
  message: {
    id: 'a1',
    role: 'assistant',
    blocks: [{ type: 'text', text: 'hi' }],
    timestamp: 2,
  },
};

const transcript: ChatStateChange = {
  type: 'transcript.updated',
  chatId: 'chat',
  transcript: descriptor,
  reset: false,
};

function runtime(next: ChatRuntimeState): ChatStateChange {
  return { type: 'runtime.patched', chatId: 'chat', runtime: next };
}

describe('isStreamedContentEvent', () => {
  const runtimeByChatId = { chat: streaming };

  it('defers a streamed provider commit', () => {
    expect(
      isStreamedContentEvent(
        event([
          upsert,
          transcript,
          runtime({ ...streaming, lastActivityAt: 11 }),
        ]),
        runtimeByChatId,
      ),
    ).toBe(true);
  });

  it('renders lifecycle changes immediately', () => {
    const cases: ChatRuntimeState[] = [
      { ...streaming, status: 'completed', lastActivityAt: 11 },
      { ...streaming, queuedMessageIds: ['q1'] },
      {
        ...streaming,
        error: {
          code: 'provider_error',
          message: 'boom',
          retryable: true,
          occurredAt: '2026-10-01T00:00:00.000Z',
        },
      },
      { ...streaming, activeTurn: { userMessageId: 'u2', startedAt: 5 } },
    ];
    for (const next of cases) {
      expect(
        isStreamedContentEvent(event([upsert, runtime(next)]), runtimeByChatId),
      ).toBe(false);
    }
    // No known runtime to compare with.
    expect(isStreamedContentEvent(event([runtime(streaming)]), {})).toBe(false);
  });

  it('renders structural changes and transcript resets immediately', () => {
    const structural: ChatStateChange[] = [
      { type: 'message.removed', chatId: 'chat', messageId: 'a1' },
      {
        type: 'messages.replaced',
        chatId: 'chat',
        messages: [],
        removedMessageIds: [],
      },
      { type: 'tab.removed', tabId: 'chat' },
      { type: 'tab.active_changed', activeTabId: 'chat' },
      { type: 'pending_question.removed', chatId: 'chat', requestId: 'r' },
      { ...transcript, reset: true },
    ];
    for (const change of structural) {
      expect(
        isStreamedContentEvent(event([upsert, change]), runtimeByChatId),
      ).toBe(false);
    }
    expect(isStreamedContentEvent(event([]), runtimeByChatId)).toBe(false);
  });
});

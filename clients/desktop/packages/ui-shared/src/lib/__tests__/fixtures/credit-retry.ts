import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import {
  applyClaudeTranscriptEvent,
  createEmptyTranscriptReducerState,
} from '@canopy/agent-transcript';

// Saved canonical CAN-4450 QA ordering: failed attempt, starter, held original,
// then Retry reuses the original user ID and appends its own timer and answer.
export const CREDIT_RETRY_MESSAGES: PersistedChatMessage[] = [
  {
    id: 'msg-1-1793228381030',
    role: 'user',
    userMessageSource: 'human',
    timestamp: 1793228381075,
    blocks: [
      {
        type: 'text',
        text: 'Summarize this project',
      },
    ],
    inputMode: 'typed',
  },
  {
    id: '5603a3bc-4d96-435a-b4f8-fe2baf49d6b7:timer',
    role: 'system',
    timestamp: 1793228382305,
    blocks: [
      {
        type: 'turn_timer',
        turnId: '5603a3bc-4d96-435a-b4f8-fe2baf49d6b7',
        startedAt: 1793228382306,
        completedAt: 1793228382388,
        userMessageId: 'msg-1-1793228381030',
        accumulatedPausedDurationMs: 0,
        pauseOwnerIds: [],
      },
    ],
  },
  {
    id: '81864a31-883c-4d21-b4ca-4f8eb13179c1',
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: 'API Error: 402 AI Credits are unavailable for this request.',
      },
    ],
    timestamp: 1793228382349,
    claudeUuid: 'ac62ca7a-c77b-419f-9a04-25acf34b3752',
  },
  {
    id: 'can4450-qa-starter-1793228690396',
    role: 'user',
    userMessageSource: 'human',
    timestamp: 1793228690425,
    blocks: [
      {
        type: 'text',
        text: '[Canopy-CCAN4450Manual] [Canopy-Mock-Request:starter] Prepare to summarize.',
      },
    ],
    inputMode: 'typed',
  },
  {
    id: '6f0471d5-7868-4033-ac8c-2a6aa6ddaf9c:timer',
    role: 'system',
    timestamp: 1793228690829,
    blocks: [
      {
        type: 'turn_timer',
        turnId: '6f0471d5-7868-4033-ac8c-2a6aa6ddaf9c',
        startedAt: 1793228690813,
        completedAt: 1793228699348,
        userMessageId: 'can4450-qa-starter-1793228690396',
        accumulatedPausedDurationMs: 0,
        pauseOwnerIds: [],
      },
    ],
  },
  {
    id: 'msg_mock_1793228699338',
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: 'Ready for your project summary',
      },
    ],
    timestamp: 1793228699341,
    claudeUuid: 'd95c83e7-705c-4946-ad82-027c492145f8',
  },
  {
    id: 'can4450-qa-original-1793228699314',
    role: 'user',
    userMessageSource: 'human',
    timestamp: 1793228699551,
    blocks: [
      {
        type: 'text',
        text: '[Canopy-CCAN4450Manual] [Canopy-Mock-Request:original] Summarize this project.',
      },
    ],
    inputMode: 'typed',
  },
  {
    id: 'a2cf1be5-0d48-4d6c-8743-1f636499bcd7:timer',
    role: 'system',
    timestamp: 1793228699645,
    blocks: [
      {
        type: 'turn_timer',
        turnId: 'a2cf1be5-0d48-4d6c-8743-1f636499bcd7',
        startedAt: 1793228699639,
        completedAt: 1793228712687,
        userMessageId: 'can4450-qa-original-1793228699314',
        accumulatedPausedDurationMs: 0,
        pauseOwnerIds: [],
      },
    ],
  },
  {
    id: '62d9969e-7972-428f-9b1e-4fa599991e00',
    role: 'system',
    blocks: [
      {
        type: 'text',
        text: '{"error":{"canopy_proxy":"CANOPY_AI_CREDITS_PROXY","code":"no_billing_source","message":"AI Credits are unavailable for this request."}}',
      },
    ],
    timestamp: 1793228712898,
  },
  {
    id: '28fea365-1284-4bc3-be4c-4b40aa594e88:timer',
    role: 'system',
    timestamp: 1793229252367,
    blocks: [
      {
        type: 'turn_timer',
        turnId: '28fea365-1284-4bc3-be4c-4b40aa594e88',
        startedAt: 1793229252367,
        completedAt: 1793229252435,
        userMessageId: 'can4450-qa-original-1793228699314',
        accumulatedPausedDurationMs: 0,
        pauseOwnerIds: [],
      },
    ],
  },
  {
    id: 'msg_mock_1793229252400',
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: 'Ready for your project summary',
      },
    ],
    timestamp: 1793229252403,
    claudeUuid: '75aff085-ac8c-4b3f-b1eb-a9b29641de7f',
  },
];

// Positive control for newly persisted canonical completion evidence. The raw
// historical fixture above deliberately has no outcome and remains unknown.
export const COMPLETED_CREDIT_RETRY_MESSAGES: PersistedChatMessage[] =
  CREDIT_RETRY_MESSAGES.map((message, index) =>
    index === 9
      ? {
          ...message,
          blocks: message.blocks.map((block) =>
            block.type === 'turn_timer'
              ? { ...block, outcome: 'completed' as const }
              : block,
          ),
        }
      : message,
  );

/** Native Stop closes the timer without adding a cancellation diagnostic. */
export function nativeStoppedCreditRetry(): PersistedChatMessage[] {
  const messages = CREDIT_RETRY_MESSAGES.map((message, index) =>
    index === 9
      ? {
          ...message,
          blocks: message.blocks.map((block) =>
            block.type === 'turn_timer'
              ? { ...block, completedAt: null }
              : block,
          ),
        }
      : message,
  );
  return applyClaudeTranscriptEvent(
    { ...createEmptyTranscriptReducerState(), status: 'streaming', messages },
    { type: 'result', is_error: false, result: 'Session aborted' },
    {
      childToolLiveness: { kind: 'unknown' },
      now: 1793229252435,
      turnCompletedAt: 1793229252435,
      createMessageId: () => 'unused-result-id',
    },
  ).messages;
}

// Native Stop plus the exact execution's canonical cancellation handoff.
// Keep the legacy Stop fixture above unknown; a closed timer alone is not proof.
export function cancelledCreditRetry(): PersistedChatMessage[] {
  return nativeStoppedCreditRetry().map((message, index) =>
    index === 9
      ? {
          ...message,
          blocks: message.blocks.map((block) =>
            block.type === 'turn_timer'
              ? {
                  ...block,
                  completedAt: 1793229281367,
                  outcome: 'cancelled' as const,
                }
              : block,
          ),
        }
      : message,
  );
}

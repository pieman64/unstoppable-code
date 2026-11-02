import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import { persistedMessageToPortalMessage } from '@canopy/agent-transcript';
import { omitRecoveredCreditHoldArtifacts } from '../recovered-credit-hold';
import {
  COMPLETED_CREDIT_RETRY_MESSAGES as CREDIT_RETRY_MESSAGES,
  nativeStoppedCreditRetry,
  cancelledCreditRetry,
} from './fixtures/credit-retry';

const original = CREDIT_RETRY_MESSAGES[6];
const notice = CREDIT_RETRY_MESSAGES[8];
const retryTimer = CREDIT_RETRY_MESSAGES[9];
const reply = CREDIT_RETRY_MESSAGES[10];
const held = CREDIT_RETRY_MESSAGES.slice(0, -2);
const ids = (messages: PersistedChatMessage[]): string[] =>
  messages.map((message) => message.id);
const project = (
  messages: PersistedChatMessage[],
): ReturnType<typeof persistedMessageToPortalMessage>[] =>
  messages.map((message) =>
    persistedMessageToPortalMessage({
      scope: 'worktree',
      chatId: 'c1',
      message,
    }),
  );

// Both adapters consume the same canonical ordering, before display floats the
// timers. Assertions describe retained content, never a copy of the policy.
describe.each(['desktop', 'Portal'] as const)(
  'credit Retry cleanup (%s)',
  (host) => {
    function visible(messages: PersistedChatMessage[]): string[] {
      const before = JSON.stringify(messages);
      const result =
        host === 'desktop'
          ? omitRecoveredCreditHoldArtifacts(messages).map(
              (message) => message.id,
            )
          : omitRecoveredCreditHoldArtifacts(project(messages)).map(
              (message) => message.messageId,
            );
      expect(JSON.stringify(messages)).toBe(before);
      return result;
    }

    it('requires a settled later execution with an actual answer; funding alone cannot clear the hold', () => {
      for (const messages of [
        held,
        [...held, retryTimer],
        [...held, reply],
        [
          ...held,
          {
            ...retryTimer,
            blocks: retryTimer.blocks.map((block) =>
              block.type === 'turn_timer'
                ? { ...block, completedAt: null }
                : block,
            ),
          },
          reply,
        ],
      ]) {
        expect(visible(messages)).toEqual(ids(messages));
      }
    });

    it('keeps a still-failing retry and its earlier hold', () => {
      const messages = [
        ...CREDIT_RETRY_MESSAGES,
        { ...notice, id: 'new-refusal', timestamp: reply.timestamp + 1 },
      ];
      expect(visible(messages)).toEqual(ids(messages));
    });

    it('preserves hold artifacts after partial answer followed by native Stop without a diagnostic', () => {
      const messages = nativeStoppedCreditRetry();
      expect(messages[9].blocks[0]).toMatchObject({
        completedAt: 1793229252435,
      });
      expect(visible(messages)).toEqual(ids(messages));
    });

    it('preserves legacy completed timers whose execution outcome is unknown', () => {
      const messages = CREDIT_RETRY_MESSAGES.map((message) => ({
        ...message,
        blocks: message.blocks.map((block) =>
          block.type === 'turn_timer'
            ? { ...block, outcome: undefined }
            : block,
        ),
      }));
      expect(visible(messages)).toEqual(ids(messages));
    });

    it('retains the cancelled execution and warning but removes the empty prior attempt timer without mutating history', () => {
      const messages = cancelledCreditRetry();
      expect(visible(messages)).toEqual(
        ids(messages).filter((id) => id !== held[7].id),
      );
    });

    it('keeps prior timing when cancelled Retry has no answer or its own footer is still active', () => {
      const cancelled = cancelledCreditRetry();
      const active = cancelled.map((message, index) =>
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
      for (const messages of [cancelled.slice(0, -1), active]) {
        expect(visible(messages)).toEqual(ids(messages));
      }
    });

    it('preserves partial/tool activity, mixed errors and another prompt when Retry is cancelled', () => {
      const cancelled = cancelledCreditRetry();
      const tool: PersistedChatMessage = {
        ...reply,
        id: 'prior-tool',
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'read-1',
            toolName: 'Read',
            input: '{}',
          },
        ],
      };
      const diagnostic: PersistedChatMessage = {
        ...notice,
        id: 'other-error',
        blocks: [{ type: 'text', text: 'The connection dropped.' }],
      };
      for (const messages of [
        [
          ...cancelled.slice(0, 8),
          { ...reply, id: 'prior-partial' },
          ...cancelled.slice(8),
        ],
        [...cancelled.slice(0, 8), tool, ...cancelled.slice(8)],
        [...cancelled.slice(0, 8), diagnostic, ...cancelled.slice(8)],
        [...cancelled, diagnostic],
        [
          ...cancelled.slice(0, 9),
          { ...original, id: 'other-prompt' },
          ...cancelled.slice(9),
        ],
      ]) {
        expect(visible(messages)).toEqual(ids(messages));
      }
    });

    it.each(['cancelled', 'failed'] as const)(
      'preserves the warning for a canonically %s Retry even with partial output',
      (outcome) => {
        const messages = CREDIT_RETRY_MESSAGES.map((message, index) =>
          index === 9
            ? {
                ...message,
                blocks: message.blocks.map((block) =>
                  block.type === 'turn_timer' ? { ...block, outcome } : block,
                ),
              }
            : message,
        );
        expect(visible(messages)).toEqual(
          ids(messages).filter(
            (id) => outcome !== 'cancelled' || id !== held[7].id,
          ),
        );
      },
    );

    it('keeps the earlier hold and both timers when a partial Retry ends with a native API failure', () => {
      const messages: PersistedChatMessage[] = [
        ...CREDIT_RETRY_MESSAGES,
        {
          ...reply,
          id: 'native-retry-failure',
          timestamp: reply.timestamp + 1,
          blocks: [
            { type: 'text', text: 'API Error: 500 Internal server error' },
          ],
        },
      ];
      expect(visible(messages)).toEqual(ids(messages));
    });

    it('cannot clear another prompt with a later successful turn', () => {
      const messages = [
        ...held,
        { ...original, id: 'different-prompt' },
        retryTimer,
        reply,
      ];
      expect(visible(messages)).toEqual(ids(messages));
    });

    it('retains mixed notice content and its timing', () => {
      const messages = CREDIT_RETRY_MESSAGES.map((message) =>
        message.id === notice.id
          ? {
              ...message,
              blocks: [
                ...message.blocks,
                { type: 'thinking' as const, text: 'Diagnostic details' },
              ],
            }
          : message,
      );
      expect(visible(messages)).toEqual(ids(messages));
    });

    it('retains timing attached to partial visible content from the refused attempt', () => {
      const partial = {
        ...reply,
        id: 'partial',
        timestamp: notice.timestamp - 1,
      };
      const messages = [
        ...held.slice(0, -1),
        partial,
        notice,
        retryTimer,
        reply,
      ];
      expect(visible(messages)).toEqual(
        ids(messages).filter((id) => id !== notice.id),
      );
    });

    it('clears recovered artifacts while retaining an unrelated later error and ordinary failed history', () => {
      const laterError: PersistedChatMessage = {
        id: 'later-error',
        role: 'system',
        timestamp: reply.timestamp + 2,
        blocks: [{ type: 'text', text: 'The connection dropped.' }],
      };
      const messages = [
        ...CREDIT_RETRY_MESSAGES,
        { ...original, id: 'later-prompt', timestamp: reply.timestamp + 1 },
        laterError,
      ];
      const result = visible(messages);
      expect(result).not.toContain(notice.id);
      expect(result).not.toContain(held[7].id);
      expect(result).toContain(laterError.id);
      expect(result).toContain(CREDIT_RETRY_MESSAGES[1].id);
      expect(result).toContain(CREDIT_RETRY_MESSAGES[2].id);
      expect(result.filter((id) => id === original.id)).toHaveLength(1);
      expect(result).toContain(retryTimer.id);
    });
  },
);

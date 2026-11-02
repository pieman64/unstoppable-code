import type { PendingQuestion } from '@/stores/chatStore';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CODEX_BUILTIN_ASK_USER_TOOL_NAME,
} from '@/lib/canopy-tool-aliases';
import {
  answersToDisplay,
  matchAskUserQuestionRecord,
  parseAskUserQuestionTexts,
  type AskUserQuestionRecordState,
} from '@canopy/ui-shared/components';

function requiresExactToolUseId(toolName: string): boolean {
  return (
    toolName ===
      CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.codexToolName ||
    toolName === CODEX_BUILTIN_ASK_USER_TOOL_NAME
  );
}

/**
 * Match the chat's question record for a transcript ask-user `tool_use` block
 * and normalize it into one state. Async records render through their own
 * text block, so they never match a synchronous tool call. A dismissal wins
 * over a contradictory `answeredAt`, so a dismissed record never exposes an
 * answer.
 */
export function findAskUserQuestionRecordState(
  pendingQuestions: readonly PendingQuestion[],
  toolName: string,
  toolUseId: string,
  input: string,
): AskUserQuestionRecordState<PendingQuestion> {
  const record = matchAskUserQuestionRecord(
    pendingQuestions.filter((pending) => pending.delivery !== 'async'),
    (pending) => ({
      toolUseId: pending.toolUseId,
      questionTexts: pending.questions.map((question) => question.question),
    }),
    {
      toolUseId,
      questionTexts: parseAskUserQuestionTexts(input),
      requireExactToolUseId: requiresExactToolUseId(toolName),
    },
  );
  if (!record) return { kind: 'none' };
  if (record.dismissedAt !== undefined) return { kind: 'dismissed' };
  if (record.answeredAt !== undefined) {
    return {
      kind: 'answered',
      // Persisted and projected answers are already redacted; `secret` keeps
      // the answers block masking freeform text as defense in depth.
      answers: answersToDisplay(record.answers ?? [], record.questions),
    };
  }
  return { kind: 'unanswered', record };
}

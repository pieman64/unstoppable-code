import type { PendingQuestion } from '@/stores/chatStore';
import {
  CANOPY_INJECTED_TOOL_REGISTRY,
  CODEX_BUILTIN_ASK_USER_TOOL_NAME,
} from '@/lib/canopy-tool-aliases';

function requiresExactToolUseId(toolName: string): boolean {
  return (
    toolName ===
      CANOPY_INJECTED_TOOL_REGISTRY.ask_user_question.codexToolName ||
    toolName === CODEX_BUILTIN_ASK_USER_TOOL_NAME
  );
}

export function findPendingAskUserQuestion(
  pendingQuestions: PendingQuestion[],
  toolName: string,
  toolUseId: string,
): PendingQuestion | undefined {
  if (requiresExactToolUseId(toolName)) {
    return pendingQuestions.find(
      (pending) =>
        pending.delivery !== 'async' &&
        pending.toolUseId === toolUseId &&
        pending.answeredAt === undefined,
    );
  }

  return pendingQuestions.find(
    (pending) =>
      pending.delivery !== 'async' && pending.answeredAt === undefined,
  );
}

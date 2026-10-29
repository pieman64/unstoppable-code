import { useCallback, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, type PendingQuestion } from '@/stores/chatStore';

/** Keep reserved answers mounted until their awaited delivery succeeds. */
export function useComposerQuestions(
  chatId: string | undefined,
  projectId: string | undefined,
  worktreeId: string | undefined,
  enabled: boolean,
): {
  questions: PendingQuestion[];
  onDeliveryChange: (requestId: string, retained: boolean) => void;
} {
  const [retainedIds, setRetainedIds] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const questions = useChatStore(
    useShallow((state) =>
      Object.values(state.pendingQuestions).filter(
        (question) =>
          enabled &&
          chatId !== undefined &&
          question.chatId === chatId &&
          (projectId === undefined || question.projectId === projectId) &&
          (worktreeId === undefined || question.worktreeId === worktreeId) &&
          ((question.answeredAt === undefined &&
            question.dismissedAt === undefined) ||
            retainedIds.has(question.requestId)),
      ),
    ),
  );
  const onDeliveryChange = useCallback(
    (requestId: string, retained: boolean): void => {
      setRetainedIds((previous) => {
        const next = new Set(previous);
        if (retained) next.add(requestId);
        else next.delete(requestId);
        return next;
      });
    },
    [],
  );
  return { questions, onDeliveryChange };
}

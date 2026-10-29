import { useCallback, useRef, useState } from 'react';
import { openEditSkillWithAIChat } from '@/lib/editSkillWithAI';

/** Shown when the Cowork chat for "Edit with AI" could not be opened. */
const EDIT_WITH_AI_START_ERROR = "Couldn't start the chat. Try again.";

export interface EditSkillWithAI {
  /** A chat is being opened; the actions ignore further presses. */
  pending: boolean;
  error: string;
  start: (skill: { sourceId: string; name: string }) => void;
}

/**
 * Starts "Edit with AI" (CAN-1259) for a surface: one chat at a time, with a
 * failure kept on the page so the user can try again.
 */
export function useEditSkillWithAI(): EditSkillWithAI {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const start = useCallback(
    (skill: { sourceId: string; name: string }): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      setError('');
      void openEditSkillWithAIChat(skill)
        .catch((): void => {
          setError(EDIT_WITH_AI_START_ERROR);
        })
        .finally((): void => {
          inFlight.current = false;
          setPending(false);
        });
    },
    [],
  );

  return { pending, error, start };
}

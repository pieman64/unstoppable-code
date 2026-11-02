import type { JSX } from 'react';
import { TurnResumeNotice, useChatAppName } from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';
import { resumeEffectDisclosure } from '@/lib/usage-limit/interrupted-work-copy';
import type { InterruptedTurnResumePromptKind } from '@/stores/chat/interrupted-turn-resume';

export interface InterruptedTurnResumeNoticeProps {
  /** What Resume sends; absent when the history cannot tell. */
  promptKind?: InterruptedTurnResumePromptKind;
  busy: boolean;
  error?: string;
  onResume: () => void;
  onDismiss: () => void;
}

/**
 * The in-chat Resume offer for a turn cut off when the app closed (CAN-5177).
 *
 * Resume goes through main's trusted resume, the same one Home uses, so the
 * message it describes is the one that is sent. Dismiss hides the offer for
 * this session only; the chat stays on Home's interrupted list.
 */
export function InterruptedTurnResumeNotice({
  promptKind,
  busy,
  error,
  onResume,
  onDismiss,
}: InterruptedTurnResumeNoticeProps): JSX.Element {
  const appName = useChatAppName() ?? brandText.appName;
  const message =
    resumeEffectDisclosure([
      {
        session: {
          kind: 'chat',
          worktreeId: '',
          ...(promptKind ? { resumePromptKind: promptKind } : {}),
        },
      },
    ]) ?? '';
  return (
    <TurnResumeNotice
      intent="attention"
      title={`${appName} closed before this chat finished`}
      message={message}
      resumeLabel="Resume chat"
      busy={busy}
      busyLabel="Resuming…"
      onResume={onResume}
      onDismiss={onDismiss}
      data-testid="interrupted-turn-resume"
      {...(error ? { error } : {})}
    />
  );
}

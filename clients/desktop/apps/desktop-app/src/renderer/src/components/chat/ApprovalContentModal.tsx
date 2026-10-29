import type { JSX, RefObject } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { DialogModal } from '@/components/shared/DialogModal';

export interface ApprovalContentModalProps {
  title: string;
  subtitle?: string;
  /** The complete, untruncated text. */
  content: string;
  onClose: () => void;
  /** Where focus returns if the control that opened the modal is gone. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Full-text view for a tool approval's content or rule target (CAN-3001).
 * The card and the allow/deny menu headers only ever show a bounded preview;
 * this portaled dialog is the one place the whole payload renders, inside
 * `DialogModal`'s scrollable body so a multi-thousand-line script stays
 * navigable without growing the composer.
 */
export function ApprovalContentModal({
  title,
  subtitle,
  content,
  onClose,
  restoreFocusRef,
}: ApprovalContentModalProps): JSX.Element {
  return (
    <DialogModal
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      titleId="tool-approval-content-modal-title"
      maxWidth="3xl"
      dataTestId="tool-approval-content-modal"
      trapFocus
      restoreFocusRef={restoreFocusRef}
    >
      <pre
        data-testid="tool-approval-content-modal-body"
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} m-5 mt-4 select-text whitespace-pre-wrap break-all rounded-md bg-fg-primary/[0.06] px-3 py-2.5 font-mono text-xs fg-primary/90`}
      >
        {content}
      </pre>
    </DialogModal>
  );
}

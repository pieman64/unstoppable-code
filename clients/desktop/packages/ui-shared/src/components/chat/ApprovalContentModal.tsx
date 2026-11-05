import type { JSX, RefObject } from 'react';
import type { ApprovalFileChange } from '@canopy/protocol/approvals';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { DialogModal } from '../DialogModal';
import { ApprovalFileChangePreview } from './ApprovalFileChangePreview';

/** What the dialog body shows: plain text, or a proposed file change. */
export type ApprovalContentModalContent =
  | { kind: 'text'; text: string }
  | { kind: 'change'; change: ApprovalFileChange };

export interface ApprovalContentModalProps {
  title: string;
  /** Tool input, such as a file path: blocked from session replay. */
  subtitle?: string;
  /** The complete text, or the change as delivered (already bounded upstream). */
  content: ApprovalContentModalContent;
  onClose: () => void;
  /** Where focus returns if the control that opened the modal is gone. */
  restoreFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Full view for a tool approval's content or rule target (CAN-3001). The card
 * and the allow/deny menu headers only ever show a bounded preview; this
 * portaled dialog is the one place the whole payload renders, inside
 * `DialogModal`'s scrollable body so a multi-thousand-line script stays
 * navigable without growing the composer. A file change renders without the
 * compact limits (CAN-5165); text capped before delivery stays unavailable.
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
      inset="flush"
      onClose={onClose}
      title={title}
      subtitle={
        subtitle === undefined ? undefined : (
          <span
            data-testid="tool-approval-content-modal-subtitle"
            className={`${REPLAY_BLOCK_CLASS} break-all`}
          >
            {subtitle}
          </span>
        )
      }
      titleId="tool-approval-content-modal-title"
      maxWidth="3xl"
      dataTestId="tool-approval-content-modal"
      trapFocus
      restoreFocusRef={restoreFocusRef}
    >
      {content.kind === 'text' ? (
        <pre
          data-testid="tool-approval-content-modal-body"
          className={`${REPLAY_BLOCK_CLASS} m-6 mt-4 select-text whitespace-pre-wrap break-all rounded-md bg-fg-primary/[0.06] px-3 py-2.5 font-mono text-xs fg-primary/90`}
        >
          {content.text}
        </pre>
      ) : (
        <div
          data-testid="tool-approval-content-modal-body"
          className={`${REPLAY_BLOCK_CLASS} m-6 mt-4 select-text`}
        >
          <ApprovalFileChangePreview change={content.change} mode="expanded" />
        </div>
      )}
    </DialogModal>
  );
}

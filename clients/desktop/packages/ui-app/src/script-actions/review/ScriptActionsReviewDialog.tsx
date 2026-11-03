'use client';

import { useId, useState, type JSX, type RefObject } from 'react';
import { DialogModal } from '@canopy/ui-shared/components';
import {
  useScriptActionsReviewRequests,
  type ScriptActionsReviewOpenRequest,
} from '../review-requests';
import {
  ScriptActionsReview,
  type ScriptActionsReviewHostProps,
} from './ScriptActionsReview';

export interface ScriptActionsReviewDialogProps extends ScriptActionsReviewHostProps {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly onClose: () => void;
  /** Where focus goes on close when the opening control is gone. */
  readonly restoreFocusRef?: RefObject<HTMLElement | null>;
}

/**
 * Modal review. Focus moves into the dialog, stays there while it is open,
 * and returns to the control that opened it. Opening asks for a rescan; a
 * failed scan keeps the last results and shows the error.
 */
export function ScriptActionsReviewDialog({
  projectId,
  worktreeId,
  onClose,
  restoreFocusRef,
  ...hostProps
}: ScriptActionsReviewDialogProps): JSX.Element {
  const titleId = useId();
  return (
    <DialogModal
      inset="flush"
      onClose={onClose}
      title="Review scripts"
      titleId={titleId}
      maxWidth="2xl"
      trapFocus
      scrollableBody={false}
      {...(restoreFocusRef ? { restoreFocusRef } : {})}
      dataTestId="script-actions-review-dialog"
    >
      <ScriptActionsReview
        {...hostProps}
        projectId={projectId}
        worktreeId={worktreeId}
        layout="dialog"
        rescanOnMount
      />
    </DialogModal>
  );
}

export interface ScriptActionsReviewHostComponentProps extends ScriptActionsReviewHostProps {
  /** Requests for other targets are ignored, for hosts that scope them. */
  readonly accepts?: (request: ScriptActionsReviewOpenRequest) => boolean;
  /** Reported when the dialog opens, for UI state reporting. */
  readonly onOpenChange?: (
    request: ScriptActionsReviewOpenRequest | null,
  ) => void;
}

/**
 * The one review dialog per window. Composer, toast, settings and App
 * Advisor entry points call `requestScriptActionsReview`; review never opens
 * on its own.
 */
export function ScriptActionsReviewHost({
  accepts,
  onOpenChange,
  ...hostProps
}: ScriptActionsReviewHostComponentProps): JSX.Element | null {
  const [request, setRequest] = useState<
    (ScriptActionsReviewOpenRequest & { readonly openCount: number }) | null
  >(null);
  useScriptActionsReviewRequests((next) => {
    if (accepts && !accepts(next)) return;
    setRequest((previous) => ({
      ...next,
      openCount: (previous?.openCount ?? 0) + 1,
    }));
    onOpenChange?.(next);
  });
  if (request === null) return null;
  return (
    <ScriptActionsReviewDialog
      key={request.openCount}
      {...hostProps}
      projectId={request.projectId}
      worktreeId={request.worktreeId}
      onClose={(): void => {
        setRequest(null);
        onOpenChange?.(null);
      }}
    />
  );
}

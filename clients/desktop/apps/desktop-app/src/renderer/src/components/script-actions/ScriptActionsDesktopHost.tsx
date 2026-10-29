import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import type { ScriptActionsReviewOpenRequest } from '@canopy/ui-app/script-actions';
import { useEffect, useRef, useState, type JSX } from 'react';
import {
  createScriptActionsNoticeDeduper,
  ScriptActionsReviewHost,
} from '@canopy/ui-app/script-actions';
import { useDesktopScriptActionsReviewProps } from './desktopScriptActions';
import { showScriptActionsFoundToast } from './scriptActionsFoundToast';

/**
 * The window's script review dialog and post-add notices. Startup, watcher,
 * manual and review-open rescans never emit `found`, so they never toast.
 */
export function ScriptActionsDesktopHost(): JSX.Element {
  const [review, setReview] = useState<ScriptActionsReviewOpenRequest | null>(
    null,
  );
  useCurrentUiStateReporter(
    'scriptActions.review',
    review
      ? { projectId: review.projectId, worktreeId: review.worktreeId }
      : null,
  );
  const reviewProps = useDesktopScriptActionsReviewProps();
  const dedupe = useRef(createScriptActionsNoticeDeduper());
  useEffect(
    () =>
      window.api.scriptActions.onFound((receipt) => {
        showScriptActionsFoundToast(receipt, dedupe.current);
      }),
    [],
  );
  return <ScriptActionsReviewHost {...reviewProps} onOpenChange={setReview} />;
}

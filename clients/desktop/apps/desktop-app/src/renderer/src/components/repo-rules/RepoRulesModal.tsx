import { useMemo, useState, type JSX } from 'react';
import {
  RepoRulesReview,
  repoRulesAppliedToastCopy,
  type RepoRulesOfferOutcome,
} from '@canopy/ui-app/repo-rules';
import { DialogModal } from '@/components/shared/DialogModal';
import { brandText } from '@/lib/brand';
import {
  captureRepoRulesReviewOrigin,
  retargetHomeAfterRepoRulesApplied,
} from '@/lib/repoRulesHomeRetarget';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  useRepoRulesModalStore,
  repoRulesOfferEligibleIds,
  type RepoRulesModalTarget,
} from '@/stores/repoRulesModalStore';
import { evaluateEditorSetupGate } from './editorSetupCompletionGate';
import {
  recordRepoRulesOfferDecision,
  recordRepoRulesSave,
} from './repoRulesOfferCompletion';

interface RepoRulesModalProps {
  target: RepoRulesModalTarget;
  onClose: () => void;
}

/**
 * Modal chrome for the Cursor rules review (CAN-2053). The shared review owns
 * consent, scanning, and the saved policy; the desktop supplies its code
 * workspaces, confirms each save with a result toast (CAN-4676), and aims an
 * untouched Home composer at a just-imported project (CAN-4674). Settings
 * resumes a multi-project offer (CAN-4980) while any projects remain undecided.
 */
export function RepoRulesModal({
  target,
  onClose,
}: RepoRulesModalProps): JSX.Element {
  const projects = useProjectsStore((state) => state.projects);
  // The host remounts this modal per open, so this is the review's origin.
  const [origin] = useState(() => captureRepoRulesReviewOrigin(target.source));
  const offer = useRepoRulesModalStore((state) => state.offer);
  const codeProjects = useMemo(
    () =>
      projects
        .filter((project) => project.type !== 'cowork')
        .map((project) => ({ id: project.id, name: project.name })),
    [projects],
  );
  const eligibleIds = useMemo(
    () => new Set(codeProjects.map((project) => project.id)),
    [codeProjects],
  );
  // Fixed for this open: an offer's own entry point, or Settings while
  // the offer still has undecided projects.
  const [offerFlow] = useState(
    () =>
      offer !== null &&
      target.workspaceId === undefined &&
      (target.workspaceIds !== undefined ||
        (target.source === 'settings' &&
          evaluateEditorSetupGate(
            offer,
            repoRulesOfferEligibleIds(eligibleIds),
          ) === 'pending')),
  );
  const offerMemberIds = offerFlow ? offer?.memberIds : undefined;
  // An offer lists only its projects, even when none remain: the empty state
  // closes rather than offering unrelated projects.
  const workspaces = useMemo(
    () =>
      offerMemberIds
        ? codeProjects.filter((project) => offerMemberIds.includes(project.id))
        : codeProjects,
    [codeProjects, offerMemberIds],
  );
  return (
    <DialogModal
      onClose={onClose}
      title="Cursor rules"
      subtitle="Use a project's Cursor rules in new chats"
      maxWidth="2xl"
      dataTestId="repo-rules-modal"
    >
      {/* DialogModal pads only its header; the body inset matches it. */}
      <div className="p-5">
        <RepoRulesReview
          appName={brandText.appName}
          workspaces={workspaces}
          {...(target.workspaceId
            ? { initialWorkspaceId: target.workspaceId }
            : {})}
          onClose={onClose}
          {...(offerFlow && offer
            ? {
                offer: {
                  decisions: offer.decisions,
                  onDecide: (workspaceId, decision): RepoRulesOfferOutcome =>
                    recordRepoRulesOfferDecision(
                      workspaceId,
                      decision,
                      eligibleIds,
                    ),
                },
              }
            : {})}
          onApplied={(result): void => {
            // The offer flow recorded this save through `onDecide`.
            if (!offerFlow) recordRepoRulesSave(result, eligibleIds);
            const { title, message } = repoRulesAppliedToastCopy(result);
            // Name the saved project, never the current selection; omit the
            // name rather than show another project's.
            const workspaceName = workspaces.find(
              (workspace) => workspace.id === result.workspaceId,
            )?.name;
            useGitHubStore.getState().addToast(message, 'success', undefined, {
              title,
              ...(workspaceName ? { workspaceName } : {}),
              projectId: result.workspaceId,
              // The modal closed or moved on from this save, so confirm it
              // even with in-app notifications off, and keep it out of the OS.
              forceInApp: true,
              suppressOsNotification: true,
            });
            retargetHomeAfterRepoRulesApplied(origin, result);
          }}
        />
      </div>
    </DialogModal>
  );
}

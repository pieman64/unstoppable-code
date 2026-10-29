import { useMemo, type JSX } from 'react';
import { RepoRulesReview } from '@canopy/ui-app/repo-rules';
import { DialogModal } from '@/components/shared/DialogModal';
import { completeOnboardingSuggestionDurably } from '@/components/home/onboarding-suggestions/completionWriter';
import { brandText } from '@/lib/brand';
import { useProjectsStore } from '@/stores/projectsStore';
import type { RepoRulesModalTarget } from '@/stores/repoRulesModalStore';

interface RepoRulesModalProps {
  target: RepoRulesModalTarget;
  onClose: () => void;
}

/**
 * Modal chrome for the Cursor rules review (CAN-2053). The shared review owns
 * consent, scanning, and the saved policy; the desktop supplies its code
 * workspaces and records Getting started completion after rules turn on.
 */
export function RepoRulesModal({
  target,
  onClose,
}: RepoRulesModalProps): JSX.Element {
  const projects = useProjectsStore((state) => state.projects);
  const onlyIds =
    target.workspaceId === undefined ? target.workspaceIds : undefined;
  const workspaces = useMemo(() => {
    const code = projects
      .filter((project) => project.type !== 'cowork')
      .map((project) => ({ id: project.id, name: project.name }));
    const narrowed = onlyIds
      ? code.filter((project) => onlyIds.includes(project.id))
      : [];
    // Narrowing is a shortcut. If those projects are gone, offer every one
    // rather than an empty choice that says to add a project.
    return narrowed.length > 0 ? narrowed : code;
  }, [projects, onlyIds]);
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
          onApplied={({ status }): void => {
            if (status.enabled)
              completeOnboardingSuggestionDurably(
                'import-editor-setup',
                'finished',
              );
          }}
        />
      </div>
    </DialogModal>
  );
}

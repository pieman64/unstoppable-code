import type { AppAdvisorRepoRulesModalSource } from '@canopy/desktop-shared/types';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { openRepoRulesModal } from '@/stores/repoRulesModalStore';

/** Presence checks are metadata-only, but an import can add many projects. */
const MAX_PRESENCE_CHECKS = 10;

/**
 * Projects checked this session, so each one is offered once. A check that
 * fails is forgotten, so a later trigger can try that project again.
 */
const checkedWorkspaceIds = new Set<string>();

export interface NewWorkspace {
  readonly workspaceId: string;
  /** Shown on the offer; looked up from the project list when omitted. */
  readonly displayName?: string;
}

/** Whether to offer the review; `undefined` when the check failed. */
async function needsRulesReview(
  workspaceId: string,
): Promise<boolean | undefined> {
  try {
    const status = await window.api.repoRules.status({ workspaceId });
    // Rules that are on, or that the member reviewed and left off, are decided.
    if (status.enabled || status.reviewedAt !== undefined) return false;
    const presence = await window.api.editorSetup.presence({ workspaceId });
    return presence.cursorRulesPresent === true;
  } catch {
    // The offer is a nudge; Settings and Project settings still open the review.
    return undefined;
  }
}

function projectName(workspace: NewWorkspace): string | undefined {
  return (
    workspace.displayName ??
    useProjectsStore
      .getState()
      .projects.find((project) => project.id === workspace.workspaceId)?.name
  );
}

/**
 * After projects are added (CAN-2053), offers the Cursor rules review for the
 * new ones whose repository root has Cursor rules that are not turned on yet.
 * The check reads file metadata only, never rule contents. Nothing is turned
 * on here: the offer opens the same consent and review as every other entry
 * point.
 */
export async function offerCursorRulesReview(
  workspaces: readonly NewWorkspace[],
  source: Extract<
    AppAdvisorRepoRulesModalSource,
    'add-project' | 'first-run-import'
  >,
): Promise<void> {
  const candidates = workspaces
    .filter((workspace) => !checkedWorkspaceIds.has(workspace.workspaceId))
    .slice(0, MAX_PRESENCE_CHECKS);
  if (candidates.length === 0) return;
  for (const workspace of candidates)
    checkedWorkspaceIds.add(workspace.workspaceId);
  const needed = await Promise.all(
    candidates.map((workspace) => needsRulesReview(workspace.workspaceId)),
  );
  candidates.forEach((workspace, index) => {
    if (needed[index] === undefined)
      checkedWorkspaceIds.delete(workspace.workspaceId);
  });
  const withRules = candidates.filter((_, index) => needed[index] === true);
  const [first] = withRules;
  if (!first) return;
  const single = withRules.length === 1;
  const name = single ? projectName(first) : undefined;
  useGitHubStore.getState().addToast(
    // The single-project message doesn't repeat the title: the stacked
    // notification card leads with the project name and puts the title in
    // front of the message.
    single
      ? 'Review them to use them in new chats. The repository stays unchanged.'
      : `${withRules.length} new projects have Cursor rules. Review them to use them in new chats. The repositories stay unchanged.`,
    'info',
    undefined,
    {
      title: 'Cursor rules found',
      persistent: true,
      // The member just added the project with the app in front, and a
      // native banner can't carry the action.
      suppressOsNotification: true,
      ...(name ? { workspaceName: name } : {}),
      // Shows the project's icon on the stacked card, like other project
      // notifications. There is no worktree, so the toast doesn't navigate.
      ...(single ? { projectId: first.workspaceId } : {}),
      action: {
        label: 'Review Cursor rules',
        onClick: (): void =>
          openRepoRulesModal(
            single
              ? { source, workspaceId: first.workspaceId }
              : {
                  source,
                  workspaceIds: withRules.map(
                    (workspace) => workspace.workspaceId,
                  ),
                },
          ),
      },
    },
  );
}

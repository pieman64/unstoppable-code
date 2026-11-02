import type { AppAdvisorRepoRulesModalSource } from '@canopy/desktop-shared/types';
import type { RepoRulesStatus } from '@canopy/protocol/repo-rules';
import { serializeWorkspaceContext } from '@canopy/protocol/workspace-context';
import { getHomeScope } from '@/components/home/homeScope';
import { useHomeComposerStore } from '@/stores/homeComposerStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';

/**
 * Review sources that follow an import, where the member has not chosen a
 * project yet and the review names the one they are about to work in.
 */
const RETARGETING_SOURCES: ReadonlySet<AppAdvisorRepoRulesModalSource> =
  new Set<AppAdvisorRepoRulesModalSource>([
    'first-run-import',
    'import-results',
  ]);

/** The state a rules review opened against, to reject a stale Apply. */
export interface RepoRulesReviewOrigin {
  readonly source: AppAdvisorRepoRulesModalSource;
  readonly accountEpoch: number;
  readonly contextRevision: number;
  readonly contextKey: string;
  readonly selectionGeneration: number;
}

export function captureRepoRulesReviewOrigin(
  source: AppAdvisorRepoRulesModalSource,
): RepoRulesReviewOrigin {
  const context = useWorkspaceContextStore.getState();
  return {
    source,
    accountEpoch: context.accountEpoch,
    contextRevision: context.state.revision,
    contextKey: serializeWorkspaceContext(context.state.context),
    selectionGeneration:
      useHomeComposerStore.getState().workspaceSelectionGeneration,
  };
}

/** The draft and selection facts that decide whether a retarget is safe. */
export interface RetargetComposerState {
  readonly text: string;
  readonly fileReferences: readonly unknown[];
  readonly attachments: readonly unknown[];
  readonly pendingAttachmentImportIds: readonly unknown[];
  readonly scheduledSendDraft: { readonly runAt: string } | null;
  readonly isSending: boolean;
  readonly workspaceSelectionExplicit: boolean;
}

/**
 * Whether the composer holds nothing a retarget could discard and no project
 * the member chose. Selecting another workspace drops staged attachments and
 * schedules, so any draft content protects the current target.
 */
export function isHomeComposerRetargetable(
  composer: RetargetComposerState,
): boolean {
  return (
    composer.text.trim() === '' &&
    composer.fileReferences.length === 0 &&
    composer.attachments.length === 0 &&
    composer.pendingAttachmentImportIds.length === 0 &&
    composer.scheduledSendDraft === null &&
    !composer.isSending &&
    !composer.workspaceSelectionExplicit
  );
}

function isOriginCurrent(origin: RepoRulesReviewOrigin): boolean {
  const context = useWorkspaceContextStore.getState();
  return (
    context.accountEpoch === origin.accountEpoch &&
    context.state.revision === origin.contextRevision &&
    serializeWorkspaceContext(context.state.context) === origin.contextKey &&
    useHomeComposerStore.getState().workspaceSelectionGeneration ===
      origin.selectionGeneration
  );
}

function isWorkspaceAvailable(workspaceId: string): boolean {
  const project = useProjectsStore
    .getState()
    .projects.find((candidate) => candidate.id === workspaceId);
  return (
    project !== undefined &&
    project.type !== 'cowork' &&
    getHomeScope().isInScope(workspaceId)
  );
}

/**
 * Aims an untouched Home composer at the project whose post-import Cursor
 * rules were just turned on (CAN-4674), so an immediate task goes there.
 * Reads live state; leaves a protected or stale composer entirely unchanged.
 * Never navigates or changes context. Returns whether the visible target or
 * reason changed; a same-project Apply also advances selection identity.
 */
export function retargetHomeAfterRepoRulesApplied(
  origin: RepoRulesReviewOrigin,
  result: { readonly workspaceId: string; readonly status: RepoRulesStatus },
): boolean {
  if (!RETARGETING_SOURCES.has(origin.source)) return false;
  if (!result.status.enabled) return false;
  if (!isOriginCurrent(origin)) return false;
  const composer = useHomeComposerStore.getState();
  if (!isHomeComposerRetargetable(composer)) return false;
  if (!isWorkspaceAvailable(result.workspaceId)) return false;
  if (composer.workspaceId === result.workspaceId) {
    const hadReason = composer.workspaceSelectionReason !== null;
    composer.clearWorkspaceSelectionReason();
    return hadReason;
  }
  composer.selectWorkspace(result.workspaceId, { explicit: false });
  return true;
}

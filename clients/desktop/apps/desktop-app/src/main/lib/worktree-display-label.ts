import {
  APP_ADVISOR_PROJECT_ID,
  IPC_CHANNELS,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  canGenerateWorktreeLabel,
  evaluateGeneratedWorktreeLabel,
  type GeneratedWorktreeLabelCandidate,
} from '@canopy/protocol/worktree-display-labels';
import { isDefaultWorktreeBranchName } from '@canopy/desktop-shared/lib/default-worktree-branch';
import { getExecutionObservabilityIngest } from '../observability/ingest';
import { sendToAllWindows } from './window-send';
import { readWorkspaceWorktrees } from './workspace-persistence';
import { isCoworkWorkspace } from './workspace-registry';
import { recordGeneratedWorktreeLabel } from './worktree-repair';

// Generated sidebar labels ride on the worktree summary run: it already reads
// the conversation and the changes after turns settle, so it proposes the
// label too. The label is validated here and written as a system record that
// a manual label always wins over. Git branch names are never touched.

export interface WorktreeDisplayLabelContext {
  /** Present when the worktree may take a generated label. */
  request?: { provisionalLabel?: string };
  /** Branch and linked pull request lines for the summary prompt. */
  worktreeContext?: string;
}

function describeWorktree(worktree: WorktreeData): string {
  const lines = isDefaultWorktreeBranchName(worktree.branchName, worktree.id)
    ? []
    : [`Branch: ${worktree.branchName}`];
  for (const repo of worktree.lastKnownPrStatus?.repos ?? []) {
    if (!repo.status) continue;
    lines.push(
      `Pull request in ${repo.repoName}: #${repo.status.prNumber} ${repo.status.title}`,
    );
  }
  return lines.join('\n');
}

/** Reads what the summary prompt needs to propose a display label. */
export async function readWorktreeDisplayLabelContext(
  projectId: string,
  worktreeId: string,
): Promise<WorktreeDisplayLabelContext> {
  // Cowork projects and the advisor have no worktree rows to label.
  if (projectId === APP_ADVISOR_PROJECT_ID || isCoworkWorkspace(projectId)) {
    return {};
  }
  const worktrees = await readWorkspaceWorktrees(projectId).catch(
    (): WorktreeData[] => [],
  );
  const worktree = worktrees.find((row) => row.id === worktreeId);
  if (!worktree) return {};
  const worktreeContext = describeWorktree(worktree);
  const context: WorktreeDisplayLabelContext = worktreeContext
    ? { worktreeContext }
    : {};
  if (!canGenerateWorktreeLabel(worktree)) return context;
  return {
    ...context,
    request:
      worktree.labelSource === 'generated' && worktree.label
        ? { provisionalLabel: worktree.label }
        : {},
  };
}

export interface GeneratedDisplayLabelInput {
  projectId: string;
  worktreeId: string;
  candidate: GeneratedWorktreeLabelCandidate | null;
  /** The conversation, changes and worktree context the label must reflect. */
  evidence: string;
  observabilityTaskKey?: string;
}

/**
 * Validates a proposed label and records it when it names the work. A
 * rejected candidate leaves the row as it is, so the next summary run tries
 * again with more of the conversation.
 */
export async function applyGeneratedDisplayLabel(
  input: GeneratedDisplayLabelInput,
): Promise<void> {
  if (!input.candidate) return;
  const verdict = evaluateGeneratedWorktreeLabel(
    input.candidate,
    input.evidence,
  );
  if (input.observabilityTaskKey) {
    getExecutionObservabilityIngest().appendTranscriptRecord(
      input.observabilityTaskKey,
      {
        type: 'canopy_helper_diagnostic',
        helper: 'worktree_display_label',
        level: verdict.kind === 'accepted' ? 'info' : 'warning',
        message:
          verdict.kind === 'accepted'
            ? 'Generated display label accepted'
            : `Generated display label rejected: ${verdict.reason}`,
        clarity: input.candidate.clarity,
        timestamp: new Date().toISOString(),
      },
    );
  }
  if (verdict.kind !== 'accepted') return;
  const outcome = await recordGeneratedWorktreeLabel({
    workspaceId: input.projectId,
    worktreeId: input.worktreeId,
    label: verdict.label,
    provisional: verdict.provisional,
  });
  if (outcome.status === 'recorded' && outcome.worktree) {
    sendToAllWindows(IPC_CHANNELS.workspaceWorktreesUpdated, {
      workspaceId: input.projectId,
      worktree: outcome.worktree,
    });
  }
}

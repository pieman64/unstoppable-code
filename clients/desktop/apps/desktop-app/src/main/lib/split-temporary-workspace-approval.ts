import { randomUUID } from 'node:crypto';
import type {
  SplitTemporaryWorkspaceDestructiveApprovalRequest,
  SplitTemporaryWorkspacePreviewResponse,
  SplitTemporaryWorkspaceRequest,
} from '@canopy/desktop-shared/types';

const APPROVAL_TTL_MS = 60_000;
const approvals = new Map<string, { fingerprint: string; expiresAt: number }>();

export const SPLIT_DESTRUCTIVE_APPROVAL_REQUIRED_MESSAGE =
  'Permanent deletion must be confirmed in the Split project dialog. Review the current preview and confirm the operation there.';

function approvalFingerprint(
  request: SplitTemporaryWorkspaceRequest,
  preview: SplitTemporaryWorkspacePreviewResponse,
): { destructive: boolean; value: string } {
  const rootAction = request.rootAction ?? 'delete';
  const repos = preview.repos
    .map((repo) => ({
      repoId: repo.repoId,
      selection: request.selections[repo.repoId] ?? 'split',
      removalMode: repo.removalMode,
      destinationWorkspaceId: repo.destinationWorkspaceId ?? null,
    }))
    .sort((left, right) => left.repoId.localeCompare(right.repoId));
  const destructive =
    (preview.root.present && rootAction === 'delete') ||
    repos.some(
      (repo) => repo.selection === 'remove' && repo.removalMode === 'delete',
    );
  return {
    destructive,
    value: JSON.stringify({
      workspaceId: request.workspaceId,
      worktreeId: request.worktreeId,
      previewRevision: preview.previewRevision,
      rootAction,
      root: {
        present: preview.root.present,
        canArchive: preview.root.canArchive,
      },
      repos,
    }),
  };
}

function pruneExpiredApprovals(now: number): void {
  approvals.forEach((approval, token) => {
    if (approval.expiresAt <= now) {
      approvals.delete(token);
    }
  });
}

export function createSplitTemporaryWorkspaceDestructiveApproval(
  request: SplitTemporaryWorkspaceDestructiveApprovalRequest,
  preview: SplitTemporaryWorkspacePreviewResponse,
  now = Date.now(),
): string | null {
  pruneExpiredApprovals(now);
  const fingerprint = approvalFingerprint(request, preview);
  if (!fingerprint.destructive) {
    return null;
  }
  if (request.previewRevision !== preview.previewRevision) {
    throw new Error(SPLIT_DESTRUCTIVE_APPROVAL_REQUIRED_MESSAGE);
  }
  const token = randomUUID();
  approvals.set(token, {
    fingerprint: fingerprint.value,
    expiresAt: now + APPROVAL_TTL_MS,
  });
  return token;
}

export function consumeSplitTemporaryWorkspaceDestructiveApproval(
  request: SplitTemporaryWorkspaceRequest,
  preview: SplitTemporaryWorkspacePreviewResponse,
  now = Date.now(),
): void {
  pruneExpiredApprovals(now);
  const fingerprint = approvalFingerprint(request, preview);
  if (!fingerprint.destructive) {
    return;
  }
  const token = request.destructiveApprovalToken;
  const approval = token ? approvals.get(token) : undefined;
  if (token) {
    approvals.delete(token);
  }
  if (
    !approval ||
    approval.expiresAt <= now ||
    request.previewRevision !== preview.previewRevision ||
    approval.fingerprint !== fingerprint.value
  ) {
    throw new Error(SPLIT_DESTRUCTIVE_APPROVAL_REQUIRED_MESSAGE);
  }
}

export interface PendingReviewPrReference {
  owner: string;
  repo: string;
  prId: number;
}

export type PendingReviewClassification =
  | 'pre_existing_human'
  | 'pre_existing_automated'
  | 'new_automated_partial';

export type PendingReviewEscrowStatus =
  | 'captured'
  | 'deleted_pending_restore'
  | 'deleted_not_restored'
  | 'delete_failed'
  | 'restoring'
  | 'restored'
  | 'restore_failed';

export interface GitHubPendingReview extends Record<string, unknown> {
  id: number;
  state: 'PENDING';
  body: string;
  commit_id: string;
  user: Record<string, unknown> & { login: string };
}

export interface GitHubPendingReviewComment extends Record<string, unknown> {
  id: number;
  path: string;
  body: string;
}

export interface PendingReviewEscrowEntry {
  originalReviewId: number;
  classification: PendingReviewClassification;
  status: PendingReviewEscrowStatus;
  capturedAt: string;
  deletedAt?: string;
  restoredAt?: string;
  restoredReviewId?: string;
  deletionError?: string;
  restorationError?: string;
  review: GitHubPendingReview;
  comments: GitHubPendingReviewComment[];
  restorePayload: Record<string, unknown>;
}

export interface PendingReviewEscrowData {
  version: 1;
  durable: true;
  pr: PendingReviewPrReference;
  createdAt: string;
  updatedAt: string;
  entries: PendingReviewEscrowEntry[];
}

export interface PendingReviewFilesystem {
  writeUtf8File(filePath: string, content: string): void;
  renameFile(oldPath: string, newPath: string): void;
}

import { create } from 'zustand';

export type GitHubConnectOfferKind =
  | 'push'
  | 'pr'
  | 'org-project-setup'
  | 'home-link-add-project';

/**
 * What a push or pull request that failed on GitHub authentication needs to
 * continue once, after the user connects GitHub. Transient: never persisted.
 */
export interface GitHubActionContinuation {
  operationId: string;
  kind: 'push' | 'pr';
  /** Preserve original analytics attribution across the one login continuation. */
  source?: 'manual' | 'chat';
  telemetryRepoCount?: number;
  projectId: string;
  worktreeId: string;
  /**
   * Authentication-failed repositories, plus already-pushed siblings whose
   * PR stage has not started. Successful commit/push stages are never repeated.
   */
  repoIds?: string[];
  /**
   * The shared original head, or null for different/unknown repository heads.
   * Different known heads use expectedHeadBranches; unknown targets never retry.
   */
  expectedHeadBranch: string | null;
  /** Original per-repository heads, including operations with different branches. */
  expectedHeadBranches?: Record<string, string>;
  /** Commit & Push already committed; push those commits with upstream tracking. */
  establishUpstream?: boolean;
  /** Preserve rebase-pull intent when authentication failed before committing. */
  pullFirst?: boolean;
  /** False for a preflight offer: no commit or PR stage has started yet. */
  skipCommit?: boolean;
  /** Whether each auth-failed PR repository has already prepared its commits. */
  repoCommitPrepared?: Record<string, boolean>;
  /** Successful push stages that must not run again when creating the PR. */
  pushCompletedRepoIds?: string[];
}

/**
 * An org project setup whose clone failed on GitHub authentication (CAN-4466).
 * It continues only under the account it was offered for.
 */
export interface OrgProjectSetupContinuation {
  operationId: string;
  kind: 'org-project-setup';
  projectId: string;
  destinationRoot?: string;
  accountEpoch: number;
}

/**
 * A Home link that needs GitHub to become a project (CAN-4466): `resolve`
 * re-resolves the link target, `send` resends the composer once.
 */
export interface HomeLinkAddProjectContinuation {
  operationId: string;
  kind: 'home-link-add-project';
  resume: 'resolve' | 'send';
  /** The link a resend must still target. */
  linkKey?: string;
  /** The submitted draft a resend must still hold, so edits never auto-send. */
  draftText?: string;
  /** The send failure to show again when the offer ends without a resend. */
  failureMessage?: string;
}

/** What an action that needed GitHub continues once the user connects. */
export type GitHubConnectContinuation =
  | GitHubActionContinuation
  | OrgProjectSetupContinuation
  | HomeLinkAddProjectContinuation;

export function isGitHubActionContinuation(
  continuation: GitHubConnectContinuation,
): continuation is GitHubActionContinuation {
  return continuation.kind === 'push' || continuation.kind === 'pr';
}

/** idle (no offer) → offered → settling → retrying → cleared (no offer). */
export type GitHubConnectOfferPhase = 'offered' | 'settling' | 'retrying';

export interface GitHubConnectOffer {
  continuation: GitHubConnectContinuation;
  phase: GitHubConnectOfferPhase;
}

export type GitHubConnectOfferRequestResult = 'offered' | 'coalesced' | 'busy';

interface GitHubConnectOfferState {
  offer: GitHubConnectOffer | null;
  /**
   * Offer to connect GitHub for an operation. A repeat for the same operation
   * coalesces; another operation never replaces a pending offer.
   */
  requestOffer: (
    continuation: GitHubConnectContinuation,
  ) => GitHubConnectOfferRequestResult;
  /** offered → settling, once per offer. Returns false when already claimed. */
  beginSettle: (operationId: string) => boolean;
  /** settling → retrying, once per offer. Returns the continuation to run. */
  claimRetry: (operationId: string) => GitHubConnectContinuation | null;
  /** Clears the offer, only if it still belongs to `operationId` when given. */
  clearOffer: (operationId?: string) => void;
}

export const useGitHubConnectOfferStore = create<GitHubConnectOfferState>(
  (set, get) => ({
    offer: null,

    requestOffer: (continuation): GitHubConnectOfferRequestResult => {
      const current = get().offer;
      if (current) {
        return current.continuation.operationId === continuation.operationId
          ? 'coalesced'
          : 'busy';
      }
      set({ offer: { continuation, phase: 'offered' } });
      return 'offered';
    },

    beginSettle: (operationId): boolean => {
      const current = get().offer;
      if (
        current?.phase !== 'offered' ||
        current.continuation.operationId !== operationId
      ) {
        return false;
      }
      set({ offer: { ...current, phase: 'settling' } });
      return true;
    },

    claimRetry: (operationId): GitHubConnectContinuation | null => {
      const current = get().offer;
      if (
        current?.phase !== 'settling' ||
        current.continuation.operationId !== operationId
      ) {
        return null;
      }
      set({ offer: { ...current, phase: 'retrying' } });
      return current.continuation;
    },

    clearOffer: (operationId): void => {
      const current = get().offer;
      if (!current) return;
      if (
        operationId !== undefined &&
        current.continuation.operationId !== operationId
      ) {
        return;
      }
      set({ offer: null });
    },
  }),
);

/** Whether a worktree has a connect offer that has not finished. */
export function hasPendingGitHubConnectOffer(
  projectId: string,
  worktreeId: string,
): boolean {
  const continuation =
    useGitHubConnectOfferStore.getState().offer?.continuation;
  return (
    continuation !== undefined &&
    isGitHubActionContinuation(continuation) &&
    continuation.projectId === projectId &&
    continuation.worktreeId === worktreeId
  );
}

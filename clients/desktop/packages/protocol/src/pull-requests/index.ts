// Pure pull request helpers shared by the desktop app and the cloud server
// (REG-3025). Hoisted from `@canopy/desktop-shared` so `apps/web`, which may
// not import desktop-shared, judges checks, merge readiness and PR content the
// same way the desktop does. Everything here is pure: no transport, no Node,
// no React. Desktop-shared re-exports these names unchanged.

/** Aggregate CI state of a pull request head. `none`: no checks reported. */
export type PullRequestCheckStatus =
  | 'passing'
  | 'failing'
  | 'pending'
  | 'neutral'
  | 'none';

export type PullRequestReviewStatus =
  | 'approved'
  | 'changes_requested'
  | 'pending'
  | 'none';

export type PullRequestLifecycleState = 'open' | 'merged' | 'closed' | 'draft';

/** What merge readiness reads from a pull request status. */
export interface PullRequestMergeInput {
  state: PullRequestLifecycleState;
  checkStatus: PullRequestCheckStatus;
  reviewStatus: PullRequestReviewStatus;
  hasConflicts: boolean;
  /** GitHub's computed test-merge result; `null` while GitHub computes it. */
  mergeable?: boolean | null;
  /** GitHub's `mergeable_state`, for example `clean`, `blocked`, `dirty`. */
  mergeableState?: string | null;
  /** Merge queue facts; absent when unknown. */
  mergeQueue?: { required?: boolean; inQueue?: boolean };
}

/**
 * One status for a set of checks: any failure wins, then pending, then
 * passing, then neutral. No checks at all is `none`, never `passing`.
 */
export function aggregateCheckStatus(
  statuses: readonly PullRequestCheckStatus[],
): PullRequestCheckStatus {
  if (statuses.includes('failing')) return 'failing';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('passing')) return 'passing';
  if (statuses.includes('neutral')) return 'neutral';
  return 'none';
}

const READY_MERGEABLE_STATES = new Set(['clean', 'has_hooks']);

/** True when the PR is open and already in its base branch's merge queue. */
export function isPrInMergeQueue(
  status: Pick<PullRequestMergeInput, 'state' | 'mergeQueue'>,
): boolean {
  return status.state === 'open' && status.mergeQueue?.inQueue === true;
}

/**
 * Pure check for whether a PR is mergeable via the GitHub API. Shared by the
 * desktop renderer (button gating), the desktop merge handler (server-side
 * re-verification) and the cloud server, so all agree on what "mergeable"
 * means.
 */
export function isPrReadyToMerge(status: PullRequestMergeInput): boolean {
  if (status.state !== 'open' || status.hasConflicts) {
    return false;
  }
  // A queued PR has nothing left to merge or enqueue.
  if (isPrInMergeQueue(status)) {
    return false;
  }

  const hasMergeabilitySignal =
    Object.prototype.hasOwnProperty.call(status, 'mergeable') ||
    Object.prototype.hasOwnProperty.call(status, 'mergeableState');
  const mergeableState = status.mergeableState?.toLowerCase();
  // GitHub's ready mergeable_state values already account for required
  // reviews and status checks, so local review/check fields are not rechecked.
  if (mergeableState) {
    if (READY_MERGEABLE_STATES.has(mergeableState)) {
      return true;
    }
    // GitHub may report a PR whose base branch requires a merge queue as
    // `blocked`, because a direct merge is not allowed. The PR can still be
    // enqueued, so the local review and check signals stand in for GitHub's
    // rollup. Enqueueing re-verifies on GitHub's side. Tradeoff: `blocked`
    // also covers rules these signals can't see (code owners, extra
    // approvals, conversation resolution); for those PRs Merge is offered and
    // GitHub's enqueue error is shown.
    return (
      mergeableState === 'blocked' &&
      status.mergeQueue?.required === true &&
      status.reviewStatus === 'approved' &&
      status.checkStatus === 'passing'
    );
  }

  if (status.mergeable !== undefined && status.mergeable !== null) {
    return (
      status.mergeable &&
      status.reviewStatus === 'approved' &&
      status.checkStatus === 'passing'
    );
  }

  if (hasMergeabilitySignal) {
    return false;
  }

  return status.reviewStatus === 'approved' && status.checkStatus === 'passing';
}

// ---------------------------------------------------------------------------
// Pull request content policy
// ---------------------------------------------------------------------------

/** A generated pull request title and body. */
export interface PrContent {
  title: string;
  body: string;
}

/** The first line of the system prompt for PR content generation. */
export const PR_CONTENT_SYSTEM_PREAMBLE =
  'You generate GitHub pull request titles and bodies from the supplied diff and commit log.';

export const DEFAULT_PR_CONTENT_INSTRUCTIONS =
  "Respect the project's GitHub PR template when creating the pull request title and body. " +
  'Summarize changes concisely with a brief description in the title and a complete ' +
  'but brief summary of individual changes in the body.';

export const PR_CONTENT_RESPONSE_FORMAT_INSTRUCTIONS = [
  'Return exactly one structured object with two fields: `title` and `body`.',
  'The `title` value must be only the pull request title text. Do not use placeholder or label text such as "PR Title and Body", "Title", or "PR Title".',
  'The `body` value must be only the pull request body markdown. Do not include an extra PR title, a "Body" label, or a markdown divider that separates title and body.',
  'Minimal example response: {"title":"Add GitHub PR generation","body":"## Summary\\n- Add generated PR title and body support"}',
].join(' ');

/** JSON schema of a {@link PrContent} response. */
export const PR_CONTENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string' },
    body: { type: 'string' },
  },
  required: ['title', 'body'],
};

export function isPrContent(value: unknown): value is PrContent {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const title: unknown = Reflect.get(value, 'title');
  const body: unknown = Reflect.get(value, 'body');
  return (
    typeof title === 'string' &&
    title.trim().length > 0 &&
    typeof body === 'string'
  );
}

/**
 * The instructions a PR content request uses: `replace` uses the user's
 * instructions alone, `append` adds them after the default, anything else
 * uses the default.
 */
export function resolvePrContentInstructions(options: {
  instructions: string;
  instructionMode: string;
}): string {
  if (options.instructionMode === 'replace') {
    return options.instructions;
  }

  if (options.instructionMode === 'append' && options.instructions) {
    return `${DEFAULT_PR_CONTENT_INSTRUCTIONS}\n\nAdditional instructions:\n${options.instructions}`;
  }

  return DEFAULT_PR_CONTENT_INSTRUCTIONS;
}

/** A readable title from a branch name: `feat/add-login` → `Add login`. */
export function formatBranchAsTitle(branch: string): string {
  const stripped = branch.replace(
    /^(feat|fix|chore|refactor|docs|test|ci|build|perf|style)\//i,
    '',
  );
  const words = stripped.replace(/[-_/]/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export {
  normalizePullRequestTitleQuery,
  scopePullRequestTitleQuery,
  PullRequestTitleQueryError,
  PR_TITLE_SEARCH_MAX_INPUT_LENGTH,
  PR_TITLE_SEARCH_MAX_QUERY_LENGTH,
} from './title-search';

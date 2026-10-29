import type {
  PrStatusData,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import type { BranchSyncAction } from '@/lib/githubBranchActions';

/**
 * Fixtures for the Header States gallery page
 * ({@link ../pages/HeaderStateGalleryPage}).
 *
 * Kept apart from the page so the state matrix reads as data: adding a state
 * means adding one entry here, not editing render code. Mirrors how
 * `worktreeStateGalleryData` backs the Worktree States page.
 */

export const HEADER_STATE_GALLERY_PROJECT_ID = 'header-states-gallery';

/** Every store slice one header instance needs, all keyed by worktree. */
export interface HeaderGalleryState {
  /** Stable worktree id; also the store key suffix. */
  id: string;
  /** Row caption in the gallery. */
  title: string;
  /** Why this state exists / what to look at. */
  note: string;
  branchName: string;
  baseBranch?: string;
  /** Archived-chat count driving the archive control's corner badge. */
  archivedChats?: number;
  projects?: {
    uncommittedChanges?: boolean;
    hasUnpushedCommits?: boolean;
    hasUnpulledCommits?: boolean;
    hasRemoteTracking?: boolean;
    hasOriginRemote?: boolean;
    hasBranchBeenPushed?: boolean;
    commitsAhead?: boolean;
    baseBranchExistsLocally?: boolean;
    baseBranchExistsInRemote?: boolean;
  };
  prStatus?: WorktreePrStatus | null;
  github?: {
    creatingPr?: boolean;
    committingAndPushing?: boolean;
    gitStatsRefreshing?: boolean;
    mergingPr?: boolean;
    activeBranchSyncAction?: BranchSyncAction;
  };
}

function pr(overrides: Partial<PrStatusData> = {}): PrStatusData {
  return {
    prNumber: 2441,
    prUrl: 'https://github.com/canopy-demo/repo/pull/2441',
    state: 'open',
    title: 'feat(desktop): move archived chats to the worktree header',
    body: 'Demo pull request.',
    checkStatus: 'passing',
    checkDetails: [],
    reviewStatus: 'none',
    reviewers: [],
    hasConflicts: false,
    commentCount: 0,
    updatedAt: '2026-08-19T12:00:00.000Z',
    ...overrides,
  };
}

function singleRepo(status: PrStatusData | null): WorktreePrStatus {
  return {
    repos: [{ repoId: 'repo-1', repoName: 'repo', status }],
    lastCheckedAt: '2026-08-19T12:00:00.000Z',
  };
}

/**
 * The state matrix. Ordered roughly as a branch's life runs: clean → local
 * work → pushed → PR open → CI outcomes → merge, then the edge cases.
 */
export const HEADER_GALLERY_STATES: readonly HeaderGalleryState[] = [
  {
    id: 'clean',
    title: 'Clean branch, no PR',
    note: 'Nothing to commit or push. Only the breadcrumb and Open in.',
    branchName: 'demo/clean-branch',
    projects: { hasRemoteTracking: true, hasBranchBeenPushed: true },
    prStatus: singleRepo(null),
  },
  {
    id: 'uncommitted',
    title: 'Uncommitted changes',
    note: 'Primary action commits AND pushes; visible copy stays "Create PR", the accessible name is the full action.',
    branchName: 'demo/uncommitted-work',
    projects: { uncommittedChanges: true, hasRemoteTracking: true },
    prStatus: singleRepo(null),
    archivedChats: 2,
  },
  {
    id: 'unpushed',
    title: 'Committed, not pushed',
    note: 'Push + create PR in one action.',
    branchName: 'demo/unpushed-commits',
    projects: { hasUnpushedCommits: true, hasRemoteTracking: true },
    prStatus: singleRepo(null),
  },
  {
    id: 'behind-base',
    title: 'Behind the base branch',
    note: 'Pull affordance appears alongside the PR action.',
    branchName: 'demo/behind-base',
    projects: {
      hasUnpulledCommits: true,
      hasRemoteTracking: true,
      hasBranchBeenPushed: true,
    },
    prStatus: singleRepo(null),
  },
  {
    id: 'pr-passing',
    title: 'PR open, checks passing',
    note: 'PR badge + green CI badge.',
    branchName: 'demo/pr-checks-passing',
    prStatus: singleRepo(pr({ checkStatus: 'passing' })),
    archivedChats: 1,
  },
  {
    id: 'pr-failing',
    title: 'PR open, checks failing',
    note: 'Red CI badge; the settled-failure state also offers the CI fix action.',
    branchName: 'demo/pr-checks-failing',
    prStatus: singleRepo(
      pr({
        checkStatus: 'failing',
        checkDetails: [
          {
            name: 'Lint & Typecheck',
            status: 'failing',
            detailsUrl: 'https://ci.example/1',
          },
          { name: 'Unit Tests', status: 'passing', detailsUrl: null },
        ],
      }),
    ),
  },
  {
    id: 'pr-pending',
    title: 'PR open, checks running',
    note: 'Pending CI badge.',
    branchName: 'demo/pr-checks-pending',
    prStatus: singleRepo(pr({ checkStatus: 'pending' })),
  },
  {
    id: 'pr-conflicts',
    title: 'PR open, conflicting',
    note: 'Conflict state exposes the resolve action.',
    branchName: 'demo/pr-conflicts',
    // Clean worktree on purpose: the header only offers Resolve conflicts
    // when there is nothing to commit first (`worktreeCleanForMerge`).
    prStatus: singleRepo(pr({ hasConflicts: true, checkStatus: 'passing' })),
  },
  {
    id: 'pr-approved',
    title: 'PR approved, ready to merge',
    note: 'Approved review + passing checks.',
    branchName: 'demo/pr-approved',
    prStatus: singleRepo(
      pr({
        checkStatus: 'passing',
        reviewStatus: 'approved',
        reviewers: [{ login: 'canopy-demo', state: 'approved' }],
      }),
    ),
  },
  {
    id: 'pr-draft',
    title: 'Draft PR',
    note: 'Draft badge variant.',
    branchName: 'demo/pr-draft',
    prStatus: singleRepo(pr({ state: 'draft' })),
  },
  {
    id: 'pr-merged',
    title: 'PR merged',
    note: 'Terminal state — the worktree is done.',
    branchName: 'demo/pr-merged',
    prStatus: singleRepo(pr({ state: 'merged', checkStatus: 'passing' })),
  },
  {
    id: 'creating-pr',
    title: 'Creating the PR (in flight)',
    note: 'Spinner + "Creating…" with the cancel affordance.',
    branchName: 'demo/creating-pr',
    projects: { uncommittedChanges: true },
    prStatus: singleRepo(null),
    github: { creatingPr: true },
  },
  {
    id: 'committing',
    title: 'Commit & push (in flight)',
    note: 'Branch-sync action running.',
    branchName: 'demo/committing',
    projects: { uncommittedChanges: true },
    prStatus: singleRepo(null),
    github: { committingAndPushing: true, activeBranchSyncAction: 'commit' },
  },
  {
    id: 'local-only',
    title: 'Local-only repository, uncommitted changes',
    note: 'No origin remote: the primary action is a local Commit on the secondary hairline ring, with nothing to push or open.',
    branchName: 'demo/local-only-commit',
    projects: {
      uncommittedChanges: true,
      hasOriginRemote: false,
      hasRemoteTracking: false,
      hasBranchBeenPushed: false,
    },
    prStatus: singleRepo(null),
  },
  {
    id: 'long-branch',
    title: 'Very long branch and base names',
    note: 'Labels take the space that is free and truncate only under real pressure; the base branch yields first.',
    branchName: 'dzzzgnr/task-description-generator-refactor-experiment',
    baseBranch: 'anhan-blip/fix-oauth-token-refresh-and-retry-policy',
    prStatus: singleRepo(null),
    projects: { uncommittedChanges: true },
    archivedChats: 12,
  },
  {
    id: 'archive-overflow',
    title: 'Archive badge overflow',
    note: 'Counts above 99 collapse to "99+" so the corner badge keeps its size.',
    branchName: 'demo/many-archives',
    prStatus: singleRepo(pr({ checkStatus: 'passing' })),
    archivedChats: 120,
  },
];

/** One synthetic workspace holding a worktree per state. */
export function buildDemoProject(
  states: readonly HeaderGalleryState[],
): SidebarItem {
  return {
    type: 'single-repo',
    id: HEADER_STATE_GALLERY_PROJECT_ID,
    name: 'Header States (demo)',
    repoPath: '/demo/header-gallery',
    color: 'blue',
    collapsed: false,
    order: 0,
    worktrees: states.map((state) => ({
      id: state.id,
      branchName: state.branchName,
      createdAt: '2026-08-19T12:00:00.000Z',
    })),
    // A launch script is what makes the real Launch control render
    // (`hasRunScripts` → `getScriptCommand(effectiveScripts, 'launch')`).
    worktreeEffective: Object.fromEntries(
      states.map((state) => [
        state.id,
        { effectiveScripts: { launch: 'npm run dev' } },
      ]),
    ),
  };
}

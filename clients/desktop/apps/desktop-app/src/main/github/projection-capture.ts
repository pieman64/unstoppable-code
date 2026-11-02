import { AsyncLocalStorage } from 'node:async_hooks';
import type {
  GitHubRepoSummary,
  PullRequestSummary,
} from '@canopy/desktop-shared/types';
import type { GitHubPullRequestStatusView } from '../lib/github-pr-read-model';

/*
 * What one compatibility projection's dispatched call read on the host, for
 * the legacy IPC response (CAN-4109). The desktop request handle and the
 * pull-request host fill these only inside a projection; every other
 * dispatcher caller gets the canonical reads and captures nothing.
 */

interface RepositoryLocation {
  /** The path the IPC request named. */
  readonly repoPath: string;
  /** Where the host resolved the dispatched repository id. */
  resolvedRepoPath?: string;
}

/** `github:list-pull-requests`: today's REST listing, not the canonical read. */
export interface PullRequestListCapture extends RepositoryLocation {
  readonly kind: 'list';
  legacy?: PullRequestSummary[];
}

/** `github:resolve-pull-request`: today's read-model call and its view. */
export interface PullRequestResolveCapture extends RepositoryLocation {
  readonly kind: 'resolve';
  view?: GitHubPullRequestStatusView;
}

/** `github:list-user-repos`: the legacy rows of the first snapshot read. */
export interface RepositoryListCapture {
  readonly kind: 'repositories';
  legacy?: GitHubRepoSummary[];
}

/**
 * `github:create-pr` and `github:update-pr-base-branch`: whether a GitHub
 * mutation was sent, and what it wrote, kept when the read after it fails.
 */
export interface PullRequestWriteCapture {
  readonly kind: 'write';
  mutationSent?: boolean;
  written?: { number: number; url: string; created: boolean };
}

export type GitHubProjectionCapture =
  | PullRequestListCapture
  | PullRequestResolveCapture
  | RepositoryListCapture
  | PullRequestWriteCapture;

const projection = new AsyncLocalStorage<GitHubProjectionCapture>();

export function runInGitHubProjection<T>(
  capture: GitHubProjectionCapture,
  call: () => Promise<T>,
): Promise<T> {
  return projection.run(capture, call);
}

export function currentGitHubProjection(): GitHubProjectionCapture | undefined {
  return projection.getStore();
}

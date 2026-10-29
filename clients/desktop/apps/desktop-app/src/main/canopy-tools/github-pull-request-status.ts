import { BRAND } from '@canopy/brand/current';
import { parseGitHubPullRequestReference } from '@canopy/desktop-shared/lib/github-pull-request-references';
import { GitHubBrokerError } from '../lib/github-broker/errors';
import type {
  GitHubPullRequestRef,
  GitHubPullRequestStatusView,
} from '../lib/github-pr-read-model';
import { getGitHubPullRequestStatusSchema } from './definitions';

export interface GetGitHubPullRequestStatusResult {
  text: string;
  isError?: boolean;
}

type FailureCode =
  | 'invalid_input'
  | 'invalid_reference'
  | 'rate_limited'
  | 'not_found'
  | 'permission_denied'
  | 'not_authenticated'
  | 'unavailable';

interface Failure {
  ok: false;
  code: FailureCode;
  message: string;
  retryAt?: string;
  retryAfterSeconds?: number;
}

const appName = BRAND.displayName;

function failure(value: Failure): GetGitHubPullRequestStatusResult {
  return { text: JSON.stringify(value), isError: true };
}

function rateLimitedFailure(
  error: GitHubBrokerError,
  label: string,
  nowMs: number,
): Failure {
  const retryAt = error.retryAt;
  if (retryAt === undefined || retryAt <= nowMs) {
    return {
      ok: false,
      code: 'rate_limited',
      message: `GitHub rate limited the read of ${label}. Try again in a few minutes. Do not poll GitHub from the shell; agents and ${appName} share one GitHub rate limit.`,
    };
  }
  const retryAtIso = new Date(retryAt).toISOString();
  const retryAfterSeconds = Math.ceil((retryAt - nowMs) / 1000);
  return {
    ok: false,
    code: 'rate_limited',
    message: `GitHub reads are paused to protect the shared GitHub rate limit until ${retryAtIso} (about ${retryAfterSeconds} seconds from now). Do not retry before then or poll GitHub from the shell. Call this again after that time, or use WatchGitHubItems to be notified when the pull request changes.`,
    retryAt: retryAtIso,
    retryAfterSeconds,
  };
}

function readFailure(error: unknown, label: string, nowMs: number): Failure {
  if (error instanceof GitHubBrokerError) {
    switch (error.code) {
      case 'rate_limited':
        return rateLimitedFailure(error, label, nowMs);
      case 'not_found':
        return {
          ok: false,
          code: 'not_found',
          message: `GitHub pull request ${label} was not found. Check the reference; GitHub also reports a private repository the connected account cannot access as not found.`,
        };
      case 'permission_denied':
        return {
          ok: false,
          code: 'permission_denied',
          message: `The GitHub account connected to ${appName} is not allowed to read ${label}.`,
        };
      case 'not_authenticated':
        return {
          ok: false,
          code: 'not_authenticated',
          message: `GitHub is not connected to ${appName}, or its credential was rejected. Ask the user to reconnect GitHub.`,
        };
      default:
        break;
    }
  }
  const detail = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    code: 'unavailable',
    message: `Could not read ${label} from GitHub: ${detail}`,
  };
}

function successPayload(view: GitHubPullRequestStatusView): unknown {
  const { ref, ...status } = view;
  return {
    ok: true,
    pullRequest: {
      repository: `${ref.owner}/${ref.repo}`,
      number: ref.number,
      ...status,
    },
  };
}

/**
 * GetGitHubPullRequestStatus: one cached, interactive-priority read of a
 * GitHub.com pull request through the shared read model, never a direct
 * GitHub request.
 */
export async function executeGetGitHubPullRequestStatus(
  rawArgs: unknown,
  options: { signal?: AbortSignal; now?: () => number } = {},
): Promise<GetGitHubPullRequestStatusResult> {
  const parsed = getGitHubPullRequestStatusSchema.safeParse(rawArgs);
  if (!parsed.success) {
    return failure({
      ok: false,
      code: 'invalid_input',
      message:
        'Invalid arguments for GetGitHubPullRequestStatus. Pass {"pullRequest":"<PR URL or owner/repository#number>"}.',
    });
  }
  const reference = parseGitHubPullRequestReference(parsed.data.pullRequest);
  if (!reference.ok) {
    return failure({
      ok: false,
      code: 'invalid_reference',
      message: reference.message,
    });
  }
  const [owner, repo] = reference.value.repository.split('/');
  const ref: GitHubPullRequestRef = {
    owner,
    repo,
    number: reference.value.number,
  };
  const label = `${reference.value.repository}#${ref.number}`;
  const now = options.now ?? Date.now;
  try {
    // Loaded on first use so chats that never read pull request status do not
    // initialize the read model's cache and sweep state.
    const { getGitHubPullRequestStatus } =
      await import('../lib/github-pr-read-model');
    const view = await getGitHubPullRequestStatus(ref, {
      priority: 'interactive',
      caller: 'agent-pr-status',
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { text: JSON.stringify(successPayload(view)) };
  } catch (error) {
    return failure(readFailure(error, label, now()));
  }
}

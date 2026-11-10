import type {
  GitHubPullRequestTarget,
  WatchGitHubItemsResult,
} from '../types/github-watchers';
import { normalizeGitHubRepositoryReference } from './github-workflow-run-references';
import {
  normalizeGitHubPullRequestNumber,
  parseGitHubPullRequestReference,
} from '@canopy/protocol/portable-tasks/pull-request-reference';

type ReferenceFailure = Extract<WatchGitHubItemsResult, { ok: false }>;

export const MAX_GITHUB_PULL_REQUEST_WATCH_ITEMS = 20;

const INVALID_PULL_REQUEST_MESSAGE =
  'Use a GitHub pull request URL, owner/repository#number, or {"kind":"pull_request","number":123} with a repository.';
const GITHUB_COM_ONLY_MESSAGE =
  'Only GitHub.com pull request references are supported.';
const REPOSITORY_REQUIRED_MESSAGE =
  'A repository is required for a pull request number. Add repository: "owner/repository" or pass a pull request URL.';
const DUPLICATE_MESSAGE =
  'The same GitHub pull request was supplied more than once.';
type PullRequestItemResult =
  | { ok: true; value: { repository: string; number: number } }
  | ReferenceFailure;

export type NormalizeGitHubPullRequestTargetsResult =
  | { ok: true; targets: GitHubPullRequestTarget[] }
  | ReferenceFailure;

function failure(
  code: ReferenceFailure['code'],
  message: string,
): ReferenceFailure {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The URL parser silently strips tab, CR and LF anywhere in its input, which
// would canonicalize a malformed host or number into a valid target.
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

/**
 * Reject URL syntax the parser would silently canonicalize into a different,
 * valid-looking URL: an explicit (even default) port, backslashes, and dot
 * segments, including percent-encoded ones.
 */
function nonCanonicalUrlFailure(value: string): ReferenceFailure | null {
  const match = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#\\]*)([^?#]*)/i);
  if (!match) return null;
  const [, authority, path] = match;
  if (authority.includes(':')) {
    return failure('invalid_reference', GITHUB_COM_ONLY_MESSAGE);
  }
  return path.includes('\\') ||
    path.split('/').some((segment) => DOT_SEGMENT.test(segment))
    ? failure('invalid_reference', INVALID_PULL_REQUEST_MESSAGE)
    : null;
}

function normalizeRepository(value: unknown): string | null {
  return typeof value === 'string' &&
    !hasControlCharacter(value) &&
    !nonCanonicalUrlFailure(value)
    ? normalizeGitHubRepositoryReference(value)
    : null;
}

function withItemIndex(
  error: ReferenceFailure,
  itemIndex: number,
): ReferenceFailure {
  return { ...error, itemIndex, field: 'items' };
}

function resolveItem(
  raw: unknown,
  defaultRepository: string | undefined,
): PullRequestItemResult {
  if (!isRecord(raw) || raw.kind !== 'pull_request') {
    return failure('invalid_input', 'Invalid WatchGitHubItems input.');
  }
  const keys = Object.keys(raw);
  if ('target' in raw) {
    return keys.every((key) => key === 'kind' || key === 'target')
      ? parseGitHubPullRequestReference(raw.target)
      : failure('invalid_input', 'Invalid WatchGitHubItems input.');
  }
  if (
    !('number' in raw) ||
    !keys.every((key) => ['kind', 'repository', 'number'].includes(key))
  ) {
    return failure('invalid_input', 'Invalid WatchGitHubItems input.');
  }
  const number = normalizeGitHubPullRequestNumber(raw.number);
  if (!number)
    return failure('invalid_reference', INVALID_PULL_REQUEST_MESSAGE);
  if (raw.repository !== undefined) {
    const repository = normalizeRepository(raw.repository);
    return repository
      ? { ok: true, value: { repository, number } }
      : failure(
          'invalid_reference',
          'Use a GitHub owner/repository slug or repository URL.',
        );
  }
  return defaultRepository
    ? { ok: true, value: { repository: defaultRepository, number } }
    : failure('repository_required', REPOSITORY_REQUIRED_MESSAGE);
}

/**
 * Validate and canonicalize pull request items in request order. A numbered
 * item without its own repository falls back to `repository`, then to the
 * single `repositoryCandidates` entry when exactly one is known.
 */
export function normalizeGitHubPullRequestTargets(options: {
  items: readonly unknown[];
  repository?: unknown;
  repositoryCandidates?: readonly string[];
}): NormalizeGitHubPullRequestTargetsResult {
  const topRepository =
    options.repository === undefined
      ? undefined
      : normalizeRepository(options.repository);
  if (options.repository !== undefined && !topRepository) {
    return {
      ...failure(
        'invalid_reference',
        'Use a GitHub owner/repository slug or repository URL.',
      ),
      field: 'repository',
    };
  }
  const candidates = Array.from(
    new Set(
      (options.repositoryCandidates ?? [])
        .map(normalizeRepository)
        .filter((entry): entry is string => entry !== null),
    ),
  );
  const defaultRepository =
    topRepository ?? (candidates.length === 1 ? candidates[0] : undefined);
  const targets: GitHubPullRequestTarget[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < options.items.length; index += 1) {
    const parsed = resolveItem(options.items[index], defaultRepository);
    if (!parsed.ok) return withItemIndex(parsed, index);
    const key = `${parsed.value.repository}#${parsed.value.number}`;
    if (seen.has(key)) {
      return withItemIndex(failure('duplicate_item', DUPLICATE_MESSAGE), index);
    }
    seen.add(key);
    targets.push({ kind: 'pull_request', ...parsed.value });
  }
  return { ok: true, targets };
}

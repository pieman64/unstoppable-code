/**
 * Browser-safe pull request reference parsing shared by desktop and web.
 * Home detection is intentionally permissive; watch/status inputs stay strict.
 */

export interface ParsedPullRequestReference {
  owner?: string;
  repo?: string;
  number: number;
}

export type ParseGitHubPullRequestReferenceResult =
  | { ok: true; value: { repository: string; number: number } }
  | { ok: false; code: 'invalid_reference'; message: string };

export interface ParsedTaskPullRequestReference {
  number: number;
  owner?: string;
  repo?: string;
}

const INVALID_PULL_REQUEST_MESSAGE =
  'Use a GitHub pull request URL, owner/repository#number, or {"kind":"pull_request","number":123} with a repository.';
const GITHUB_COM_ONLY_MESSAGE =
  'Only GitHub.com pull request references are supported.';
const MAX_PULL_REQUEST_NUMBER_DIGITS = 10;
const MAX_PULL_REQUEST_NUMBER = 10 ** MAX_PULL_REQUEST_NUMBER_DIGITS - 1;
const MAX_GITHUB_REPOSITORY_SEGMENT_LENGTH = 100;
const HOME_BARE_PR_NUMBER_RE = /^#?(\d+)$/;
const HOME_URL_IN_TEXT_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const HOME_TRAILING_URL_PUNCTUATION_RE = /[)\]},.;:!]+$/;

type PullRequestUrlPolicy = 'home' | 'strict';
type PullRequestUrlParseResult =
  | { ok: true; value: ParsedPullRequestReference }
  | { ok: false; reason: 'invalid_reference' | 'github_com_only' };

function isPositiveSafeInteger(value: string): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/** Positive integer of at most ten digits, from a number or decimal string. */
export function normalizeGitHubPullRequestNumber(
  value: unknown,
): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) &&
      value > 0 &&
      value <= MAX_PULL_REQUEST_NUMBER
      ? value
      : null;
  }
  if (
    typeof value !== 'string' ||
    value.length > MAX_PULL_REQUEST_NUMBER_DIGITS ||
    !/^\d+$/.test(value)
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isSafeInteger(number) &&
    number > 0 &&
    number <= MAX_PULL_REQUEST_NUMBER
    ? number
    : null;
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function decodePathSegment(value: string): string | null {
  if (/%2f|%5c/i.test(value)) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function normalizeRepositoryParts(
  owner: string,
  repository: string,
): string | null {
  const decodedOwner = decodePathSegment(owner);
  const decodedRepository = decodePathSegment(repository);
  if (!decodedOwner || !decodedRepository) return null;
  const repo = decodedRepository.replace(/\.git$/i, '');
  if (
    decodedOwner === '.' ||
    decodedOwner === '..' ||
    repo === '.' ||
    repo === '..' ||
    decodedOwner.length > MAX_GITHUB_REPOSITORY_SEGMENT_LENGTH ||
    repo.length > MAX_GITHUB_REPOSITORY_SEGMENT_LENGTH ||
    !/^[A-Za-z0-9_.-]+$/.test(decodedOwner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repo)
  ) {
    return null;
  }
  return `${decodedOwner.toLowerCase()}/${repo.toLowerCase()}`;
}

/** Lowercased GitHub owner and repository, or null when either is invalid. */
export function normalizeGitHubRepositoryIdentity(
  owner: unknown,
  repo: unknown,
): { owner: string; repo: string } | null {
  if (typeof owner !== 'string' || typeof repo !== 'string') return null;
  const normalized = normalizeRepositoryParts(owner, repo);
  if (normalized === null) return null;
  const [normalizedOwner, normalizedRepo] = normalized.split('/');
  return normalizedOwner === undefined || normalizedRepo === undefined
    ? null
    : { owner: normalizedOwner, repo: normalizedRepo };
}

/** Normalize an owner/repository slug or a canonical GitHub repository URL. */
function normalizeGitHubRepositoryReference(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    return null;
  }
  if (!value.includes('://')) {
    const segments = value.split('/');
    return segments.length === 2
      ? normalizeRepositoryParts(segments[0], segments[1])
      : null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'https:' ||
    (url.hostname.toLowerCase() !== 'github.com' &&
      url.hostname.toLowerCase() !== 'www.github.com') ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  if (/\/{2,}/.test(url.pathname)) return null;
  const segments = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  return segments.length === 2
    ? normalizeRepositoryParts(segments[0], segments[1])
    : null;
}

const DOT_SEGMENT = /^(?:\.|%2e){1,2}$/i;

function strictUrlFailure(
  value: string,
): 'invalid_reference' | 'github_com_only' | null {
  const match = value.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#\\]*)([^?#]*)/i);
  if (!match) return null;
  const [, authority, path] = match;
  if (authority.includes(':')) return 'github_com_only';
  return path.includes('\\') ||
    path.split('/').some((segment) => DOT_SEGMENT.test(segment))
    ? 'invalid_reference'
    : null;
}

function homeRepositoryFromUrl(
  url: URL,
): { owner: string; repo: string } | null {
  if (url.hostname !== 'github.com') return null;
  const parts = url.pathname.split('/');
  const owner = parts[1]?.toLowerCase();
  const repo = parts[2]?.replace(/\.git$/i, '').toLowerCase();
  if (
    !owner ||
    !repo ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(owner) ||
    !/^[a-z0-9_.-]+$/.test(repo) ||
    repo === '.' ||
    repo === '..'
  ) {
    return null;
  }
  return { owner, repo };
}

/** Shared URL core with policy-specific acceptance and canonicalization rules. */
function parsePullRequestUrlCore(
  input: string,
  policy: PullRequestUrlPolicy,
): PullRequestUrlParseResult {
  let value = input;
  if (policy === 'home') {
    value = value
      .trim()
      .replace(HOME_TRAILING_URL_PUNCTUATION_RE, '')
      .split(/[?#]/, 1)[0];
    if (value.length > 2_048) {
      return { ok: false, reason: 'invalid_reference' };
    }
  } else {
    if (hasControlCharacter(value)) {
      return { ok: false, reason: 'invalid_reference' };
    }
    const nonCanonical = strictUrlFailure(value);
    if (nonCanonical) return { ok: false, reason: nonCanonical };
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid_reference' };
  }

  if (policy === 'home') {
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      url.port
    ) {
      return { ok: false, reason: 'invalid_reference' };
    }
    const repository = homeRepositoryFromUrl(url);
    const match = url.pathname.match(
      /^\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/(?:files|commits|checks))?\/?$/,
    );
    const number = match ? isPositiveSafeInteger(match[1]) : null;
    return repository && number
      ? { ok: true, value: { ...repository, number } }
      : { ok: false, reason: 'invalid_reference' };
  }

  const host = url.hostname.toLowerCase();
  if (
    url.protocol !== 'https:' ||
    (host !== 'github.com' && host !== 'www.github.com') ||
    url.username ||
    url.password ||
    url.port
  ) {
    return { ok: false, reason: 'github_com_only' };
  }
  if (/\/{2,}/.test(url.pathname)) {
    return { ok: false, reason: 'invalid_reference' };
  }
  const segments = url.pathname.split('/').filter(Boolean);
  const repository =
    segments.length >= 4 && segments[2] === 'pull'
      ? normalizeGitHubRepositoryReference(`${segments[0]}/${segments[1]}`)
      : null;
  const number = normalizeGitHubPullRequestNumber(segments[3]);
  if (!repository || !number) {
    return { ok: false, reason: 'invalid_reference' };
  }
  const [owner, repo] = repository.split('/');
  return { ok: true, value: { owner, repo, number } };
}

function legacyHomeUrls(input: string): string[] {
  const urls = Array.from(
    input.matchAll(HOME_URL_IN_TEXT_RE),
    (match) => match[0],
  );
  if (/^(?:github\.com|linear\.app)\//i.test(input)) {
    urls.unshift(`https://${input}`);
  }
  return urls;
}

/** Home-detection policy: embedded URLs, HTTP URLs and bare numbers are accepted. */
export function parseHomePullRequestReference(
  input: string,
): ParsedPullRequestReference | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  for (const url of legacyHomeUrls(trimmed)) {
    const parsed = parsePullRequestUrlCore(url, 'home');
    if (parsed.ok) return parsed.value;
  }

  const bareMatch = trimmed.match(HOME_BARE_PR_NUMBER_RE);
  if (!bareMatch) return null;
  const number = isPositiveSafeInteger(bareMatch[1]);
  return number ? { number } : null;
}

/** Backward-compatible name for Home detection consumers. */
export const parsePullRequestReference = parseHomePullRequestReference;

/** Strict watch/status policy: canonical HTTPS URL or owner/repository#number. */
export function parseStrictGitHubPullRequestReference(
  reference: unknown,
): ParseGitHubPullRequestReferenceResult {
  if (typeof reference !== 'string' || reference !== reference.trim()) {
    return {
      ok: false,
      code: 'invalid_reference',
      message: INVALID_PULL_REQUEST_MESSAGE,
    };
  }
  if (/^https?:\/\//i.test(reference)) {
    const parsed = parsePullRequestUrlCore(reference, 'strict');
    if (parsed.ok) {
      const repository = `${parsed.value.owner}/${parsed.value.repo}`;
      return {
        ok: true,
        value: { repository, number: parsed.value.number },
      };
    }
    return {
      ok: false,
      code: 'invalid_reference',
      message:
        parsed.reason === 'github_com_only'
          ? GITHUB_COM_ONLY_MESSAGE
          : INVALID_PULL_REQUEST_MESSAGE,
    };
  }
  const compact = reference.match(/^([^/#]+\/[^/#]+)#(\d+)$/);
  const repository = compact
    ? normalizeGitHubRepositoryReference(compact[1])
    : null;
  const number = compact ? normalizeGitHubPullRequestNumber(compact[2]) : null;
  return repository && number
    ? { ok: true, value: { repository, number } }
    : {
        ok: false,
        code: 'invalid_reference',
        message: INVALID_PULL_REQUEST_MESSAGE,
      };
}

/** Backward-compatible name for strict watch/status consumers. */
export const parseGitHubPullRequestReference =
  parseStrictGitHubPullRequestReference;

/** True for a GitHub.com pull request URL; used to redirect misfiled run items. */
export function isGitHubPullRequestUrl(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    /^https?:\/\//i.test(value) &&
    parsePullRequestUrlCore(value, 'strict').ok
  );
}

/**
 * Parse a task-facing PR reference. Owner/repository identities are normalized
 * to lowercase so callers can match the repository case-insensitively.
 */
export function parseTaskPullRequestReference(
  reference: unknown,
): ParsedTaskPullRequestReference | null {
  if (typeof reference !== 'string') return null;
  const trimmed = reference.trim();
  const bare = trimmed.match(HOME_BARE_PR_NUMBER_RE);
  if (bare) {
    const number = normalizeGitHubPullRequestNumber(bare[1]);
    return number ? { number } : null;
  }
  const parsed = parseStrictGitHubPullRequestReference(trimmed);
  if (!parsed.ok) return null;
  const [owner, repo] = parsed.value.repository.split('/');
  return { owner, repo, number: parsed.value.number };
}

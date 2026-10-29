/**
 * Pure parsing/detection helpers for the "Create worktree from ..." flow
 * (ECW-8121). Detects whether free-form user input refers to a Linear issue,
 * a GitHub pull request, or a branch name. Zero runtime dependencies so it is
 * usable from renderer, main, and tests alike.
 */

export type CreateFromMode = 'new' | 'branch' | 'pr' | 'linear';

export type CreateFromSource = Exclude<CreateFromMode, 'new'>;

export interface DetectedReference {
  mode: CreateFromSource;
  value: string;
}

export interface ParsedPullRequestReference {
  owner?: string;
  repo?: string;
  number: number;
}

const LINEAR_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/;
const BARE_PR_NUMBER_RE = /^#?(\d+)$/;

export interface ParsedGitHubRepositoryReference {
  owner: string;
  repo: string;
  /** Case-insensitive GitHub origin identity, without a branch or PR. */
  repositoryKey: string;
  url: string;
}

export type CreateFromLinkReference =
  | (ParsedGitHubRepositoryReference & {
      kind: 'repository';
      key: string;
    })
  | (ParsedGitHubRepositoryReference & {
      kind: 'pr';
      number: number;
      key: string;
    })
  | { kind: 'linear'; identifier: string; key: string };

export interface ExtractedCreateFromReferences {
  references: CreateFromLinkReference[];
  /** False means callers must not assume the returned targets are unique. */
  complete: boolean;
}

const MAX_REFERENCE_TEXT_LENGTH = 100_000;
const MAX_REFERENCE_URL_LENGTH = 2_048;
const MAX_REFERENCE_COUNT = 100;
const URL_IN_TEXT_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi;
const TRAILING_URL_PUNCTUATION_RE = /[)\]},.;:!]+$/;

function legacyReferenceUrls(input: string): string[] {
  const urls = Array.from(input.matchAll(URL_IN_TEXT_RE), (match) => match[0]);
  // Retain the branch picker's existing scheme-less input, with an anchored
  // host check so paths and lookalike hosts cannot impersonate these services.
  if (/^(?:github\.com|linear\.app)\//i.test(input)) {
    urls.unshift(`https://${input}`);
  }
  return urls;
}

function parseReferenceUrl(input: string): URL | null {
  const trimmed = input
    .trim()
    .replace(TRAILING_URL_PUNCTUATION_RE, '')
    .split(/[?#]/, 1)[0];
  if (trimmed.length > MAX_REFERENCE_URL_LENGTH) return null;
  try {
    const url = new URL(trimmed);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      url.port
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function githubRepositoryFromUrl(
  url: URL,
): ParsedGitHubRepositoryReference | null {
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
  return {
    owner,
    repo,
    repositoryKey: `github.com/${owner}/${repo}`,
    url: `https://github.com/${owner}/${repo}`,
  };
}

/** A tree URL identifies the repository; its ref is deliberately discarded. */
export function parseGitHubRepositoryReference(
  input: string,
): ParsedGitHubRepositoryReference | null {
  const url = parseReferenceUrl(input);
  if (
    !url ||
    !/^\/[^/]+\/[^/]+(?:\/|\/tree\/[^/]+(?:\/.*)?)?$/.test(url.pathname)
  ) {
    return null;
  }
  return githubRepositoryFromUrl(url);
}

function parseLinkReference(input: string): CreateFromLinkReference | null {
  const url = parseReferenceUrl(input);
  if (!url) return null;
  if (url.hostname === 'linear.app') {
    const match = url.pathname.match(
      /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^/]+)?\/?$/,
    );
    if (!match) return null;
    const identifier = match[1].toUpperCase();
    return { kind: 'linear', identifier, key: `linear:${identifier}` };
  }
  const repository = githubRepositoryFromUrl(url);
  if (!repository) return null;
  const pr = url.pathname.match(
    /^\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/(?:files|commits|checks))?\/?$/,
  );
  if (pr) {
    const number = Number(pr[1]);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    return {
      ...repository,
      kind: 'pr',
      number,
      url: `${repository.url}/pull/${number}`,
      key: `${repository.repositoryKey}/pull/${number}`,
    };
  }
  if (!parseGitHubRepositoryReference(input)) return null;
  return { ...repository, kind: 'repository', key: repository.repositoryKey };
}

export interface ReferenceOccurrence {
  start: number;
  /** Exclusive offset into the scanned text. */
  end: number;
  reference: CreateFromLinkReference;
  /** The matched URL, with its query and fragment, for navigation. */
  originalUrl?: string;
  /** Lowercase workspace from a Linear URL; a bare identifier has none. */
  linearWorkspaceSlug?: string;
}

export interface ScannedReferenceOccurrences {
  occurrences: ReferenceOccurrence[];
  /** False means some occurrences were dropped and callers must not decorate. */
  complete: boolean;
}

const STANDALONE_IDENTIFIER_RE =
  /(?:^|[^A-Za-z0-9_./@-])([A-Za-z][A-Za-z0-9]*-\d+)(?![A-Za-z0-9_/@-]|\.[A-Za-z0-9_])/g;

/** URL occurrences first, then standalone identifiers; each in text order. */
function collectReferenceOccurrences(text: string): ReferenceOccurrence[] {
  const occurrences: ReferenceOccurrence[] = [];
  // Mask every URL, including unsupported hosts, before looking for bare issue
  // identifiers: an identifier embedded in an unrelated URL is not standalone.
  const withoutUrls = text.replace(
    URL_IN_TEXT_RE,
    (value: string, start: number): string => {
      const reference = parseLinkReference(value);
      if (reference) {
        const originalUrl = value.replace(TRAILING_URL_PUNCTUATION_RE, '');
        occurrences.push({
          start,
          end: start + originalUrl.length,
          reference,
          originalUrl,
          ...(reference.kind === 'linear'
            ? {
                linearWorkspaceSlug: new URL(originalUrl).pathname
                  .split('/')[1]
                  .toLowerCase(),
              }
            : {}),
        });
      }
      return ' '.repeat(value.length);
    },
  );
  for (const match of Array.from(
    withoutUrls.matchAll(STANDALONE_IDENTIFIER_RE),
  )) {
    const identifier = match[1].toUpperCase();
    const end = match.index + match[0].length;
    occurrences.push({
      start: end - match[1].length,
      end,
      reference: { kind: 'linear', identifier, key: `linear:${identifier}` },
    });
  }
  return occurrences;
}

/**
 * Every supported reference occurrence with its source offsets, for
 * decorating rendered text. Repeated references are all kept.
 */
export function scanReferenceOccurrences(
  text: string,
): ScannedReferenceOccurrences {
  if (text.length > MAX_REFERENCE_TEXT_LENGTH) {
    return { occurrences: [], complete: false };
  }
  const occurrences = collectReferenceOccurrences(text).sort(
    (left, right) => left.start - right.start,
  );
  return {
    occurrences: occurrences.slice(0, MAX_REFERENCE_COUNT),
    complete: occurrences.length <= MAX_REFERENCE_COUNT,
  };
}

/**
 * Parse without fetching URLs or choosing between competing targets. Equivalent
 * URLs share a key. A PR subsumes only its own repository reference.
 */
export function extractCreateFromReferences(
  text: string,
): ExtractedCreateFromReferences {
  if (text.length > MAX_REFERENCE_TEXT_LENGTH) {
    return { references: [], complete: false };
  }
  const references = new Map<string, CreateFromLinkReference>();
  for (const { reference } of collectReferenceOccurrences(text)) {
    references.set(reference.key, reference);
  }
  const prRepositories = new Set(
    Array.from(references.values())
      .filter((reference) => reference.kind === 'pr')
      .map((reference) => reference.repositoryKey),
  );
  const candidates = Array.from(references.values()).filter(
    (reference) =>
      reference.kind !== 'repository' ||
      !prRepositories.has(reference.repositoryKey),
  );
  return {
    references: candidates.slice(0, MAX_REFERENCE_COUNT),
    complete: candidates.length <= MAX_REFERENCE_COUNT,
  };
}

export function parsePullRequestReference(
  input: string,
): ParsedPullRequestReference | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  for (const url of legacyReferenceUrls(trimmed)) {
    const reference = parseLinkReference(url);
    if (reference?.kind === 'pr') {
      return {
        owner: reference.owner,
        repo: reference.repo,
        number: reference.number,
      };
    }
  }

  const bareMatch = trimmed.match(BARE_PR_NUMBER_RE);
  if (bareMatch) {
    const number = Number.parseInt(bareMatch[1], 10);
    return Number.isSafeInteger(number) && number > 0 ? { number } : null;
  }

  return null;
}

export function parseLinearIdentifier(input: string): string | null {
  const trimmed = input.trim();
  if (LINEAR_IDENTIFIER_RE.test(trimmed)) {
    return trimmed;
  }

  for (const url of legacyReferenceUrls(trimmed)) {
    const reference = parseLinkReference(url);
    if (reference?.kind === 'linear') return reference.identifier;
  }

  return null;
}

/**
 * Classify free-form input. Linear wins over PR (identifiers are unambiguous),
 * PR wins over branch (URLs and numeric refs are near-unambiguous), and
 * anything else is treated as a branch name. The UI lets the user override
 * the detected mode via the mode pills.
 */
export function detectCreateFromReference(
  input: string,
): DetectedReference | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const linearIdentifier = parseLinearIdentifier(trimmed);
  if (linearIdentifier) {
    return { mode: 'linear', value: linearIdentifier };
  }

  if (parsePullRequestReference(trimmed)) {
    return { mode: 'pr', value: trimmed };
  }

  return { mode: 'branch', value: trimmed };
}

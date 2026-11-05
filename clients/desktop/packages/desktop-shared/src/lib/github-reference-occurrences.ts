/**
 * Display-only detection of GitHub.com pull request, issue and repository
 * references in transcript text. Browser-safe and dependency-free beyond the
 * protocol validators. The New Task "create from" flow keeps its own parser
 * in `create-from-reference.ts`; its semantics are deliberately separate.
 */

import {
  isGitHubItemNumber,
  isGitHubRepositoryName,
  type GitHubPreviewTarget,
} from '@canopy/protocol/reference-previews';

type GitHubItemTarget = Extract<GitHubPreviewTarget, { kind: 'item' }>;

export type GitHubReferenceOccurrence =
  | {
      start: number;
      /** Exclusive offset into the scanned text. */
      end: number;
      form: 'url';
      target: GitHubPreviewTarget;
      /** The matched URL, with its query and fragment, for navigation. */
      originalUrl: string;
    }
  | { start: number; end: number; form: 'qualified'; target: GitHubItemTarget }
  /** `#1234`; only the transcript's origin can say which repository it means. */
  | { start: number; end: number; form: 'bare'; number: number };

export interface ScannedGitHubReferences {
  occurrences: GitHubReferenceOccurrence[];
  /** False means some occurrences were dropped and callers must not decorate. */
  complete: boolean;
}

// Same bounds as the create-from scanner.
const MAX_TEXT_LENGTH = 100_000;
const MAX_URL_LENGTH = 2_048;
const MAX_OCCURRENCES = 100;

const SCHEME_CHAR_RE = /[A-Za-z0-9+.-]/;
const LETTER_RE = /[A-Za-z]/;
const WORD_CHAR_RE = /[A-Za-z0-9_]/;
const URL_BODY_STOP_RE = /[\s<>"'`]/;
const TRAILING_URL_PUNCTUATION_RE = /[)\]},.;:!]+$/;

const GITHUB_URL_RE = /^https?:\/\/github\.com(\/[^?#]*)(?:\?[^#]*)?(?:#.*)?$/i;
const PULL_PATH_RE =
  /^\/([^/]+)\/([^/]+)\/pull\/([^/]+)(?:\/(?:files|commits|checks))?\/?$/;
const ISSUE_PATH_RE = /^\/([^/]+)\/([^/]+)\/issues\/([^/]+)\/?$/;
const REPOSITORY_PATH_RE = /^\/([^/]+)\/([^/]+)\/?$/;
const ITEM_NUMBER_RE = /^[1-9]\d{0,9}$/;

// Lookbehind/lookahead keep matches standalone: no path, email, URL-without-
// scheme, HTML entity (`&#123;`), `C#1` or `CAN-12#3` fragments. Bounded
// quantifiers keep the scan linear.
const QUALIFIED_RE =
  /(?<![A-Za-z0-9_./@#-])([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})#([1-9]\d{0,9})(?![A-Za-z0-9_#/@-]|\.\d)/g;
const BARE_RE = /(?<![A-Za-z0-9_&/#.-])#([1-9]\d{0,9})(?![A-Za-z0-9_-]|\.\d)/g;
// A bare `#N` is a GitHub item only with evidence: a PR or issue word right
// before it ("PR #12", "fixes #12"), a squash-merge title's `(#12)`, or a
// list continuing an accepted reference ("#12, #13 and #14"). Numbering in
// prose such as "Done-when #1:" or "step #2" stays plain.
const BARE_CUE_RE =
  /(?:(?:^|[^A-Za-z0-9_])(?:PRs?|pull requests?|pulls?|issues?|fix(?:es|ed)?|close[sd]?|resolve[sd]?|merged?|reverts?|reverted|refs?)\s*|\(\s*)$/i;
const BARE_CUE_LOOKBEHIND = 20;
// Markdown emphasis, code and strikethrough delimiters never separate a cue
// from its number: `**PR** #12` and `PR **#12**` read as "PR #12".
const MARKDOWN_DELIMITER_RE = /[*_`~]/g;
const BARE_LIST_SEPARATOR_RE =
  /^\s*(?:,\s*(?:(?:and|or)\s+)?|(?:and|or)\s+|&\s*)$/i;

// GitHub site routes that can never be an owner, so `/orgs/acme` or
// `/settings/tokens` is not mistaken for a repository.
const RESERVED_OWNERS: ReadonlySet<string> = new Set([
  'about',
  'account',
  'apps',
  'blog',
  'codespaces',
  'collections',
  'contact',
  'copilot',
  'customer-stories',
  'dashboard',
  'education',
  'enterprise',
  'explore',
  'features',
  'issues',
  'join',
  'login',
  'logout',
  'marketplace',
  'new',
  'notifications',
  'organizations',
  'orgs',
  'pricing',
  'pulls',
  'readme',
  'resources',
  'search',
  'security',
  'sessions',
  'settings',
  'signup',
  'site',
  'solutions',
  'sponsors',
  'team',
  'topics',
  'trending',
  'users',
]);

interface Span {
  start: number;
  end: number;
}

function repositoryTarget(
  rawOwner: string,
  rawRepository: string,
): GitHubPreviewTarget | null {
  const owner = rawOwner.toLowerCase();
  const repository = rawRepository.toLowerCase();
  if (
    RESERVED_OWNERS.has(owner) ||
    !isGitHubRepositoryName(owner, repository)
  ) {
    return null;
  }
  return { kind: 'repository', owner, repository };
}

function itemTarget(
  rawOwner: string,
  rawRepository: string,
  rawNumber: string,
): GitHubItemTarget | null {
  const repository = repositoryTarget(rawOwner, rawRepository);
  if (!repository || !ITEM_NUMBER_RE.test(rawNumber)) return null;
  const number = Number(rawNumber);
  if (!isGitHubItemNumber(number)) return null;
  return {
    kind: 'item',
    owner: repository.owner,
    repository: repository.repository,
    number,
  };
}

/** The target of an already-trimmed URL, or `null` for anything else. */
function targetFromUrl(url: string): GitHubPreviewTarget | null {
  if (url.length > MAX_URL_LENGTH) return null;
  const path = GITHUB_URL_RE.exec(url)?.[1];
  if (path === undefined) return null;
  const item = PULL_PATH_RE.exec(path) ?? ISSUE_PATH_RE.exec(path);
  if (item) return itemTarget(item[1], item[2], item[3]);
  const repository = REPOSITORY_PATH_RE.exec(path);
  return repository
    ? repositoryTarget(repository[1], repository[2].replace(/\.git$/i, ''))
    : null;
}

/**
 * The spans `/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"'`]+/gi` would match, found in
 * linear time: that regex backtracks quadratically on input like `a.a.a…`.
 */
function findUrlSpans(text: string): Span[] {
  const spans: Span[] = [];
  let floor = 0;
  let separator = text.indexOf('://');
  while (separator >= 0) {
    let runStart = separator;
    while (runStart > floor && SCHEME_CHAR_RE.test(text[runStart - 1])) {
      runStart -= 1;
    }
    let start = -1;
    for (let index = runStart; index < separator; index += 1) {
      if (
        LETTER_RE.test(text[index]) &&
        (index === 0 || !WORD_CHAR_RE.test(text[index - 1]))
      ) {
        start = index;
        break;
      }
    }
    let end = separator + 3;
    // Only a valid scheme start scans the body, so every character is
    // scanned once and the search stays linear.
    while (
      start >= 0 &&
      end < text.length &&
      !URL_BODY_STOP_RE.test(text[end])
    ) {
      end += 1;
    }
    if (end > separator + 3) {
      spans.push({ start, end });
      floor = end;
      separator = text.indexOf('://', end);
    } else {
      floor = separator + 1;
      separator = text.indexOf('://', separator + 1);
    }
  }
  return spans;
}

function mask(text: string, spans: readonly Span[]): string {
  let masked = '';
  let cursor = 0;
  for (const { start, end } of spans) {
    masked += text.slice(cursor, start) + ' '.repeat(end - start);
    cursor = end;
  }
  return masked + text.slice(cursor);
}

/**
 * URLs first (every URL is masked, including unsupported ones), then
 * `owner/repo#N` outside URLs, then `#N` outside both, so a full reference
 * always outranks a bare number and occurrences never overlap.
 */
function collectOccurrences(
  text: string,
  bareNumbers: ReadonlySet<number> | undefined,
): GitHubReferenceOccurrence[] {
  const occurrences: GitHubReferenceOccurrence[] = [];
  const urlSpans = findUrlSpans(text);
  for (const { start, end } of urlSpans) {
    const originalUrl = text
      .slice(start, end)
      .replace(TRAILING_URL_PUNCTUATION_RE, '');
    const target = targetFromUrl(originalUrl);
    if (target) {
      occurrences.push({
        start,
        end: start + originalUrl.length,
        form: 'url',
        target,
        originalUrl,
      });
    }
  }

  const withoutUrls = mask(text, urlSpans);
  const qualifiedSpans: Span[] = [];
  for (const match of Array.from(withoutUrls.matchAll(QUALIFIED_RE))) {
    const target = itemTarget(match[1], match[2], match[3]);
    if (!target) continue;
    const span = { start: match.index, end: match.index + match[0].length };
    qualifiedSpans.push(span);
    occurrences.push({ ...span, form: 'qualified', target });
  }

  const withoutReferences = mask(withoutUrls, qualifiedSpans);
  const ends = occurrences.map((occurrence) => occurrence.end);
  ends.sort((left, right) => left - right);
  let endIndex = 0;
  let previousEnd = -1;
  for (const match of Array.from(withoutReferences.matchAll(BARE_RE))) {
    const number = Number(match[1]);
    if (!isGitHubItemNumber(number)) continue;
    while (endIndex < ends.length && ends[endIndex] <= match.index) {
      previousEnd = Math.max(previousEnd, ends[endIndex]);
      endIndex += 1;
    }
    if (bareNumbers) {
      if (!bareNumbers.has(number)) continue;
    } else {
      const continuesList =
        previousEnd >= 0 &&
        match.index - previousEnd <= BARE_CUE_LOOKBEHIND &&
        BARE_LIST_SEPARATOR_RE.test(
          text
            .slice(previousEnd, match.index)
            .replace(MARKDOWN_DELIMITER_RE, ''),
        );
      const cued = BARE_CUE_RE.test(
        text
          .slice(Math.max(0, match.index - BARE_CUE_LOOKBEHIND), match.index)
          .replace(MARKDOWN_DELIMITER_RE, ''),
      );
      if (!continuesList && !cued) continue;
    }
    previousEnd = match.index + match[0].length;
    occurrences.push({
      start: match.index,
      end: match.index + match[0].length,
      form: 'bare',
      number,
    });
  }
  return occurrences;
}

/**
 * Every GitHub reference occurrence with its source offsets, sorted by
 * start. Above the text or occurrence budget the result is incomplete.
 */
export function scanGitHubReferenceOccurrences(
  text: string,
  options: {
    /**
     * Bare numbers already accepted from the whole block's text. A renderer
     * scanning one inline text node at a time passes these, because the cue
     * ("PR", "fixes") may sit in a sibling node such as `**PR** #12`.
     */
    readonly bareNumbers?: ReadonlySet<number>;
  } = {},
): ScannedGitHubReferences {
  if (text.length > MAX_TEXT_LENGTH) {
    return { occurrences: [], complete: false };
  }
  const occurrences = collectOccurrences(text, options.bareNumbers).sort(
    (left, right) => left.start - right.start,
  );
  return {
    occurrences: occurrences.slice(0, MAX_OCCURRENCES),
    complete: occurrences.length <= MAX_OCCURRENCES,
  };
}

/** The reference an anchor's href names exactly: one whole GitHub URL. */
export function gitHubReferenceFromHref(
  href: string,
): { target: GitHubPreviewTarget; originalUrl: string } | null {
  const { occurrences } = scanGitHubReferenceOccurrences(href);
  const [occurrence] = occurrences;
  if (
    occurrences.length !== 1 ||
    occurrence.form !== 'url' ||
    occurrence.start !== 0 ||
    occurrence.end !== href.length
  ) {
    return null;
  }
  return { target: occurrence.target, originalUrl: occurrence.originalUrl };
}

/**
 * `owner/repo` or `owner/repo#N`; `#N` only when `shortRepository` (the
 * transcript's own single repository) is the item's repository.
 */
export function gitHubReferenceLabel(
  target: GitHubPreviewTarget,
  shortRepository: { owner: string; repository: string } | null,
): string {
  const repository = `${target.owner}/${target.repository}`;
  if (target.kind === 'repository') return repository;
  const short =
    shortRepository !== null &&
    shortRepository.owner.toLowerCase() === target.owner &&
    shortRepository.repository.toLowerCase() === target.repository;
  return short ? `#${target.number}` : `${repository}#${target.number}`;
}

/**
 * A raw URL or reference-ID label may be replaced by a generated one; an
 * author-written label is meaningful and keeps its text.
 */
export function isGeneratedGitHubLabel(
  label: string,
  href: string,
  target: GitHubPreviewTarget,
): boolean {
  const trimmed = label.trim();
  if (trimmed === href) return true;
  const lower = trimmed.toLowerCase();
  const repository = `${target.owner}/${target.repository}`;
  if (target.kind === 'repository') return lower === repository;
  return (
    lower === `${repository}#${target.number}` || lower === `#${target.number}`
  );
}

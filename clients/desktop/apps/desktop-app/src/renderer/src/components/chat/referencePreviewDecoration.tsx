import { Children, Fragment, useMemo, type ReactNode } from 'react';
import { invalidateReferencePreviews } from '@canopy/app-state';
import { CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT } from '@canopy/desktop-shared/constants/canopy-cloud';
import { scanReferenceOccurrences } from '@canopy/desktop-shared/lib/create-from-reference';
import {
  gitHubReferenceLabel,
  isGeneratedGitHubLabel,
  scanGitHubReferenceOccurrences,
  type GitHubReferenceOccurrence,
} from '@canopy/desktop-shared/lib/github-reference-occurrences';
import {
  isLinearIssuePreviewRequest,
  linearTeamKeyOf,
  type GitHubPreviewTarget,
  type ReferenceEnrichmentMode,
} from '@canopy/protocol/reference-previews';
import {
  GitHubReferencePreview,
  LinearReferencePreview,
  useGitHubOriginRepository,
  useGitHubPreviewConnected,
  useLinearTeamCatalog,
} from '@canopy/ui-app';
import {
  GITHUB_CONNECTION_CHANGED_EVENT,
  LINEAR_CONNECTION_CHANGED_EVENT,
} from '@/lib/integrationConnectionEvents';
import { mayChangeCanopyCloudIdentity } from '@/lib/canopyCloudAccountChange';
import type { ChatMarkdownFileTarget } from './chat-markdown-file-target';
import { useChatEnrichmentModes } from '@/lib/chat-enrichment-modes';

// Desktop-only transcript wiring by design for this slice: the card, trigger
// and cache are shared (ui-shared, ui-app, app-state), but the scanner lives
// in @canopy/desktop-shared, which ui-app may not import, and no web host has
// an authenticated provider adapter yet. Move this decoration into the shared
// transcript when a web host advertises `referencePreviews`; the gap is
// recorded in docs/parity/registry.yaml (transcript-reference-previews).

// Uppercase as written: lowercase prose such as "utf-8" is not decorated.
const BARE_IDENTIFIER_RE = /^[A-Z][A-Z0-9]*-\d+$/;

let invalidationWired = false;

/**
 * Clears cached previews, here and in every other window, when a provider
 * credential or the Canopy account changes: a Linear or GitHub change clears
 * only that provider, an account identity change clears both. Called at
 * renderer startup.
 */
export function ensureReferencePreviewInvalidation(): void {
  if (invalidationWired) return;
  invalidationWired = true;
  window.addEventListener(LINEAR_CONNECTION_CHANGED_EVENT, () =>
    invalidateReferencePreviews(undefined, 'linear'),
  );
  window.addEventListener(GITHUB_CONNECTION_CHANGED_EVENT, () =>
    invalidateReferencePreviews(undefined, 'github'),
  );
  // Same-account refreshes keep previews; identity or legacy notifications clear.
  window.addEventListener(CANOPY_CLOUD_ACCOUNT_CHANGED_EVENT, (event) => {
    if (mayChangeCanopyCloudIdentity(event)) invalidateReferencePreviews();
  });
}

/** What a settled block could decorate before the team catalog is known. */
export interface LinearCandidates {
  /** Team keys of bare identifiers in the block. */
  readonly prefixes: ReadonlySet<string>;
  /** The block contains a Linear issue URL. */
  readonly urls: boolean;
}

/** What a block may decorate now. */
export interface LinearDecoration {
  readonly mode: ReferenceEnrichmentMode;
  /** Accessible team keys from a complete, fresh catalog; `null` keeps bare IDs plain. */
  readonly teamKeys: ReadonlySet<string> | null;
  /** Issue URL anchors get the icon, title and card. */
  readonly urls: boolean;
}

function bareRequest(
  text: string,
  occurrence: ReturnType<
    typeof scanReferenceOccurrences
  >['occurrences'][number],
): string | null {
  if (
    occurrence.reference.kind !== 'linear' ||
    occurrence.originalUrl !== undefined ||
    !BARE_IDENTIFIER_RE.test(text.slice(occurrence.start, occurrence.end)) ||
    !isLinearIssuePreviewRequest({
      identifier: occurrence.reference.identifier,
    })
  ) {
    return null;
  }
  return occurrence.reference.identifier;
}

/**
 * Pure scan of a whole settled block. `null` when it has no Linear candidate
 * or exceeds the scan budget, so ordinary prose never touches preview state.
 */
export function scanLinearCandidates(text: string): LinearCandidates | null {
  const { occurrences, complete } = scanReferenceOccurrences(text);
  if (!complete) return null;
  const prefixes = new Set<string>();
  let urls = false;
  for (const occurrence of occurrences) {
    if (occurrence.reference.kind !== 'linear') continue;
    if (occurrence.originalUrl !== undefined) {
      urls = true;
      continue;
    }
    const identifier = bareRequest(text, occurrence);
    if (identifier) prefixes.add(linearTeamKeyOf(identifier));
  }
  return prefixes.size > 0 || urls ? { prefixes, urls } : null;
}

/**
 * Bare identifiers decorate only when their team key is in the connection's
 * complete, fresh catalog; URLs only while the host holds a Linear credential.
 */
export function useLinearDecoration(
  candidates: LinearCandidates,
): LinearDecoration | null {
  const mode = useChatEnrichmentModes().linear;
  const catalog = useLinearTeamCatalog(mode !== 'off');
  const keys = catalog?.keys ?? null;
  const bare =
    keys !== null &&
    Array.from(candidates.prefixes).some((prefix) => keys.has(prefix));
  const urls = candidates.urls && catalog?.connected === true;
  return useMemo(
    () => (bare || urls ? { teamKeys: bare ? keys : null, urls, mode } : null),
    [bare, keys, urls, mode],
  );
}

/**
 * What a settled block could decorate before GitHub state is known: explicit
 * URLs or `owner/repo#N` references, and bare `#N` numbers.
 */
export interface GitHubCandidates {
  readonly qualified: boolean;
  readonly bare: boolean;
}

/** What a block may decorate now. */
export interface GitHubDecoration {
  readonly mode: ReferenceEnrichmentMode;
  /**
   * The transcript's own single GitHub repository: bare numbers resolve in
   * it and its items keep short labels. `null` keeps bare numbers plain.
   */
  readonly originRepository: {
    readonly owner: string;
    readonly repository: string;
  } | null;
}

/**
 * Pure scan of a whole settled block. `null` when it has no GitHub candidate
 * or exceeds the scan budget, so ordinary prose never touches preview state.
 */
export function scanGitHubCandidates(text: string): GitHubCandidates | null {
  const { occurrences, complete } = scanGitHubReferenceOccurrences(text);
  if (!complete || occurrences.length === 0) return null;
  return {
    qualified: occurrences.some((occurrence) => occurrence.form !== 'bare'),
    bare: occurrences.some((occurrence) => occurrence.form === 'bare'),
  };
}

/**
 * GitHub references decorate only while the host holds a GitHub credential
 * and the transcript's origin is resolved, so a label never changes form
 * after it appears. Bare numbers additionally need a single origin
 * repository; cowork and multi-repository origins keep them plain.
 */
export function useGitHubDecoration(
  candidates: GitHubCandidates,
  target: ChatMarkdownFileTarget | null,
): GitHubDecoration | null {
  const mode = useChatEnrichmentModes().github;
  const connected = useGitHubPreviewConnected(mode !== 'off') === true;
  const origin = useMemo(
    () =>
      target
        ? {
            kind: 'worktree' as const,
            projectId: target.projectId,
            worktreeId: target.worktreeId,
          }
        : null,
    [target],
  );
  const originRepository = useGitHubOriginRepository(connected ? origin : null);
  const resolved = origin === null ? null : originRepository;
  const eligible =
    connected &&
    resolved !== undefined &&
    (candidates.qualified || (candidates.bare && resolved !== null));
  return useMemo(
    () =>
      eligible && resolved !== undefined
        ? { originRepository: resolved, mode }
        : null,
    [eligible, resolved, mode],
  );
}

interface GitHubPiece {
  readonly start: number;
  readonly end: number;
  readonly target: GitHubPreviewTarget;
  readonly href?: string;
}

function gitHubPiece(
  occurrence: GitHubReferenceOccurrence,
  github: GitHubDecoration,
): GitHubPiece | null {
  switch (occurrence.form) {
    case 'url':
      return { ...occurrence, href: occurrence.originalUrl };
    case 'qualified':
      return occurrence;
    case 'bare':
      return github.originRepository
        ? {
            start: occurrence.start,
            end: occurrence.end,
            target: {
              kind: 'item',
              ...github.originRepository,
              number: occurrence.number,
            },
          }
        : null;
  }
}

/**
 * Splits one prose text node; `decorateText` handles the text between.
 * Linear and GitHub references interleave in text order and never overlap.
 */
export function decorateReferences(
  text: string,
  keyPrefix: string,
  decorateText: (text: string) => ReactNode,
  teamKeys: ReadonlySet<string> | null,
  github: GitHubDecoration | null,
  linearMode: ReferenceEnrichmentMode = 'replace',
): ReactNode[] {
  const pieces: ReactNode[] = [];
  const references: { start: number; end: number; node: ReactNode }[] = [];
  if (teamKeys) {
    const { occurrences, complete } = scanReferenceOccurrences(text);
    for (const occurrence of complete ? occurrences : []) {
      const identifier = bareRequest(text, occurrence);
      if (!identifier || !teamKeys.has(linearTeamKeyOf(identifier))) continue;
      references.push({
        start: occurrence.start,
        end: occurrence.end,
        node: (
          <LinearReferencePreview
            key={`${keyPrefix}-linear-${occurrence.start}`}
            identifier={identifier}
            mode={linearMode}
          >
            {text.slice(occurrence.start, occurrence.end)}
          </LinearReferencePreview>
        ),
      });
    }
  }
  if (github) {
    const { occurrences, complete } = scanGitHubReferenceOccurrences(text);
    for (const occurrence of complete ? occurrences : []) {
      const piece = gitHubPiece(occurrence, github);
      if (!piece) continue;
      const raw = text.slice(piece.start, piece.end);
      references.push({
        start: piece.start,
        end: piece.end,
        node: (
          <GitHubReferencePreview
            key={`${keyPrefix}-github-${piece.start}`}
            target={piece.target}
            mode={github.mode}
            href={piece.href}
            label={
              piece.href === undefined
                ? raw
                : gitHubReferenceLabel(piece.target, github.originRepository)
            }
          >
            {raw}
          </GitHubReferencePreview>
        ),
      });
    }
  }
  references.sort((left, right) => left.start - right.start);
  let cursor = 0;
  const pushText = (end: number): void => {
    if (end > cursor) {
      pieces.push(
        <Fragment key={`${keyPrefix}-text-${cursor}`}>
          {decorateText(text.slice(cursor, end))}
        </Fragment>,
      );
    }
  };
  for (const reference of references) {
    if (reference.start < cursor) continue;
    pushText(reference.start);
    pieces.push(reference.node);
    cursor = reference.end;
  }
  pushText(text.length);
  return pieces;
}

/** The Linear issue an anchor's href names exactly, if any. */
export function linearReferenceFromHref(
  href: string,
): { identifier: string; workspaceSlug?: string } | null {
  const { occurrences } = scanReferenceOccurrences(href);
  const [occurrence] = occurrences;
  if (
    occurrences.length !== 1 ||
    occurrence.start !== 0 ||
    occurrence.end !== href.length ||
    occurrence.reference.kind !== 'linear'
  ) {
    return null;
  }
  const request = occurrence.linearWorkspaceSlug
    ? {
        identifier: occurrence.reference.identifier,
        workspaceSlug: occurrence.linearWorkspaceSlug,
      }
    : { identifier: occurrence.reference.identifier };
  // Only decorate what the host's request validator accepts; anything else
  // stays an ordinary link instead of a card that can never load.
  return isLinearIssuePreviewRequest(request) ? request : null;
}

/**
 * A raw URL or bare-ID label can become `ID: title`; an author-written label
 * is meaningful and keeps its text.
 */
export function isGeneratedLinearLabel(
  children: ReactNode,
  href: string,
  identifier: string,
): boolean {
  const parts = Children.toArray(children);
  if (!parts.every((part) => typeof part === 'string')) return false;
  const label = parts.join('').trim();
  return label === href || label.toUpperCase() === identifier;
}

/**
 * A raw URL or ID label can become `ID: title`; an author-written label is
 * meaningful and keeps its text.
 */
export function isGeneratedGitHubLinkLabel(
  children: ReactNode,
  href: string,
  target: GitHubPreviewTarget,
): boolean {
  const parts = Children.toArray(children);
  return (
    parts.every((part) => typeof part === 'string') &&
    isGeneratedGitHubLabel(parts.join(''), href, target)
  );
}

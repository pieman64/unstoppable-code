import type {
  ChatSearchQueryRequest,
  ChatSearchResult,
  ChatSearchSource,
  TrackedPlanReviewStatus,
} from '@canopy/desktop-shared/types';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';
import {
  CORE_SEARCH_DESCRIPTION_MAX,
  CORE_SEARCH_PROVIDER_MAX,
  CORE_SEARCH_SNIPPET_MAX,
  CORE_SEARCH_SOURCES,
  CORE_SEARCH_TITLE_MAX,
  type CanopyQueryParams,
  type CanopyQueryResult,
  type CoreSearchHit,
} from '@canopy/protocol/canopy-core';
import {
  canopyCapabilityUnavailableError,
  canopyInvalidArgumentError,
} from '@canopy/core-runtime';
import type { DesktopDomainAdapter } from './desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from './desktop-runtime-identity';

/** The chat search index operations `core.search.query` reads. */
export interface CoreSearchIndex {
  getIndexRevision(): number;
  queryResponsive(
    request: ChatSearchQueryRequest,
    context?: WorkspaceContext,
    linkedPersonalWorkspaceIds?: readonly string[],
  ): Promise<ChatSearchResult[]>;
}

/** The index caps one query at this many results (`chat-search/query.ts`). */
export const CORE_SEARCH_INDEX_RESULT_MAX = 100;

const IDENTIFIER_MAX = 512;

type CoreSearchSource = (typeof CORE_SEARCH_SOURCES)[number];
type CoreSearchReviewStatus = NonNullable<
  CoreSearchHit['document']['reviewStatus']
>;

const CORE_SOURCE_BY_INDEX_SOURCE: Record<ChatSearchSource, CoreSearchSource> =
  {
    live: 'live_chat',
    'worktree-archive': 'chat_archive',
    'cowork-archive': 'cowork_archive',
    'archived-container': 'archived_container',
    plan: 'plan',
  };

const REVIEW_STATUS_BY_PLAN_STATUS: Record<
  TrackedPlanReviewStatus,
  CoreSearchReviewStatus
> = {
  pending: 'in_review',
  approved: 'approved',
  dismissed: 'dismissed',
};

function isIdentifier(value: string): boolean {
  return value.length > 0 && value.length <= IDENTIFIER_MAX;
}

/** An ISO timestamp the contract can carry, or null when the epoch ms cannot be one. */
function isoTimestamp(epochMs: number): string | null {
  if (!Number.isFinite(epochMs)) return null;
  const date = new Date(epochMs);
  const year = date.getUTCFullYear();
  if (Number.isNaN(date.getTime()) || year < 0 || year > 9999) return null;
  return date.toISOString();
}

function refKind(
  result: ChatSearchResult,
): CoreSearchHit['document']['ref']['kind'] {
  const documentKind =
    result.documentKind ?? (result.source === 'plan' ? 'plan' : 'chat');
  if (documentKind === 'plan') return 'plan';
  if (documentKind === 'archived-container') return 'archive';
  return 'chat';
}

/** D18 mapping; null when the entry cannot be represented (identifier or date out of bounds). */
export function projectSearchHit(
  result: ChatSearchResult,
  rank: number,
): CoreSearchHit | null {
  const source = CORE_SOURCE_BY_INDEX_SOURCE[result.source];
  if (!source) return null;
  const kind = refKind(result);
  // Archived-container documents carry the container id as worktreeId; their
  // chatId is the index's shared '__container__' placeholder.
  const refId = kind === 'archive' ? result.worktreeId : result.chatId;
  if (!isIdentifier(result.docId) || !isIdentifier(refId)) return null;
  const updatedAt = isoTimestamp(result.updatedAt);
  if (updatedAt === null) return null;
  let archivedAt: string | null = null;
  if (result.archivedAt !== null && result.archivedAt !== undefined) {
    archivedAt = isoTimestamp(result.archivedAt);
    if (archivedAt === null) return null;
  }
  const snippet = result.snippet.slice(0, CORE_SEARCH_SNIPPET_MAX);
  const matches = result.matchRanges
    .filter(
      ({ start, end }) =>
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 0 &&
        start <= end &&
        end <= snippet.length,
    )
    .map(({ start, end }) => ({ start, end }));
  return {
    document: {
      documentId: result.docId,
      ref: { kind, id: refId },
      source,
      title: result.title.slice(0, CORE_SEARCH_TITLE_MAX),
      description:
        result.description === null || result.description === undefined
          ? null
          : result.description.slice(0, CORE_SEARCH_DESCRIPTION_MAX),
      provider:
        result.providerType === null || result.providerType === undefined
          ? null
          : result.providerType.slice(0, CORE_SEARCH_PROVIDER_MAX),
      updatedAt,
      archivedAt,
      messageCount: Number.isFinite(result.messageCount)
        ? Math.max(0, Math.trunc(result.messageCount))
        : 0,
      reviewStatus: result.reviewStatus
        ? (REVIEW_STATUS_BY_PLAN_STATUS[result.reviewStatus] ?? null)
        : null,
    },
    score: 1 / (rank + 1),
    snippet,
    matches,
  };
}

function visibilityContext(
  scope: CanopyQueryParams<'core.search.query'>['scope'],
): WorkspaceContext {
  return scope.organizationId
    ? {
        kind: 'organization',
        organizationId: scope.organizationId.toLowerCase(),
      }
    : { kind: 'personal' };
}

export function createCoreSearchAdapter(
  index: () => Promise<CoreSearchIndex>,
): DesktopDomainAdapter {
  return {
    queries: {
      'core.search.query': async (
        params: CanopyQueryParams<'core.search.query'>,
      ): Promise<CanopyQueryResult<'core.search.query'>> => {
        const { query, scope, sources, cursor, limit } = params;
        if (
          scope.targetId !== undefined ||
          (scope.authorityId !== undefined &&
            scope.authorityId !== LOCAL_DESKTOP_AUTHORITY_ID)
        )
          throw canopyCapabilityUnavailableError(
            'The selected search authority or target is unavailable.',
          );
        if (cursor !== null)
          throw canopyInvalidArgumentError(
            'Search results have one page; send cursor null.',
          );
        const searchIndex = await index();
        const indexRevision = searchIndex.getIndexRevision();
        if (sources.length === 0)
          return { indexRevision, hits: [], nextCursor: null };
        const wanted = new Set<CoreSearchSource>(sources);
        const narrowed =
          CORE_SEARCH_SOURCES.some((source) => !wanted.has(source)) ||
          scope.workspaceId !== undefined ||
          scope.worktreeId !== undefined ||
          scope.chatId !== undefined;
        const results = await searchIndex.queryResponsive(
          {
            query,
            limit: narrowed
              ? CORE_SEARCH_INDEX_RESULT_MAX
              : Math.min(limit, CORE_SEARCH_INDEX_RESULT_MAX),
          },
          visibilityContext(scope),
          [],
        );
        const hits: CoreSearchHit[] = [];
        for (const result of results) {
          if (hits.length >= limit) break;
          const source = CORE_SOURCE_BY_INDEX_SOURCE[result.source];
          if (!source || !wanted.has(source)) continue;
          if (
            (scope.workspaceId !== undefined &&
              result.projectId !== scope.workspaceId) ||
            (scope.worktreeId !== undefined &&
              result.worktreeId !== scope.worktreeId) ||
            (scope.chatId !== undefined && result.chatId !== scope.chatId)
          )
            continue;
          const hit = projectSearchHit(result, hits.length);
          if (hit) hits.push(hit);
        }
        return { indexRevision, hits, nextCursor: null };
      },
    },
  };
}

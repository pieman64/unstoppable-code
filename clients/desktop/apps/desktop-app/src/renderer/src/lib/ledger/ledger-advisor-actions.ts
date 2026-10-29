import { ledgerViewSearchParams } from '@canopy/app-state';
import {
  getRendererToolRequestScopeKey,
  type AppAdvisorAction,
  type AppAdvisorActionError,
  type AppAdvisorJson,
} from '@canopy/desktop-shared/types';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import type {
  LedgerViewResult,
  LedgerViewScope,
} from '@canopy/protocol/ledger-view';
import {
  indexLedgerActorLabels,
  ledgerActorName,
  ledgerExcerpt,
} from '@canopy/ui-shared/lib';
import { isCoworkChatTarget } from '@/lib/cowork';
import { openLedgerPanel } from '@/lib/ledger/open-ledger-panel';
import {
  desktopLedgerClient,
  ledgerViewStoreFor,
} from '@/lib/ledger/ledger-view-stores';
import { useChatStore } from '@/stores/chatStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { useNavigationStore } from '@/stores/navigationStore';

/*
 * App Advisor's Ledger actions. They act as the person, through the same
 * client and view stores as the Ledger panel: searching reads a scope's
 * entries, adding records an entry the person owns (keyed by the advisor
 * request, so a retried request is recorded once), and opening shows the
 * panel. Everything waits behind `canopy-ledger-enabled`.
 */

export type LedgerAdvisorOutcome =
  | { readonly ok: true; readonly result: AppAdvisorJson }
  | { readonly ok: false; readonly error: AppAdvisorActionError };

type LedgerOpenAction = Extract<AppAdvisorAction, { type: 'ledger.open' }>;
type LedgerSearchAction = Extract<AppAdvisorAction, { type: 'ledger.search' }>;
type LedgerAddEntryAction = Extract<
  AppAdvisorAction,
  { type: 'ledger.add_entry' }
>;

const DEFAULT_SEARCH_LIMIT = 20;
const SEARCH_EXCERPT_CODE_POINTS = 200;
const REQUEST_KEY_MAX_LENGTH = 128;
const ADVISOR_KEY_PREFIX = 'advisor:';
/** Keys a request ID too long to use as is; a separate prefix never collides. */
const HASHED_ADVISOR_KEY_PREFIX = 'advisor-sha256:';
/** Frames to wait for a newly shown scope's panel layout. */
const LAYOUT_WAIT_FRAMES = 30;

function failure(
  code: AppAdvisorActionError['code'],
  message: string,
  retryable = false,
): LedgerAdvisorOutcome {
  return { ok: false, error: { code, message, retryable } };
}

function ledgerUnavailable(): LedgerAdvisorOutcome | null {
  return useFeatureFlagsStore
    .getState()
    .isEnabled(CLIENT_FEATURE_FLAGS.canopyLedgerEnabled.key)
    ? null
    : failure('surface_unavailable', 'The Feed is not available.');
}

/** The action's scope, or the selected work when it names none. */
function resolveScope(action: {
  readonly projectId?: string;
  readonly worktreeId?: string;
}): LedgerViewScope | null {
  if (action.projectId !== undefined && action.worktreeId !== undefined) {
    return { projectId: action.projectId, worktreeId: action.worktreeId };
  }
  const selected = useChatStore.getState().selectedWorktree;
  return selected === null
    ? null
    : { projectId: selected.projectId, worktreeId: selected.worktreeId };
}

function noScope(): LedgerAdvisorOutcome {
  return failure('surface_unavailable', 'No work is selected.', true);
}

/** A view result's failure, as the advisor reports it. */
function fromResult(
  result: Exclude<LedgerViewResult<unknown>, { status: 'ok' }>,
): LedgerAdvisorOutcome {
  if (result.status === 'unavailable') {
    return failure(
      'surface_unavailable',
      result.reason === 'disabled'
        ? 'The Feed is not available.'
        : result.reason === 'no_scope'
          ? 'This work has no Feed.'
          : 'The Feed is not running.',
      result.reason === 'runtime_unavailable',
    );
  }
  switch (result.reason) {
    case 'INVALID_INPUT':
      return failure('invalid_payload', result.message);
    case 'NOT_FOUND':
      return failure('not_found', result.message);
    case 'FORBIDDEN':
      return failure('authorization_conflict', result.message);
    default:
      return failure('execution_failed', result.message, true);
  }
}

/**
 * The Ledger request key for an advisor request: its ID, or a SHA-256 of an ID
 * too long for the key, so every attempt of the request keeps the same key.
 * Without an ID nothing identifies a retry, and each attempt is its own add.
 * Request IDs are only unique within a chat, so the origin chat scopes them.
 */
async function advisorRequestKey(
  requestId: string,
  originChatTabId: string | undefined,
): Promise<string> {
  if (requestId.length === 0) return globalThis.crypto.randomUUID();
  const identity =
    originChatTabId === undefined
      ? requestId
      : getRendererToolRequestScopeKey(requestId, originChatTabId);
  const plain = `${ADVISOR_KEY_PREFIX}${identity}`;
  if (plain.length <= REQUEST_KEY_MAX_LENGTH) return plain;
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(identity),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `${HASHED_ADVISOR_KEY_PREFIX}${hex}`;
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

/** Shows the scope, opening its Ledger panel once its layout is built. */
async function showLedger(scope: LedgerViewScope): Promise<boolean> {
  const chat = useChatStore.getState();
  const selected = chat.selectedWorktree;
  const isSelected =
    selected !== null &&
    selected.projectId === scope.projectId &&
    selected.worktreeId === scope.worktreeId;
  const cowork = isCoworkChatTarget(scope.projectId);
  // A Cowork or App Advisor Work Entry is shown by selecting it first.
  if (!isSelected && cowork) return false;
  useNavigationStore.getState().navigate(cowork ? 'chat' : 'main');
  if (!isSelected) chat.selectWorktree(scope.projectId, scope.worktreeId);
  for (let frame = 0; frame < LAYOUT_WAIT_FRAMES; frame += 1) {
    if (openLedgerPanel(scope.projectId, scope.worktreeId)) return true;
    await nextFrame();
  }
  return false;
}

export async function runLedgerOpenAction(
  action: LedgerOpenAction,
): Promise<LedgerAdvisorOutcome> {
  const unavailable = ledgerUnavailable();
  if (unavailable !== null) return unavailable;
  const scope = resolveScope(action);
  if (scope === null) return noScope();
  if (!(await showLedger(scope))) {
    return failure(
      'surface_unavailable',
      'The Feed panel could not open. Select the work first.',
      true,
    );
  }
  if (action.entryId !== undefined) {
    const store = ledgerViewStoreFor(scope.projectId, scope.worktreeId);
    await store.getState().select(action.entryId);
    // Opened only once the panel shows the entry; a failed read says why.
    const { detail } = store.getState();
    if (detail.status !== 'ready' || detail.entryId !== action.entryId) {
      const problem = detail.entryId === action.entryId ? detail.problem : null;
      if (problem?.kind === 'error' && problem.reason === 'NOT_FOUND') {
        return failure('not_found', 'This work has no entry with that ID.');
      }
      if (problem?.kind === 'unavailable') {
        return failure(
          'surface_unavailable',
          'The Feed is not available.',
          problem.reason === 'runtime_unavailable',
        );
      }
      return failure(
        'execution_failed',
        "The entry couldn't be read. Try again.",
        true,
      );
    }
  }
  return {
    ok: true,
    result: {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      ...(action.entryId === undefined ? {} : { entryId: action.entryId }),
    },
  };
}

export async function runLedgerSearchAction(
  action: LedgerSearchAction,
): Promise<LedgerAdvisorOutcome> {
  const unavailable = ledgerUnavailable();
  if (unavailable !== null) return unavailable;
  const scope = resolveScope(action);
  if (scope === null) return noScope();
  const result = await desktopLedgerClient.searchEntries({
    scope,
    params: ledgerViewSearchParams(
      action.query ?? '',
      {
        types: action.types ?? [],
        statuses: action.statuses ?? [],
        owner: 'anyone',
      },
      { limit: action.limit ?? DEFAULT_SEARCH_LIMIT },
    ),
  });
  if (result.status !== 'ok') return fromResult(result);
  const actors = indexLedgerActorLabels(result.value.actors);
  return {
    ok: true,
    result: {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      hasMore: result.value.hasMore,
      entries: result.value.entries.map((entry) => ({
        entryId: entry.entryId,
        type: entry.type,
        title: entry.title,
        status: entry.status,
        author: ledgerActorName(entry.author, actors),
        owner: ledgerActorName(entry.owner, actors),
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        excerpt: ledgerExcerpt(entry.content, SEARCH_EXCERPT_CODE_POINTS),
      })),
    },
  };
}

export async function runLedgerAddEntryAction(
  action: LedgerAddEntryAction,
  requestId: string,
  originChatTabId?: string,
): Promise<LedgerAdvisorOutcome> {
  const unavailable = ledgerUnavailable();
  if (unavailable !== null) return unavailable;
  const scope = resolveScope(action);
  if (scope === null) return noScope();
  const result = await desktopLedgerClient.addEntry({
    scope,
    // A retried advisor request carries the same ID: one entry, not two.
    requestKey: await advisorRequestKey(requestId, originChatTabId),
    params: {
      type: action.entryType,
      title: action.title,
      content: action.content,
      ...(action.highlights === undefined
        ? {}
        : { highlights: action.highlights }),
      ...(action.status === undefined ? {} : { status: action.status }),
      owner: 'self',
      ...(action.supersedesEntryId === undefined
        ? {}
        : { supersedesEntryId: action.supersedesEntryId }),
    },
  });
  if (result.status !== 'ok') return fromResult(result);
  const { entry } = result.value;
  return {
    ok: true,
    result: {
      projectId: scope.projectId,
      worktreeId: scope.worktreeId,
      entryId: entry.entryId,
      revision: entry.revision,
      type: entry.type,
      title: entry.title,
      status: entry.status,
    },
  };
}

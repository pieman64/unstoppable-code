import { createHash } from 'node:crypto';
import { CanopyOperationError } from '@canopy/core-runtime';
import type {
  ArchiveChatGetResult,
  ArchiveContainerListResult,
  ArchiveContainerSummary,
  LedgerEntriesSearchParams,
  LedgerEntriesSearchResult,
} from '@canopy/protocol/canopy-core';
import {
  normalizeLedgerViewQuery,
  type LedgerTaskViewScope,
  type LedgerViewReceipt,
  type LedgerViewResult,
} from '@canopy/protocol/ledger-view';
import {
  indexLedgerActorLabels,
  ledgerActorName,
  ledgerExcerpt,
} from '@canopy/ui-shared/lib/ledger-display';
import { clampChatHistoryLimit } from '@canopy/desktop-shared/lib/app-advisor-chat-reads';
import type {
  AppAdvisorAction,
  AppAdvisorActionError,
  AppAdvisorActionResponse,
  AppAdvisorJson,
  AppAdvisorWatcherSummary,
  ArchivedContainerRestoreResponse,
} from '@canopy/desktop-shared/types';
import { toAdvisorJson } from './advisor-json';

/**
 * CAN-6007: App Advisor's Feed, watcher and archive actions, in Electron
 * main. Feed entries are recorded as the advisor chat; another chat's or a
 * person's watcher, and unlocking an archive, need a person's confirmation.
 */
export const ADVISOR_RECORDS_ACTION_TYPES = [
  'ledger.search',
  'ledger.add_entry',
  'watcher.list',
  'watcher.get',
  'watcher.delete',
  'archived.list',
  'archived.read_chat',
  'archived.restore',
  'archived.set_locked',
] as const;

export type AdvisorRecordsAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_RECORDS_ACTION_TYPES)[number] }
>;

export function isAdvisorRecordsAction(
  action: AppAdvisorAction,
): action is AdvisorRecordsAction {
  return ADVISOR_RECORDS_ACTION_TYPES.some((type) => type === action.type);
}

export type PersonConfirmation = 'confirmed' | 'declined' | 'no_person';

/** The owners these actions use; tests substitute their own. */
export interface AdvisorRecordsActionHost {
  /** The advisor chat, whose own watchers it may delete unasked. */
  readonly chatId: string;
  /** The idempotency key of this tool call, for its keyed writes. */
  readonly callKey: string;
  searchFeed(
    scope: LedgerTaskViewScope,
    params: LedgerEntriesSearchParams,
  ): Promise<LedgerViewResult<LedgerEntriesSearchResult>>;
  addFeedEntry(
    scope: LedgerTaskViewScope,
    requestKey: string,
    params: AddEntryParams,
  ): Promise<LedgerViewResult<LedgerViewReceipt>>;
  /** Every watcher, read-only. */
  listWatchers(): Promise<AppAdvisorWatcherSummary[]>;
  /** `core.initiatedWork.watcher.delete` for the advisor's own watcher. */
  deleteOwnWatcher(
    watcherId: string,
  ): Promise<
    | { ok: true }
    | { ok: false; reason: 'busy' | 'not_found' | 'failed'; message: string }
  >;
  /** The watcher service's delete, the one the window's Delete uses. */
  deleteWatcher(watcherId: string, notifySubscriber: boolean): Promise<boolean>;
  /** One AskUserQuestion; only a person's answer can confirm. */
  confirm(
    question: string,
    options: { confirm: string; decline: string },
  ): Promise<PersonConfirmation>;
  listArchive(workspaceId: string): Promise<ArchiveContainerListResult>;
  readArchivedChat(
    workspaceId: string,
    archiveId: string,
    chatId: string,
    limit: number,
  ): Promise<ArchiveChatGetResult>;
  setArchiveLocked(
    workspaceId: string,
    archiveId: string,
    locked: boolean,
  ): Promise<ArchiveContainerSummary>;
  restoreArchive(
    workspaceId: string,
    archiveId: string,
  ): Promise<ArchivedContainerRestoreResponse>;
}

type LedgerAddEntryAction = Extract<
  AdvisorRecordsAction,
  { type: 'ledger.add_entry' }
>;

export interface AddEntryParams {
  type: LedgerAddEntryAction['entryType'];
  title: string;
  content: string;
  highlights?: string[];
  status?: NonNullable<LedgerAddEntryAction['status']>;
  owner: 'self';
  supersedesEntryId?: string;
}

type Response = Omit<AppAdvisorActionResponse, 'requestId'>;

const DEFAULT_SEARCH_LIMIT = 20;
const SEARCH_EXCERPT_CODE_POINTS = 200;
const REQUEST_KEY_MAX_LENGTH = 128;

export const DELETE_WATCHER = 'Delete watcher';
export const KEEP_WATCHER = 'Keep watcher';
export const UNLOCK_ARCHIVE = 'Unlock';
export const KEEP_ARCHIVE_LOCKED = 'Keep locked';

function failure(
  code: AppAdvisorActionError['code'],
  message: string,
  retryable = false,
): Response {
  return { ok: false, error: { code, message, retryable } };
}

/** The scope the action names; the advisor has no selected work to fall back on. */
function namedScope(action: {
  readonly projectId?: string;
  readonly worktreeId?: string;
}): LedgerTaskViewScope | null {
  return action.projectId !== undefined && action.worktreeId !== undefined
    ? { projectId: action.projectId, worktreeId: action.worktreeId }
    : null;
}

const NO_SCOPE = failure(
  'invalid_payload',
  'Name the project and worktree whose Feed to use.',
);

/** A Feed read's failure, as the window's actions report it. */
function fromLedgerResult(
  result: Exclude<LedgerViewResult<unknown>, { status: 'ok' }>,
): Response {
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
 * The Feed request key for this tool call: its key, or a SHA-256 of a key too
 * long for the Ledger, so every attempt of the call adds one entry.
 */
function feedRequestKey(callKey: string): string {
  const plain = `advisor:${callKey}`;
  if (plain.length <= REQUEST_KEY_MAX_LENGTH) return plain;
  return `advisor-sha256:${createHash('sha256').update(callKey).digest('hex')}`;
}

function operationFailure(error: unknown, fallback: string): Response {
  if (error instanceof CanopyOperationError) {
    switch (error.payload.kind) {
      case 'not_found':
        return failure('not_found', error.payload.message);
      case 'invalid_argument':
        return failure('invalid_payload', error.payload.message);
      case 'permission_denied':
      case 'unauthenticated':
        return failure('authorization_conflict', error.payload.message);
      default:
        return failure('execution_failed', error.payload.message, true);
    }
  }
  return failure(
    'execution_failed',
    error instanceof Error && error.message ? error.message : fallback,
    true,
  );
}

async function searchFeed(
  action: Extract<AdvisorRecordsAction, { type: 'ledger.search' }>,
  host: AdvisorRecordsActionHost,
): Promise<Response> {
  const scope = namedScope(action);
  if (scope === null) return NO_SCOPE;
  const query = normalizeLedgerViewQuery(action.query ?? '');
  const result = await host.searchFeed(scope, {
    ...(query.length > 0 ? { query } : {}),
    ...(action.types && action.types.length > 0
      ? { types: [...action.types] }
      : {}),
    ...(action.statuses && action.statuses.length > 0
      ? { statuses: [...action.statuses] }
      : {}),
    sort: 'created_desc',
    limit: action.limit ?? DEFAULT_SEARCH_LIMIT,
  });
  if (result.status !== 'ok') return fromLedgerResult(result);
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

async function addFeedEntry(
  action: LedgerAddEntryAction,
  host: AdvisorRecordsActionHost,
): Promise<Response> {
  const scope = namedScope(action);
  if (scope === null) return NO_SCOPE;
  const result = await host.addFeedEntry(scope, feedRequestKey(host.callKey), {
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
  });
  if (result.status !== 'ok') return fromLedgerResult(result);
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

async function deleteWatcher(
  action: Extract<AdvisorRecordsAction, { type: 'watcher.delete' }>,
  host: AdvisorRecordsActionHost,
): Promise<Response> {
  const watcher = (await host.listWatchers()).find(
    (entry) => entry.id === action.id,
  );
  if (!watcher)
    return failure('not_found', `Watcher ${action.id} was not found.`);
  // Core's agent delete removes only a watcher an agent of this chat set
  // up, but sends no notice; a delete that must tell the subscriber goes to
  // the person and the watcher service below, whoever set it up.
  if (
    watcher.destination.chatId === host.chatId &&
    action.notifySubscriber !== true
  ) {
    const deleted = await host.deleteOwnWatcher(action.id);
    if (deleted.ok) return { ok: true, result: { id: action.id } };
    // Core deletes only watchers an agent of this chat set up; a listed one
    // it doesn't find, such as one a person set up for this chat, is
    // someone else's and goes to the person below.
    if (deleted.reason !== 'not_found')
      return failure(
        'execution_failed',
        deleted.message,
        deleted.reason === 'busy',
      );
  }
  // Another chat's or a person's watcher: only a person may remove it.
  const answer = await host.confirm(
    `Delete the watcher "${watcher.label}"? A person or another chat set it up, and it stops for them too.`,
    { confirm: DELETE_WATCHER, decline: KEEP_WATCHER },
  );
  if (answer !== 'confirmed')
    return failure(
      'authorization_conflict',
      answer === 'declined'
        ? 'The watcher was kept.'
        : "Only a person can delete another chat's watcher, and nobody confirmed it.",
    );
  return (await host.deleteWatcher(action.id, action.notifySubscriber === true))
    ? { ok: true, result: { id: action.id } }
    : failure('execution_failed', 'Watcher not found or currently firing.');
}

function archiveContainerResult(
  container: ArchiveContainerSummary,
): Record<string, AppAdvisorJson> {
  return {
    id: container.archiveId,
    kind: container.kind,
    name: container.name,
    branchName: container.branchName,
    archivedAt: container.archivedAt,
    expiresAt: container.expiresAt,
    locked: container.locked,
    lockedAt: container.lockedAt,
    chatCount: container.chatCount,
    archivedChatCount: container.archivedChatCount,
    executionCount: container.executionCount,
    partiallyRestored: container.partiallyRestored,
  };
}

async function setArchiveLocked(
  action: Extract<AdvisorRecordsAction, { type: 'archived.set_locked' }>,
  host: AdvisorRecordsActionHost,
): Promise<Response> {
  const container = (
    await host.listArchive(action.workspaceId)
  ).containers.find((entry) => entry.archiveId === action.containerId);
  if (!container)
    return failure(
      'not_found',
      `Archived container ${action.containerId} was not found in project ${action.workspaceId}.`,
    );
  if (!action.locked && !container.locked)
    // Already unlocked: nothing is written, so a lock a person sets after
    // this listing is never cleared without asking them.
    return {
      ok: true,
      result: {
        workspaceId: action.workspaceId,
        containerId: action.containerId,
        locked: false,
        lockedAt: null,
        expiresAt: container.expiresAt,
      },
    };
  if (!action.locked) {
    // Unlocking lets retention delete it: only a person may do that.
    const answer = await host.confirm(
      `Unlock the archived "${container.name}"? It can then be deleted when its retention period ends.`,
      { confirm: UNLOCK_ARCHIVE, decline: KEEP_ARCHIVE_LOCKED },
    );
    if (answer !== 'confirmed')
      return failure(
        'authorization_conflict',
        answer === 'declined'
          ? 'The archive stays locked.'
          : 'Only a person can unlock an archive, and nobody confirmed it.',
      );
  }
  const updated = await host.setArchiveLocked(
    action.workspaceId,
    action.containerId,
    action.locked,
  );
  return {
    ok: true,
    result: {
      workspaceId: action.workspaceId,
      containerId: action.containerId,
      locked: updated.locked,
      lockedAt: updated.lockedAt,
      // Meaningful when unlocked: the retention window restarted from the
      // unlock time.
      expiresAt: updated.expiresAt,
    },
  };
}

async function run(
  action: AdvisorRecordsAction,
  host: AdvisorRecordsActionHost,
): Promise<Response> {
  switch (action.type) {
    case 'ledger.search':
      return searchFeed(action, host);
    case 'ledger.add_entry':
      return addFeedEntry(action, host);
    case 'watcher.list':
      return {
        ok: true,
        result: { watchers: toAdvisorJson(await host.listWatchers()) },
      };
    case 'watcher.get': {
      const watcher = (await host.listWatchers()).find(
        (entry) => entry.id === action.id,
      );
      return watcher
        ? { ok: true, result: { watcher: toAdvisorJson(watcher) } }
        : failure('not_found', `Watcher ${action.id} was not found.`);
    }
    case 'watcher.delete':
      return deleteWatcher(action, host);
    case 'archived.list': {
      const listed = await host.listArchive(action.workspaceId);
      return {
        ok: true,
        result: {
          workspaceId: action.workspaceId,
          containers: listed.containers.map(archiveContainerResult),
        },
      };
    }
    case 'archived.read_chat': {
      const limit = clampChatHistoryLimit(action.limit);
      const chat = await host.readArchivedChat(
        action.workspaceId,
        action.containerId,
        action.chatId,
        limit,
      );
      return {
        ok: true,
        result: {
          workspaceId: action.workspaceId,
          containerId: action.containerId,
          chatId: action.chatId,
          title: chat.title,
          limit,
          totalMessages: chat.totalMessages,
          returnedMessages: chat.messages.length,
          messages: chat.messages,
        },
      };
    }
    case 'archived.restore': {
      const restored = await host.restoreArchive(
        action.workspaceId,
        action.containerId,
      );
      const pending = (
        await host.listArchive(action.workspaceId)
      ).containers.some((entry) => entry.archiveId === action.containerId);
      return {
        ok: true,
        result: {
          workspaceId: action.workspaceId,
          containerId: action.containerId,
          kind: restored.kind,
          restoredWorktreeId: restored.restoredWorktreeId ?? null,
          restoredEntryId: restored.restoredEntryId ?? null,
          branchName: restored.branchName ?? null,
          warnings: restored.warnings,
          // True when pipeline imports are still pending (partial restore);
          // `archived.restore` on the same container retries the import.
          pending,
        },
      };
    }
    case 'archived.set_locked':
      return setArchiveLocked(action, host);
  }
}

export async function dispatchAdvisorRecordsAction(
  action: AdvisorRecordsAction,
  host: AdvisorRecordsActionHost,
): Promise<Response> {
  try {
    return await run(action, host);
  } catch (error) {
    return operationFailure(error, 'The action failed.');
  }
}

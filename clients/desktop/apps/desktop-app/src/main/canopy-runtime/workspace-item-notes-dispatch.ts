import { randomUUID } from 'node:crypto';
import { CanopyOperationError } from '@canopy/core-runtime';
import { encodeWorkspaceItemId } from '@canopy/core-runtime/node/workspace/workspace-item-ids';
import {
  createWorkspaceItemStoreLocks,
  type CoreWorkspaceTextItemKind,
} from '@canopy/core-runtime/node/workspace/workspace-note-items';
import {
  CORE_WORKSPACE_ITEM_GRANTS,
  CORE_WORKSPACE_ITEM_LIST_MAX_LIMIT,
  type CanopyCallerDescriptor,
  type CoreWorkspaceItem,
  type CoreWorkspaceItemListResult,
} from '@canopy/protocol/canopy-core';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type WorkspaceNoteItem,
  type WorkspaceNoteReadResponse,
} from '@canopy/desktop-shared/types';
import { assertWritableScope } from '../lib/read-only-scope';
import { validateId } from '../lib/validation';
import {
  listNotesForProject,
  listPromptsForProject,
  readNoteForProject,
  readPromptForProject,
} from '../services/workspace-items-service';
import {
  runTextItemsCall,
  type TextItemsCall,
} from './core-workspace-note-items-host';
import type { WorkspaceItemsDispatcher } from './workspace-item-attachments-dispatch';

/*
 * The `core.workspace.item.*` projection behind the note and prompt IPC
 * channels and Portal commands. Each call adds only the grant its operation
 * requires. The channels keep their responses byte for byte: the desktop host
 * records the unchanged store result during the call and the projection
 * returns it, recovering it when the canonical item cannot represent the
 * stored one.
 */

const ID_LABEL: Record<CoreWorkspaceTextItemKind, string> = {
  note: 'noteId',
  prompt: 'promptId',
};

/*
 * The channels take no revision and never refused a concurrent write, so
 * their writes to one store run one at a time here, and a write that still
 * loses to another caller re-reads and tries again.
 */
const WRITE_ATTEMPTS = 3;
const serializedWrites = createWorkspaceItemStoreLocks();

function writeQueue<Result>(
  kind: CoreWorkspaceTextItemKind,
  projectId: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  return serializedWrites(JSON.stringify([kind, projectId]), operation);
}

function operationError(error: unknown): CanopyOperationError | null {
  return error instanceof CanopyOperationError ? error : null;
}

function hasCode(error: unknown, code: string): boolean {
  return operationError(error)?.payload.code === code;
}

/** Kinds whose canonical refusal still leaves a recorded legacy result. */
function isRecoverable(error: unknown): boolean {
  const kind = operationError(error)?.payload.kind;
  return (
    kind === 'invalid_argument' ||
    kind === 'internal' ||
    kind === 'resource_exhausted'
  );
}

/** The host error carried by the in-process binding, as the channels threw it. */
function hostError(error: unknown): unknown {
  const runtimeCause = operationError(error)?.runtimeCause;
  return runtimeCause instanceof Error ? runtimeCause : error;
}

function workspaceTextItemId(
  kind: CoreWorkspaceTextItemKind,
  projectId: string,
  name: string,
): string {
  const itemId = encodeWorkspaceItemId({
    kind,
    workspaceId: projectId,
    worktreeId: null,
    name,
  });
  if (itemId === null) throw new Error(`Invalid ${kind} id`);
  return itemId;
}

function readCaller(caller: CanopyCallerDescriptor): CanopyCallerDescriptor {
  return { ...caller, grants: [CORE_WORKSPACE_ITEM_GRANTS.read] };
}

function writeCaller(caller: CanopyCallerDescriptor): CanopyCallerDescriptor {
  return { ...caller, grants: [CORE_WORKSPACE_ITEM_GRANTS.write] };
}

/**
 * `workspace-items:list-notes`/`list-prompts` and the Portal lists through
 * `core.workspace.item.list`. Notes and prompts belong to the workspace, so
 * the channels' `worktreeId` only selects a read-only viewer replica.
 */
export async function listTextItemsForIpc(
  dispatcher: WorkspaceItemsDispatcher,
  caller: CanopyCallerDescriptor,
  kind: CoreWorkspaceTextItemKind,
  projectId: unknown,
  worktreeId?: string,
): Promise<WorkspaceNoteItem[]> {
  validateId(projectId, 'projectId');
  // shortcut: the viewer replica has no creation times for the item schema,
  // so it keeps its direct reader (CAN-4095 inventory debt).
  if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
    return kind === 'note'
      ? listNotesForProject(projectId, worktreeId)
      : listPromptsForProject(projectId, worktreeId);
  const call: TextItemsCall = {};
  try {
    await runTextItemsCall(call, () =>
      dispatcher.query(
        'core.workspace.item.list',
        {
          workspaceId: projectId,
          worktreeId: null,
          kinds: [kind],
          cursor: null,
          limit: CORE_WORKSPACE_ITEM_LIST_MAX_LIMIT,
        },
        { caller: readCaller(caller) },
      ),
    );
  } catch (error) {
    if (!call.listed || !isRecoverable(error)) throw hostError(error);
  }
  // The first page lists the whole store, so its record is the full list.
  if (!call.listed) throw new Error(`The ${kind} list was not captured.`);
  return call.listed;
}

/**
 * `workspace-items:read-note`/`read-prompt` and the Portal reads through
 * `core.workspace.item.get`.
 */
export async function readTextItemForIpc(
  dispatcher: WorkspaceItemsDispatcher,
  caller: CanopyCallerDescriptor,
  kind: CoreWorkspaceTextItemKind,
  projectId: unknown,
  name: unknown,
  worktreeId?: string,
): Promise<WorkspaceNoteReadResponse> {
  validateId(projectId, 'projectId');
  validateId(name, ID_LABEL[kind]);
  // shortcut: viewer reads keep their direct reader (CAN-4095 inventory debt).
  if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
    return kind === 'note'
      ? readNoteForProject(projectId, name, worktreeId)
      : readPromptForProject(projectId, name, worktreeId);
  const itemId = workspaceTextItemId(kind, projectId, name);
  const call: TextItemsCall = {};
  try {
    await runTextItemsCall(call, () =>
      dispatcher.query(
        'core.workspace.item.get',
        { itemId },
        { caller: readCaller(caller) },
      ),
    );
  } catch (error) {
    // A missing item answers `notFound`; the channels threw the store's error.
    if (call.readError) throw call.readError;
    // A file removed between the store read and its revision read still
    // returns what the store read, as the channels did.
    const recovered =
      isRecoverable(error) || hasCode(error, 'core.workspace.item.notFound');
    if (!call.read || !recovered) throw hostError(error);
  }
  if (!call.read) throw new Error(`The ${kind} read was not captured.`);
  return call.read;
}

/** The current item, or null when it is missing or cannot be represented. */
async function currentItem(
  dispatcher: WorkspaceItemsDispatcher,
  caller: CanopyCallerDescriptor,
  itemId: string,
): Promise<CoreWorkspaceItem | null> {
  try {
    return await dispatcher.query(
      'core.workspace.item.get',
      { itemId },
      { caller: readCaller(caller) },
    );
  } catch {
    return null;
  }
}

export interface TextItemSaveRequest {
  projectId: string;
  itemId?: string;
  title: string;
  content: string;
  originWorktreeId?: string;
}

// The upsert params' `title` and `content` bounds.
const TITLE_MAX = 512;
const CONTENT_MAX = 2_000_000;

/** At most `max` UTF-16 units, never ending on half of a surrogate pair. */
function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** A string `title`; an empty or missing one gets the legacy fallback name. */
function canonicalTitle(
  title: unknown,
  itemId: string | undefined,
  kind: CoreWorkspaceTextItemKind,
): string {
  return clamp(
    typeof title === 'string' && title !== '' ? title : (itemId ?? kind),
    TITLE_MAX,
  );
}

function canonicalContent(content: unknown): string {
  return typeof content === 'string' ? clamp(content, CONTENT_MAX) : '';
}

/**
 * `workspace-items:save-note`/`save-prompt` through
 * `core.workspace.item.upsert`. The item's current revision is read first;
 * an ID the store does not have is saved as a new item, as the channels
 * always did. The store writer receives the request exactly as sent, and
 * the canonical params only stand in for it within their bounds: an empty
 * title carries the writer's own fallback name (D3), and a title over 512
 * characters or content over 2,000,000 is clamped, while the writer still
 * stores what was sent.
 */
export async function saveTextItemForIpc(
  dispatcher: WorkspaceItemsDispatcher,
  caller: CanopyCallerDescriptor,
  kind: CoreWorkspaceTextItemKind,
  request: TextItemSaveRequest,
): Promise<WorkspaceNoteItem> {
  const { projectId, itemId: requestedId } = request;
  validateId(projectId, 'projectId');
  assertWritableScope(projectId);
  if (requestedId !== undefined) validateId(requestedId, ID_LABEL[kind]);
  if (request.originWorktreeId !== undefined)
    validateId(request.originWorktreeId, 'originWorktreeId');
  const title = canonicalTitle(request.title, requestedId, kind);
  const content = canonicalContent(request.content);
  const saveOnce = async (): Promise<WorkspaceNoteItem> => {
    const current =
      requestedId === undefined
        ? null
        : await currentItem(
            dispatcher,
            caller,
            workspaceTextItemId(kind, projectId, requestedId),
          );
    const call: TextItemsCall = {
      legacySave: {
        kind,
        workspaceId: projectId,
        itemId: requestedId,
        title: request.title,
        content: request.content,
        standsIn: title !== request.title || content !== request.content,
      },
    };
    try {
      await runTextItemsCall(call, () =>
        dispatcher.instruction(
          'core.workspace.item.upsert',
          {
            itemId: current?.itemId ?? null,
            workspaceId: projectId,
            worktreeId: null,
            kind,
            title,
            content,
            artifactId: null,
            expectedRevision: current?.revision ?? null,
            originWorktreeId: request.originWorktreeId ?? null,
          },
          {
            caller: writeCaller(caller),
            metadata: { idempotencyKey: randomUUID() },
          },
        ),
      );
    } catch (error) {
      if (!call.saved || !isRecoverable(error)) throw error;
    }
    if (!call.saved) throw new Error(`The ${kind} save was not captured.`);
    return call.saved;
  };
  return writeQueue(kind, projectId, async () => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await saveOnce();
      } catch (error) {
        // The item changed or was renamed after it was read: read it again,
        // and save it as new if it is gone, as the channels always did.
        const lost =
          hasCode(error, 'core.workspace.item.revisionConflict') ||
          hasCode(error, 'core.workspace.item.notFound');
        if (!lost || attempt === WRITE_ATTEMPTS) throw hostError(error);
      }
    }
  });
}

/** The revision of an item `get` cannot return, found by listing. */
async function listedRevision(
  dispatcher: WorkspaceItemsDispatcher,
  caller: CanopyCallerDescriptor,
  kind: CoreWorkspaceTextItemKind,
  projectId: string,
  itemId: string,
): Promise<number | null> {
  let cursor: string | null = null;
  do {
    const page: CoreWorkspaceItemListResult = await dispatcher.query(
      'core.workspace.item.list',
      {
        workspaceId: projectId,
        worktreeId: null,
        kinds: [kind],
        cursor,
        limit: CORE_WORKSPACE_ITEM_LIST_MAX_LIMIT,
      },
      { caller: readCaller(caller) },
    );
    const found = page.items.find((item) => item.itemId === itemId);
    if (found) return found.revision;
    cursor = page.nextCursor;
  } while (cursor !== null);
  return null;
}

/** The item's current revision, or null when it does not exist. */
async function revisionForDelete(
  dispatcher: WorkspaceItemsDispatcher,
  caller: CanopyCallerDescriptor,
  kind: CoreWorkspaceTextItemKind,
  projectId: string,
  itemId: string,
): Promise<number | null> {
  try {
    const item = await dispatcher.query(
      'core.workspace.item.get',
      { itemId },
      { caller: readCaller(caller) },
    );
    return item.revision;
  } catch (error) {
    if (hasCode(error, 'core.workspace.item.notFound')) return null;
    // Content too large for `get` still lists, with its revision.
    if (operationError(error)?.payload.kind !== 'resource_exhausted')
      throw hostError(error);
  }
  try {
    return await listedRevision(dispatcher, caller, kind, projectId, itemId);
  } catch (error) {
    throw hostError(error);
  }
}

/**
 * `workspace-items:delete-note`/`delete-prompt` through
 * `core.workspace.item.delete`. The channels take no revision and succeed for
 * a missing item, so the projection reads the revision, treats `notFound` as
 * success and reads again after a conflict. An item whose revision cannot be
 * read (an unreadable file) is not deleted; the read error is thrown.
 */
export async function deleteTextItemForIpc(
  dispatcher: WorkspaceItemsDispatcher,
  caller: CanopyCallerDescriptor,
  kind: CoreWorkspaceTextItemKind,
  projectId: unknown,
  name: unknown,
): Promise<void> {
  validateId(projectId, 'projectId');
  assertWritableScope(projectId);
  validateId(name, ID_LABEL[kind]);
  const itemId = workspaceTextItemId(kind, projectId, name);
  await writeQueue(kind, projectId, async () => {
    for (let attempt = 1; ; attempt += 1) {
      const expectedRevision = await revisionForDelete(
        dispatcher,
        caller,
        kind,
        projectId,
        itemId,
      );
      if (expectedRevision === null) return;
      try {
        await dispatcher.instruction(
          'core.workspace.item.delete',
          { itemId, expectedRevision },
          {
            caller: writeCaller(caller),
            metadata: { idempotencyKey: randomUUID() },
          },
        );
        return;
      } catch (error) {
        if (hasCode(error, 'core.workspace.item.notFound')) return;
        if (
          attempt < WRITE_ATTEMPTS &&
          hasCode(error, 'core.workspace.item.revisionConflict')
        )
          continue;
        throw hostError(error);
      }
    }
  });
}

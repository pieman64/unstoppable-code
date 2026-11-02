import { randomUUID } from 'node:crypto';
import {
  CORE_WORKSPACE_ITEM_GRANTS,
  CORE_WORKSPACE_ITEM_IMPORT_MAX_SOURCES,
  CORE_WORKSPACE_ITEM_LIST_MAX_LIMIT,
  type CanopyCallerDescriptor,
  type CoreWorkspaceItem,
  type CoreWorkspaceItemListResult,
} from '@canopy/protocol/canopy-core';
import type { CoreWorkspaceItemScope } from '@canopy/core-runtime/node/workspace/workspace-item-ids';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ClipboardAttachmentData,
  type WorkspaceAttachmentItem,
} from '@canopy/desktop-shared/types';
import { validateId } from '../lib/validation';
import { isWorkEntryWorkspace } from '../lib/workspace-registry';
import { listAttachmentsForProject } from '../services/workspace-items-service';
import {
  attachmentHostPath,
  createAttachmentImportCall,
  runAttachmentImportCall,
  type AttachmentImportInput,
} from './core-workspace-items-adapter';
import type { DesktopCanopyDispatcher } from './desktop-runtime';
import { preserveRuntimeCauseError } from './runtime-cause-error';

/*
 * The `core.workspace.item.*` projection shared by the attachment IPC
 * channels and the Portal attachment list. Each call adds only the grant its
 * operation requires; results map back to the legacy payloads, with host
 * paths projected by the desktop host adapter.
 */

export type WorkspaceItemsDispatcher = Pick<
  DesktopCanopyDispatcher,
  'query' | 'instruction'
>;

/**
 * The `workspace-items:*` channels keep a Cowork or App Advisor workspace's
 * attachments at workspace level whatever worktree the request names.
 */
export function workspaceItemsChannelScope(
  projectId: string,
  worktreeId: string,
): CoreWorkspaceItemScope {
  return {
    workspaceId: projectId,
    worktreeId: isWorkEntryWorkspace(projectId) ? null : worktreeId,
  };
}

function toLegacyAttachment(
  scope: CoreWorkspaceItemScope,
  item: CoreWorkspaceItem,
): WorkspaceAttachmentItem {
  return {
    filename: item.title,
    absolutePath: attachmentHostPath(scope, item.title),
    sizeBytes: item.sizeBytes ?? 0,
    createdAt: item.createdAt,
  };
}

/**
 * Import files, then clipboard items, through `core.workspace.item.import`.
 * The first failed source rethrows its original host error, as the channels
 * always have; later sources are not attempted.
 */
export async function importAttachmentsForIpc(
  dispatcher: WorkspaceItemsDispatcher,
  caller: CanopyCallerDescriptor,
  request: {
    scope: CoreWorkspaceItemScope;
    filePaths: readonly string[];
    clipboardItems: readonly ClipboardAttachmentData[];
  },
): Promise<WorkspaceAttachmentItem[]> {
  const { scope } = request;
  const inputs: AttachmentImportInput[] = [
    ...request.filePaths.map(
      (path): AttachmentImportInput => ({
        kind: 'file',
        path,
      }),
    ),
    ...request.clipboardItems.map(
      (item): AttachmentImportInput => ({
        kind: 'clipboard',
        item,
      }),
    ),
  ];
  const call = createAttachmentImportCall(inputs);
  const imported: WorkspaceAttachmentItem[] = [];
  for (
    let start = 0;
    start < call.handles.length;
    start += CORE_WORKSPACE_ITEM_IMPORT_MAX_SOURCES
  ) {
    const handles = call.handles.slice(
      start,
      start + CORE_WORKSPACE_ITEM_IMPORT_MAX_SOURCES,
    );
    const { outcomes } = await preserveRuntimeCauseError(
      runAttachmentImportCall(call, () =>
        dispatcher.instruction(
          'core.workspace.item.import',
          {
            workspaceId: scope.workspaceId,
            worktreeId: scope.worktreeId,
            kind: 'attachment',
            sources: handles.map((handle) => ({
              kind: 'host' as const,
              handle,
            })),
          },
          {
            caller: { ...caller, grants: [CORE_WORKSPACE_ITEM_GRANTS.write] },
            metadata: { idempotencyKey: randomUUID() },
          },
        ),
      ),
    );
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome.status === 'imported')
        imported.push(toLegacyAttachment(scope, outcome.item));
      else if (outcome.status === 'failed') {
        const cause = call.failures.get(handles[index]);
        throw cause instanceof Error ? cause : new Error(outcome.error.message);
      }
    }
  }
  return imported;
}

/**
 * `workspace-items:list-attachments` and the Portal list through
 * `core.workspace.item.list`.
 */
export async function listAttachmentsForIpc(
  dispatcher: WorkspaceItemsDispatcher,
  caller: CanopyCallerDescriptor,
  projectId: unknown,
  worktreeId: unknown,
): Promise<WorkspaceAttachmentItem[]> {
  // Validate before dispatch: a rejected params schema would replace the
  // legacy identifier messages.
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  // shortcut: the viewer replica has no creation times for the item schema,
  // so it keeps its direct reader (CAN-4105 inventory debt).
  if (projectId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
    return listAttachmentsForProject(projectId, worktreeId);
  const scope = workspaceItemsChannelScope(projectId, worktreeId);
  const attachments: WorkspaceAttachmentItem[] = [];
  // Offset pages shift when the store changes between them; the legacy
  // single read never repeated a file.
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: CoreWorkspaceItemListResult = await preserveRuntimeCauseError(
      dispatcher.query(
        'core.workspace.item.list',
        {
          workspaceId: scope.workspaceId,
          worktreeId: scope.worktreeId,
          kinds: ['attachment'],
          cursor,
          limit: CORE_WORKSPACE_ITEM_LIST_MAX_LIMIT,
        },
        {
          caller: { ...caller, grants: [CORE_WORKSPACE_ITEM_GRANTS.read] },
        },
      ),
    );
    for (const item of page.items) {
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
      attachments.push(toLegacyAttachment(scope, item));
    }
    cursor = page.nextCursor;
  } while (cursor !== null);
  return attachments;
}

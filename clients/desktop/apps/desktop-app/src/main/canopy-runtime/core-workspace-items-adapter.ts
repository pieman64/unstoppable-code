import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ClipboardAttachmentData,
} from '@canopy/desktop-shared/types';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import type { CoreWorkspaceItemScope } from '@canopy/core-runtime/node/workspace/workspace-item-ids';
import {
  createCoreWorkspaceItemHandlers,
  type CoreWorkspaceAttachmentEntry,
  type CoreWorkspaceAttachmentsHost,
  type CoreWorkspaceItemHandlerOptions,
  type CoreWorkspaceItemHandlers,
  type CoreWorkspaceItemScopeHost,
} from '@canopy/core-runtime/node/workspace/workspace-items';
import { listAttachmentsInDir } from '../lib/agent-attachments';
import { resolveCoworkWorkspaceId } from '../lib/cowork-migration-map';
import {
  getAppAdvisorHomeDir,
  getCoworkWorkspaceRootDir,
  getWorkspaceWorktreeAttachmentsDir,
  getWorktreeAttachmentsDir,
} from '../lib/paths';
import {
  ATTACHMENT_EXTENSION_TOO_LONG_MESSAGE,
  copyAttachmentFileToDir,
  importAttachment as importCoworkAttachment,
  importClipboardAttachment as importCoworkClipboardAttachment,
  writeClipboardAttachmentToDir,
} from '../lib/standalone-workspace-files';
import { IdentifierValidationError, validateId } from '../lib/validation';
import {
  isMultiRepoWorkspace,
  isWorkEntryWorkspace,
} from '../lib/workspace-registry';
import { listWorkEntryAttachments } from '../services/workspace-items-service';

/*
 * The desktop host behind `core.workspace.item.*`. It classifies scopes for
 * every kind, resolves each attachments store from trusted state and keeps
 * the existing copy helpers as the writers. Host paths never reach the
 * operations: sources arrive as handles issued for one call, and only this
 * module maps an item back to the host path the legacy channels return.
 */

/**
 * A per-call slot the legacy projections fill before dispatch and the host
 * binding reads during it (AsyncLocalStorage), so call-scoped host state
 * never outlives the call. CAN-4152 creates its own slots for notes and
 * prompts.
 */
export interface WorkspaceItemsCallSlot<Value> {
  run<Result>(value: Value, operation: () => Promise<Result>): Promise<Result>;
  current(): Value | undefined;
}

export function createWorkspaceItemsCallSlot<
  Value,
>(): WorkspaceItemsCallSlot<Value> {
  const storage = new AsyncLocalStorage<Value>();
  return {
    run: (value, operation) => storage.run(value, operation),
    current: () => storage.getStore(),
  };
}

/** A file the user picked or dropped, or clipboard bytes, for one import. */
export type AttachmentImportInput =
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'clipboard'; readonly item: ClipboardAttachmentData };

export interface AttachmentImportCall {
  /** One handle per input, in input order. */
  readonly handles: readonly string[];
  readonly inputs: ReadonlyMap<string, AttachmentImportInput>;
  /** The host error of each failed source, for the legacy projections. */
  readonly failures: Map<string, unknown>;
}

// Handles resolve only inside the call that issued them, so neither paths
// nor clipboard bytes outlive it.
const importCalls = createWorkspaceItemsCallSlot<AttachmentImportCall>();

export function createAttachmentImportCall(
  inputs: readonly AttachmentImportInput[],
): AttachmentImportCall {
  const entries = inputs.map((input): [string, AttachmentImportInput] => [
    `h-${randomBytes(16).toString('hex')}`,
    input,
  ]);
  return {
    handles: entries.map(([handle]) => handle),
    inputs: new Map(entries),
    failures: new Map(),
  };
}

export function runAttachmentImportCall<Result>(
  call: AttachmentImportCall,
  operation: () => Promise<Result>,
): Promise<Result> {
  return importCalls.run(call, operation);
}

class UnknownAttachmentSourceError extends Error {
  public constructor() {
    super('The attachment source is not available to this call.');
    this.name = 'UnknownAttachmentSourceError';
  }
}

function workEntryHomeDir(projectId: string): string {
  if (projectId === APP_ADVISOR_PROJECT_ID) return getAppAdvisorHomeDir();
  return getCoworkWorkspaceRootDir(resolveCoworkWorkspaceId(projectId));
}

/**
 * A scope's attachments folder: the worktree's own folder (multi-repo
 * workspaces under `workspaces/`, app-managed IDs under `app-workspaces/`),
 * or a Cowork or App Advisor workspace's shared folder. Null when the scope
 * has none.
 */
export function attachmentStoreDir(
  scope: CoreWorkspaceItemScope,
): string | null {
  const { workspaceId, worktreeId } = scope;
  if (worktreeId === null)
    return isWorkEntryWorkspace(workspaceId)
      ? getCoworkManagedSubdir(workEntryHomeDir(workspaceId), 'attachments')
      : null;
  return isMultiRepoWorkspace(workspaceId)
    ? getWorkspaceWorktreeAttachmentsDir(workspaceId, worktreeId)
    : getWorktreeAttachmentsDir(workspaceId, worktreeId);
}

/** The trusted host path of an attachment item, for local path projection. */
export function attachmentHostPath(
  scope: CoreWorkspaceItemScope,
  filename: string,
): string {
  const dir = attachmentStoreDir(scope);
  if (dir === null) throw new Error('This scope has no attachments folder.');
  return join(dir, filename);
}

async function copyInto(
  scope: CoreWorkspaceItemScope,
  input: AttachmentImportInput,
): Promise<CoreWorkspaceAttachmentEntry> {
  const { workspaceId } = scope;
  const dir = attachmentStoreDir(scope);
  if (dir === null) throw new Error('This scope has no attachments folder.');
  // The workspace-level helpers resolve the same shared folder themselves.
  const copied =
    scope.worktreeId === null
      ? input.kind === 'clipboard'
        ? await importCoworkClipboardAttachment(workspaceId, input.item)
        : await importCoworkAttachment(workspaceId, input.path)
      : input.kind === 'clipboard'
        ? await writeClipboardAttachmentToDir(dir, input.item)
        : await copyAttachmentFileToDir(dir, input.path);
  return {
    name: copied.filename,
    sizeBytes: copied.sizeBytes ?? 0,
    createdAt: copied.createdAt,
  };
}

/** Scope classes for every item kind, with the legacy ID messages. */
export const desktopWorkspaceItemScopeHost: CoreWorkspaceItemScopeHost = {
  classify(scope) {
    validateId(scope.workspaceId, 'projectId');
    if (scope.worktreeId !== null) validateId(scope.worktreeId, 'worktreeId');
    if (scope.workspaceId === SHARED_CONTAINER_VIEWER_PROJECT_ID)
      return 'viewer';
    return isWorkEntryWorkspace(scope.workspaceId) ? 'workEntry' : 'code';
  },
  isInvalidScope: (error) => error instanceof IdentifierValidationError,
};

export const desktopWorkspaceAttachmentsHost: CoreWorkspaceAttachmentsHost = {
  storeKey(scope) {
    const dir = attachmentStoreDir(scope);
    if (dir === null) throw new Error('This scope has no attachments folder.');
    return dir;
  },
  async list(scope) {
    const dir = attachmentStoreDir(scope);
    if (dir === null) return [];
    const items =
      scope.worktreeId === null
        ? await listWorkEntryAttachments(scope.workspaceId)
        : await listAttachmentsInDir(dir);
    return items.map(({ filename, sizeBytes, createdAt }) => ({
      name: filename,
      sizeBytes,
      createdAt,
    }));
  },
  async importSource(scope, source) {
    if (source.kind === 'item') {
      const dir = attachmentStoreDir(source.scope);
      if (dir === null) throw new UnknownAttachmentSourceError();
      return copyInto(scope, { kind: 'file', path: join(dir, source.name) });
    }
    const call = importCalls.current();
    const input = call?.inputs.get(source.handle);
    if (!call || !input) throw new UnknownAttachmentSourceError();
    try {
      return await copyInto(scope, input);
    } catch (error) {
      call.failures.set(source.handle, error);
      throw error;
    }
  },
  classifyFailure(error) {
    if (error instanceof UnknownAttachmentSourceError) return 'unknownHandle';
    if (
      error instanceof Error &&
      error.message === ATTACHMENT_EXTENSION_TOO_LONG_MESSAGE
    )
      return 'filenameInvalid';
    return null;
  },
};

/**
 * The one `core.workspace.item` owner's handlers. CAN-4152 passes its note
 * and prompt providers here and adds its instructions to the same set.
 */
export function createCoreWorkspaceItemsAdapter(
  options: Partial<CoreWorkspaceItemHandlerOptions> = {},
): CoreWorkspaceItemHandlers {
  return createCoreWorkspaceItemHandlers({
    ...options,
    scopes: options.scopes ?? desktopWorkspaceItemScopeHost,
    attachments: options.attachments ?? desktopWorkspaceAttachmentsHost,
  });
}

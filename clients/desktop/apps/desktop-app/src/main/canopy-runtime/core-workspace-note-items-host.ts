import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  WorkspaceNoteItem,
  WorkspaceNoteReadResponse,
} from '@canopy/desktop-shared/types';
import { getCoworkManagedSubdir } from '@canopy/desktop-shared/node/lib/cowork-managed-dir';
import type { CoreWorkspaceItemAdmittedScope } from '@canopy/core-runtime/node/workspace/workspace-items';
import {
  createWorkspaceTextItemProviders,
  type CoreWorkspaceTextItemDocument,
  type CoreWorkspaceTextItemEntry,
  type CoreWorkspaceTextItemKind,
  type CoreWorkspaceTextItemProviders,
  type CoreWorkspaceTextItemSave,
  type CoreWorkspaceTextItemsHost,
} from '@canopy/core-runtime/node/workspace/workspace-note-items';
import { logMainProcessWarn } from '../lib/main-process-logging';
import { isPathInside } from '../lib/path-safety';
import { getWorkspaceNotesDir, getWorkspacePromptsDir } from '../lib/paths';
import {
  listNotes as listCoworkNotes,
  listPrompts as listCoworkPrompts,
  readNote as readCoworkNote,
  readPrompt as readCoworkPrompt,
  saveNote as saveCoworkNote,
  savePrompt as saveCoworkPrompt,
} from '../lib/standalone-workspace-files';
import {
  deleteWorkspaceNote,
  deleteWorkspacePrompt,
  listWorkspaceNotes,
  listWorkspacePrompts,
  readWorkspaceNote,
  readWorkspacePrompt,
  saveWorkspaceNote,
  saveWorkspacePrompt,
} from '../lib/workspace-items';
import {
  removeSharedContainerScopeItemId,
  replaceSharedContainerScopeItemId,
} from '../shared-containers/file-scope-store';
import {
  createWorkspaceItemsCallSlot,
  workEntryHomeDir,
} from './core-workspace-items-adapter';

/*
 * The desktop host behind the `note` and `prompt` item kinds. The existing
 * Code and Cowork store modules stay the readers and writers; this host maps
 * their results onto host-free entries and runs the side effects the IPC
 * channels ran (shared-container selection rewrites and publication), so
 * every caller of the operations triggers them.
 */

/** The `workspace-items:save-*` request fields the canonical params cannot carry. */
export interface LegacyTextItemSave {
  /** The store the request is for; a save of any other is not this request. */
  readonly kind: CoreWorkspaceTextItemKind;
  readonly workspaceId: string;
  /** The requested ID, even one the store does not have. */
  readonly itemId: string | undefined;
  /** As sent, including an empty or missing title. */
  readonly title: string;
  /** As sent, including missing content. */
  readonly content: string;
  /**
   * The canonical title or content differs from what was sent (an empty
   * title's fallback name, or a clamp to the params' bounds), so the store
   * must never write the canonical values in this request's place.
   */
  readonly standsIn: boolean;
}

/**
 * One IPC or Portal projection call. The projection fills `legacySave`; the
 * host records the unchanged store result each projection returns.
 */
export interface TextItemsCall {
  legacySave?: LegacyTextItemSave;
  listed?: WorkspaceNoteItem[];
  read?: WorkspaceNoteReadResponse;
  /** The store's error for an item it could not find. */
  readError?: Error;
  saved?: WorkspaceNoteItem;
}

const textItemCalls = createWorkspaceItemsCallSlot<TextItemsCall>();

export function runTextItemsCall<Result>(
  call: TextItemsCall,
  operation: () => Promise<Result>,
): Promise<Result> {
  return textItemCalls.run(call, operation);
}

function folder(kind: CoreWorkspaceTextItemKind): 'notes' | 'prompts' {
  return kind === 'note' ? 'notes' : 'prompts';
}

function isWorkEntry(scope: CoreWorkspaceItemAdmittedScope): boolean {
  return scope.scopeClass === 'workEntry';
}

/** The scope's notes or prompts folder; a legacy chat-project ID resolves to its Cowork workspace. */
export function textItemStoreDir(
  scope: CoreWorkspaceItemAdmittedScope,
  kind: CoreWorkspaceTextItemKind,
): string {
  if (isWorkEntry(scope))
    return getCoworkManagedSubdir(
      workEntryHomeDir(scope.workspaceId),
      folder(kind),
    );
  return kind === 'note'
    ? getWorkspaceNotesDir(scope.workspaceId)
    : getWorkspacePromptsDir(scope.workspaceId);
}

/** A Cowork note or prompt meta in the shape the channels return. */
function coworkItem(
  meta: { id: string; title: string; createdAt: string; updatedAt: string },
  dir: string,
): WorkspaceNoteItem {
  return {
    id: meta.id,
    title: meta.title,
    absolutePath: join(dir, `${meta.id}.md`),
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

// Loaded lazily: desktop-runtime imports this host, and a static scheduler
// import would pull the publish pipeline into every desktop-runtime importer.
function scheduleWorkspaceItemPublication(projectId: string): void {
  void import('../shared-containers/publish/scheduler')
    .then(({ getSharedContainerPublishScheduler }) =>
      getSharedContainerPublishScheduler().scheduleWorkspace(projectId),
    )
    .catch((error) =>
      logMainProcessWarn(
        '[shared-containers] failed to schedule workspace-item publication',
        error,
      ),
    );
}

function errnoCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? Reflect.get(error, 'code')
    : undefined;
}

function isMissing(error: unknown): boolean {
  const code = errnoCode(error);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function legacyList(
  scope: CoreWorkspaceItemAdmittedScope,
  kind: CoreWorkspaceTextItemKind,
): Promise<WorkspaceNoteItem[]> {
  const { workspaceId } = scope;
  if (!isWorkEntry(scope))
    return kind === 'note'
      ? listWorkspaceNotes(workspaceId)
      : listWorkspacePrompts(workspaceId);
  const dir = textItemStoreDir(scope, kind);
  const metas =
    kind === 'note'
      ? await listCoworkNotes(workspaceId)
      : await listCoworkPrompts(workspaceId);
  return metas.map((meta) => coworkItem(meta, dir));
}

async function legacyRead(
  scope: CoreWorkspaceItemAdmittedScope,
  kind: CoreWorkspaceTextItemKind,
  name: string,
): Promise<WorkspaceNoteReadResponse> {
  const { workspaceId } = scope;
  if (!isWorkEntry(scope))
    return kind === 'note'
      ? readWorkspaceNote(workspaceId, name)
      : readWorkspacePrompt(workspaceId, name);
  const { meta, content } =
    kind === 'note'
      ? await readCoworkNote(workspaceId, name)
      : await readCoworkPrompt(workspaceId, name);
  return { meta: coworkItem(meta, textItemStoreDir(scope, kind)), content };
}

/** Changes with any write to or replacement of the file; null when unknown. */
async function fileVersion(path: string): Promise<string | null> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch {
    return null;
  }
}

/**
 * Whether the store holds a file named exactly `<name>.md`. A case-folding
 * or normalizing filesystem also opens the file through another spelling,
 * which would give one item a second ID and leave cleanup keyed by it.
 */
async function isStoredName(dir: string, name: string): Promise<boolean> {
  try {
    return (await readdir(dir)).includes(`${name}.md`);
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

const READ_ATTEMPTS = 3;

/** The stored bytes and file times of one listed or read item. */
async function storedFile(
  item: WorkspaceNoteItem,
): Promise<CoreWorkspaceTextItemEntry> {
  const [raw, info] = await Promise.all([
    readFile(item.absolutePath),
    stat(item.absolutePath),
  ]);
  return {
    name: item.id,
    title: item.title,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    fileCreatedAt: info.birthtime.toISOString(),
    fileUpdatedAt: info.mtime.toISOString(),
    origin: item.origin ?? {},
    raw,
  };
}

/** What the store writers receive: the legacy request, or the canonical write. */
interface TextItemWrite {
  readonly itemId: string | undefined;
  readonly title: string;
  readonly content: string;
  readonly originWorktreeId: string | null;
}

async function saveCoworkItem(
  scope: CoreWorkspaceItemAdmittedScope,
  kind: CoreWorkspaceTextItemKind,
  { itemId, title, content }: TextItemWrite,
): Promise<WorkspaceNoteItem> {
  const { workspaceId } = scope;
  // The Cowork writer rewrites selections and schedules publication itself.
  const meta =
    kind === 'note'
      ? await saveCoworkNote(workspaceId, title, content, itemId)
      : await saveCoworkPrompt(workspaceId, title, content, itemId);
  return coworkItem(meta, textItemStoreDir(scope, kind));
}

async function saveCodeItem(
  scope: CoreWorkspaceItemAdmittedScope,
  kind: CoreWorkspaceTextItemKind,
  { itemId, title, content, originWorktreeId }: TextItemWrite,
): Promise<WorkspaceNoteItem> {
  const { workspaceId } = scope;
  const request = {
    workspaceId,
    title,
    content,
    ...(originWorktreeId !== null ? { originWorktreeId } : {}),
  };
  const saved =
    kind === 'note'
      ? await saveWorkspaceNote({
          ...request,
          ...(itemId !== undefined ? { noteId: itemId } : {}),
        })
      : await saveWorkspacePrompt({
          ...request,
          ...(itemId !== undefined ? { promptId: itemId } : {}),
        });
  // The IPC channel always rewrote selections when an ID was named.
  if (itemId !== undefined)
    await replaceSharedContainerScopeItemId(
      workspaceId,
      kind,
      itemId,
      saved.id,
    );
  scheduleWorkspaceItemPublication(workspaceId);
  return saved;
}

/**
 * The call's legacy request when this write is the one it projects: same
 * store, and an update of the requested ID or a create. It applies once, so
 * no other write in the call can pick it up.
 */
function claimLegacySave(
  call: TextItemsCall | undefined,
  scope: CoreWorkspaceItemAdmittedScope,
  kind: CoreWorkspaceTextItemKind,
  input: CoreWorkspaceTextItemSave,
): LegacyTextItemSave | null {
  const legacy = call?.legacySave;
  if (
    !call ||
    !legacy ||
    legacy.kind !== kind ||
    legacy.workspaceId !== scope.workspaceId ||
    scope.worktreeId !== null ||
    (input.name !== null && input.name !== legacy.itemId)
  )
    return null;
  call.legacySave = undefined;
  return legacy;
}

export const desktopWorkspaceTextItemsHost: CoreWorkspaceTextItemsHost = {
  storeKey: textItemStoreDir,
  async list(scope, kind) {
    const listed = await legacyList(scope, kind);
    const call = textItemCalls.current();
    if (call) call.listed = listed;
    const entries = await Promise.all(
      listed.map((item) => storedFile(item).catch(() => null)),
    );
    // A file that cannot be read now is left out, as a code list skips one.
    return entries.filter(
      (entry): entry is CoreWorkspaceTextItemEntry => entry !== null,
    );
  },
  async read(scope, kind, name): Promise<CoreWorkspaceTextItemDocument | null> {
    const call = textItemCalls.current();
    const dir = textItemStoreDir(scope, kind);
    const file = join(dir, `${name}.md`);
    const guarded = isPathInside(dir, file);
    for (let attempt = 1; ; attempt += 1) {
      const before = guarded ? await fileVersion(file) : null;
      let response: WorkspaceNoteReadResponse;
      try {
        response = await legacyRead(scope, kind, name);
      } catch (error) {
        if (call && error instanceof Error) call.readError = error;
        if (isMissing(error)) return null;
        throw error;
      }
      if (call) call.read = response;
      let document: CoreWorkspaceTextItemDocument;
      try {
        document = {
          ...(await storedFile(response.meta)),
          content: response.content,
        };
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
      // The revision bytes must be the version the content came from, or an
      // update at that revision could overwrite an edit the caller never saw.
      // Checked after the store read, so the channels still get its result.
      if (before !== null && before === (await fileVersion(file)))
        return (await isStoredName(dir, name)) ? document : null;
      if (attempt === READ_ATTEMPTS)
        throw new Error(`The ${kind} changed while it was read.`);
    }
  },
  async save(scope, kind, input) {
    const call = textItemCalls.current();
    const legacy = claimLegacySave(call, scope, kind, input);
    const unclaimed = call?.legacySave;
    if (
      !legacy &&
      unclaimed?.standsIn &&
      unclaimed.kind === kind &&
      unclaimed.workspaceId === scope.workspaceId
    )
      throw new Error(`The ${kind} save did not match its request.`);
    const request: TextItemWrite = legacy
      ? {
          itemId: legacy.itemId,
          title: legacy.title,
          content: legacy.content,
          originWorktreeId: input.originWorktreeId,
        }
      : {
          itemId: input.name ?? undefined,
          title: input.title,
          content: input.content,
          originWorktreeId: input.originWorktreeId,
        };
    const saved = isWorkEntry(scope)
      ? await saveCoworkItem(scope, kind, request)
      : await saveCodeItem(scope, kind, request);
    if (call && legacy) call.saved = saved;
    return saved.id;
  },
  async delete(scope, kind, name) {
    const { workspaceId } = scope;
    if (isWorkEntry(scope)) {
      // Cowork deletes leave selections and publication alone, as they always have.
      const dir = textItemStoreDir(scope, kind);
      const target = join(dir, `${name}.md`);
      if (!isPathInside(dir, target)) throw new Error(`Invalid ${kind} id`);
      await rm(target, { force: true });
      return;
    }
    await (kind === 'note'
      ? deleteWorkspaceNote(workspaceId, name)
      : deleteWorkspacePrompt(workspaceId, name));
    await removeSharedContainerScopeItemId(workspaceId, kind, name);
    scheduleWorkspaceItemPublication(workspaceId);
  },
};

/** The note and prompt providers over the desktop stores. */
export function createDesktopWorkspaceTextItemProviders(
  host: CoreWorkspaceTextItemsHost = desktopWorkspaceTextItemsHost,
): CoreWorkspaceTextItemProviders {
  return createWorkspaceTextItemProviders(host);
}

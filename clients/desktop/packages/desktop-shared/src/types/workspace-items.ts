/**
 * Workspace items — Notes, Prompts, and Attachments exposed as shared
 * activity cards for both Code workspaces and Cowork workspaces.
 *
 * Storage differs per workspace type (the main-process IPC layer dispatches
 * on `getWorkspaceType`):
 * - Code workspaces (single-repo / multi-repo): notes and prompts are
 *   machine-local, workspace-global markdown files under
 *   `{dataDir}/workspaces/{workspaceId}/notes|prompts/` with a versioned
 *   `index.json` per directory carrying origin metadata; attachments reuse
 *   the existing per-worktree attachment directories unchanged.
 * - Cowork workspaces: notes/prompts/attachments keep their brand-managed
 *   subdirectories under the cowork working folder (`.{brand}/notes` etc.) —
 *   zero data migration, and the agent-facing folder layout described by the
 *   cowork system prompt stays valid.
 */
import type { ClipboardAttachmentData } from '../types';

/**
 * One indexed note/prompt. `id` doubles as the markdown filename stem
 * (slugified). Origin fields are set when the item was created from a
 * worktree-scoped composer: `originWorktreeId` is the stable key;
 * `originBranchName` is a snapshot refreshed lazily on list while the
 * worktree still exists (see `WorkspaceItemOrigin`).
 */
export interface WorkspaceItemIndexEntry {
  id: string;
  filename: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  originWorktreeId?: string;
  originBranchName?: string;
}

export interface WorkspaceNotesIndexFile {
  version: 1;
  items: Record<string, WorkspaceItemIndexEntry>;
}

export interface WorkspacePromptsIndexFile {
  version: 1;
  items: Record<string, WorkspaceItemIndexEntry>;
}

/**
 * Branch-origin projection returned to the renderer. While the origin
 * worktree still exists, `branchName` is resolved live from the worktree
 * record (so the canopy-generated → real branch rename shows through);
 * after the worktree is deleted the stored snapshot is returned with
 * `worktreeExists: false`.
 */
export interface WorkspaceItemOrigin {
  worktreeId: string;
  branchName: string;
  worktreeExists: boolean;
}

export interface WorkspaceNoteItem {
  id: string;
  title: string;
  absolutePath: string;
  createdAt: string;
  updatedAt: string;
  origin?: WorkspaceItemOrigin;
}

export interface WorkspacePromptItem {
  id: string;
  title: string;
  absolutePath: string;
  createdAt: string;
  updatedAt: string;
  origin?: WorkspaceItemOrigin;
}

export interface WorkspaceAttachmentItem {
  filename: string;
  absolutePath: string;
  sizeBytes: number;
  createdAt: string;
}

export interface WorkspaceNotesListRequest {
  projectId: string;
  /** Required for worktree-scoped read adapters such as shared containers. */
  worktreeId?: string;
}

export interface WorkspaceNoteReadRequest {
  projectId: string;
  worktreeId?: string;
  noteId: string;
}

export interface WorkspaceNoteReadResponse {
  meta: WorkspaceNoteItem;
  content: string;
}

export interface WorkspaceNoteSaveRequest {
  projectId: string;
  /** Existing note id when editing; omitted for a new note. */
  noteId?: string;
  title: string;
  content: string;
  /** Worktree the composing surface was scoped to, when any. */
  originWorktreeId?: string;
}

export interface WorkspaceNoteDeleteRequest {
  projectId: string;
  noteId: string;
}

export interface WorkspacePromptsListRequest {
  projectId: string;
  worktreeId?: string;
}

export interface WorkspacePromptReadRequest {
  projectId: string;
  worktreeId?: string;
  promptId: string;
}

export interface WorkspacePromptReadResponse {
  meta: WorkspacePromptItem;
  content: string;
}

/**
 * Prompt-body read for @-mention expansion at send time. The main process
 * validates that `absolutePath` resolves inside the named workspace's
 * prompts directory (the code workspace prompts dir, or the cowork managed
 * prompts dir) before reading — arbitrary paths are rejected.
 */
export interface WorkspacePromptReadByPathRequest {
  projectId: string;
  absolutePath: string;
}

export interface WorkspacePromptReadByPathResponse {
  content: string;
}

export interface WorkspacePromptSaveRequest {
  projectId: string;
  /** Existing prompt id when editing; omitted for a new prompt. */
  promptId?: string;
  title: string;
  content: string;
  /** Worktree the composing surface was scoped to, when any. */
  originWorktreeId?: string;
}

export interface WorkspacePromptDeleteRequest {
  projectId: string;
  promptId: string;
}

export interface WorkspaceAttachmentsListRequest {
  projectId: string;
  worktreeId: string;
}

export interface WorkspaceAttachmentsImportRequest {
  projectId: string;
  worktreeId: string;
  /** Empty and no clipboard items → the main process opens a file dialog. */
  filePaths: string[];
  clipboardItems?: ClipboardAttachmentData[];
}

export interface WorkspaceAttachmentsImportResponse {
  attachments: WorkspaceAttachmentItem[];
}

export interface WorkspaceAttachmentDeleteRequest {
  projectId: string;
  worktreeId: string;
  filename: string;
}

/** Renderer-facing API exposed on `window.api.workspaceItems`. */
export interface WorkspaceItemsApi {
  listNotes(request: WorkspaceNotesListRequest): Promise<WorkspaceNoteItem[]>;
  readNote(
    request: WorkspaceNoteReadRequest,
  ): Promise<WorkspaceNoteReadResponse>;
  saveNote(request: WorkspaceNoteSaveRequest): Promise<WorkspaceNoteItem>;
  deleteNote(request: WorkspaceNoteDeleteRequest): Promise<void>;
  listPrompts(
    request: WorkspacePromptsListRequest,
  ): Promise<WorkspacePromptItem[]>;
  readPrompt(
    request: WorkspacePromptReadRequest,
  ): Promise<WorkspacePromptReadResponse>;
  readPromptByPath(
    request: WorkspacePromptReadByPathRequest,
  ): Promise<WorkspacePromptReadByPathResponse>;
  savePrompt(request: WorkspacePromptSaveRequest): Promise<WorkspacePromptItem>;
  deletePrompt(request: WorkspacePromptDeleteRequest): Promise<void>;
  listAttachments(
    request: WorkspaceAttachmentsListRequest,
  ): Promise<WorkspaceAttachmentItem[]>;
  importAttachments(
    request: WorkspaceAttachmentsImportRequest,
  ): Promise<WorkspaceAttachmentsImportResponse>;
  deleteAttachment(request: WorkspaceAttachmentDeleteRequest): Promise<void>;
}

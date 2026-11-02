// ---------------------------------------------------------------------------
// Chat attachment helpers (renderer)
// ---------------------------------------------------------------------------
//
// Reusable logic for importing files/clipboard items as worktree attachments
// and staging them as pending attachments on a chat tab. Extracted verbatim
// from `ChatInput.tsx` so other surfaces (e.g. the in-app browser's
// "Pick & Polish" flow) can stage attachments without duplicating the import
// + index-refresh dance.

import {
  type AttachmentMeta,
  type ClipboardAttachmentData,
} from '@canopy/desktop-shared/types';
import { isCoworkChatTarget } from '@/lib/cowork';
import { useChatStore } from '@/stores/chatStore';
import { useFileListStore } from '@/stores/fileListStore';
import { useWorkspaceItemsStore } from '@/stores/workspaceItemsStore';

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/bmp': '.bmp',
  'application/pdf': '.pdf',
};

export const ATTACHMENT_IMPORT_ERROR_MESSAGE =
  "Couldn't attach that file. It may have moved or become unavailable — try selecting it again.";

function mimeExtension(mimeType: string): string {
  return MIME_EXTENSIONS[mimeType] ?? '.png';
}

export interface AttachmentImportTarget {
  projectId: string;
  worktreeId: string;
}

export interface ActiveChatAttachmentTarget extends AttachmentImportTarget {
  chatId: string;
}

/**
 * Resolve the currently-active *editable* chat tab as an attachment target, or
 * `null` when there is no selected worktree or the active tab cannot accept
 * attachments (a file tab or a read-only tab). Used by surfaces that stage
 * attachments outside the composer (the in-app browser's Pick & Polish,
 * screenshot, and recording flows).
 */
export function resolveActiveEditableChatTarget(): ActiveChatAttachmentTarget | null {
  const chat = useChatStore.getState();
  const selected = chat.selectedWorktree;
  if (!selected) {
    return null;
  }
  const key = `${selected.projectId}/${selected.worktreeId}`;
  const worktreeChat = chat.worktreeChats[key];
  const activeTab = worktreeChat?.tabs.find(
    (tab) => tab.id === worktreeChat.activeTabId,
  );
  if (!activeTab || activeTab.kind === 'file' || activeTab.readOnly) {
    return null;
  }
  return {
    projectId: selected.projectId,
    worktreeId: selected.worktreeId,
    chatId: activeTab.id,
  };
}

function mapStandaloneAttachment(result: {
  filename: string;
  absolutePath: string;
  sizeBytes?: number;
}): AttachmentMeta {
  return {
    filename: result.filename,
    absolutePath: result.absolutePath,
    sizeBytes: result.sizeBytes,
  };
}

export async function fileToClipboardAttachment(
  file: File,
  fallbackBasename: string,
): Promise<ClipboardAttachmentData> {
  const buffer = await file.arrayBuffer();
  const mimeType = file.type || 'application/octet-stream';
  const ext = mimeExtension(mimeType);
  const filename = file.name || `${fallbackBasename}${ext}`;
  return { filename, data: new Uint8Array(buffer) };
}

export async function createClipboardAttachments(
  files: File[],
  fallbackBasename: string,
): Promise<ClipboardAttachmentData[]> {
  if (files.length === 0) {
    return [];
  }

  return Promise.all(
    files.map((file) => fileToClipboardAttachment(file, fallbackBasename)),
  );
}

export async function importChatAttachments(
  target: AttachmentImportTarget,
  filePaths: string[],
  clipboardItems?: ClipboardAttachmentData[],
  isCurrent?: () => boolean,
): Promise<AttachmentMeta[]> {
  if (isCurrent?.() === false) return [];
  // Cowork chats key as (workspaceId, 'home'); route their attachments through
  // the workspace-items attachment IPC, which stores them under the
  // workspace's managed `.{brand}/attachments` dir. `target.projectId` is the
  // cowork workspace id (the backend resolves legacy ids via
  // resolveCoworkWorkspaceId).
  if (isCoworkChatTarget(target.projectId)) {
    const result = await window.api.workspaceItems.importAttachments({
      projectId: target.projectId,
      worktreeId: target.worktreeId,
      filePaths,
      clipboardItems,
    });
    if (isCurrent?.() === false) return [];
    await useWorkspaceItemsStore
      .getState()
      .loadAttachments(target.projectId, target.worktreeId, isCurrent);
    if (isCurrent?.() === false) return [];
    return result.attachments.map(mapStandaloneAttachment);
  }

  const result = await window.api.importWorktreeAttachments({
    projectId: target.projectId,
    worktreeId: target.worktreeId,
    filePaths,
    clipboardItems,
  });
  if (isCurrent?.() === false) return [];
  // The Attachments activity card is backed by its own workspace-items
  // snapshot, separate from the file index refreshed when the attachment is
  // staged on the composer. Keep that snapshot current for paste, browse,
  // drag/drop, and other chat attachment import flows.
  await useWorkspaceItemsStore
    .getState()
    .loadAttachments(target.projectId, target.worktreeId, isCurrent);
  if (isCurrent?.() === false) return [];
  return result.attachments;
}

export function addPendingAttachmentsAndRefreshIndex(
  target: AttachmentImportTarget,
  attachments: AttachmentMeta[],
  addOverride?: (attachments: AttachmentMeta[]) => void,
  pendingTarget?: { projectId: string; worktreeId: string; chatId: string },
): void {
  if (attachments.length === 0) {
    return;
  }

  if (addOverride) {
    addOverride(attachments);
  } else {
    useChatStore.getState().addPendingAttachments(attachments, pendingTarget);
  }
  const fileStore = useFileListStore.getState();
  fileStore.invalidate(target.projectId, target.worktreeId);
  void fileStore.fetchFileIndex(target.projectId, target.worktreeId);
}

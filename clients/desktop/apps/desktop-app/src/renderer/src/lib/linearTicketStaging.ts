// ---------------------------------------------------------------------------
// Linear ticket → chat attachment staging
// ---------------------------------------------------------------------------
//
// Stages a Linear ticket as a snapshot-markdown chat attachment, following
// the same import + mark shape as `stageBrowserMarkdownAttachment`
// (`lib/browserChatStaging.ts`). Unlike that helper, this one does not
// resolve the active chat tab or show a toast itself — the Home composer and
// ChatInput resolve their own target and pending-attachment sink (their
// stores differ), so both are supplied by the caller.

import type {
  AttachmentMeta,
  LinearTicketSearchResult,
} from '@canopy/desktop-shared/types';
import {
  importChatAttachments,
  type AttachmentImportTarget,
} from '@/lib/chatAttachments';
import {
  buildLinearTicketSnapshotMarkdown,
  linearSnapshotFilename,
  markLinearTicketAttachment,
} from '@/lib/linear';

/**
 * Build the snapshot markdown for a Linear ticket, import it as a worktree
 * (or cowork) attachment, mark it with the `linear-ticket` prompt kind, and
 * hand the resulting attachment metadata to the caller-supplied sink.
 */
export async function stageLinearTicketAttachment(
  target: AttachmentImportTarget,
  ticket: LinearTicketSearchResult,
  addPending: (attachments: AttachmentMeta[]) => void | Promise<void>,
): Promise<void> {
  const markdown = buildLinearTicketSnapshotMarkdown(ticket);
  const filename = linearSnapshotFilename(ticket);
  const imported = await importChatAttachments(
    target,
    [],
    [{ filename, data: new TextEncoder().encode(markdown) }],
  );
  const attachments = imported.map(markLinearTicketAttachment);
  await addPending(attachments);
}

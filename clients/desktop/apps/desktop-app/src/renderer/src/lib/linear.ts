import type {
  AttachmentMeta,
  LinearTicketSearchResult,
} from '@canopy/desktop-shared/types';

/**
 * Renders a Linear ticket as a standalone snapshot markdown document. Staged
 * as a chat attachment (see `markLinearTicketAttachment`) so the agent reads
 * the ticket's full context from disk rather than having it inlined into the
 * prompt text.
 */
export function buildLinearTicketSnapshotMarkdown(
  ticket: LinearTicketSearchResult,
): string {
  const description = ticket.description?.trim();
  return [
    `# ${ticket.identifier}: ${ticket.title}`,
    '',
    `- URL: ${ticket.url}`,
    `- Priority: ${ticket.priorityLabel}`,
    `- Suggested branch: ${ticket.branchName}`,
    '',
    '## Description',
    '',
    description && description.length > 0
      ? description
      : '_No description provided._',
  ].join('\n');
}

/**
 * Builds the snapshot markdown filename for a Linear ticket, sanitizing the
 * ticket identifier down to `[a-z0-9-]` so it is always a safe filename
 * (e.g. `CAN-202` -> `linear-can-202.md`).
 */
export function linearSnapshotFilename(
  ticket: LinearTicketSearchResult,
): string {
  const sanitizedIdentifier = ticket.identifier
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return `linear-${sanitizedIdentifier}.md`;
}

/**
 * Marks a staged attachment as a Linear ticket snapshot so downstream prompt
 * assembly (`buildSubmittedMessageText`) instructs the agent to read it as
 * the task's source context.
 */
export function markLinearTicketAttachment(
  attachment: AttachmentMeta,
): AttachmentMeta {
  return {
    ...attachment,
    promptKind: 'linear-ticket',
  };
}

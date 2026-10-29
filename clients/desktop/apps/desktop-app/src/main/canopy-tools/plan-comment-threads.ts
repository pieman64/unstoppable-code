import type {
  PlanComment,
  PlanCommentAnchor,
  PlanCommentThread,
} from '@canopy/desktop-shared/types';
import type { PlanCommentThreadOwner } from '../lib/plan-persistence';
import { hasTrackedPlanStorage } from '../lib/tracked-plan-scope';

/**
 * Whether a resolved file-comment scope can own tracked plans, and therefore
 * whether the file-comment tools should search its plan comment threads.
 * Assistant/app-managed sentinels and Cowork workspaces have no tracked plans;
 * the Code Review sentinel is resolved to the reviewed scope before asking.
 */
export function hasTrackedPlanCommentStorage(projectId: string): boolean {
  return hasTrackedPlanStorage(projectId);
}

const QUOTE_SNIPPET_MAX = 120;

function snippet(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

function diagramKindLabel(
  diagramKind: PlanCommentAnchor['diagramKind'],
): string {
  switch (diagramKind) {
    case 'sequence':
      return 'sequence diagram';
    case 'logicDiff':
      return 'logic diagram';
    case 'dataModelDiff':
      return 'data model diagram';
    default:
      return 'diagram';
  }
}

/**
 * What the thread is attached to. Diagram-node threads are checked first: a
 * node comment without a plan quote is stored `unanchored` but is still a
 * node comment, not a general note.
 */
function formatPlanCommentSource(anchor: PlanCommentAnchor): string {
  if (anchor.source === 'diagram') {
    const nodeText = snippet(
      anchor.renderedText ?? anchor.quote,
      QUOTE_SNIPPET_MAX,
    );
    return `${diagramKindLabel(anchor.diagramKind)} node "${nodeText}"`;
  }
  if (anchor.unanchored === true) {
    return 'general note (not anchored)';
  }
  return 'document passage';
}

function formatPlanCommentLines(anchor: PlanCommentAnchor): string | null {
  if (anchor.lineStart === undefined) {
    return null;
  }
  if (anchor.lineEnd !== undefined && anchor.lineEnd !== anchor.lineStart) {
    return `lines ${anchor.lineStart}-${anchor.lineEnd}`;
  }
  return `line ${anchor.lineStart}`;
}

/** Heading path, line range, and plan node id, in that order when present. */
function planAnchorLocationParts(anchor: PlanCommentAnchor): string[] {
  const parts: string[] = [];
  if (anchor.headingPath && anchor.headingPath.length > 0) {
    parts.push(anchor.headingPath.join(' > '));
  }
  const lines = formatPlanCommentLines(anchor);
  if (lines) {
    parts.push(lines);
  }
  if (anchor.planNodeId) {
    parts.push(`node ${anchor.planNodeId}`);
  }
  return parts;
}

function formatPlanAnchorValidity(
  thread: PlanCommentThread,
  latestRevisionNumber: number,
): string {
  return thread.anchorState === 'outdated'
    ? `outdated; the quoted text is no longer in revision ${latestRevisionNumber}`
    : `matches revision ${latestRevisionNumber}`;
}

/** A fence longer than any backtick run in the quote, so it cannot close early. */
function markdownFence(text: string): string {
  let longestRun = 0;
  for (const run of text.match(/`+/g) ?? []) {
    longestRun = Math.max(longestRun, run.length);
  }
  return '`'.repeat(Math.max(3, longestRun + 1));
}

function formatPlanCommentAuthor(comment: PlanComment): string {
  if (comment.author === 'remote') {
    return `remote: ${comment.remoteAuthor?.displayName ?? 'unknown teammate'}`;
  }
  return comment.author;
}

/**
 * One history line. Staged local drafts are redacted: the owner has not
 * submitted them to the agent, matching the file and review thread readers.
 */
function formatPlanCommentHistoryLine(comment: PlanComment): string {
  const staged = comment.staged === true;
  const body = staged ? '[redacted draft]' : comment.body;
  return `- [${formatPlanCommentAuthor(comment)}] ${comment.createdAt}${staged ? ' (staged draft)' : ''}: ${body}`;
}

export interface FormatPlanCommentThreadInput {
  readonly owner: PlanCommentThreadOwner;
  readonly thread: PlanCommentThread;
  /**
   * The plan's editable working file, or null when none is available. A read
   * may create or refresh an unedited working copy, but never creates a
   * revision or overwrites pending edits.
   */
  readonly planFile: string | null;
}

/**
 * Agent-facing view of one tracked-plan comment thread for `GetFileComments`:
 * the owning plan and its latest revision, the editable plan file (when one is
 * current), what the thread is attached to and whether that anchor still
 * matches the latest revision, the raw markdown quote, and the full comment
 * history with teammate attribution and staged drafts redacted.
 */
export function formatPlanCommentThread(
  input: FormatPlanCommentThreadInput,
): string {
  const { owner, thread, planFile } = input;
  const { anchor } = thread;
  const location = planAnchorLocationParts(anchor);
  const lines = [
    `Plan "${owner.title}" (plan ${owner.planId}, latest revision ${owner.latestRevisionNumber})`,
    planFile
      ? `Plan file: ${planFile}`
      : 'Plan file: none available for editing',
    `Thread ${thread.id} [${thread.status}] (anchor ${thread.anchorState})`,
    `Source: ${formatPlanCommentSource(anchor)}`,
    `Anchor: ${location.length > 0 ? location.join('; ') : 'none'}`,
    `Anchor validity: ${formatPlanAnchorValidity(thread, owner.latestRevisionNumber)}`,
  ];
  if (anchor.quote.length > 0) {
    const fence = markdownFence(anchor.quote);
    lines.push('Quote:', `${fence}markdown`, anchor.quote, fence);
  } else {
    lines.push('Quote: none');
  }
  lines.push('', 'Comments:');
  if (thread.comments.length === 0) {
    lines.push('(no comments yet)');
  } else {
    lines.push(...thread.comments.map(formatPlanCommentHistoryLine));
  }
  return lines.join('\n');
}

/** One `GetFileComments` open-thread summary line for a plan comment thread. */
export function formatPlanCommentSummaryLine(
  owner: PlanCommentThreadOwner,
  thread: PlanCommentThread,
): string {
  const location = planAnchorLocationParts(thread.anchor);
  const locationText = location.length > 0 ? ` (${location.join(', ')})` : '';
  return `- ${thread.id} [${thread.status}] ${thread.comments.length} comment(s): Plan "${owner.title}" (${owner.planId}) ${formatPlanCommentSource(thread.anchor)}${locationText} [anchor ${thread.anchorState}]`;
}

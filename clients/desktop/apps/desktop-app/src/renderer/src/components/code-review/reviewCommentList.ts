import type { ReviewCommentThread } from '@canopy/desktop-shared/types';
import { diagramLocationLabel, formatCodeLocation } from './useReviewComments';

/**
 * Splits + describes review comment threads for the bottom comments tray,
 * mirroring the plan modal's tray (`PlanDocumentPanel.tsx`'s `activeThreads` /
 * `archivedThreads` split and `renderThread`'s `reference` computation).
 */

export interface ReviewThreadPartition {
  active: ReviewCommentThread[];
  archived: ReviewCommentThread[];
}

/**
 * Split threads into the bottom tray's two groups, mirroring the plan tray:
 * Active = open and still anchored; Archived = resolved OR anchor outdated.
 */
export function partitionReviewThreads(
  threads: ReviewCommentThread[],
): ReviewThreadPartition {
  const active: ReviewCommentThread[] = [];
  const archived: ReviewCommentThread[] = [];
  for (const thread of threads) {
    if (thread.status === 'resolved' || thread.anchorState === 'outdated') {
      archived.push(thread);
    } else {
      active.push(thread);
    }
  }
  return { active, archived };
}

export interface ThreadReferenceDescriptor {
  text: string;
  outdated: boolean;
  isDiagram: boolean;
  /** A general note not attached to any code line or diagram node. */
  isGeneral: boolean;
}

/** The tray card's reference line: a code location or a diagram-node label. */
export function describeThreadReference(
  thread: ReviewCommentThread,
): ThreadReferenceDescriptor {
  const isGeneral = thread.anchor.unanchored === true;
  const isDiagram = !isGeneral && thread.anchor.source === 'diagram';
  return {
    text: isGeneral
      ? 'General note'
      : isDiagram
        ? diagramLocationLabel(thread.anchor)
        : formatCodeLocation(thread.anchor),
    outdated: thread.anchorState === 'outdated',
    isDiagram,
    isGeneral,
  };
}

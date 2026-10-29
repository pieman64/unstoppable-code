/**
 * Plan diagram artifacts and plan comment threads.
 *
 * The generated diagram artifact contracts (parsed plan graph, logic diff,
 * artifact envelope, and their type guards) are the canonical wire shapes and
 * now live in `@canopy/protocol/plans` so the web service can type and
 * validate them without importing desktop-shared. They are re-exported here to
 * preserve the existing `@canopy/desktop-shared/types/plan-diagrams` import
 * paths used across the desktop main process and renderer.
 *
 * Plan comment-thread wire shapes (anchor, status, author identity, and the
 * `WirePlanComment` / `WirePlanCommentThread` DTOs) now also live in
 * `@canopy/protocol/plans` so they round-trip desktop ⇄ web (CAN-393); they are
 * re-exported here. The desktop renderer keeps a local superset of a comment —
 * `PlanComment` adds a renderer-only `staged` draft flag — defined in this
 * module.
 */

import type {
  PlanCommentAuthorKind,
  PlanCommentRemoteAuthor,
  PlanCommentAnchor,
  PlanCommentThreadStatus,
  PlanCommentAnchorState,
} from '@canopy/protocol/plans';

export type {
  PlanAnchor,
  PlanGraphNodeKind,
  PlanGraphNode,
  PlanGraphEdgeKind,
  PlanGraphEdge,
  ParsedPlanGraph,
  LogicNode,
  LogicEdge,
  LogicFlow,
  LogicChangeType,
  LogicChange,
  LogicDiffDiagram,
  DataModelFieldKind,
  DataModelField,
  DataModelEntity,
  DataModelCardinality,
  DataModelRelationship,
  DataModelGraph,
  DataModelChangeTarget,
  DataModelChangeType,
  DataModelEntityChange,
  DataModelFieldChange,
  DataModelRelationshipChange,
  DataModelChange,
  DataModelDiffDiagram,
  DataModelDiffGenerationResult,
  PlanDiagramStatus,
  PlanDiagramArtifact,
  PlanDiagramArtifacts,
  PlanCommentAuthorKind,
  PlanCommentRemoteAuthor,
  PlanCommentAnchor,
  PlanCommentThreadStatus,
  PlanCommentAnchorState,
  WirePlanComment,
  WirePlanCommentThread,
} from '@canopy/protocol/plans';

export {
  PLAN_DIAGRAM_SCHEMA_VERSION,
  isPlanDiagramArtifacts,
  isParsedPlanGraph,
  isLogicDiffDiagram,
  isDataModelDiffDiagram,
  isDataModelDiffGenerationResult,
} from '@canopy/protocol/plans';

// --- Comment threads --------------------------------------------------------
//
// The anchor, status, author-kind, and wire DTOs are re-exported from
// `@canopy/protocol/plans` (see the import block above). The desktop renderer
// keeps the local superset below: `PlanComment` adds the renderer-only
// `staged` draft flag, and a `'user'`/`'agent'`/`'remote'` author plus optional
// `remoteAuthor` identity matching the wire shape.

/**
 * @deprecated Use `PlanCommentAuthorKind` from `@canopy/protocol/plans`. Kept
 * as an alias so existing imports keep compiling.
 */
export type PlanCommentAuthor = PlanCommentAuthorKind;

export interface PlanComment {
  id: string;
  author: PlanCommentAuthorKind;
  /** Present when `author === 'remote'`: the teammate's server identity. */
  remoteAuthor?: PlanCommentRemoteAuthor;
  body: string;
  createdAt: string;
  /** User draft not yet submitted to the chat agent. Renderer-only. */
  staged?: boolean;
  /**
   * Renderer-only (CAN-393): set once a `'remote'` (teammate) comment has been
   * handed to the chat agent, so it is counted/submitted exactly once — the
   * remote-author analogue of clearing `staged` on the owner's own drafts.
   * Never sent on the wire.
   */
  submittedToChat?: boolean;
}

export interface PlanCommentThread {
  id: string;
  status: PlanCommentThreadStatus;
  createdAt: string;
  anchor: PlanCommentAnchor;
  anchorState: PlanCommentAnchorState;
  comments: PlanComment[];
}

// --- Shallow type guard (persistence tolerance) -----------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPlanCommentThreadArray(
  value: unknown,
): value is PlanCommentThread[] {
  if (!Array.isArray(value)) return false;
  return value.every((thread) => {
    if (!isRecord(thread)) return false;
    if (!isRecord(thread.anchor)) return false;
    return (
      typeof thread.id === 'string' &&
      (thread.status === 'open' || thread.status === 'resolved') &&
      typeof thread.createdAt === 'string' &&
      typeof thread.anchor.quote === 'string' &&
      (thread.anchorState === 'matched' || thread.anchorState === 'outdated') &&
      Array.isArray(thread.comments)
    );
  });
}

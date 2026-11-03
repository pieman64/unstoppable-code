import type { W5Resource } from '@canopy/desktop-shared/node/w5-commit-log';
import {
  classifyW5FileProvenance,
  classifyW5RevisionEligibility,
  type W5FileProvenance,
  type W5ProjectionCompleteness,
  type W5RevisionEligibility,
} from '@canopy/core-runtime/node/w5/commit-log/eligibility';
import type {
  W5CaptureFile,
  W5CaptureResult,
  W5FileImage,
} from '../w5-commit-log/commit-log-worker-contract';
import type {
  W5ReadViewOutcome,
  W5ReadViewUncapturedReason,
} from '../lib/w5-read-view';

/*
 * Internal provenance of one core workspace read (CAN-5318): which W5
 * position served it, each captured file's evidence, and per W5 resource
 * whether its projection is complete and its revision eligible. Path-free
 * and kept off the protocol; only eligible revisions become public
 * (CAN-5319, `publishableRevisions`).
 */

/** Why a projection is not the whole W5 resource or collection it reads. */
export type CoreWorkspaceReadFilter =
  | 'workspace-scope'
  | 'worktree-scope'
  | 'organization'
  /** RR1: rows this process removed are left out without a write. */
  | 'recently-removed'
  /** Entries or rows the file format could not read were left out. */
  | 'unreadable-entries'
  /** Indexed workspaces the sidebar could not project were left out. */
  | 'unprojected'
  /** Projected from a default after an unreadable read. */
  | 'fallback'
  | 'possibly-stale'
  | 'page';

/** Projected fields derived from the source, account or host (decision B1). */
export type CoreWorkspaceExternalField = 'repositorySources';

export interface CoreWorkspaceResourceProvenance {
  readonly resource: W5Resource;
  readonly completeness: W5ProjectionCompleteness;
  readonly filters: readonly CoreWorkspaceReadFilter[];
  /** Outside the guarantee a revision of `resource` would make. */
  readonly external: readonly CoreWorkspaceExternalField[];
  readonly eligibility: W5RevisionEligibility;
}

export interface CoreWorkspaceReadProvenance {
  readonly position:
    | {
        readonly status: 'captured';
        /** Allocation high-water mark: an internal position, not a cache key. */
        readonly commitId: number;
        readonly discovery: W5CaptureResult['discovery'];
      }
    | {
        readonly status: 'uncaptured';
        readonly reason: W5ReadViewUncapturedReason;
      };
  readonly files: readonly {
    readonly file: W5CaptureFile;
    readonly provenance: W5FileProvenance;
  }[];
  /** The whole result, including aggregations no W5 resource represents. */
  readonly result: {
    readonly completeness: W5ProjectionCompleteness;
    readonly filters: readonly CoreWorkspaceReadFilter[];
  };
  readonly resources: readonly CoreWorkspaceResourceProvenance[];
}

export interface CoreWorkspaceResourceProjection {
  resource: W5Resource;
  filters?: readonly (CoreWorkspaceReadFilter | false | undefined)[];
  external?: readonly CoreWorkspaceExternalField[];
}

function presentFilters(
  filters: readonly (CoreWorkspaceReadFilter | false | undefined)[] = [],
): CoreWorkspaceReadFilter[] {
  return Array.from(
    new Set(
      filters.filter(
        (filter): filter is CoreWorkspaceReadFilter =>
          typeof filter === 'string',
      ),
    ),
  );
}

/** The image's file alone, without its bytes. */
function imageFile(image: W5FileImage): W5CaptureFile {
  const file: W5CaptureFile = image;
  return 'workspaceId' in file
    ? { kind: file.kind, workspaceId: file.workspaceId }
    : { kind: file.kind };
}

/**
 * Whether a first page leaves out part of `total` items. Paging a pinned
 * snapshot filters nothing from its collection, so only the result says so.
 */
export function isPartialPage(total: number, pageSize: number): boolean {
  return total > pageSize;
}

/** Follows `w5ResourceKey` without importing the commit log at runtime. */
export function coreWorkspaceResourceKey(resource: W5Resource): string {
  switch (resource.kind) {
    case 'workspaces':
      return 'workspaces';
    case 'workspace':
      return `workspace:${resource.workspaceId}`;
    case 'worktrees':
      return `worktrees:${resource.workspaceId}`;
    case 'worktree':
      return `worktree:${resource.workspaceId}/${resource.worktreeId}`;
  }
}

/**
 * The revisions a read may publish, by resource key: only eligible ones
 * (decision A1). External fields never withhold one (decision B1).
 */
export function publishableRevisions(
  provenance: CoreWorkspaceReadProvenance | undefined,
): ReadonlyMap<string, number> {
  const revisions = new Map<string, number>();
  for (const { resource, eligibility } of provenance?.resources ?? [])
    if (eligibility.status === 'eligible')
      revisions.set(coreWorkspaceResourceKey(resource), eligibility.revision);
  return revisions;
}

export function projectReadProvenance(
  view: W5ReadViewOutcome,
  resultFilters: readonly (CoreWorkspaceReadFilter | false | undefined)[],
  resources: readonly CoreWorkspaceResourceProjection[],
): CoreWorkspaceReadProvenance {
  const filters = presentFilters([
    ...resultFilters,
    view.status === 'uncaptured' &&
      view.reason === 'daemon-unavailable' &&
      'possibly-stale',
  ]);
  const result: CoreWorkspaceReadProvenance['result'] = {
    completeness: filters.length ? 'partial' : 'complete',
    filters,
  };
  const uncaptured: W5RevisionEligibility = {
    status: 'unverified',
    reason: 'not-captured',
  };
  const projected = resources.map(
    (projection): CoreWorkspaceResourceProvenance => {
      const resourceFilters = presentFilters(projection.filters);
      const completeness: W5ProjectionCompleteness = resourceFilters.length
        ? 'partial'
        : 'complete';
      return {
        resource: projection.resource,
        completeness,
        filters: resourceFilters,
        external: projection.external ?? [],
        eligibility:
          view.status === 'captured'
            ? classifyW5RevisionEligibility(
                view.capture,
                projection.resource,
                completeness,
              )
            : uncaptured,
      };
    },
  );
  if (view.status === 'uncaptured')
    return {
      position: { status: 'uncaptured', reason: view.reason },
      files: [],
      result,
      resources: projected,
    };
  return {
    position: {
      status: 'captured',
      commitId: view.capture.log.commitId,
      discovery: view.capture.discovery,
    },
    files: [...view.capture.files.map(imageFile), ...view.uncapturedReads].map(
      (file) => ({
        file,
        provenance: classifyW5FileProvenance(view.capture, file),
      }),
    ),
    result,
    resources: projected,
  };
}

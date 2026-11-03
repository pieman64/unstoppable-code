import type { CanopyJsonValue } from '@canopy/protocol/canopy-core';
import { PROJECT_COLORS } from '@canopy/protocol/project-colors';
import {
  isProjectStartPage,
  type ProjectStartPage,
} from '@canopy/protocol/start-page';
import type { WorkspaceIndexReadEntry } from '../../workspace/read-formats';
import {
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from '../boundary-operation';
import type { W5CommitOptions } from '../commit-scope';
import { createW5CompositionLocks } from '../composition-operation';
import type { W5OutcomeParser } from '../composition-outcome';
import { createW5SingleDecisionOperation } from '../single-decision-operation';
import { w5UnreadableMessage } from '../file-store';
import type {
  WorkspaceIndexRepository,
  WorkspaceIndexSnapshot,
} from '../workspace-index-repository';
import { WorkspaceConfigUnreadableError } from '../workspace-manifest-repository';
import type {
  W5SidebarSortMode,
  W5WorkspaceCommandHost,
  W5WorkspaceCommandStorage,
  W5WorkspaceManifestChange,
  W5WorkspaceManifestEditor,
} from './ports';

/** The caller of a metadata update, recorded in workspace CRUD telemetry. */
export type WorkspaceMetadataSource =
  | 'desktop_canopy_client'
  | 'desktop_set_start_page'
  | 'portal'
  | 'projects_save';

/**
 * A start page change. `set` stores a local override (`null` explicitly
 * disables the project's start page); `inherit` removes the local override so
 * the project falls back to its source configuration.
 */
export type WorkspaceStartPageChange =
  | { kind: 'set'; startPage: ProjectStartPage | null }
  | { kind: 'inherit' };

/**
 * The typed fields of `core.workspace.update` (CAN-3799). Each present field
 * replaces one persisted field; an absent field is unchanged.
 */
export interface WorkspaceMetadataPatch<Section extends string = string> {
  name?: string;
  /** One of the project palette colors. */
  color?: string;
  /** Pin within the top-level Projects section; persisted only when true. */
  pinned?: boolean;
  /** Sidebar group collapse; a view preference, recorded without telemetry. */
  collapsed?: boolean;
  /** Ordering mode for this workspace's child rows. */
  itemSortMode?: W5SidebarSortMode;
  /** Empty clears the order. Never persisted for Cowork workspaces. */
  activitySectionOrder?: readonly Section[];
  alwaysShow?: boolean;
  /** Refused for Cowork workspaces, whose start page is a Cowork setting. */
  startPage?: WorkspaceStartPageChange;
}

/**
 * A validated patch. An unrecognized start page kind changes no field but
 * still counts as a manifest edit; it keeps nothing of the caller's object, so
 * a keyed retry's fingerprint ignores it.
 */
export interface CanonicalWorkspaceMetadataPatch<
  Section extends string = string,
> extends Omit<WorkspaceMetadataPatch<Section>, 'startPage'> {
  startPage?: WorkspaceStartPageChange | { kind: 'unrecognized' };
}

/**
 * Where each typed field persists (CAN-3799 field ownership): the index entry
 * or the workspace manifest. An update writes only the files its fields live
 * in, so it never rewrites another workspace or a worktree list (F12).
 */
const INDEX_FIELDS = [
  'name',
  'color',
  'pinned',
  'collapsed',
  'activitySectionOrder',
] as const satisfies ReadonlyArray<keyof WorkspaceMetadataPatch>;
const MANIFEST_FIELDS = [
  'itemSortMode',
  'alwaysShow',
  'startPage',
] as const satisfies ReadonlyArray<keyof WorkspaceMetadataPatch>;

export interface WorkspaceMetadataUpdateRequest<
  Section extends string = string,
> extends W5BoundaryOptions {
  workspaceId: string;
  patch: WorkspaceMetadataPatch<Section>;
  source: WorkspaceMetadataSource;
  /** Revision of this workspace (index entry plus manifest). */
  expectedRevision?: number;
}

export interface WorkspaceMetadataUpdateOutcome {
  workspaceId: string;
  /** Whether the workspace's index entry was rewritten. */
  indexWritten: boolean;
  /** Whether the workspace's `workspace.json` was rewritten. */
  manifestWritten: boolean;
  /**
   * Version 2 only: the workspace as the decision left it, from a host's
   * `decidedWorkspace`; a decoded receipt carries it as stored. Version 1
   * outcomes have none.
   */
  workspace?: unknown;
}

export interface WorkspaceMoveRequest {
  /**
   * The workspaces the caller shows, in any order. Only their slots move;
   * every other entry, including ones added since the caller read, keeps its
   * place.
   */
  visibleWorkspaceIds: readonly string[];
  activeWorkspaceId: string;
  overWorkspaceId: string;
}

/** The compatibility save replaces only the slots of the named workspaces. */
export type WorkspaceReorderRequest = W5BoundaryOptions &
  (
    | WorkspaceMoveRequest
    | {
        source: 'projects_save';
        workspaceOrder: readonly string[];
      }
  );

export interface WorkspaceReorderOutcome {
  /** The readable workspace ids in their new order. */
  workspaceIds: string[];
}

export type WorkspaceMetadataRefusal =
  | 'invalid-patch'
  | 'not-found'
  | 'unsupported-for-cowork'
  | 'index-unavailable'
  | 'configuration-unavailable';

/** The update or reorder was refused before anything was written. */
export class WorkspaceMetadataRefusedError extends Error {
  constructor(
    readonly reason: WorkspaceMetadataRefusal,
    message: string,
  ) {
    super(message);
    this.name = 'WorkspaceMetadataRefusedError';
  }
}

/** The fixed receipt caller sources. */
export type WorkspaceMetadataCommandSource =
  | 'workspace-metadata'
  | 'workspace-reorder';

/** A staged update, for the host's post-commit effects. */
export interface StagedWorkspaceMetadataUpdate<Section extends string> {
  workspaceId: string;
  source: WorkspaceMetadataSource;
  patch: CanonicalWorkspaceMetadataPatch<Section>;
}

export interface WorkspaceMetadataCommandHost<
  Section extends string,
> extends W5WorkspaceCommandHost<WorkspaceMetadataCommandSource> {
  index: () => WorkspaceIndexRepository<WorkspaceIndexReadEntry<Section>>;
  manifest: W5WorkspaceManifestEditor;
  storage: W5WorkspaceCommandStorage;
  isActivitySectionId: (value: string) => value is Section;
  /** Orders a writing update among the host's other workspace mutations. */
  serializeUpdate: <T>(work: () => Promise<T>) => Promise<T>;
  updateOutcome: W5OutcomeParser<WorkspaceMetadataUpdateOutcome>;
  reorderOutcome: W5OutcomeParser<WorkspaceReorderOutcome>;
  /** Inside the decision's scope, after a writing update staged its files. */
  afterUpdateStaged: (
    update: StagedWorkspaceMetadataUpdate<Section>,
  ) => Promise<void>;
  /** After an update's decision, outside its scope. */
  afterUpdate: (outcome: WorkspaceMetadataUpdateOutcome) => Promise<void>;
  /** Inside the decision's scope, after a drag move staged the index. */
  afterMoveStaged: () => Promise<void>;
  /**
   * Inside the decision's scope, after staging and before the outcome is
   * saved: the workspace as this decision leaves it, saved as the outcome's
   * `workspace` (version 2), so a replay answers what the first response
   * did. A refusal it throws comes before the decision. Absent, outcomes
   * keep version 1.
   */
  decidedWorkspace?: (workspaceId: string) => Promise<CanopyJsonValue>;
}

export interface WorkspaceMetadataCommands<Section extends string> {
  update(
    request: WorkspaceMetadataUpdateRequest<Section>,
  ): Promise<WorkspaceMetadataUpdateOutcome>;
  reorder(request: WorkspaceReorderRequest): Promise<WorkspaceReorderOutcome>;
}

const INDEX_UNAVAILABLE_MESSAGE =
  "Couldn't update this project because the project list couldn't be read. Try again.";
const REORDER_INDEX_UNAVAILABLE_MESSAGE =
  "Couldn't reorder projects because the project list couldn't be read. Try again.";

/** An unreadable index's refusal, naming its capture class when known. */
function indexUnavailable(
  snapshot: WorkspaceIndexSnapshot,
  fallback = INDEX_UNAVAILABLE_MESSAGE,
): WorkspaceMetadataRefusedError {
  return new WorkspaceMetadataRefusedError(
    'index-unavailable',
    w5UnreadableMessage(fallback, snapshot.unserved),
  );
}

function invalid(message: string): WorkspaceMetadataRefusedError {
  return new WorkspaceMetadataRefusedError('invalid-patch', message);
}

function notFound(workspaceId: string): WorkspaceMetadataRefusedError {
  return new WorkspaceMetadataRefusedError(
    'not-found',
    `Project ${workspaceId} not found.`,
  );
}

function configurationUnavailable(
  message = new WorkspaceConfigUnreadableError().message,
): WorkspaceMetadataRefusedError {
  return new WorkspaceMetadataRefusedError(
    'configuration-unavailable',
    message,
  );
}

function canonicalStartPage(
  change: WorkspaceStartPageChange | undefined,
): CanonicalWorkspaceMetadataPatch['startPage'] {
  if (change === undefined) return undefined;
  if (change.kind === 'inherit') return { kind: 'inherit' };
  if (change.kind !== 'set') return { kind: 'unrecognized' };
  if (change.startPage !== null && !isProjectStartPage(change.startPage)) {
    throw invalid('Invalid start page');
  }
  return { kind: 'set', startPage: change.startPage };
}

/** The manifest fields a patch replaces; `inherit` removes the start page. */
function manifestChange(
  patch: CanonicalWorkspaceMetadataPatch,
): W5WorkspaceManifestChange {
  const change: W5WorkspaceManifestChange = {};
  if (patch.itemSortMode !== undefined)
    change.itemSortMode = patch.itemSortMode;
  if (patch.alwaysShow !== undefined) change.alwaysShow = patch.alwaysShow;
  const startPage = patch.startPage;
  if (startPage?.kind === 'set') change.startPage = startPage.startPage;
  if (startPage?.kind === 'inherit') change.startPage = undefined;
  return change;
}

/**
 * `core.workspace.update` and `core.workspace.reorder` (CAN-3807) over the
 * host's index repository and manifest editor.
 *
 * An update writes only the persisted fields the patch names: the index entry
 * keeps its unknown fields and every other entry stays as it is; the manifest
 * is edited in its write queue from a fresh read. Admission (validation, the
 * workspace's index entry, Cowork restrictions, an existing manifest) runs
 * before anything is written, and a manifest field is written before an index
 * field, so an unreadable manifest also leaves the index untouched. A move is
 * applied to the latest index inside its write queue: only the visible slots
 * change, and every entry is renumbered to its position. The files, an
 * optional revision and a keyed change's receipt and outcome commit as one
 * decision (CAN-4393).
 */
export function createWorkspaceMetadataCommands<Section extends string>(
  host: WorkspaceMetadataCommandHost<Section>,
): WorkspaceMetadataCommands<Section> {
  type Entry = WorkspaceIndexReadEntry<Section>;
  type Patch = CanonicalWorkspaceMetadataPatch<Section>;

  const run = createW5SingleDecisionOperation<WorkspaceMetadataCommandSource>(
    host.decision,
    (error) => error instanceof WorkspaceMetadataRefusedError,
  );
  const locks = createW5CompositionLocks(host.paths);

  function isActivitySectionOrder(value: unknown): value is Section[] {
    return (
      Array.isArray(value) &&
      value.every(
        (id: unknown) => typeof id === 'string' && host.isActivitySectionId(id),
      ) &&
      new Set(value).size === value.length
    );
  }

  /**
   * Validates a caller-supplied patch (IPC and Portal payloads are untyped at
   * runtime) and returns its canonical form: only the typed fields, with the
   * name trimmed. A keyed retry is fingerprinted on this form.
   */
  function validatePatch(patch: WorkspaceMetadataPatch<Section>): Patch {
    const name = patch.name?.trim();
    if (name !== undefined && name.length === 0) {
      throw invalid('Project name cannot be empty.');
    }
    const { color, pinned, collapsed, itemSortMode, alwaysShow } = patch;
    if (color !== undefined && !PROJECT_COLORS.some((c) => c === color)) {
      throw invalid('Invalid project color.');
    }
    if (pinned !== undefined && typeof pinned !== 'boolean') {
      throw invalid('Invalid pinned state.');
    }
    if (collapsed !== undefined && typeof collapsed !== 'boolean') {
      throw invalid('Invalid collapsed state.');
    }
    if (
      itemSortMode !== undefined &&
      itemSortMode !== 'last-updated' &&
      itemSortMode !== 'manual'
    ) {
      throw invalid('Invalid sidebar sort mode.');
    }
    const order: unknown = patch.activitySectionOrder;
    if (order !== undefined && !isActivitySectionOrder(order)) {
      throw invalid('Invalid activity section order.');
    }
    if (alwaysShow !== undefined && typeof alwaysShow !== 'boolean') {
      throw invalid('Invalid Always show setting.');
    }
    const startPage = canonicalStartPage(patch.startPage);
    return {
      name,
      color,
      pinned,
      collapsed,
      itemSortMode,
      activitySectionOrder: patch.activitySectionOrder,
      alwaysShow,
      startPage,
    };
  }

  function applyIndexFields(entry: Entry, patch: Patch): Entry {
    const next: Entry = { ...entry };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.color !== undefined) next.color = patch.color;
    if (patch.collapsed !== undefined) next.collapsed = patch.collapsed;
    if (patch.pinned === true) next.pinned = true;
    // An unpinned workspace carries no `pinned` key, as every desktop write.
    if (patch.pinned === false) delete next.pinned;
    if (patch.activitySectionOrder !== undefined && entry.type !== 'cowork') {
      next.activitySectionOrder =
        patch.activitySectionOrder.length > 0
          ? [...patch.activitySectionOrder]
          : undefined;
    }
    return next;
  }

  /** Admits and writes one validated update. */
  async function writeWorkspaceMetadata(
    request: {
      workspaceId: string;
      source: WorkspaceMetadataSource;
      patch: Patch;
      expectedRevision: number | undefined;
    },
    options: W5CommitOptions,
    /** Records the outcome in the decision; called inside the commit scope. */
    save: (
      outcome: WorkspaceMetadataUpdateOutcome,
    ) => WorkspaceMetadataUpdateOutcome,
  ): Promise<WorkspaceMetadataUpdateOutcome> {
    const { workspaceId, source, patch, expectedRevision } = request;
    const resource = { kind: 'workspace', workspaceId } as const;
    const decided = async (
      outcome: WorkspaceMetadataUpdateOutcome,
    ): Promise<WorkspaceMetadataUpdateOutcome> =>
      save(
        host.decidedWorkspace
          ? { ...outcome, workspace: await host.decidedWorkspace(workspaceId) }
          : outcome,
      );
    const commitOptions: W5CommitOptions = {
      ...options,
      locks: locks({ index: true, manifests: [workspaceId] }),
      expectedRevisions: w5ExpectedRevision(resource, expectedRevision),
    };
    const writesIndex = INDEX_FIELDS.some(
      (field) => patch[field] !== undefined,
    );
    const writesManifest = MANIFEST_FIELDS.some(
      (field) => patch[field] !== undefined,
    );
    if (!writesIndex && !writesManifest) {
      return host.withCommit(commitOptions, async () => {
        await host.checkExpectedRevision(resource, expectedRevision);
        return decided({
          workspaceId,
          indexWritten: false,
          manifestWritten: false,
        });
      });
    }

    // Both namespaces before the manifest write, so a refused index leaves the
    // manifest unchanged.
    const storage = [
      ...(writesIndex ? [host.storage.index] : []),
      ...(writesManifest ? [host.storage.manifest] : []),
    ];
    async function stageWorkspaceMetadata(): Promise<WorkspaceMetadataUpdateOutcome> {
      // A keyed attempt refuses a stale revision before its decision, so the
      // key is released for a retry.
      await host.checkExpectedRevision(resource, expectedRevision);
      const indexRepository = host.index();
      const snapshot = await indexRepository.read();
      if (snapshot.authority === 'unreadable') throw indexUnavailable(snapshot);
      const entry = snapshot.entries.find(
        (candidate) => candidate.id === workspaceId,
      );
      if (!entry) throw notFound(workspaceId);
      if (patch.startPage !== undefined && entry.type === 'cowork') {
        throw new WorkspaceMetadataRefusedError(
          'unsupported-for-cowork',
          'Cowork start pages are managed through cowork settings',
        );
      }

      if (writesManifest) {
        // A missing manifest would be read as the default configuration, of
        // another workspace type; never create one from a metadata edit.
        if ((await host.manifest.readAuthority(workspaceId)) === 'absent')
          throw configurationUnavailable();
        const edit = await host.manifest.edit(workspaceId, (_view, read) => {
          if (read.authority === 'absent') throw configurationUnavailable();
          return { result: undefined, change: manifestChange(patch) };
        });
        if (edit.status === 'unreadable')
          throw configurationUnavailable(edit.message);
      }

      if (writesIndex) {
        await indexRepository.update((latest) => {
          // Unreadable since the read above: no entries prove no deletion.
          if (latest.authority === 'unreadable') throw indexUnavailable(latest);
          const current = latest.entries;
          const target = current.find(
            (candidate) => candidate.id === workspaceId,
          );
          // Deleted since the read above.
          if (!target) throw notFound(workspaceId);
          return {
            result: undefined,
            entries: current.map((candidate) =>
              candidate === target
                ? applyIndexFields(target, patch)
                : candidate,
            ),
          };
        });
      }

      await host.afterUpdateStaged({ workspaceId, source, patch });
      return decided({
        workspaceId,
        indexWritten: writesIndex,
        manifestWritten: writesManifest,
      });
    }
    return host.decision.admitStorage(storage, () =>
      host.serializeUpdate(() =>
        host.withCommit(commitOptions, stageWorkspaceMetadata),
      ),
    );
  }

  async function update(
    request: WorkspaceMetadataUpdateRequest<Section>,
  ): Promise<WorkspaceMetadataUpdateOutcome> {
    const { workspaceId, source, expectedRevision, idempotencyKey } = request;
    host.validateId(workspaceId, 'workspaceId');
    const patch = validatePatch(request.patch);
    return run(
      {
        operation: 'core.workspace.update',
        // Fixed: `request.source` is fingerprinted and drives telemetry only.
        source: 'workspace-metadata',
        idempotencyKey,
        parameters: () => ({ workspaceId, source, patch }),
      },
      () => Promise.resolve(patch),
      (outcome) => host.updateOutcome.parse(outcome),
      async (admitted, options, save) => {
        const outcome = await writeWorkspaceMetadata(
          { workspaceId, source, patch: admitted, expectedRevision },
          options,
          save,
        );
        await host.afterUpdate(outcome);
        return outcome;
      },
    );
  }

  /** The compatibility save: the named workspaces take each other's slots. */
  function reorderNamedSlots(
    workspaceOrder: readonly string[],
  ): Promise<WorkspaceReorderOutcome> {
    for (const id of workspaceOrder) host.validateId(id, 'workspace id');
    return host.index().update((snapshot) => {
      if (snapshot.authority === 'unreadable') throw indexUnavailable(snapshot);
      const { entries } = snapshot;
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const ordered = Array.from(new Set(workspaceOrder)).flatMap((id) => {
        const entry = byId.get(id);
        return entry ? [entry] : [];
      });
      const selected = new Set(ordered.map((entry) => entry.id));
      let position = 0;
      const next = entries.map((entry, order) => ({
        ...(selected.has(entry.id) ? (ordered[position++] ?? entry) : entry),
        order,
      }));
      const result = { workspaceIds: next.map((entry) => entry.id) };
      return next.every((entry, index) => entry.id === entries[index]?.id)
        ? { result }
        : { result, entries: next };
    });
  }

  /** A drag move of one visible workspace onto another's slot. */
  async function moveVisibleSlot(
    request: WorkspaceMoveRequest,
  ): Promise<WorkspaceReorderOutcome> {
    const { activeWorkspaceId, overWorkspaceId } = request;
    host.validateId(activeWorkspaceId, 'activeWorkspaceId');
    host.validateId(overWorkspaceId, 'overWorkspaceId');
    const visibleIdSet = new Set(request.visibleWorkspaceIds);
    const outcome = await host
      .index()
      .update<WorkspaceReorderOutcome | 'not-found'>((snapshot) => {
        if (snapshot.authority === 'unreadable')
          throw indexUnavailable(snapshot, REORDER_INDEX_UNAVAILABLE_MESSAGE);
        const { entries } = snapshot;
        const visible = entries.filter((entry) => visibleIdSet.has(entry.id));
        const fromIndex = visible.findIndex(
          (entry) => entry.id === activeWorkspaceId,
        );
        const toIndex = visible.findIndex(
          (entry) => entry.id === overWorkspaceId,
        );
        const moved = visible[fromIndex];
        if (fromIndex < 0 || toIndex < 0 || !moved)
          return { result: 'not-found' };

        const reorderedVisible = visible.slice();
        reorderedVisible.splice(fromIndex, 1);
        reorderedVisible.splice(toIndex, 0, moved);
        let visibleIndex = 0;
        const next = entries.map((entry, order) => {
          const replacement = visibleIdSet.has(entry.id)
            ? reorderedVisible[visibleIndex++]
            : entry;
          return { ...(replacement ?? entry), order };
        });
        return {
          result: { workspaceIds: next.map((entry) => entry.id) },
          entries: next,
        };
      });
    if (outcome === 'not-found') {
      throw new WorkspaceMetadataRefusedError(
        'not-found',
        'Project to reorder was not found.',
      );
    }
    await host.afterMoveStaged();
    return outcome;
  }

  async function reorder(
    request: WorkspaceReorderRequest,
  ): Promise<WorkspaceReorderOutcome> {
    const { expectedRevision, idempotencyKey, ...parameters } = request;
    const resource = { kind: 'workspaces' } as const;
    return run(
      {
        operation: 'core.workspace.reorder',
        source: 'workspace-reorder',
        idempotencyKey,
        parameters: () => parameters,
      },
      () => Promise.resolve(),
      (outcome) => host.reorderOutcome.parse(outcome),
      (_admitted, options, save) =>
        host.withCommit(
          {
            ...options,
            locks: locks({ index: true }),
            expectedRevisions: w5ExpectedRevision(resource, expectedRevision),
          },
          async () => {
            await host.checkExpectedRevision(resource, expectedRevision);
            return save(
              'workspaceOrder' in request
                ? await reorderNamedSlots(request.workspaceOrder)
                : await moveVisibleSlot(request),
            );
          },
        ),
    );
  }

  return { update, reorder };
}

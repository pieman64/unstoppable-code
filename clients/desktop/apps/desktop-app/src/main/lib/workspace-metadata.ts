import { z } from 'zod';
import {
  checkW5ExpectedRevision,
  w5ExpectedRevision,
  type W5BoundaryOptions,
} from './w5-boundary-operation';
import { withW5Commit } from './w5-commit-log-file-store';
import { getWorkspaceIndexFilePath, getWorkspaceConfigPath } from './paths';
import type { W5RepositoryLock } from './w5-repository-locks';
import { afterW5Commit, type W5CommitOptions } from './w5-commit-scope';
import { createW5SingleDecisionOperation } from './w5-single-decision-operation';
import { isActivitySectionId } from '@canopy/desktop-shared/constants/activity';
import { PROJECT_COLORS } from '@canopy/desktop-shared/constants/project-colors';
import type {
  ActivitySectionId,
  SidebarSortMode,
  WorkspaceConfigFile,
  WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';
import {
  isProjectStartPage,
  type ProjectStartPage,
} from '@canopy/protocol/start-page';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import { recordWorkspaceCrudTelemetry } from './desktop-telemetry';
import { getWorkspaceIndexRepository } from './sidebar-items';
import { validateId } from './validation';
import {
  WORKSPACE_INDEX_STORAGE,
  WORKSPACE_MANIFEST_STORAGE,
  withStorageAdmission,
} from './w5-storage';
import {
  readWorkspaceConfigDetailed,
  updateWorkspaceConfig,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';

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
export interface WorkspaceMetadataPatch {
  name?: string;
  /** One of the project palette colors. */
  color?: string;
  /** Pin within the top-level Projects section; persisted only when true. */
  pinned?: boolean;
  /** Sidebar group collapse; a view preference, recorded without telemetry. */
  collapsed?: boolean;
  /** Ordering mode for this workspace's child rows. */
  itemSortMode?: SidebarSortMode;
  /** Empty clears the order. Never persisted for Cowork workspaces. */
  activitySectionOrder?: readonly ActivitySectionId[];
  alwaysShow?: boolean;
  /** Refused for Cowork workspaces, whose start page is a Cowork setting. */
  startPage?: WorkspaceStartPageChange;
}

/**
 * A validated patch. An unrecognized start page kind changes no field but
 * still counts as a manifest edit; it keeps nothing of the caller's object, so
 * a keyed retry's fingerprint ignores it.
 */
interface CanonicalWorkspaceMetadataPatch extends Omit<
  WorkspaceMetadataPatch,
  'startPage'
> {
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

export interface WorkspaceMetadataUpdateRequest extends W5BoundaryOptions {
  workspaceId: string;
  patch: WorkspaceMetadataPatch;
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
}

/** The saved outcome a keyed retry replays; it carries no host path. */
const workspaceMetadataUpdateOutcomeSchema = z.object({
  workspaceId: z.string(),
  indexWritten: z.boolean(),
  manifestWritten: z.boolean(),
});

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

/** The fixed receipt caller sources (`desktop-host:<source>`). */
type WorkspaceMetadataCommandSource =
  | 'workspace-metadata'
  | 'workspace-reorder';

const runWorkspaceMetadataCommand =
  createW5SingleDecisionOperation<WorkspaceMetadataCommandSource>(
    (error) => error instanceof WorkspaceMetadataRefusedError,
  );

const INDEX_UNAVAILABLE_MESSAGE =
  "Couldn't update this project because the project list couldn't be read. Try again.";

function invalid(message: string): WorkspaceMetadataRefusedError {
  return new WorkspaceMetadataRefusedError('invalid-patch', message);
}

function notFound(workspaceId: string): WorkspaceMetadataRefusedError {
  return new WorkspaceMetadataRefusedError(
    'not-found',
    `Project ${workspaceId} not found.`,
  );
}

function configurationUnavailable(): WorkspaceMetadataRefusedError {
  return new WorkspaceMetadataRefusedError(
    'configuration-unavailable',
    new WorkspaceConfigUnreadableError().message,
  );
}

function isPresent<K extends keyof CanonicalWorkspaceMetadataPatch>(
  patch: CanonicalWorkspaceMetadataPatch,
  field: K,
): boolean {
  return patch[field] !== undefined;
}

function isActivitySectionOrder(value: unknown): value is ActivitySectionId[] {
  return (
    Array.isArray(value) &&
    value.every(
      (id: unknown) => typeof id === 'string' && isActivitySectionId(id),
    ) &&
    new Set(value).size === value.length
  );
}

/**
 * Validates a caller-supplied patch (IPC and Portal payloads are untyped at
 * runtime) and returns its canonical form: only the typed fields, with the
 * name trimmed. A keyed retry is fingerprinted on this form. Messages are the
 * ones the desktop and Portal have always shown.
 */
function validatePatch(
  patch: WorkspaceMetadataPatch,
): CanonicalWorkspaceMetadataPatch {
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

function applyIndexFields(
  entry: WorkspaceIndexEntry,
  patch: CanonicalWorkspaceMetadataPatch,
): WorkspaceIndexEntry {
  const next: WorkspaceIndexEntry = { ...entry };
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

function applyManifestFields(
  config: WorkspaceConfigFile,
  patch: CanonicalWorkspaceMetadataPatch,
): void {
  if (patch.itemSortMode !== undefined) {
    config.itemSortMode = patch.itemSortMode;
  }
  if (patch.alwaysShow !== undefined) config.alwaysShow = patch.alwaysShow;
  const startPage = patch.startPage;
  if (startPage?.kind === 'set') config.startPage = startPage.startPage;
  if (startPage?.kind === 'inherit') delete config.startPage;
}

/**
 * The typed in-process workspace metadata boundary (CAN-3807): every rename,
 * recolor, pin, collapse, sort mode, activity section order, Always show and
 * start page change of one workspace, from the renderer
 * (`workspace:update-metadata`, `workspace:set-start-page`) and the browser
 * Remote Control portal (`portal.workspace.update`).
 *
 * It writes only the persisted fields the patch names, through the index and
 * manifest repositories: the index entry keeps its unknown fields and every
 * other entry, readable or not, stays as it is; the manifest is updated in
 * its write queue from a fresh read. Admission (validation, the workspace's
 * index entry, Cowork restrictions, an existing manifest) runs before
 * anything is written, and a manifest field is written before an index field,
 * so an unreadable manifest also leaves the index untouched. Both files, an
 * optional workspace revision and a keyed update's receipt and outcome commit
 * as one decision, before publication; a same-key retry replays the outcome
 * without effects (CAN-3805, CAN-4393). `core.workspace.update` stays
 * unregistered.
 *
 * Every write it commits stales the desktop session snapshot, with or
 * without a portal session: an index write through the index repository's
 * commit hook, a manifest write here, through the same structural sync.
 */
export async function updateWorkspaceMetadata(
  request: WorkspaceMetadataUpdateRequest,
): Promise<WorkspaceMetadataUpdateOutcome> {
  const { workspaceId, source, expectedRevision, idempotencyKey } = request;
  validateId(workspaceId, 'workspaceId');
  const patch = validatePatch(request.patch);
  return runWorkspaceMetadataCommand(
    {
      operation: 'core.workspace.update',
      // Fixed: `request.source` is fingerprinted and drives telemetry only.
      source: 'workspace-metadata',
      idempotencyKey,
      parameters: () => ({ workspaceId, source, patch }),
    },
    () => Promise.resolve(patch),
    (outcome) => workspaceMetadataUpdateOutcomeSchema.parse(outcome),
    async (admitted, options, save) => {
      const outcome = await writeWorkspaceMetadata(
        { workspaceId, source, patch: admitted, expectedRevision },
        options,
        save,
      );
      // The manifest repository has no commit hook. Without this, a sort mode,
      // Always show or start page change reaches the renderer only after an
      // unrelated write stales the snapshot.
      if (outcome.manifestWritten)
        await afterW5Commit(schedulePortalStructuralSync);
      return outcome;
    },
  );
}

/** Admits and writes one validated update inside the workspace mutation queue. */
async function writeWorkspaceMetadata(
  request: Omit<WorkspaceMetadataUpdateRequest, 'patch' | 'idempotencyKey'> & {
    patch: CanonicalWorkspaceMetadataPatch;
  },
  options: W5CommitOptions,
  /** Records the outcome in the decision; called inside the commit scope. */
  save: (
    outcome: WorkspaceMetadataUpdateOutcome,
  ) => WorkspaceMetadataUpdateOutcome,
): Promise<WorkspaceMetadataUpdateOutcome> {
  const { workspaceId, source, patch, expectedRevision } = request;
  const resource = { kind: 'workspace', workspaceId } as const;
  const locks: W5RepositoryLock[] = [
    { kind: 'index', path: getWorkspaceIndexFilePath() },
    { kind: 'manifest', path: getWorkspaceConfigPath(workspaceId) },
  ];
  const commitOptions: W5CommitOptions = {
    ...options,
    locks,
    expectedRevisions: w5ExpectedRevision(resource, expectedRevision),
  };
  const writesIndex = INDEX_FIELDS.some((field) => isPresent(patch, field));
  const writesManifest = MANIFEST_FIELDS.some((field) =>
    isPresent(patch, field),
  );
  if (!writesIndex && !writesManifest) {
    return withW5Commit(commitOptions, async () => {
      await checkW5ExpectedRevision(resource, expectedRevision);
      return save({ workspaceId, indexWritten: false, manifestWritten: false });
    });
  }

  // Both namespaces before the manifest write, so a refused index leaves the
  // manifest unchanged.
  const storage = [
    ...(writesIndex ? [WORKSPACE_INDEX_STORAGE] : []),
    ...(writesManifest ? [WORKSPACE_MANIFEST_STORAGE] : []),
  ];
  async function stageWorkspaceMetadata(): Promise<WorkspaceMetadataUpdateOutcome> {
    // A keyed attempt refuses a stale revision before its decision, so the
    // key is released for a retry.
    await checkW5ExpectedRevision(resource, expectedRevision);
    const indexRepository = getWorkspaceIndexRepository();
    const { entries, authority } = await indexRepository.read();
    if (authority === 'unreadable') {
      throw new WorkspaceMetadataRefusedError(
        'index-unavailable',
        INDEX_UNAVAILABLE_MESSAGE,
      );
    }
    const entry = entries.find((candidate) => candidate.id === workspaceId);
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
      const { authority: manifestAuthority } =
        await readWorkspaceConfigDetailed(workspaceId);
      if (manifestAuthority === 'absent') throw configurationUnavailable();
      try {
        await updateWorkspaceConfig(workspaceId, (config, read): void => {
          if (read.authority === 'absent') throw configurationUnavailable();
          applyManifestFields(config, patch);
        });
      } catch (error) {
        if (error instanceof WorkspaceConfigUnreadableError) {
          throw configurationUnavailable();
        }
        throw error;
      }
    }

    if (writesIndex) {
      await indexRepository.update(({ entries: current }) => {
        const target = current.find(
          (candidate) => candidate.id === workspaceId,
        );
        // Deleted since the read above; the repository refuses an index that
        // became unreadable.
        if (!target) throw notFound(workspaceId);
        return {
          result: undefined,
          entries: current.map((candidate) =>
            candidate === target ? applyIndexFields(target, patch) : candidate,
          ),
        };
      });
    }

    await afterW5Commit(notifyPortalStructureChanged);
    // Collapse, pin and the other view preferences are not edits of the
    // workspace's identity, so only a rename or recolor records telemetry.
    if (
      source !== 'projects_save' &&
      (patch.name !== undefined || patch.color !== undefined)
    ) {
      await afterW5Commit(() =>
        recordWorkspaceCrudTelemetry({
          action: 'update',
          workspaceId,
          source,
        }),
      );
    }
    return save({
      workspaceId,
      indexWritten: writesIndex,
      manifestWritten: writesManifest,
    });
  }
  return withStorageAdmission(storage, () =>
    serializeWorkspaceMutation(() =>
      withW5Commit(commitOptions, stageWorkspaceMetadata),
    ),
  );
}

/**
 * The typed in-process workspace ordering boundary (CAN-3807): a drag move of
 * one visible workspace onto another's slot, from the renderer
 * (`workspace:reorder`) and the portal (`portal.workspace.reorder`). Each
 * caller decides which workspaces it shows.
 *
 * The move is applied to the latest index inside its write queue: only the
 * visible slots change, non-visible and newly added entries keep theirs, an
 * entry this version cannot read stays in the file, and no manifest or
 * worktree list is rewritten. Every entry is renumbered to its position, as
 * every desktop index write does. The index, an optional revision and a keyed
 * move's receipt and outcome commit as one decision (CAN-4393).
 */
export async function reorderWorkspaces(
  request: WorkspaceReorderRequest,
): Promise<WorkspaceReorderOutcome> {
  const { expectedRevision, idempotencyKey, ...parameters } = request;
  return runWorkspaceMetadataCommand(
    {
      operation: 'core.workspace.reorder',
      source: 'workspace-reorder',
      idempotencyKey,
      parameters: () => parameters,
    },
    () => Promise.resolve(),
    (outcome) => z.object({ workspaceIds: z.array(z.string()) }).parse(outcome),
    (_admitted, options, save) => {
      async function stageWorkspaceReorder(): Promise<WorkspaceReorderOutcome> {
        await checkW5ExpectedRevision({ kind: 'workspaces' }, expectedRevision);
        if ('workspaceOrder' in request) {
          request.workspaceOrder.forEach((id) =>
            validateId(id, 'workspace id'),
          );
          const saved = await getWorkspaceIndexRepository().update(
            ({ entries, authority }) => {
              if (authority === 'unreadable') {
                throw new WorkspaceMetadataRefusedError(
                  'index-unavailable',
                  INDEX_UNAVAILABLE_MESSAGE,
                );
              }
              const byId = new Map(entries.map((entry) => [entry.id, entry]));
              const ordered = Array.from(
                new Set(request.workspaceOrder),
              ).flatMap((id) => {
                const entry = byId.get(id);
                return entry ? [entry] : [];
              });
              const selected = new Set(ordered.map((entry) => entry.id));
              let position = 0;
              const next = entries.map((entry, order) => ({
                ...(selected.has(entry.id)
                  ? (ordered[position++] ?? entry)
                  : entry),
                order,
              }));
              const result = { workspaceIds: next.map((entry) => entry.id) };
              return next.every(
                (entry, index) => entry.id === entries[index]?.id,
              )
                ? { result }
                : { result, entries: next };
            },
          );
          return save(saved);
        }
        const { activeWorkspaceId, overWorkspaceId } = request;
        validateId(activeWorkspaceId, 'activeWorkspaceId');
        validateId(overWorkspaceId, 'overWorkspaceId');
        const visibleIdSet = new Set(request.visibleWorkspaceIds);
        const outcome = await getWorkspaceIndexRepository().update<
          WorkspaceReorderOutcome | WorkspaceMetadataRefusal
        >(({ entries, authority }) => {
          if (authority === 'unreadable')
            return { result: 'index-unavailable' };
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
        if (outcome === 'index-unavailable') {
          throw new WorkspaceMetadataRefusedError(
            'index-unavailable',
            "Couldn't reorder projects because the project list couldn't be read. Try again.",
          );
        }
        if (typeof outcome === 'string') {
          throw new WorkspaceMetadataRefusedError(
            'not-found',
            'Project to reorder was not found.',
          );
        }
        await afterW5Commit(notifyPortalStructureChanged);
        return save(outcome);
      }
      return withW5Commit(
        {
          ...options,
          locks: [{ kind: 'index', path: getWorkspaceIndexFilePath() }],
          expectedRevisions: w5ExpectedRevision(
            { kind: 'workspaces' },
            expectedRevision,
          ),
        },
        stageWorkspaceReorder,
      );
    },
  );
}

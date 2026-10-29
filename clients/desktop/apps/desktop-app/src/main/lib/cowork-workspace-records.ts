import {
  commitWorkspaceCreation,
  markWorkspaceCreationEffectsStarted,
  withLocalWorkspaceCreation,
  pendingWorkspaceCreationIds,
  workspaceCreationPathOccupied,
} from './w5-workspace-creation-commit';
import { afterW5Commit } from './w5-commit-scope';
import { rm } from 'node:fs/promises';
import {
  CHAT_UNIT_LABEL_PLURAL,
  validateWorkspaceTemplateStarterPrompts,
} from '@canopy/protocol';
import { isProjectStartPage } from '@canopy/protocol/start-page';
import { PROJECT_COLORS } from '@canopy/desktop-shared/constants/project-colors';
import type {
  CoworkSidebarItem,
  CoworkWorkspaceSettings,
  WorkspaceConfigFile,
  WorkspaceOwnerBinding,
  UpdateChatProjectRequest,
  ChatTabPluginSelections,
} from '@canopy/desktop-shared/types';
import { serializeWorkspaceMutation } from './chat-project-operation-queue';
import { ensureCoworkHomeScaffold } from './chat-project-utils';
import { getWorkspaceDir } from './paths';
import {
  getWorkspaceIndexRepository,
  readAllSidebarItems,
} from './sidebar-items';
import { slugify, uniqueId } from './string-utils';
import { IdentifierValidationError, validateId } from './validation';
import { PROJECT_W5_STORAGE, withStorageAdmission } from './w5-storage';
import {
  updateWorkspaceConfig,
  readWorkspaceConfigDetailed,
  getWorkspaceManifestRepository,
  WorkspaceConfigUnreadableError,
} from './workspace-persistence';
import { notifyPortalStructureChanged } from '../portal/portal-event-bus';
import { schedulePortalStructuralSync } from '../portal/portal-structural-sync';
import {
  MAX_ARCHIVE_RETENTION_DAYS,
  resolveAutoArchiveDays,
} from '@canopy/desktop-shared/lib/archive-retention';
import { touchAllWorkspaceTargets } from './workspace-activity';
import {
  WorkspaceIndexUnreadableError,
  type WorkspaceIndexAuthority,
  type WorkspaceIndexSnapshot,
  type WorkspaceIndexChange,
} from './workspace-index-repository';
import {
  applyCoworkIndexDecision,
  applyCoworkManifestDecision,
  applyCoworkProvisionDecision,
} from './cowork-record-decision-port';
import {
  admitCoworkIndex,
  COWORK_FIELDS,
  coworkConfigFor as configFor,
  coworkEntryFor as entryFor,
  CoworkWorkspaceRecordRefusedError,
  projectedCoworkItem as projected,
  sameCoworkOwner as sameOwner,
  withUnknownCoworkFields,
  type CoworkWorkspaceRecordRefusal,
} from './worktree-record-decision-apply';

export {
  CoworkWorkspaceRecordRefusedError,
  type CoworkWorkspaceRecordRefusal,
} from './worktree-record-decision-apply';

export const DEFAULT_COWORK_WORKSPACE_NAME = CHAT_UNIT_LABEL_PLURAL;
const DEFAULT_CREATED_AT = '2025-01-01T00:00:00.000Z';

function refuse(reason: CoworkWorkspaceRecordRefusal, message: string): never {
  throw new CoworkWorkspaceRecordRefusedError(reason, message);
}
function admitId(id: string): void {
  try {
    validateId(id, 'projectId');
  } catch (error) {
    if (error instanceof IdentifierValidationError)
      refuse('invalid-request', error.message);
    throw error;
  }
}
function authoritative(snapshot: WorkspaceIndexSnapshot): void {
  admitCoworkIndex(snapshot.authority);
}
function inIndex<T>(
  change: (
    snapshot: WorkspaceIndexSnapshot,
  ) => Promise<WorkspaceIndexChange<T>>,
  manifestRefusal?: { reason: CoworkWorkspaceRecordRefusal; message: string },
): Promise<T> {
  return indexWork(
    () => getWorkspaceIndexRepository().update(change),
    manifestRefusal,
  );
}
/** Runs an index update admitted, in the workspace mutation queue, with its refusals typed. */
async function indexWork<T>(
  work: () => Promise<T>,
  manifestRefusal?: { reason: CoworkWorkspaceRecordRefusal; message: string },
): Promise<T> {
  try {
    return await withStorageAdmission(PROJECT_W5_STORAGE, () =>
      serializeWorkspaceMutation(work),
    );
  } catch (error) {
    if (error instanceof WorkspaceIndexUnreadableError)
      refuse('index-unavailable', error.message);
    if (error instanceof WorkspaceConfigUnreadableError)
      refuse(
        manifestRefusal?.reason ?? 'configuration-unavailable',
        manifestRefusal?.message ?? error.message,
      );
    throw error;
  }
}
function color(count: number): string {
  return PROJECT_COLORS[count % PROJECT_COLORS.length];
}
async function afterCommit(): Promise<void> {
  await afterW5Commit(async (): Promise<void> => {
    await readAllSidebarItems();
    schedulePortalStructuralSync();
    notifyPortalStructureChanged();
  });
}

async function preserveCoworkFields(
  workspaceId: string,
  config: WorkspaceConfigFile,
): Promise<CoworkWorkspaceSettings> {
  const raw = await getWorkspaceManifestRepository().read(workspaceId);
  return withUnknownCoworkFields(
    raw.authority === 'ok' ? raw.document.cowork : undefined,
    config,
  );
}

export type CoworkMetadataChange =
  | { kind: 'settings'; request: UpdateChatProjectRequest }
  | {
      kind: 'import';
      color?: string;
      cowork?: CoworkWorkspaceSettings;
      defaultPluginSelections?: ChatTabPluginSelections;
    }
  | { kind: 'install'; externalId: string; contentHash: string }
  | { kind: 'blueprint'; externalId: string };
export interface CoworkMetadataRecord {
  source:
    | 'chat_project_update'
    | 'bundle_import'
    | 'template_install'
    | 'blueprint_create';
  workspaceId: string;
  change: CoworkMetadataChange;
}

export type CoworkTemplateShareChange =
  | { kind: 'publication'; publicationKey: string }
  | {
      kind: 'share';
      metadata: { externalId: string; pinnedContentHash: string } | null;
    };
/**
 * `internal.workspace.templateShare.record` (A26(a)): the local share
 * identity the host records around its share network effects. Revoke and get
 * only clear it; get's clear observes a remote share that is gone.
 */
export type CoworkTemplateShareRecord = { workspaceId: string } & (
  | { source: 'template_share_publish'; change: CoworkTemplateShareChange }
  | {
      source: 'template_share_revoke' | 'template_share_get';
      change: { kind: 'share'; metadata: null };
    }
);
export type CoworkTemplateShareRecordSource =
  CoworkTemplateShareRecord['source'];

function admitSettings(req: UpdateChatProjectRequest): void {
  if (req.starterPrompts !== undefined) {
    const parsed = validateWorkspaceTemplateStarterPrompts(req.starterPrompts);
    if (!parsed.ok) refuse('invalid-request', parsed.error);
  }
  if (
    req.startPage !== undefined &&
    req.startPage !== null &&
    !isProjectStartPage(req.startPage)
  ) {
    refuse('invalid-request', 'Invalid start page');
  }
  if (
    req.archiveRetentionDays !== undefined &&
    req.archiveRetentionDays !== null &&
    (!Number.isInteger(req.archiveRetentionDays) ||
      req.archiveRetentionDays < 0 ||
      req.archiveRetentionDays > MAX_ARCHIVE_RETENTION_DAYS)
  ) {
    refuse(
      'invalid-request',
      `Archive retention must be null or an integer from 0 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
    );
  }
  if (
    req.autoArchiveDays !== undefined &&
    req.autoArchiveDays !== null &&
    (!Number.isInteger(req.autoArchiveDays) ||
      req.autoArchiveDays < 1 ||
      req.autoArchiveDays > MAX_ARCHIVE_RETENTION_DAYS)
  ) {
    refuse(
      'invalid-request',
      `Auto Delete inactivity must be null or an integer from 1 to ${MAX_ARCHIVE_RETENTION_DAYS}`,
    );
  }

  const trimmedName = req.name?.trim();
  if (req.name !== undefined && !trimmedName) {
    refuse('invalid-request', 'Project name is required');
  }
}

/**
 * The fields of a standalone `core.workspace.cowork.update` (A28′(a)): only
 * Cowork settings, with plugin defaults derived from the selected preset.
 */
export type CoworkSettingsPatch = Pick<
  UpdateChatProjectRequest,
  | 'description'
  | 'defaultModel'
  | 'defaultPresetId'
  | 'presets'
  | 'archiveRetentionDays'
  | 'autoArchiveDays'
  | 'starterPrompts'
  | 'startPage'
>;
// Owned by other operations: presentation, Always show, explicit plugin defaults.
const NON_SETTINGS_FIELDS = [
  'name',
  'color',
  'alwaysShow',
  'defaultPluginSelections',
] as const satisfies ReadonlyArray<keyof UpdateChatProjectRequest>;

/**
 * Admits a settings-only change before any receipt lookup or reservation and
 * returns its settings, without fields an untyped payload may carry.
 */
export function admitCoworkSettingsChange(
  req: UpdateChatProjectRequest,
): CoworkSettingsPatch {
  admitId(req.projectId);
  if (NON_SETTINGS_FIELDS.some((field) => req[field] !== undefined))
    refuse(
      'invalid-request',
      'Name, color, Always show and default plugins are updated separately from project settings',
    );
  admitSettings(req);
  return {
    description: req.description,
    defaultModel: req.defaultModel,
    defaultPresetId: req.defaultPresetId,
    presets: req.presets,
    archiveRetentionDays: req.archiveRetentionDays,
    autoArchiveDays: req.autoArchiveDays,
    starterPrompts: req.starterPrompts,
    startPage: req.startPage,
  };
}

/** The Auto Delete baseline: every Work Entry's recency, stamped before staging. */
async function stampAutoDeleteBaseline(workspaceId: string): Promise<void> {
  try {
    await touchAllWorkspaceTargets(workspaceId);
  } catch (error) {
    // No decision follows a failed stamp, so a keyed retry is safe.
    refuse(
      'activity-unavailable',
      error instanceof Error ? error.message : String(error),
    );
  }
}

/** Applies only this call's Cowork fields to the manifest read in its queue. */
export async function recordCoworkWorkspaceMetadata(
  record: CoworkMetadataRecord,
): Promise<void> {
  admitId(record.workspaceId);
  if (record.change.kind === 'settings') admitSettings(record.change.request);
  await inIndex(async (snapshot): Promise<WorkspaceIndexChange<void>> => {
    authoritative(snapshot);
    const entry = snapshot.entries.find(
      (candidate) =>
        candidate.id === record.workspaceId && candidate.type === 'cowork',
    );
    if (!entry) refuse('not-found', 'Chat project not found');
    const change = record.change;
    const presentation: { name?: string; color?: string } =
      change.kind === 'settings'
        ? change.request
        : change.kind === 'import'
          ? change
          : {};
    await updateWorkspaceConfig(
      record.workspaceId,
      async (config, read): Promise<void> => {
        if (read.authority === 'absent' || config.type !== 'cowork')
          refuse('not-found', 'Chat project not found');
        // Keep unknown nested Cowork fields as well as the fields normalized by this version.
        const settings = await preserveCoworkFields(record.workspaceId, config);
        switch (change.kind) {
          case 'settings': {
            const req = change.request;
            const next: CoworkWorkspaceSettings = { ...settings };
            if (req.description !== undefined)
              next.description = req.description;
            if (req.defaultModel !== undefined)
              next.defaultModel = req.defaultModel;
            if (req.defaultPresetId !== undefined)
              next.defaultPresetId = req.defaultPresetId;
            if (req.presets !== undefined) next.presets = req.presets;
            if (req.archiveRetentionDays !== undefined)
              next.archiveRetentionDays = req.archiveRetentionDays;
            if (req.autoArchiveDays !== undefined)
              next.autoArchiveDays = req.autoArchiveDays;
            if (req.starterPrompts !== undefined)
              next.starterPrompts = req.starterPrompts;
            if (req.startPage === null) delete next.startPage;
            else if (req.startPage !== undefined)
              next.startPage = req.startPage;
            const preset = next.presets?.find(
              (candidate) => candidate.id === next.defaultPresetId,
            );
            config.defaultPluginSelections =
              preset?.pluginSelections ??
              req.defaultPluginSelections ??
              config.defaultPluginSelections;
            if (req.alwaysShow !== undefined)
              config.alwaysShow = req.alwaysShow;
            if (
              resolveAutoArchiveDays(
                'cowork',
                settings.archiveRetentionDays,
                settings.autoArchiveDays,
              ) === null &&
              resolveAutoArchiveDays(
                'cowork',
                next.archiveRetentionDays,
                next.autoArchiveDays,
              ) !== null
            )
              await stampAutoDeleteBaseline(record.workspaceId);
            config.cowork = next;
            break;
          }
          case 'import':
            if (change.cowork !== undefined) {
              const next = { ...settings, ...change.cowork };
              for (const key of COWORK_FIELDS) {
                if (change.cowork[key] === undefined) delete next[key];
              }
              config.cowork = next;
            }
            if (change.defaultPluginSelections !== undefined)
              config.defaultPluginSelections = change.defaultPluginSelections;
            break;
          case 'install':
            config.installedFromTemplateExternalId = change.externalId;
            config.installedFromTemplateContentHash = change.contentHash;
            break;
          case 'blueprint':
            config.seededFromBlueprintExternalId = change.externalId;
            break;
        }
        // A non-settings change must not clear fields hidden from the sidebar projection.
        if (change.kind !== 'settings' && change.kind !== 'import')
          config.cowork = settings;
      },
    );
    return {
      result: undefined,
      ...(presentation.name !== undefined || presentation.color !== undefined
        ? {
            entries: snapshot.entries.map((candidate) =>
              candidate === entry
                ? {
                    ...entry,
                    ...(presentation.name !== undefined
                      ? { name: presentation.name.trim() }
                      : {}),
                    ...(presentation.color !== undefined
                      ? { color: presentation.color }
                      : {}),
                  }
                : candidate,
            ),
          }
        : {}),
    };
  });
  await afterCommit();
}

/**
 * Applies only the `sharedTemplate*` fields to the manifest read in its
 * queue. Unkeyed, with no revision: the host serializes it with the share
 * network effects around it.
 */
export async function recordCoworkTemplateShare(
  record: CoworkTemplateShareRecord,
): Promise<void> {
  admitId(record.workspaceId);
  await inIndex(async (snapshot): Promise<WorkspaceIndexChange<void>> => {
    authoritative(snapshot);
    if (
      !snapshot.entries.some(
        (candidate) =>
          candidate.id === record.workspaceId && candidate.type === 'cowork',
      )
    )
      refuse('not-found', 'Chat project not found');
    const change = record.change;
    await updateWorkspaceConfig(
      record.workspaceId,
      async (config, read): Promise<void> => {
        if (read.authority === 'absent' || config.type !== 'cowork')
          refuse('not-found', 'Chat project not found');
        const settings = await preserveCoworkFields(record.workspaceId, config);
        if (change.kind === 'publication') {
          config.sharedTemplatePublicationKey = change.publicationKey;
        } else {
          if (change.metadata === null)
            config.sharedTemplatePublicationKey = undefined;
          config.sharedTemplateExternalId = change.metadata?.externalId;
          config.sharedTemplateContentHash = change.metadata?.pinnedContentHash;
        }
        // Must not clear fields hidden from the sidebar projection.
        config.cowork = settings;
      },
    );
    return { result: undefined };
  });
  await afterCommit();
}

export interface CoworkCreationRecord {
  source: 'managed_create' | 'external_import';
  name: string;
  createdAt: string;
  externalPath?: string;
  installedFromTemplateExternalId?: string;
  owner?: WorkspaceOwnerBinding;
}
/** Select under the index queue, reserve durably, then publish both canonical files. */
export async function recordNewCoworkWorkspace(
  request: CoworkCreationRecord,
): Promise<CoworkSidebarItem> {
  return serializeWorkspaceMutation(async () => {
    if (!request.name.trim())
      refuse('invalid-request', 'Project name is required');
    const pendingIds = await pendingWorkspaceCreationIds();
    const item = await inIndex(
      async (snapshot): Promise<WorkspaceIndexChange<CoworkSidebarItem>> => {
        authoritative(snapshot);
        const taken = new Set([
          ...snapshot.entries.map((entry) => entry.id),
          ...pendingIds,
        ]);
        const base = slugify(request.name) || 'workspace';
        let id = uniqueId(base, taken);
        while (await workspaceCreationPathOccupied(getWorkspaceDir(id))) {
          taken.add(id);
          id = uniqueId(base, taken);
        }
        admitId(id);
        return {
          result: {
            id,
            name: request.name.trim(),
            type: 'cowork',
            color: color(snapshot.entries.length),
            collapsed: false,
            order: snapshot.entries.length,
            externalPath: request.externalPath,
            installedFromTemplateExternalId:
              request.installedFromTemplateExternalId,
            cowork: { createdAt: request.createdAt, archiveRetentionDays: 7 },
            ...(request.owner ? { owner: request.owner } : {}),
          },
        };
      },
    );
    return withLocalWorkspaceCreation(item.id, [getWorkspaceDir(item.id)], () =>
      commitWorkspaceCreation(
        () => stageNewCoworkWorkspace(item, request),
        [item.id],
      ),
    );
  });
}

async function stageNewCoworkWorkspace(
  item: CoworkSidebarItem,
  request: CoworkCreationRecord,
): Promise<CoworkSidebarItem> {
  await inIndex(async (snapshot): Promise<WorkspaceIndexChange<void>> => {
    authoritative(snapshot);
    if (snapshot.entries.some((entry) => entry.id === item.id))
      refuse('identity-changed', 'The local workspace id is already in use');
    if (request.owner) await recordNewCoworkConfig(item, true);
    if (!request.externalPath) {
      markWorkspaceCreationEffectsStarted();
      await ensureCoworkHomeScaffold(item.id);
    }
    return {
      result: undefined,
      entries: [...snapshot.entries, entryFor(item)],
    };
  });
  if (!request.owner) await recordNewCoworkConfig(item, false);
  await afterCommit();
  return item;
}

async function recordNewCoworkConfig(
  item: CoworkSidebarItem,
  replaceOwnership: boolean,
): Promise<void> {
  await updateWorkspaceConfig(
    item.id,
    (config, read): void => {
      if (read.authority !== 'absent')
        refuse('identity-changed', 'The local workspace id is already in use');
      Object.assign(config, configFor(item));
    },
    replaceOwnership ? { ownership: 'replace' } : undefined,
  );
}

export interface CoworkStageRecord {
  source: 'org_cowork_stage';
  item: CoworkSidebarItem;
}
/** Stores or refreshes only the staged workspace's owner and initial manifest. */
export async function recordStagedCoworkWorkspace(
  record: CoworkStageRecord,
): Promise<boolean> {
  const { item } = record;
  admitId(item.id);
  if (!item.owner)
    refuse('identity-changed', 'The local workspace id is already in use');
  const owner = item.owner;
  return inIndex(
    async (snapshot): Promise<WorkspaceIndexChange<boolean>> => {
      authoritative(snapshot);
      const indexed = snapshot.entries.find((entry) => entry.id === item.id);
      if (indexed && indexed.type !== 'cowork')
        refuse('identity-changed', 'The local workspace id is already in use');
      const created = await updateWorkspaceConfig(
        item.id,
        async (config, read): Promise<boolean> => {
          if (read.authority !== 'absent') {
            if (
              config.type !== 'cowork' ||
              read.ownerMalformed ||
              !sameOwner(config.owner, owner)
            )
              refuse(
                'identity-changed',
                'The local workspace id is already in use',
              );
            await preserveCoworkFields(item.id, config);
            config.owner = owner;
            return false;
          }
          // An indexed workspace without a manifest has no owner to prove it
          // belongs to this organization project; never claim it.
          if (indexed)
            refuse(
              'identity-changed',
              'The local workspace id is already in use',
            );
          Object.assign(config, configFor(item));
          config.ownershipTransfer = undefined;
          return true;
        },
        { ownership: 'replace' },
      );
      return { result: created };
    },
    {
      reason: 'identity-changed',
      message: 'The local workspace id is already in use',
    },
  );
}

export interface CoworkPublishRecord {
  source: 'org_cowork_publish';
  workspaceId: string;
  name: string;
  owner: WorkspaceOwnerBinding;
  precheck?: () => Promise<void>;
}
/** Publishes a staged manifest, keeping other index entries and manifest fields. */
export async function publishCoworkWorkspaceRecord(
  record: CoworkPublishRecord,
): Promise<CoworkSidebarItem> {
  admitId(record.workspaceId);
  const outcome = await inIndex(
    async (
      snapshot,
    ): Promise<
      WorkspaceIndexChange<{ item: CoworkSidebarItem; changed: boolean }>
    > => {
      authoritative(snapshot);
      await record.precheck?.();
      const entry = snapshot.entries.find(
        (candidate) => candidate.id === record.workspaceId,
      );
      if (entry && entry.type !== 'cowork')
        refuse('identity-changed', 'The local workspace id is already in use');
      const outcome = await updateWorkspaceConfig(
        record.workspaceId,
        async (
          config,
          read,
        ): Promise<{ item: CoworkSidebarItem; changed: boolean }> => {
          if (
            read.authority === 'absent' ||
            config.type !== 'cowork' ||
            read.ownerMalformed ||
            !sameOwner(config.owner, record.owner)
          )
            refuse(
              'configuration-unavailable',
              'The staged Cowork workspace is unavailable',
            );
          await preserveCoworkFields(record.workspaceId, config);
          const alreadyPublished =
            entry?.name === record.name.trim() &&
            config.owner?.type === 'organization' &&
            record.owner.type === 'organization' &&
            config.owner.instanceId === record.owner.instanceId &&
            config.owner.bindingGeneration === record.owner.bindingGeneration;
          const next = projected(
            entry ?? {
              id: record.workspaceId,
              name: record.name.trim(),
              type: 'cowork',
              color: color(snapshot.entries.length),
              collapsed: false,
              order: snapshot.entries.length,
            },
            config,
          );
          next.name = record.name.trim();
          next.owner = record.owner;
          if (!alreadyPublished) {
            config.owner = record.owner;
            config.ownershipTransfer = undefined;
          }
          return { item: next, changed: !alreadyPublished };
        },
        { ownership: 'replace', shouldWrite: (outcome) => outcome.changed },
      );
      return {
        result: outcome,
        ...(outcome.changed
          ? {
              entries: entry
                ? snapshot.entries.map((candidate) =>
                    candidate === entry
                      ? { ...entry, name: outcome.item.name }
                      : candidate,
                  )
                : [...snapshot.entries, entryFor(outcome.item)],
            }
          : {}),
      };
    },
    {
      reason: 'configuration-unavailable',
      message: 'The staged Cowork workspace is unavailable',
    },
  );
  if (outcome.changed) await afterCommit();
  return outcome.item;
}

export interface CoworkDiscardRecord {
  source: 'org_cowork_discard';
  workspaceId: string;
  projectId: string;
}
/** Keeps published or rebound workspaces; removes only this unpublished metadata directory. */
export async function discardCoworkWorkspaceRecord(
  record: CoworkDiscardRecord,
): Promise<void> {
  admitId(record.workspaceId);
  await inIndex(async (snapshot): Promise<WorkspaceIndexChange<void>> => {
    if (snapshot.authority !== 'ok' && snapshot.authority !== 'absent')
      return { result: undefined };
    if (snapshot.entries.some((entry) => entry.id === record.workspaceId))
      return { result: undefined };
    const manifests = getWorkspaceManifestRepository();
    await manifests.serialize(record.workspaceId, async (): Promise<void> => {
      const read = await readWorkspaceConfigDetailed(record.workspaceId);
      if (
        read.authority !== 'ok' ||
        read.ownerMalformed ||
        read.config.type !== 'cowork' ||
        read.config.owner?.type !== 'organization' ||
        read.config.owner.projectId !== record.projectId
      )
        return;
      await rm(getWorkspaceDir(record.workspaceId), {
        recursive: true,
        force: true,
      });
    });
    return { result: undefined };
  });
}

export interface CoworkProvisionRecord {
  source: 'default_cowork_provision';
  workspaceId: string;
  owner?: WorkspaceOwnerBinding;
  publishToIndex?: boolean;
}
/**
 * Decides default provisioning from current index and manifest state, never a
 * caller's projection, through the record decision port (W5c2).
 */
export async function provisionCoworkWorkspaceRecord(
  record: CoworkProvisionRecord,
): Promise<{ item: CoworkSidebarItem; notify: boolean }> {
  return serializeWorkspaceMutation(
    async (): Promise<{ item: CoworkSidebarItem; notify: boolean }> => {
      admitId(record.workspaceId);
      const outcome = await indexWork(
        () =>
          applyCoworkProvisionDecision({
            kind: 'cowork.provision',
            workspaceId: record.workspaceId,
            ...(record.owner ? { owner: record.owner } : {}),
            publishToIndex: record.publishToIndex !== false,
            name: DEFAULT_COWORK_WORKSPACE_NAME,
            createdAt: DEFAULT_CREATED_AT,
          }),
        {
          reason: 'configuration-unavailable',
          message: `The ${DEFAULT_COWORK_WORKSPACE_NAME} project configuration is unavailable`,
        },
      );
      if (outcome.deferredManifest)
        await applyCoworkManifestDecision(record.workspaceId, {
          kind: 'cowork.provision.manifest',
          item: outcome.deferredManifest,
        });
      if (outcome.notify) await afterCommit();
      return outcome;
    },
  );
}

export interface CoworkMigrationRecord {
  source: 'legacy_cowork_migration';
  legacyId: string;
  candidateId: string;
  name: string;
  color?: string;
  cowork?: CoworkWorkspaceSettings;
}
/**
 * Allocates or reuses the migration identity under the index queue, through
 * the record decision port (W5c2); Cowork has no worktree list.
 */
export async function recordMigratedCoworkWorkspace(
  record: CoworkMigrationRecord,
): Promise<string> {
  return serializeWorkspaceMutation(async (): Promise<string> => {
    admitId(record.candidateId);
    const { id, created } = await indexWork(() =>
      applyCoworkIndexDecision({
        kind: 'cowork.migration',
        candidateId: record.candidateId,
        name: record.name,
        ...(record.color === undefined ? {} : { color: record.color }),
        ...(record.cowork === undefined ? {} : { cowork: record.cowork }),
      }),
    );
    if (!created) return id;
    await applyCoworkManifestDecision(id, {
      kind: 'cowork.migration.manifest',
      ...(record.cowork === undefined ? {} : { cowork: record.cowork }),
    });
    await afterCommit();
    return id;
  });
}
export interface CoworkNameMigrationRecord {
  source: 'default_cowork_name_migration';
  workspaceId: string;
  name: string;
  onlyWhenNamed: readonly string[];
}
export async function renameDefaultCoworkWorkspaceRecord(
  record: CoworkNameMigrationRecord,
): Promise<{ authority: WorkspaceIndexAuthority; renamed: boolean }> {
  admitId(record.workspaceId);
  return applyCoworkIndexDecision({
    kind: 'cowork.default-name',
    workspaceId: record.workspaceId,
    name: record.name,
    onlyWhenNamed: record.onlyWhenNamed,
  });
}

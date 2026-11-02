import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';
import { BrowserWindow } from 'electron';
import { isCapabilityPackageDigest } from '@canopy/protocol/pipelines';
import {
  IPC_CHANNELS,
  type SharedContainerPublicationState,
} from '@canopy/desktop-shared/types';
import {
  getAppWorkspacesRootDir,
  getWorkspacesRootDir,
  getWorktreeDataRootDir,
  getWorktreeSharePublicationStatePath,
} from '../lib/paths';
import { isRecord } from '../lib/type-guards';
import { getObservabilityService } from '../observability';
import { sharedContainerOwnerKey } from './owner-scope';
import { sendToWebContents } from '../lib/web-contents-send';

/**
 * Record one publish status transition for this worktree.
 *
 * CAN-2551 reduced the owner-facing publish UI to a single quiet line, so the
 * detailed ladder an owner used to read on screen has to survive somewhere it
 * can still be triaged. It lands in
 * `agent-observability/diagnostics/session-events/` rather than
 * `app-events/`, because publishing is worktree-scoped and global app events
 * must never carry a worktree id.
 *
 * Failure here is swallowed on purpose: a diagnostic must never be the reason
 * a publish state fails to persist.
 */
function recordPublishTransition(
  previous: SharedContainerPublicationRecord | undefined,
  next: SharedContainerPublicationRecord,
): void {
  try {
    getObservabilityService().recordSessionDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'shared_container_publish_transition',
      // Publishing is not a chat, but `chatId` is required on every session
      // diagnostic, so the slot carries the container this transition belongs
      // to rather than a fabricated id. It is empty only before a container
      // exists; `sharedContainerId` is the field consumers should group by.
      sessionKey: `${next.projectId}/${next.worktreeId}/${sharedContainerOwnerKey(next.organizationId)}`,
      projectId: next.projectId,
      worktreeId: next.worktreeId,
      chatId: next.containerId ?? '',
      providerType: 'unknown',
      ...(next.organizationId
        ? { sharedContainerOrganizationId: next.organizationId }
        : {}),
      sharedContainerPublishFrom: previous?.status ?? 'none',
      sharedContainerPublishTo: next.status,
      ...(next.containerId ? { sharedContainerId: next.containerId } : {}),
      ...(next.containerType
        ? { sharedContainerType: next.containerType }
        : {}),
      ...(next.revision !== undefined
        ? { sharedContainerRevision: next.revision }
        : {}),
      ...(next.errorReason
        ? { sharedContainerPublishErrorReason: next.errorReason }
        : {}),
      ...(next.error ? { error: next.error } : {}),
    });
  } catch {
    // Diagnostics are best-effort; publishing must not depend on them.
  }
}

export interface SharedContainerPublicationRecord extends SharedContainerPublicationState {
  revisionId?: string;
  publishedAt?: string;
  idempotencyKey?: string;
  stagingSessionId?: string;
  stagedRevisionId?: string;
  stageRequestHash?: string;
  publishedContentHash?: string;
  pendingContentHash?: string;
  publishedPackageDigest?: string;
  pendingArtifactContentHash?: string;
  pendingPackageDigest?: string;
  pendingCommittedPackageUploadId?: string;
  pendingCarryParentPackage?: boolean;
  packageRecoveryPending?: boolean;
  packageRecoveryAttempts?: number;
  restartWithFreshStage?: boolean;
  terminalError?: boolean;
}

interface PersistedPublicationFile {
  version: 1;
  /**
   * Keyed by owning organization id, or by the personal owner key for a
   * personal container (whose record has no `organizationId`). Still
   * version 1: personal entries are additive and older readers skip them.
   */
  organizations: Record<string, SharedContainerPublicationRecord>;
}

interface CachedPublicationFile {
  fingerprint: string;
  chargedBytes: number;
  value: PersistedPublicationFile;
}

const MAX_CACHED_PUBLICATION_FILES = 256;
const MAX_CACHED_PUBLICATION_BYTES = 1024 * 1024;
const MAX_CACHED_PUBLICATION_FILE_BYTES = 256 * 1024;

function emptyPublicationFile(): PersistedPublicationFile {
  return { version: 1, organizations: {} };
}

function publicationFileFingerprint(info: {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

function broadcastToRenderers(state: SharedContainerPublicationState): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.sharedContainersPublicationChanged,
        state,
      );
    }
  }
}

function publicPublicationState(
  record: SharedContainerPublicationRecord,
): SharedContainerPublicationState {
  return {
    projectId: record.projectId,
    worktreeId: record.worktreeId,
    ...(record.organizationId !== undefined
      ? { organizationId: record.organizationId }
      : {}),
    ...(record.containerId ? { containerId: record.containerId } : {}),
    ...(record.containerType ? { containerType: record.containerType } : {}),
    status: record.status,
    ...(record.revision !== undefined ? { revision: record.revision } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(record.errorReason ? { errorReason: record.errorReason } : {}),
    updatedAt: record.updatedAt,
  };
}

function normalizeRecord(
  value: unknown,
): SharedContainerPublicationRecord | null {
  if (
    !isRecord(value) ||
    typeof value.projectId !== 'string' ||
    typeof value.worktreeId !== 'string' ||
    (value.organizationId !== undefined &&
      typeof value.organizationId !== 'string') ||
    !['not-published', 'publishing', 'published', 'error'].includes(
      String(value.status),
    ) ||
    typeof value.updatedAt !== 'string'
  ) {
    return null;
  }
  return {
    projectId: value.projectId,
    worktreeId: value.worktreeId,
    ...(typeof value.organizationId === 'string'
      ? { organizationId: value.organizationId }
      : {}),
    status: value.status as SharedContainerPublicationRecord['status'],
    updatedAt: value.updatedAt,
    ...(typeof value.containerId === 'string'
      ? { containerId: value.containerId }
      : {}),
    ...(value.containerType === 'CODE_WORKTREE' ||
    value.containerType === 'COWORK_WORK_ENTRY'
      ? { containerType: value.containerType }
      : {}),
    ...(typeof value.revision === 'number' && Number.isInteger(value.revision)
      ? { revision: value.revision }
      : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...([
      'unpushed-head',
      'git-lfs',
      'undisclosable-repository',
      'artifact-budget',
      'submodule',
      'symlink',
    ].includes(String(value.errorReason))
      ? {
          errorReason:
            value.errorReason as SharedContainerPublicationRecord['errorReason'],
        }
      : {}),
    ...(typeof value.revisionId === 'string'
      ? { revisionId: value.revisionId }
      : {}),
    ...(typeof value.publishedAt === 'string'
      ? { publishedAt: value.publishedAt }
      : {}),
    ...(typeof value.idempotencyKey === 'string'
      ? { idempotencyKey: value.idempotencyKey }
      : {}),
    ...(typeof value.stagingSessionId === 'string'
      ? { stagingSessionId: value.stagingSessionId }
      : {}),
    ...(typeof value.stagedRevisionId === 'string'
      ? { stagedRevisionId: value.stagedRevisionId }
      : {}),
    ...(typeof value.stageRequestHash === 'string'
      ? { stageRequestHash: value.stageRequestHash }
      : {}),
    ...(typeof value.publishedContentHash === 'string'
      ? { publishedContentHash: value.publishedContentHash }
      : {}),
    ...(typeof value.pendingContentHash === 'string'
      ? { pendingContentHash: value.pendingContentHash }
      : {}),
    ...(isCapabilityPackageDigest(value.publishedPackageDigest)
      ? { publishedPackageDigest: value.publishedPackageDigest }
      : {}),
    ...(typeof value.pendingArtifactContentHash === 'string'
      ? { pendingArtifactContentHash: value.pendingArtifactContentHash }
      : {}),
    ...(isCapabilityPackageDigest(value.pendingPackageDigest)
      ? { pendingPackageDigest: value.pendingPackageDigest }
      : {}),
    ...(typeof value.pendingCommittedPackageUploadId === 'string' &&
    value.pendingCarryParentPackage !== true
      ? {
          pendingCommittedPackageUploadId:
            value.pendingCommittedPackageUploadId,
        }
      : {}),
    ...(value.pendingCarryParentPackage === true &&
    value.pendingCommittedPackageUploadId === undefined
      ? { pendingCarryParentPackage: true }
      : {}),
    ...(value.packageRecoveryPending === true
      ? { packageRecoveryPending: true }
      : {}),
    ...(typeof value.packageRecoveryAttempts === 'number' &&
    Number.isSafeInteger(value.packageRecoveryAttempts) &&
    value.packageRecoveryAttempts >= 0
      ? { packageRecoveryAttempts: value.packageRecoveryAttempts }
      : {}),
    ...(typeof value.restartWithFreshStage === 'boolean'
      ? { restartWithFreshStage: value.restartWithFreshStage }
      : {}),
    ...(typeof value.terminalError === 'boolean'
      ? { terminalError: value.terminalError }
      : {}),
  };
}

function parseStateFile(contents: string): PersistedPublicationFile | null {
  try {
    const value: unknown = JSON.parse(contents);
    if (
      !isRecord(value) ||
      value.version !== 1 ||
      !isRecord(value.organizations)
    ) {
      throw new Error('Invalid publication state');
    }
    const organizations = Object.fromEntries(
      Object.entries(value.organizations).flatMap(([ownerKey, record]) => {
        const normalized = normalizeRecord(record);
        return normalized &&
          sharedContainerOwnerKey(normalized.organizationId) === ownerKey
          ? [[ownerKey, normalized]]
          : [];
      }),
    );
    return { version: 1, organizations };
  } catch {
    return null;
  }
}

async function readStateFile(
  projectId: string,
  worktreeId: string,
): Promise<PersistedPublicationFile> {
  try {
    const contents = await readFile(
      getWorktreeSharePublicationStatePath(projectId, worktreeId),
      'utf8',
    );
    return parseStateFile(contents) ?? emptyPublicationFile();
  } catch {
    return emptyPublicationFile();
  }
}

async function writeStateFile(
  projectId: string,
  worktreeId: string,
  value: PersistedPublicationFile,
): Promise<void> {
  const filePath = getWorktreeSharePublicationStatePath(projectId, worktreeId);
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporary, filePath);
}

export class SharedContainerPublicationStateStore {
  private readonly mutationTails = new Map<string, Promise<void>>();
  private readonly readCache = new Map<string, CachedPublicationFile>();
  private cachedBytes = 0;

  constructor(
    private readonly broadcast: (
      state: SharedContainerPublicationState,
    ) => void = broadcastToRenderers,
    private readonly recordTransition: (
      previous: SharedContainerPublicationRecord | undefined,
      next: SharedContainerPublicationRecord,
    ) => void = recordPublishTransition,
  ) {}

  async get(
    projectId: string,
    worktreeId: string,
    organizationId: string | undefined,
  ): Promise<SharedContainerPublicationRecord | null> {
    const state = await this.readCachedStateFile(projectId, worktreeId);
    const record = state.organizations[sharedContainerOwnerKey(organizationId)];
    return record ? { ...record } : null;
  }

  async list(
    projectId: string,
    worktreeId: string,
  ): Promise<SharedContainerPublicationRecord[]> {
    return Object.values(
      (await this.readCachedStateFile(projectId, worktreeId)).organizations,
    ).map((record) => ({ ...record }));
  }

  private forgetCachedFile(path: string): void {
    const previous = this.readCache.get(path);
    if (!previous) return;
    this.cachedBytes -= previous.chargedBytes;
    this.readCache.delete(path);
  }

  private cacheFile(
    path: string,
    fingerprint: string,
    chargedBytes: number,
    value: PersistedPublicationFile,
  ): void {
    this.forgetCachedFile(path);
    if (chargedBytes > MAX_CACHED_PUBLICATION_FILE_BYTES) return;
    while (
      this.readCache.size >= MAX_CACHED_PUBLICATION_FILES ||
      this.cachedBytes + chargedBytes > MAX_CACHED_PUBLICATION_BYTES
    ) {
      const oldest = this.readCache.keys().next().value;
      if (oldest === undefined) break;
      this.forgetCachedFile(oldest);
    }
    this.readCache.set(path, { fingerprint, chargedBytes, value });
    this.cachedBytes += chargedBytes;
  }

  private async readCachedStateFile(
    projectId: string,
    worktreeId: string,
  ): Promise<PersistedPublicationFile> {
    const path = getWorktreeSharePublicationStatePath(projectId, worktreeId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let before;
      try {
        before = await stat(path, { bigint: true });
      } catch (error) {
        this.forgetCachedFile(path);
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return emptyPublicationFile();
        }
        // Stat failed, so an old cache entry cannot establish freshness.
        // Preserve the existing direct-read fallback for other errors.
        return readStateFile(projectId, worktreeId);
      }
      const fingerprint = publicationFileFingerprint(before);
      const cached = this.readCache.get(path);
      if (cached?.fingerprint === fingerprint) {
        this.readCache.delete(path);
        this.readCache.set(path, cached);
        return cached.value;
      }
      this.forgetCachedFile(path);

      let contents: string;
      try {
        contents = await readFile(path, 'utf8');
      } catch {
        return emptyPublicationFile();
      }
      const parsed = parseStateFile(contents);
      let after;
      try {
        after = await stat(path, { bigint: true });
      } catch {
        if (attempt === 0) continue;
        return readStateFile(projectId, worktreeId);
      }
      if (fingerprint !== publicationFileFingerprint(after)) {
        if (attempt === 0) continue;
        return readStateFile(projectId, worktreeId);
      }
      if (!parsed) return emptyPublicationFile();
      this.cacheFile(
        path,
        fingerprint,
        Buffer.byteLength(contents, 'utf8'),
        parsed,
      );
      return parsed;
    }
    return emptyPublicationFile();
  }

  /**
   * Enumerate every workspace that can own publication state.
   *
   * Both roots are scanned because app-managed chat workspaces live under
   * `app-workspaces/<id>/` rather than `workspaces/<id>/`. Whichever root a
   * workspace id was discovered under, its data directory is resolved through
   * the one canonical helper the read/write path uses
   * (`getWorktreeDataRootDir`, reached from
   * `getWorktreeSharePublicationStatePath`), never by hand-joining
   * `worktree-data` onto a workspace root - that hardcoded join silently
   * skipped every app-managed workspace, so those worktrees were never
   * rehydrated or crash-recovered. Keeping the derivation in one place is what
   * stops enumeration from drifting away from where the state was written.
   */
  private async listPublicationWorkspaceDirs(): Promise<
    { workspaceId: string; worktreeDataDir: string }[]
  > {
    const roots = [getWorkspacesRootDir(), getAppWorkspacesRootDir()];
    const seen = new Set<string>();
    const workspaces: { workspaceId: string; worktreeDataDir: string }[] = [];
    for (const root of roots) {
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const worktreeDataDir = getWorktreeDataRootDir(entry.name);
        if (seen.has(worktreeDataDir)) continue;
        seen.add(worktreeDataDir);
        workspaces.push({ workspaceId: entry.name, worktreeDataDir });
      }
    }
    return workspaces;
  }

  async rehydrateAll(): Promise<SharedContainerPublicationRecord[]> {
    const restored: SharedContainerPublicationRecord[] = [];
    for (const {
      workspaceId,
      worktreeDataDir,
    } of await this.listPublicationWorkspaceDirs()) {
      let worktrees;
      try {
        worktrees = await readdir(worktreeDataDir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      for (const worktree of worktrees.filter((entry) => entry.isDirectory())) {
        const records = await this.list(workspaceId, worktree.name);
        for (const record of records) {
          restored.push(record);
          this.broadcast(publicPublicationState(record));
        }
      }
    }
    return restored;
  }

  async set(
    state: SharedContainerPublicationRecord,
  ): Promise<SharedContainerPublicationRecord> {
    return this.mutate(state.projectId, state.worktreeId, (organizations) => {
      const current =
        organizations[sharedContainerOwnerKey(state.organizationId)];
      if (current?.containerId && current.containerId !== state.containerId) {
        return current;
      }
      return state;
    });
  }

  private async mutate(
    projectId: string,
    worktreeId: string,
    resolveState: (
      organizations: Readonly<Record<string, SharedContainerPublicationRecord>>,
    ) => SharedContainerPublicationRecord,
  ): Promise<SharedContainerPublicationRecord> {
    const mutationKey = `${projectId}/${worktreeId}`;
    const previous = this.mutationTails.get(mutationKey) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.mutationTails.set(mutationKey, tail);
    await previous;
    try {
      const persisted = await readStateFile(projectId, worktreeId);
      const state = resolveState(persisted.organizations);
      // Read after `resolveState`, which chooses which organization the record
      // belongs to. Comparing against the wrong organization's prior record
      // would mislabel every transition on a multi-org worktree.
      const ownerKey = sharedContainerOwnerKey(state.organizationId);
      const priorRecord = persisted.organizations[ownerKey];
      persisted.organizations[ownerKey] = state;
      await writeStateFile(projectId, worktreeId, persisted);
      this.forgetCachedFile(
        getWorktreeSharePublicationStatePath(projectId, worktreeId),
      );
      // Only real transitions are recorded. `mutate` also runs for idempotent
      // re-writes (a repeated `markNotPublished`, a scheduler retry that
      // resolves to the same record), and logging those would bury the
      // handful of edges that actually explain a publish in noise.
      //
      // `errorReason` is part of the comparison because a retry can fail a
      // second way at the same revision: both the publish scheduler and the
      // publish pipeline rewrite `status: 'error'` with a freshly classified
      // reason (the scheduler strips the stale one first), so an
      // `artifact-budget` refusal that retries into `symlink` is a real edge.
      // Comparing only status and revision would drop exactly the transition
      // this diagnostic exists to capture, now that the owner-facing UI no
      // longer narrates these.
      if (
        priorRecord?.status !== state.status ||
        priorRecord.revision !== state.revision ||
        priorRecord.errorReason !== state.errorReason
      ) {
        this.recordTransition(priorRecord, state);
      }
      this.broadcast(publicPublicationState(state));
      return state;
    } finally {
      release();
      if (this.mutationTails.get(mutationKey) === tail) {
        this.mutationTails.delete(mutationKey);
      }
    }
  }

  async markNotPublished(input: {
    projectId: string;
    worktreeId: string;
    /** Absent for a personal container. */
    organizationId?: string;
    containerId: string;
    containerType: SharedContainerPublicationRecord['containerType'];
  }): Promise<SharedContainerPublicationRecord> {
    return this.mutate(input.projectId, input.worktreeId, (organizations) => {
      const previous =
        organizations[sharedContainerOwnerKey(input.organizationId)];
      const sameContainer = previous?.containerId === input.containerId;
      if (
        sameContainer &&
        previous.idempotencyKey &&
        (previous.status === 'publishing' || previous.status === 'error')
      ) {
        return previous;
      }
      return {
        ...input,
        status: 'not-published',
        ...(sameContainer && previous?.revision !== undefined
          ? { revision: previous.revision }
          : {}),
        ...(sameContainer && previous?.revisionId
          ? { revisionId: previous.revisionId }
          : {}),
        ...(sameContainer && previous?.publishedAt
          ? { publishedAt: previous.publishedAt }
          : {}),
        updatedAt: new Date().toISOString(),
      };
    });
  }
}

let publicationStateStore: SharedContainerPublicationStateStore | null = null;

export function getSharedContainerPublicationStateStore(): SharedContainerPublicationStateStore {
  publicationStateStore ??= new SharedContainerPublicationStateStore();
  return publicationStateStore;
}

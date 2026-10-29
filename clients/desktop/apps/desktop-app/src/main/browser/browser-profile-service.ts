import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import type { BrowserProfileCleanupJob } from '@canopy/desktop-shared/node/browser-profiles/repository';
import { clearRetiredBrowserSession } from './native-maintenance';
import { BrowserProfileNetworkPolicy } from './network-policy';
import { denyPermission } from './permission-denials';
import { randomUUID } from 'node:crypto';
import { lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { app, session, type Session } from 'electron';
import {
  browserTaskScopeTuple,
  type BrowserProfileBinding,
  isBrowserProfileSelection,
  type BrowserProfileSelection,
  type BrowserProfileRecord,
  type BrowserTaskScope,
  type BrowserProfilePage,
  type BrowserTaskSlot,
} from '@canopy/protocol/browser-profiles';
import { BrowserProfileRepository } from '@canopy/desktop-shared/node/browser-profiles/repository';
import { errorCode } from '@canopy/desktop-shared/node/browser-profiles/storage';
import {
  browserTaskOwnerIds,
  legacyBrowserPartition,
  legacyBrowserPartitionOwners,
  resolveBrowserTaskOwner,
  type BrowserTaskOwner,
} from '@canopy/desktop-shared/node/browser-profiles/owners';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types/browser';
import { getDataDir, getWorkspaceWorktreeDir } from '../lib/paths';

export interface BrowserProfileOpenContext {
  selection?: BrowserProfileSelection;
  actor?: 'user' | 'agent';
}

export interface BrowserProfileResolution {
  agentEnableRequired?: boolean;
  owner: BrowserTaskOwner;
  profile: BrowserProfileRecord;
  binding: BrowserProfileBinding;
  partition: string;
}

export interface BrowserProfileAuthority {
  resolve(
    projectId: string,
    worktreeId: string,
    persisted?: BrowserSessionSnapshot,
    context?: BrowserProfileOpenContext,
  ): Promise<BrowserProfileResolution>;
  assertActive(resolution: BrowserProfileResolution): Promise<void>;
  commitBinding?<T>(
    resolution: BrowserProfileResolution,
    commit: () => Promise<T>,
  ): Promise<T>;
  acquireSession(resolution: BrowserProfileResolution): Promise<Session>;
}

export class BrowserProfileService implements BrowserProfileAuthority {
  readonly repository: BrowserProfileRepository;
  private initialization?: Promise<void>;
  private readonly sessions = new Map<string, Session>();
  private readonly networkPolicies = new WeakMap<
    Session,
    BrowserProfileNetworkPolicy
  >();
  private readonly sessionAcquisitions = new Map<string, Promise<Session>>();
  private purge?: Promise<void>;
  private prepareCleanup?: (job: BrowserProfileCleanupJob) => Promise<void>;
  setCleanupPreparation(
    prepare: NonNullable<BrowserProfileService['prepareCleanup']>,
  ): void {
    this.prepareCleanup = prepare;
  }
  readonly cleanupErrors = new Map<string, string>();
  private readonly clearedRetiredPartitions = new Set<string>();

  constructor(
    readonly dataRoot: string,
    readonly sessionRoot: string,
  ) {
    this.repository = new BrowserProfileRepository(
      join(dataRoot, 'browser-profiles'),
    );
  }

  private nativePath(partition: string): string {
    if (!/^persist:canopy-browser-[a-zA-Z0-9_%.-]+$/.test(partition))
      throw new BrowserProfileError(
        'recovery_required',
        'Invalid native browser partition locator.',
      );
    return resolve(
      this.sessionRoot,
      'Partitions',
      partition.slice('persist:'.length).toLowerCase(),
    );
  }

  ensureReady(): Promise<void> {
    this.initialization ??= this.reconcileOwners()
      .then(() => {
        void this.purgeRetired().catch(() => undefined);
      })
      .catch((error: unknown) => {
        this.initialization = undefined;
        throw error;
      });
    return this.initialization;
  }

  async taskContext(
    projectId: string,
    worktreeId: string,
  ): Promise<BrowserTaskSlot> {
    await this.ensureReady();
    const owner = await resolveBrowserTaskOwner(
      this.dataRoot,
      projectId,
      worktreeId,
    );
    if (!owner)
      throw new BrowserProfileError(
        'scope_unresolved',
        'Open an existing worktree or work entry.',
      );
    const existing = await this.repository.getTask(owner.scope);
    if (
      existing?.lifecycle === 'active' &&
      existing.ownerCreatedAt === owner.createdAt
    )
      return existing;
    return this.repository.ensureSlot(
      owner.scope,
      owner.createdAt,
      randomUUID(),
    );
  }

  async listProfiles(
    offset = 0,
    scope?: BrowserTaskScope,
  ): Promise<BrowserProfilePage> {
    await this.ensureReady();
    return this.repository.listPage(offset, scope);
  }

  private async reconcileOwners(): Promise<void> {
    for (const slot of await this.repository.listTaskSlots()) {
      if (slot.lifecycle === 'retired') continue;
      const ids = browserTaskOwnerIds(slot.scope);
      const owner = await resolveBrowserTaskOwner(
        this.dataRoot,
        ids.projectId,
        ids.worktreeId,
      );
      if (!owner || owner.createdAt !== slot.ownerCreatedAt) {
        const operationId = slot.retirementOperationId ?? randomUUID();
        if (slot.lifecycle === 'active')
          await this.repository.prepareRetirement(
            slot.scope,
            slot.ownerCreatedAt,
            operationId,
            slot.legacyOwnershipResolved
              ? undefined
              : await this.legacyPartitionForOwner({
                  ...ids,
                  scope: slot.scope,
                  createdAt: slot.ownerCreatedAt,
                }),
          );
        await this.repository.commitRetirement(operationId, {
          kind: 'owner_removed',
          ownerOperationId: operationId,
        });
      } else if (
        slot.lifecycle === 'retirement_pending' &&
        slot.retirementOperationId
      ) {
        const retirement = (await this.repository.getRetirements()).find(
          (entry) => entry.operationId === slot.retirementOperationId,
        );
        if (retirement) {
          try {
            process.kill(retirement.initiatorPid, 0);
            continue;
          } catch (error) {
            if (errorCode(error) !== 'ESRCH') continue;
          }
        }
        if (slot.scope.kind === 'worktree') {
          // Defer the heavy Git/archive module until retirement recovery actually
          // needs to inspect a staged worktree quarantine.
          const { readArchivedGitStagedDescriptor } =
            await import('../lib/archived-container-git');
          const staged = await readArchivedGitStagedDescriptor(
            ids.projectId,
            ids.worktreeId,
          );
          if (staged?.teardown?.phase === 'verified') {
            await this.repository.commitRetirement(slot.retirementOperationId, {
              kind: 'git_quarantine',
              ownerOperationId: slot.retirementOperationId,
            });
            continue;
          }
          // An incomplete Git quarantine, or a missing checkout whose registry row
          // remains, cannot prove either outcome. Keep only this task fenced: its
          // slot stays retirement_pending, so opening it fails as retired, and
          // the next archive of this owner adopts the crashed retirement. Other
          // tasks must not inherit this owner's uncertainty.
          if (staged?.teardown) continue;
          try {
            await lstat(getWorkspaceWorktreeDir(ids.projectId, ids.worktreeId));
          } catch {
            continue;
          }
        }
        await this.repository.abortRetirement(slot.retirementOperationId);
      }
    }
  }

  async legacyPartitionForOwner(
    owner: BrowserTaskOwner,
  ): Promise<string | undefined> {
    const partition = legacyBrowserPartition(owner.projectId, owner.worktreeId);
    const owners = new Set(
      (await legacyBrowserPartitionOwners(this.dataRoot, partition)).map(
        (entry) => browserTaskScopeTuple(entry.scope),
      ),
    );
    for (const slot of await this.repository.listTaskSlots()) {
      const ids = browserTaskOwnerIds(slot.scope);
      if (legacyBrowserPartition(ids.projectId, ids.worktreeId) === partition)
        owners.add(browserTaskScopeTuple(slot.scope));
    }
    return owners.size === 1 && owners.has(browserTaskScopeTuple(owner.scope))
      ? partition
      : undefined;
  }

  async resolve(
    projectId: string,
    worktreeId: string,
    persisted?: BrowserSessionSnapshot,
    context: BrowserProfileOpenContext = {},
  ): Promise<BrowserProfileResolution> {
    if (
      context.selection !== undefined &&
      !isBrowserProfileSelection(context.selection)
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid browser profile selection.',
      );
    await this.ensureReady();
    const owner = await resolveBrowserTaskOwner(
      this.dataRoot,
      projectId,
      worktreeId,
    );
    if (!owner)
      throw new BrowserProfileError(
        'scope_unresolved',
        'Open the browser in an existing worktree or work entry.',
      );
    let slot = await this.repository.getTask(owner.scope);
    let profile: BrowserProfileRecord;
    const selection = persisted?.profile?.selection ??
      context.selection ??
      slot?.defaultSelection ?? { kind: 'task' as const };
    if (persisted?.profile) {
      if (
        !slot ||
        slot.lifecycle !== 'active' ||
        slot.ownerCreatedAt !== owner.createdAt ||
        slot.incarnationId !== persisted.profile.taskIncarnationId
      )
        throw new BrowserProfileError(
          'scope_retired',
          'This browser tab belongs to an unavailable task incarnation.',
        );
      if (
        context.selection &&
        (context.selection.kind !== selection.kind ||
          (context.selection.kind === 'named' &&
            context.selection.profileId !==
              persisted.profile.resolvedProfileId))
      )
        throw new BrowserProfileError(
          'invalid_request',
          'Use profile switching to change an existing tab.',
        );
      profile = await this.repository.get(persisted.profile.resolvedProfileId);
      if (
        profile.kind !== selection.kind ||
        (selection.kind === 'named' &&
          selection.profileId !== profile.profileId)
      )
        throw new BrowserProfileError(
          'profile_unavailable',
          'The browser profile binding is inconsistent.',
        );
      if (profile.storageGeneration !== persisted.profile.storageGeneration)
        throw new BrowserProfileError(
          'profile_unavailable',
          'This browser tab references retired profile storage.',
        );
      if (
        profile.owner.kind === 'task' &&
        (profile.owner.taskIncarnationId !== slot.incarnationId ||
          browserTaskScopeTuple(profile.owner.taskScope) !==
            browserTaskScopeTuple(owner.scope))
      )
        throw new BrowserProfileError(
          'scope_unresolved',
          'The browser profile belongs to another task.',
        );
    } else if (selection.kind === 'named') {
      if (
        !slot ||
        slot.lifecycle !== 'active' ||
        slot.ownerCreatedAt !== owner.createdAt
      )
        slot = await this.repository.ensureSlot(
          owner.scope,
          owner.createdAt,
          randomUUID(),
        );
      profile = await this.repository.get(selection.profileId);
      if (profile.kind !== 'named')
        throw new BrowserProfileError(
          'invalid_request',
          'Use the Task selection for a task-owned profile.',
        );
    } else {
      let legacy: string | undefined;
      if (
        !slot ||
        (!slot.legacyOwnershipResolved &&
          slot.lifecycle === 'active' &&
          slot.ownerCreatedAt === owner.createdAt)
      ) {
        const partition = legacyBrowserPartition(projectId, worktreeId);
        try {
          const stats = await lstat(this.nativePath(partition));
          if (!stats.isDirectory() || stats.isSymbolicLink())
            throw new BrowserProfileError(
              'recovery_required',
              'The legacy browser storage is not an owned directory.',
            );
          legacy = await this.legacyPartitionForOwner(owner);
          if (!legacy)
            throw new BrowserProfileError(
              'recovery_required',
              'The legacy browser profile has ambiguous ownership and was preserved as a migration source.',
            );
        } catch (error) {
          if (errorCode(error) !== 'ENOENT') throw error;
        }
      }
      profile =
        slot?.lifecycle === 'active' &&
        slot.ownerCreatedAt === owner.createdAt &&
        slot.taskProfileId
          ? await this.repository.get(slot.taskProfileId)
          : await this.repository.ensureTask(
              owner.scope,
              owner.createdAt,
              randomUUID(),
              legacy,
            );
      slot = await this.repository.getTask(owner.scope);
    }
    if (!slot)
      throw new BrowserProfileError(
        'recovery_required',
        'Browser task metadata was not persisted.',
      );
    const agentEnableRequired =
      context.actor === 'agent' && !persisted?.profile;
    if (agentEnableRequired && !profile.agentPermissions.allowEnable)
      throw new BrowserProfileError(
        'agent_enable_denied',
        'This profile does not allow agents to open new tabs. Enable it in Browser settings or use an existing tab.',
      );
    return {
      agentEnableRequired,
      owner,
      profile,
      partition: await this.repository.getNativePartition(
        profile.profileId,
        profile.storageGeneration,
      ),
      binding: {
        selection,
        resolvedProfileId: profile.profileId,
        storageGeneration: profile.storageGeneration,
        runtimeGeneration: (persisted?.profile?.runtimeGeneration ?? 0) + 1,
        taskIncarnationId: slot.incarnationId,
      },
    };
  }

  async assertActive(resolution: BrowserProfileResolution): Promise<void> {
    const owner = await resolveBrowserTaskOwner(
      this.dataRoot,
      resolution.owner.projectId,
      resolution.owner.worktreeId,
    );
    const slot = await this.repository.getTask(resolution.owner.scope);
    if (
      !owner ||
      owner.createdAt !== resolution.owner.createdAt ||
      !slot ||
      slot.lifecycle !== 'active' ||
      slot.incarnationId !== resolution.binding.taskIncarnationId
    )
      throw new BrowserProfileError(
        'scope_retired',
        'The browser task was retired while the operation was pending.',
      );
    const current = await this.repository.get(resolution.profile.profileId);
    if (resolution.agentEnableRequired && !current.agentPermissions.allowEnable)
      throw new BrowserProfileError(
        'agent_enable_denied',
        'Agent enable permission was revoked before the new tab committed.',
      );
    await this.repository.getNativePartition(
      resolution.profile.profileId,
      resolution.binding.storageGeneration,
    );
  }

  async acquireSession(resolution: BrowserProfileResolution): Promise<Session> {
    await this.assertActive(resolution);
    let acquisition = this.sessionAcquisitions.get(resolution.partition);
    if (!acquisition) {
      acquisition = this.initializeSession(
        resolution.profile,
        resolution.partition,
      );
      this.rememberSessionAcquisition(resolution.partition, acquisition);
    }
    return acquisition;
  }

  private rememberSessionAcquisition(
    partition: string,
    acquisition: Promise<Session>,
  ): void {
    this.sessionAcquisitions.set(partition, acquisition);
    void acquisition.catch((error: unknown) => {
      const stickyRecoveryFailure =
        error instanceof BrowserProfileError &&
        error.code === 'recovery_required';
      if (
        !stickyRecoveryFailure &&
        this.sessionAcquisitions.get(partition) === acquisition
      )
        this.sessionAcquisitions.delete(partition);
    });
  }

  async commitBinding<T>(
    resolution: BrowserProfileResolution,
    commit: () => Promise<T>,
  ): Promise<T> {
    await this.assertActive(resolution);
    return this.repository.withActiveBinding(
      {
        profileId: resolution.profile.profileId,
        storageGeneration: resolution.binding.storageGeneration,
        scope: resolution.owner.scope,
        incarnationId: resolution.binding.taskIncarnationId,
        agentEnable: resolution.agentEnableRequired,
      },
      commit,
    );
  }

  private async initializeSession(
    profile: BrowserProfileRecord,
    partition: string,
  ): Promise<Session> {
    const native = session.fromPartition(partition);
    // Track native ownership even if validation fails: Electron still holds the
    // Session and its directory must not be unlinked in this process.
    this.sessions.set(partition, native);
    const nativePath = native.storagePath;
    if (!nativePath || resolve(nativePath) !== this.nativePath(partition)) {
      throw new BrowserProfileError(
        'recovery_required',
        'The browser runtime reported an unexpected storage directory.',
      );
    }
    this.networkPolicies.set(native, new BrowserProfileNetworkPolicy(native));
    native.setPermissionRequestHandler(denyPermission);
    native.setPermissionCheckHandler(() => false);
    await this.repository.recordNativePath(
      profile.profileId,
      profile.storageGeneration,
      nativePath,
    );
    return native;
  }

  isCleanupLoaded(partition: string): boolean {
    return this.sessions.has(partition);
  }

  networkPolicy(native: Session): BrowserProfileNetworkPolicy {
    const policy = this.networkPolicies.get(native);
    if (!policy)
      throw new BrowserProfileError(
        'recovery_required',
        'The browser Session policy is unavailable.',
      );
    return policy;
  }

  async storageDirectory(
    profileId: string,
    generation: number,
  ): Promise<string> {
    const partition = await this.repository.getNativePartition(
      profileId,
      generation,
    );
    const directory = this.nativePath(partition);
    try {
      const entry = await lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new BrowserProfileError(
          'recovery_required',
          'Browser storage is not an owned directory.',
        );
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    return directory;
  }

  /** Global user detail/maintenance; no invented Task owner and no allocation for an unused store. */
  async existingSession(
    profileId: string,
    generation: number,
  ): Promise<Session | undefined> {
    const profile = await this.repository.get(profileId);
    const partition = await this.repository.getNativePartition(
      profileId,
      generation,
    );
    let acquisition = this.sessionAcquisitions.get(partition);
    if (acquisition) return acquisition;
    const directory = await this.storageDirectory(profileId, generation);
    try {
      await lstat(directory);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return undefined;
      throw error;
    }
    acquisition = this.initializeSession(profile, partition);
    this.rememberSessionAcquisition(partition, acquisition);
    return acquisition;
  }

  /** Logical retirement is immediate; a loaded Session's files wait for restart. */
  purgeRetired(): Promise<void> {
    if (this.purge) return this.purge;
    const operation = this.performPurge().finally(() => {
      this.purge = undefined;
    });
    this.purge = operation;
    return operation;
  }
  private async performPurge(): Promise<void> {
    const jobs = await this.repository.getCleanupJobs();
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(2, jobs.length) }, async () => {
        while (cursor < jobs.length) {
          const job = jobs[cursor++];
          try {
            await this.repository.assertCleanupSafe(job);
            const loaded = this.sessions.get(job.partition);
            if (loaded && this.networkPolicy(loaded).hasControls) continue;
            await this.prepareCleanup?.(job);
            if (loaded) {
              if (this.clearedRetiredPartitions.has(job.partition)) continue;
              if (
                !loaded.storagePath ||
                resolve(loaded.storagePath) !== this.nativePath(job.partition)
              ) {
                throw new BrowserProfileError(
                  'recovery_required',
                  'The loaded browser runtime has an unverified storage directory.',
                );
              }
              this.networkPolicy(loaded).fence();
              await clearRetiredBrowserSession(
                loaded,
                this.networkPolicy(loaded),
              );
              this.clearedRetiredPartitions.add(job.partition);
              this.cleanupErrors.delete(job.jobId);
              continue;
            }
            const expected = this.nativePath(job.partition);
            if (job.nativePath && resolve(job.nativePath) !== expected)
              throw new BrowserProfileError(
                'recovery_required',
                'The retired browser directory no longer matches its recorded locator.',
              );
            try {
              const entry = await lstat(expected);
              if (!entry.isDirectory() || entry.isSymbolicLink())
                throw new BrowserProfileError(
                  'recovery_required',
                  'Retired browser storage is not an owned directory.',
                );
              await rm(expected, {
                recursive: true,
                force: true,
                maxRetries: 3,
                retryDelay: 100,
              });
            } catch (error) {
              if (errorCode(error) !== 'ENOENT') throw error;
            }
            await this.repository.completeCleanup(job.jobId);
            this.cleanupErrors.delete(job.jobId);
          } catch (error) {
            this.cleanupErrors.set(
              job.jobId,
              error instanceof BrowserProfileError
                ? error.message
                : 'Browser data cleanup will be retried.',
            );
          }
        }
      }),
    );
  }
}

let singleton: BrowserProfileService | undefined;
export function getBrowserProfileService(): BrowserProfileService {
  singleton ??= new BrowserProfileService(
    getDataDir(),
    app.getPath('sessionData'),
  );
  return singleton;
}

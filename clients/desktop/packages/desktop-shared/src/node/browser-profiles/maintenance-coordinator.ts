import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { opendir, rm } from 'node:fs/promises';
import {
  browserTaskScopeTuple,
  isBrowserTaskScope,
  isProfileId,
  isProfileRecord,
  type BrowserProfileRecord,
  type BrowserProfileUsage,
} from '@canopy/protocol/browser-profiles';
import { readProfileJson, writeProfileJson } from './storage';
import { type BrowserDataJobs } from './data-jobs';
import type {
  BrowserClearPreview,
  BrowserDataActor,
  BrowserDataJob,
  BrowserMaintenanceOperation,
} from '@canopy/protocol/browser-profiles';

export interface BrowserMaintenanceAdapter {
  retirement?(
    preview: BrowserClearPreview,
  ): Promise<{ retired: boolean; cleanupPending: boolean }>;
  profile(profileId: string): Promise<BrowserProfileRecord>;
  /** Includes original task incarnation and independent allowClear. */
  authorize(
    profile: BrowserProfileRecord,
    actor: BrowserDataActor,
  ): Promise<void>;
  usage(profileId: string): Promise<BrowserProfileUsage>;
  scope(
    profile: BrowserProfileRecord,
    operation: BrowserMaintenanceOperation,
  ): Promise<
    Pick<BrowserClearPreview, 'dataClasses' | 'cookieDomains' | 'contexts'>
  >;
  /** Synchronous admission fence also consulted by existing-tab commands. */
  fence(profileId: string): void;
  unfence(profileId: string): void;
  drainCreations(profileId: string): Promise<void>;
  quiesce(preview: BrowserClearPreview): Promise<void>;
  /** Trusted documents inspect every selected context before irreversible work. */
  verifySupported(preview: BrowserClearPreview): Promise<void>;
  /** Rechecks actor/revision/generation under repository writer, invoking before releasing it. */
  invoke(
    preview: BrowserClearPreview,
    actor: BrowserDataActor,
    operationId: string,
    recordAuthorizedIntent: () => Promise<void>,
  ): Promise<{
    completion: Promise<{ storageGeneration: number; cleanupPending: boolean }>;
  }>;
  /** Irreversible replay is authorized by the durable intent, never a newly focused task. */
  recover(
    preview: BrowserClearPreview,
    operationId: string,
  ): Promise<{ storageGeneration: number; cleanupPending: boolean }>;
  verifyCleared(preview: BrowserClearPreview): Promise<void>;
  rebind(preview: BrowserClearPreview, generation: number): Promise<void>;
  /** Cleanup of control targets/network exemption happens before release. */
  release(preview: BrowserClearPreview): Promise<void>;
  resume(preview: BrowserClearPreview): Promise<void>;
}
interface PreviewRecord {
  schemaVersion: 1;
  actor: BrowserDataActor;
  preview: BrowserClearPreview;
  fingerprint: string;
}
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : isProfileRecord(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const hash = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
const sameActor = (a: BrowserDataActor, b: BrowserDataActor): boolean =>
  a.kind === b.kind &&
  (a.kind === 'user' ||
    (b.kind === 'agent' &&
      a.taskIncarnationId === b.taskIncarnationId &&
      JSON.stringify(browserTaskScopeTuple(a.taskScope)) ===
        JSON.stringify(browserTaskScopeTuple(b.taskScope))));
const scopeFingerprint = (
  usage: BrowserProfileUsage,
  scope: Pick<
    BrowserClearPreview,
    'dataClasses' | 'cookieDomains' | 'contexts'
  >,
): string =>
  hash({
    tabs: usage.tabs
      .slice()
      .sort((a, b) => a.browserId.localeCompare(b.browserId)),
    defaults: usage.defaults.map(browserTaskScopeTuple).sort(),
    dataClasses: scope.dataClasses.slice().sort(),
    cookieDomains: scope.cookieDomains.slice().sort(),
    contexts: scope.contexts
      .slice()
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  });

function isUsageTab(
  value: unknown,
): value is BrowserProfileUsage['tabs'][number] {
  return (
    isProfileRecord(value) &&
    isProfileId(value.browserId) &&
    isProfileId(value.projectId) &&
    isProfileId(value.worktreeId) &&
    Number.isSafeInteger(value.runtimeGeneration) &&
    Number(value.runtimeGeneration) >= 1 &&
    (value.taskIncarnationId === undefined ||
      isProfileId(value.taskIncarnationId))
  );
}

function isPreviewContext(
  value: unknown,
): value is BrowserClearPreview['contexts'][number] {
  return (
    isProfileRecord(value) &&
    typeof value.origin === 'string' &&
    typeof value.topLevelOrigin === 'string'
  );
}

function hasErrnoCode(value: unknown): value is { code: string } {
  return isProfileRecord(value) && typeof value.code === 'string';
}

/** Main owns the injected adapter; this coordinator is never exposed as a caller-supplied capability. */
export class BrowserMaintenanceCoordinator {
  private readonly queue: {
    jobId: string;
    record: PreviewRecord;
    recovering: boolean;
  }[] = [];
  private readonly active = new Map<string, Promise<void>>();
  private readonly fenced = new Set<string>();
  private stopping = false;
  private readonly failures = new Map<string, unknown>();
  constructor(
    readonly root: string,
    readonly jobs: BrowserDataJobs,
    private readonly adapter: BrowserMaintenanceAdapter,
    private readonly now = Date.now,
  ) {}
  private path(token: string): string {
    if (!isProfileId(token))
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid browser preview token.',
      );
    return join(this.root, 'previews', `${token}.json`);
  }
  private validateRecord(value: unknown): asserts value is PreviewRecord {
    if (
      !isProfileRecord(value) ||
      value.schemaVersion !== 1 ||
      !isProfileRecord(value.preview) ||
      !isProfileRecord(value.actor) ||
      !['user', 'agent'].includes(String(value.actor.kind)) ||
      typeof value.fingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint)
    )
      throw new BrowserProfileError(
        'recovery_required',
        'The browser preview needs recovery. Original metadata was preserved.',
      );
    const p = value.preview;
    if (
      !isProfileId(p.token) ||
      !isProfileId(p.profileId) ||
      !Number.isSafeInteger(p.storageGeneration) ||
      Number(p.storageGeneration) < 1 ||
      !Number.isSafeInteger(p.metadataRevision) ||
      Number(p.metadataRevision) < 1 ||
      !Number.isSafeInteger(p.expiresAt) ||
      !isProfileRecord(p.operation) ||
      !['cache', 'site', 'reset'].includes(String(p.operation.kind)) ||
      !Array.isArray(p.tabs) ||
      !Array.isArray(p.defaults) ||
      !Array.isArray(p.cookieDomains) ||
      !Array.isArray(p.dataClasses) ||
      !Array.isArray(p.contexts)
    )
      throw new BrowserProfileError(
        'recovery_required',
        'The browser preview is incomplete. Original metadata was preserved.',
      );
    if (
      (value.actor.kind === 'agent' &&
        (!isBrowserTaskScope(value.actor.taskScope) ||
          !isProfileId(value.actor.taskIncarnationId))) ||
      (p.operation.kind === 'site' &&
        (typeof p.operation.origin !== 'string' ||
          p.operation.origin.length > 2048)) ||
      p.tabs.length > 10000 ||
      !p.tabs.every(isUsageTab) ||
      !p.defaults.every(isBrowserTaskScope) ||
      !p.cookieDomains.every((domain) => typeof domain === 'string') ||
      !p.dataClasses.every((entry) => typeof entry === 'string') ||
      p.contexts.length > 1000 ||
      !p.contexts.every(isPreviewContext)
    )
      throw new BrowserProfileError(
        'recovery_required',
        'The browser preview contains invalid scope metadata. Original data was preserved.',
      );
    // Semantic validation is repeated by adapter.scope/authorize before work.
    if (
      scopeFingerprint(
        {
          tabs: p.tabs.filter(isUsageTab),
          defaults: p.defaults.filter(isBrowserTaskScope),
        },
        {
          dataClasses: p.dataClasses.filter(
            (entry): entry is string => typeof entry === 'string',
          ),
          cookieDomains: p.cookieDomains.filter(
            (domain): domain is string => typeof domain === 'string',
          ),
          contexts: p.contexts.filter(isPreviewContext),
        },
      ) !== value.fingerprint
    )
      throw new BrowserProfileError(
        'recovery_required',
        'The browser preview changed unexpectedly. Request a new preview.',
      );
  }
  private async prunePreviews(): Promise<void> {
    let directory;
    try {
      directory = await opendir(join(this.root, 'previews'), {
        bufferSize: 16,
      });
    } catch (error) {
      if (hasErrnoCode(error) && error.code === 'ENOENT') return;
      throw new BrowserProfileError(
        'storage_unavailable',
        'Browser cleanup previews are unavailable. Retry after storage is available.',
      );
    }
    let retained = 0;
    for await (const entry of directory) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.json$/i.test(entry.name))
        continue;
      const path = join(this.root, 'previews', entry.name);
      const value = await readProfileJson(path);
      if (value === undefined) continue;
      this.validateRecord(value);
      if (`${value.preview.token}.json` !== entry.name)
        throw new BrowserProfileError(
          'recovery_required',
          'Browser preview identity is inconsistent. Original metadata was preserved.',
        );
      if (value.preview.expiresAt <= this.now())
        await rm(path, { force: true });
      else if (++retained >= 256)
        throw new BrowserProfileError(
          'storage_unavailable',
          'Too many active cleanup previews. Retry after older previews expire.',
        );
    }
  }
  async preview(
    actor: BrowserDataActor,
    profileId: string,
    generation: number,
    revision: number,
    operation: BrowserMaintenanceOperation,
  ): Promise<BrowserClearPreview> {
    if (this.stopping)
      throw new BrowserProfileError(
        'cancelled',
        'Browser data maintenance is shutting down.',
      );
    if (this.fenced.has(profileId))
      throw new BrowserProfileError(
        'operation_conflict',
        'This profile has pending maintenance. Finish or retry that job first.',
      );
    const profile = await this.adapter.profile(profileId);
    this.assertRevision(profile, generation, revision);
    await this.adapter.authorize(profile, actor);
    await this.prunePreviews();
    const usage = await this.adapter.usage(profileId);
    const scope = await this.adapter.scope(profile, operation);
    const preview: BrowserClearPreview = {
      ...usage,
      ...scope,
      token: randomUUID(),
      profileId,
      storageGeneration: generation,
      metadataRevision: revision,
      operation: structuredClone(operation),
      expiresAt: this.now() + 300_000,
      warning:
        operation.kind === 'reset'
          ? 'All tabs using this profile will reload with empty site data. Profile settings and user-saved downloads are retained.'
          : 'All tabs using this profile will reload. Active downloads stop; user-saved files are retained.',
    };
    await writeProfileJson(this.path(preview.token), {
      schemaVersion: 1,
      actor: structuredClone(actor),
      preview,
      fingerprint: scopeFingerprint(usage, scope),
    } satisfies PreviewRecord);
    return structuredClone(preview);
  }
  private assertRevision(
    profile: BrowserProfileRecord,
    generation: number,
    revision: number,
  ): void {
    if (
      profile.lifecycle !== 'active' ||
      profile.storageGeneration !== generation
    )
      throw new BrowserProfileError(
        'profile_unavailable',
        'This profile changed. Request a new preview.',
      );
    if (profile.metadataRevision !== revision)
      throw new BrowserProfileError(
        'stale_revision',
        'Profile settings changed. Request a new preview.',
      );
  }
  private async validateCurrent(
    record: PreviewRecord,
    actor: BrowserDataActor,
  ): Promise<void> {
    if (!sameActor(record.actor, actor))
      throw new BrowserProfileError(
        'scope_unresolved',
        'This preview belongs to another caller.',
      );
    const preview = record.preview;
    if (this.now() >= preview.expiresAt)
      throw new BrowserProfileError(
        'operation_expired',
        'This preview expired. Request a new preview.',
      );
    const profile = await this.adapter.profile(preview.profileId);
    this.assertRevision(
      profile,
      preview.storageGeneration,
      preview.metadataRevision,
    );
    await this.adapter.authorize(profile, actor);
    const usage = await this.adapter.usage(profile.profileId);
    const scope = await this.adapter.scope(profile, preview.operation);
    if (scopeFingerprint(usage, scope) !== record.fingerprint)
      throw new BrowserProfileError(
        'stale_revision',
        'Affected tabs or site scope changed. Request a new preview.',
      );
  }
  async commit(
    actor: BrowserDataActor,
    operationId: string,
    token: string,
  ): Promise<BrowserDataJob> {
    if (this.stopping)
      throw new BrowserProfileError(
        'cancelled',
        'Browser data maintenance is shutting down.',
      );
    const previewPath = this.path(token);
    // Durable job intent, rather than an expired preview file, authenticates replay.
    const prior = await this.jobs.getForExecution(operationId);
    if (prior) {
      this.validateRecord(prior.intent);
      if (prior.intent.preview.token !== token)
        throw new BrowserProfileError(
          'operation_conflict',
          'This browser operation ID has different input.',
        );
      return this.jobs.get(operationId, actor);
    }
    const value = await readProfileJson(previewPath);
    this.validateRecord(value);
    if (!sameActor(value.actor, actor))
      throw new BrowserProfileError(
        'scope_unresolved',
        'This preview belongs to another caller.',
      );
    if (
      this.fenced.has(value.preview.profileId) ||
      this.queue.length + this.active.size >= 128
    )
      throw new BrowserProfileError(
        'operation_conflict',
        'Browser data maintenance is busy. Finish the current operation before retrying.',
      );
    await this.validateCurrent(value, actor);
    const job = await this.jobs.create(
      operationId,
      {
        profileId: value.preview.profileId,
        storageGeneration: value.preview.storageGeneration,
        kind: value.preview.operation.kind,
      },
      actor,
      value,
    );
    this.enqueue(job.jobId, value, false);
    return job;
  }
  private enqueue(
    jobId: string,
    record: PreviewRecord,
    recovering: boolean,
  ): void {
    if (
      this.active.has(jobId) ||
      this.queue.some((item) => item.jobId === jobId)
    )
      return;
    this.queue.push({ jobId, record, recovering });
    this.pump();
  }
  private pump(): void {
    while (this.active.size < 2) {
      const index = this.queue.findIndex(
        (entry) => !this.fenced.has(entry.record.preview.profileId),
      );
      if (index < 0) return;
      const entry = this.queue.splice(index, 1)[0];
      const operation = this.execute(
        entry.jobId,
        entry.record,
        entry.recovering,
      ).catch((error) => {
        this.failures.set(entry.jobId, error);
      });
      this.active.set(entry.jobId, operation);
      void operation.finally(() => {
        this.active.delete(entry.jobId);
        this.pump();
      });
    }
  }
  private async execute(
    jobId: string,
    record: PreviewRecord,
    recovering: boolean,
  ): Promise<void> {
    const p = record.preview;
    let quiesced = false;
    let irreversible = recovering;
    let complete = false;
    this.fenced.add(p.profileId);
    try {
      const current = await this.jobs.get(jobId, record.actor);
      if (current.status === 'cancelled' || current.status === 'complete')
        return;
      if (recovering) {
        const retirement = await this.adapter.retirement?.(p);
        if (retirement?.retired) {
          await this.adapter.release(p);
          await this.jobs.update(jobId, [current.status], {
            status: 'complete',
            cancellable: false,
            retryable: false,
            cleanupPending: retirement.cleanupPending,
            message:
              'The profile was retired. Its data is unavailable; old files may require restart cleanup.',
          });
          complete = true;
          return;
        }
      }
      if (!recovering) await this.validateCurrent(record, record.actor);
      this.adapter.fence(p.profileId);
      await this.adapter.drainCreations(p.profileId);
      if (this.stopping && !recovering)
        throw new BrowserProfileError(
          'cancelled',
          'Browser data maintenance is shutting down.',
        );
      if (!recovering) {
        await this.validateCurrent(record, record.actor);
        await this.jobs.update(jobId, ['queued'], { status: 'running' });
      }
      // Treat a partial quiescence failure as needing source reload too.
      quiesced = true;
      await this.adapter.quiesce(p);
      if (
        !recovering &&
        (await this.jobs.get(jobId, record.actor)).status === 'cancelled'
      )
        throw new BrowserProfileError(
          'cancelled',
          'Browser data maintenance was cancelled.',
        );
      let result: { storageGeneration: number; cleanupPending: boolean };
      if (recovering) result = await this.adapter.recover(p, jobId);
      else {
        await this.adapter.verifySupported(p);
        if (this.stopping)
          throw new BrowserProfileError(
            'cancelled',
            'Browser data maintenance is shutting down.',
          );
        await this.validateCurrent(record, record.actor);
        const operation = await this.adapter.invoke(
          p,
          record.actor,
          jobId,
          async () => {
            // Adapter calls this after final authorization, inside the repository writer,
            // immediately before native invocation/reset commit. An earlier permission
            // denial must never become an authorization to replay after restart.
            await this.jobs.update(jobId, ['running'], {
              status: 'irreversible',
              cancellable: false,
            });
            irreversible = true;
          },
        );
        result = await operation.completion;
      }
      const retirement = await this.adapter.retirement?.(p);
      if (retirement?.retired) {
        result.cleanupPending = retirement.cleanupPending;
        quiesced = false; // Retired owners never reload. release still tears down the control.
      } else {
        if (p.operation.kind === 'site') await this.adapter.verifyCleared(p);
        await this.adapter.rebind(p, result.storageGeneration);
      }
      await this.adapter.release(p);
      await this.jobs.update(
        jobId,
        recovering ? ['irreversible', 'failed'] : ['irreversible'],
        {
          status: 'complete',
          cancellable: false,
          retryable: false,
          cleanupPending: result.cleanupPending,
          newStorageGeneration: result.storageGeneration,
        },
      );
      complete = true;
    } catch (error) {
      const current = await this.jobs.get(jobId, { kind: 'user' });
      if (current.status !== 'cancelled' && current.status !== 'complete')
        await this.jobs.update(jobId, [current.status], {
          status: 'failed',
          cancellable: false,
          retryable: irreversible,
          message:
            error instanceof BrowserProfileError
              ? error.message
              : 'Browser data maintenance failed. Try again before using this profile.',
        });
      if (irreversible) throw error; // Preserve admission fence until exact-generation recovery succeeds.
    } finally {
      if (!irreversible || complete) {
        if (quiesced && !complete) await this.releaseInterrupted(p, jobId);
        this.adapter.unfence(p.profileId);
        try {
          // Browser admission is open for restoration, but another maintenance
          // job must not capture a partially restored set of native views.
          if (quiesced) await this.adapter.resume(p);
        } finally {
          this.fenced.delete(p.profileId);
        }
      }
    }
  }
  private async releaseInterrupted(
    p: BrowserClearPreview,
    jobId: string,
  ): Promise<void> {
    try {
      await this.adapter.release(p);
    } catch (error) {
      const job = await this.jobs.get(jobId, { kind: 'user' });
      await this.jobs.update(jobId, [job.status], {
        status: 'failed',
        cancellable: false,
        retryable: true,
        message:
          'Stored site data was not changed, but this profile is still paused. Try again or restart before using it.',
      });
      throw error;
    }
  }
  async retry(jobId: string): Promise<BrowserDataJob> {
    const record = await this.jobs.getForExecution(jobId);
    if (!record || record.job.status !== 'failed')
      throw new BrowserProfileError(
        'operation_conflict',
        'This operation needs a new preview.',
      );
    this.validateRecord(record.intent);
    if (this.active.has(jobId)) return record.job;
    if (!record.irreversible) {
      await this.adapter.release(record.intent.preview);
      this.adapter.unfence(record.job.profileId);
      try {
        await this.adapter.resume(record.intent.preview);
      } finally {
        this.fenced.delete(record.job.profileId);
      }
      return this.jobs.update(jobId, ['failed'], {
        status: 'interrupted',
        retryable: false,
        message:
          'No stored site data was changed. Request a new preview to continue.',
      });
    }
    const job = await this.jobs.update(jobId, ['failed'], {
      status: 'irreversible',
      retryable: false,
    });
    this.fenced.delete(job.profileId); // Adapter admission remains paused throughout retry.
    this.enqueue(jobId, record.intent, true);
    return job;
  }
  async recover(): Promise<void> {
    for (const record of await this.jobs.recoveryRecords()) {
      if (!['cache', 'site', 'reset'].includes(record.job.kind)) continue;
      this.validateRecord(record.intent);
      if (record.irreversible) {
        this.adapter.fence(record.job.profileId);
        // Admission is blocked before asynchronous replay starts.
        this.enqueue(record.job.jobId, record.intent, true);
      } else if (record.job.status === 'running') {
        // No destructive invocation was authorized. Source pages may reload on demand.
        await this.jobs.update(record.job.jobId, ['running'], {
          status: 'interrupted',
          cancellable: false,
          message:
            'Maintenance stopped before changing site data. Request a new preview; tabs will reload.',
        });
      } else if (record.job.status === 'queued')
        this.enqueue(record.job.jobId, record.intent, false);
    }
    await this.settled();
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    // Committed work must finish or retain its durable recovery fence. Pre-commit work
    // observes stopping at its next boundary and never invokes a native clear.
    for (const entry of this.queue.splice(0))
      if (!entry.recovering)
        await this.jobs.cancel(entry.jobId, { kind: 'user' });
    await this.settled();
  }
  async settled(): Promise<void> {
    while (this.active.size) await Promise.all(this.active.values());
  }
}

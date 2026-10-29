import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  browserTaskScopeTuple,
  isBrowserTaskScope,
  isProfileId,
  isProfileRecord,
} from '@canopy/protocol/browser-profiles';
import {
  readProfileJson,
  withProfileWriter,
  writeProfileJson,
} from './storage';
import type {
  BrowserDataActor,
  BrowserDataJob,
  BrowserDataJobStatus,
  BrowserDataJobKind,
} from '@canopy/protocol/browser-profiles';

interface JobRecord {
  schemaVersion: 1;
  tombstone?: true;
  actor: BrowserDataActor;
  digest: string;
  irreversible: boolean;
  job: BrowserDataJob;
  /** Adapter-validated internal intent. Never returned by list/get. */
  intent: unknown;
}
interface JobIndex {
  schemaVersion: 1;
  ids: string[];
}
const statuses: BrowserDataJobStatus[] = [
  'queued',
  'running',
  'irreversible',
  'complete',
  'cancelled',
  'failed',
  'interrupted',
];
const kinds: BrowserDataJobKind[] = [
  'inventory',
  'cache',
  'site',
  'reset',
  'download',
];
const isStatus = (value: unknown): value is BrowserDataJobStatus =>
  typeof value === 'string' && statuses.some((status) => status === value);
const isKind = (value: unknown): value is BrowserDataJobKind =>
  typeof value === 'string' && kinds.some((kind) => kind === value);
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function fail(): never {
  throw new BrowserProfileError(
    'recovery_required',
    'Browser data jobs need recovery. Original metadata was preserved.',
  );
}
function actorKey(actor: BrowserDataActor): string {
  if (actor?.kind === 'user') return 'user';
  if (
    actor?.kind !== 'agent' ||
    !isBrowserTaskScope(actor.taskScope) ||
    !isProfileId(actor.taskIncarnationId)
  )
    throw new BrowserProfileError(
      'invalid_request',
      'Invalid browser job owner.',
    );
  return JSON.stringify([
    browserTaskScopeTuple(actor.taskScope),
    actor.taskIncarnationId,
  ]);
}
function validateJob(value: unknown): asserts value is BrowserDataJob {
  if (
    !isProfileRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'jobId',
          'profileId',
          'storageGeneration',
          'kind',
          'status',
          'createdAt',
          'updatedAt',
          'cancellable',
          'retryable',
          'message',
          'approximateBytes',
          'completedEntries',
          'cleanupPending',
          'newStorageGeneration',
        ].includes(key),
    ) ||
    !isProfileId(value.jobId) ||
    !isProfileId(value.profileId) ||
    !count(value.storageGeneration) ||
    value.storageGeneration < 1 ||
    !count(value.createdAt) ||
    !count(value.updatedAt) ||
    !isStatus(value.status) ||
    !isKind(value.kind) ||
    typeof value.cancellable !== 'boolean' ||
    (value.retryable !== undefined && typeof value.retryable !== 'boolean') ||
    (value.cancellable &&
      !['queued', 'running'].includes(String(value.status))) ||
    (value.message !== undefined &&
      (typeof value.message !== 'string' || value.message.length > 1000)) ||
    (value.approximateBytes !== undefined &&
      value.approximateBytes !== null &&
      !count(value.approximateBytes)) ||
    (value.completedEntries !== undefined && !count(value.completedEntries)) ||
    (value.newStorageGeneration !== undefined &&
      (!count(value.newStorageGeneration) || value.newStorageGeneration < 1)) ||
    (value.cleanupPending !== undefined &&
      typeof value.cleanupPending !== 'boolean')
  )
    fail();
}
function validateActor(value: unknown): asserts value is BrowserDataActor {
  if (
    !isProfileRecord(value) ||
    (value.kind !== 'user' &&
      (value.kind !== 'agent' ||
        !isBrowserTaskScope(value.taskScope) ||
        !isProfileId(value.taskIncarnationId)))
  )
    fail();
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (isProfileRecord(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const digest = (value: unknown): string =>
  createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');

/** Durable receipts and original actor identity; never infer a job owner from current focus. */
export class BrowserDataJobs {
  private nextCompaction = 0;
  constructor(
    readonly root: string,
    private readonly now = Date.now,
  ) {}
  private file(id: string): string {
    if (!isProfileId(id))
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid browser job ID.',
      );
    return join(this.root, 'records', `${id}.json`);
  }
  private async index(): Promise<JobIndex> {
    const value = await readProfileJson(join(this.root, 'index.json'));
    if (value === undefined) return { schemaVersion: 1, ids: [] };
    if (
      !isProfileRecord(value) ||
      value.schemaVersion !== 1 ||
      !Array.isArray(value.ids) ||
      value.ids.length > 4096 ||
      !value.ids.every(isProfileId) ||
      new Set(value.ids).size !== value.ids.length
    )
      fail();
    return { schemaVersion: 1, ids: value.ids.filter(isProfileId) };
  }
  private async record(id: string): Promise<JobRecord | undefined> {
    const value = await readProfileJson(this.file(id));
    if (value === undefined) return undefined;
    if (
      !isProfileRecord(value) ||
      value.schemaVersion !== 1 ||
      typeof value.irreversible !== 'boolean' ||
      typeof value.digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.digest)
    )
      fail();
    const job = value.job;
    const actor = value.actor;
    validateJob(job);
    validateActor(actor);
    if (job.jobId !== id) fail();
    actorKey(actor);
    if (
      (!value.tombstone &&
        value.digest !==
          digest({
            input: {
              kind: job.kind,
              profileId: job.profileId,
              storageGeneration: job.storageGeneration,
            },
            actor,
            intent: value.intent,
          })) ||
      (value.tombstone !== undefined &&
        (value.tombstone !== true ||
          value.intent !== undefined ||
          !['complete', 'cancelled', 'interrupted', 'failed'].includes(
            job.status,
          ) ||
          job.retryable ||
          (value.irreversible && job.status !== 'complete'))) ||
      (value.irreversible &&
        (job.cancellable ||
          ['queued', 'running', 'cancelled'].includes(job.status)))
    )
      fail();
    return {
      schemaVersion: 1,
      ...(value.tombstone === true ? { tombstone: true } : {}),
      actor,
      digest: value.digest,
      irreversible: value.irreversible,
      job,
      intent: value.intent,
    };
  }
  private allowed(record: JobRecord, actor: BrowserDataActor): void {
    if (actor.kind !== 'user' && actorKey(actor) !== actorKey(record.actor))
      throw new BrowserProfileError(
        'scope_unresolved',
        'This job belongs to another task.',
      );
  }
  private expired(record: JobRecord): void {
    if (record.tombstone)
      throw new BrowserProfileError(
        'operation_expired',
        'This browser job result has expired. Use a new request ID.',
      );
  }
  /** Compact results, retaining identity/digest and completed publication evidence forever. */
  async compact(): Promise<void> {
    await withProfileWriter(this.root, async () => {
      const index = await this.index(),
        retained: string[] = [];
      for (const id of index.ids) {
        const record = await this.record(id);
        if (!record || record.tombstone) continue;
        const terminal =
          ['complete', 'cancelled', 'interrupted'].includes(
            record.job.status,
          ) ||
          (record.job.status === 'failed' &&
            !record.irreversible &&
            !record.job.retryable);
        if (!terminal || this.now() - record.job.updatedAt < 7 * 86400_000) {
          retained.push(id);
          continue;
        }
        const {
          jobId,
          profileId,
          storageGeneration,
          kind,
          status,
          createdAt,
          updatedAt,
        } = record.job;
        await writeProfileJson(this.file(id), {
          schemaVersion: 1,
          tombstone: true,
          actor: record.actor,
          digest: record.digest,
          irreversible: record.irreversible,
          job: {
            jobId,
            profileId,
            storageGeneration,
            kind,
            status,
            createdAt,
            updatedAt,
            cancellable: false,
          },
        });
      }
      await writeProfileJson(join(this.root, 'index.json'), {
        schemaVersion: 1,
        ids: retained,
      });
      this.nextCompaction = this.now() + 3600_000;
    });
  }
  /** Completed inventory stays readable after its public job receipt expires. */
  async completed(
    id: string,
    profileId: string,
    generation: number,
  ): Promise<boolean> {
    const record = await this.record(id);
    return (
      !!record &&
      record.job.kind === 'inventory' &&
      record.job.status === 'complete' &&
      record.job.profileId === profileId &&
      record.job.storageGeneration === generation
    );
  }
  async create(
    jobId: string,
    input: Pick<BrowserDataJob, 'kind' | 'profileId' | 'storageGeneration'>,
    actor: BrowserDataActor,
    intent: unknown,
  ): Promise<BrowserDataJob> {
    if (this.now() >= this.nextCompaction) await this.compact();
    const capturedActor = structuredClone(actor);
    actorKey(capturedActor);
    const fingerprint = digest({ input, actor: capturedActor, intent });
    return withProfileWriter(this.root, async () => {
      const existing = await this.record(jobId);
      if (existing) {
        this.expired(existing);
        if (existing.digest !== fingerprint)
          throw new BrowserProfileError(
            'operation_conflict',
            'This browser job ID has different input.',
          );
        return structuredClone(existing.job);
      }
      const index = await this.index();
      if (index.ids.length >= 4096)
        throw new BrowserProfileError(
          'storage_unavailable',
          'Too many recent browser jobs. Complete or cancel current work before retrying.',
        );
      const now = this.now();
      const job: BrowserDataJob = {
        ...input,
        jobId,
        createdAt: now,
        updatedAt: now,
        status: 'queued',
        cancellable: true,
      };
      validateJob(job);
      // Index first: a crash may leave an empty reservation, but cannot hide an intent.
      if (!index.ids.includes(jobId)) index.ids.push(jobId);
      await writeProfileJson(join(this.root, 'index.json'), index);
      await writeProfileJson(this.file(jobId), {
        schemaVersion: 1,
        actor: capturedActor,
        digest: fingerprint,
        irreversible: false,
        job,
        intent: structuredClone(intent),
      });
      return structuredClone(job);
    });
  }
  async get(id: string, actor: BrowserDataActor): Promise<BrowserDataJob> {
    const record = await this.record(id);
    if (!record)
      throw new BrowserProfileError(
        'invalid_request',
        'This browser job is unavailable.',
      );
    this.allowed(record, actor);
    this.expired(record);
    return structuredClone(record.job);
  }
  async list(
    actor: BrowserDataActor,
    offset = 0,
    profileId?: string,
  ): Promise<{ jobs: BrowserDataJob[]; nextOffset?: number }> {
    actorKey(actor);
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      (profileId !== undefined && !isProfileId(profileId))
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid browser job page.',
      );
    const jobs: BrowserDataJob[] = [];
    const ids = (await this.index()).ids.slice().reverse();
    let cursor = offset;
    for (; cursor < ids.length && jobs.length < 100; cursor++) {
      const record = await this.record(ids[cursor]);
      if (
        !record ||
        record.tombstone ||
        (profileId && record.job.profileId !== profileId) ||
        (actor.kind !== 'user' && actorKey(actor) !== actorKey(record.actor))
      )
        continue;
      jobs.push(structuredClone(record.job));
    }
    return { jobs, ...(cursor < ids.length ? { nextOffset: cursor } : {}) };
  }
  /** Trusted adapter only, never IPC. Updates never replace captured identity/input. */
  async update(
    id: string,
    expected: BrowserDataJobStatus[],
    patch: Partial<
      Pick<
        BrowserDataJob,
        | 'status'
        | 'cancellable'
        | 'retryable'
        | 'message'
        | 'approximateBytes'
        | 'completedEntries'
        | 'cleanupPending'
        | 'newStorageGeneration'
      >
    >,
    beforeSave?: () => Promise<void>,
  ): Promise<BrowserDataJob> {
    return withProfileWriter(this.root, async () => {
      const record = await this.record(id);
      if (!record) fail();
      this.expired(record);
      if (!expected.includes(record.job.status))
        throw new BrowserProfileError(
          'operation_conflict',
          'The browser job has already advanced.',
        );
      const job = { ...record.job, ...patch, updatedAt: this.now() };
      validateJob(job);
      if (
        record.irreversible &&
        (job.cancellable ||
          ['queued', 'running', 'cancelled'].includes(job.status))
      )
        throw new BrowserProfileError(
          'operation_conflict',
          'This browser operation can no longer be cancelled.',
        );
      await beforeSave?.();
      await writeProfileJson(this.file(id), {
        ...record,
        irreversible: record.irreversible || job.status === 'irreversible',
        job,
      });
      return structuredClone(job);
    });
  }
  async cancel(id: string, actor: BrowserDataActor): Promise<BrowserDataJob> {
    // Recheck under the writer: a queued cancellation cannot undo a commit.
    return withProfileWriter(this.root, async () => {
      const record = await this.record(id);
      if (!record) fail();
      this.expired(record);
      this.allowed(record, actor);
      if (record.job.status === 'cancelled') return structuredClone(record.job);
      if (record.irreversible || !record.job.cancellable)
        throw new BrowserProfileError(
          'operation_conflict',
          'This browser operation can no longer be cancelled.',
        );
      const job = {
        ...record.job,
        status: 'cancelled' as const,
        cancellable: false,
        updatedAt: this.now(),
      };
      await writeProfileJson(this.file(id), { ...record, job });
      return structuredClone(job);
    });
  }
  /** Trusted adapter read; the record and intent never cross IPC. */
  async getForExecution(id: string): Promise<JobRecord | undefined> {
    const record = await this.record(id);
    if (record) this.expired(record);
    return record;
  }
  /** Internal startup iterator. Caller validates each intent before recovery. */
  async recoveryRecords(): Promise<JobRecord[]> {
    const result: JobRecord[] = [];
    for (const id of (await this.index()).ids) {
      const record = await this.record(id);
      if (
        record &&
        !record.tombstone &&
        !['complete', 'cancelled', 'interrupted'].includes(record.job.status)
      )
        result.push(structuredClone(record));
    }
    return result;
  }
}

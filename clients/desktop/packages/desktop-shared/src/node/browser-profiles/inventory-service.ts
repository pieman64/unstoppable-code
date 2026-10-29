import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { join } from 'node:path';
import {
  isProfileId,
  isProfileRecord,
} from '@canopy/protocol/browser-profiles';
import { type BrowserDataJobs } from './data-jobs';
import { type BrowserObservedSites } from './observed-sites';
import type {
  BrowserInventoryHandle,
  BrowserInventoryQueue,
} from './inventory-queue';
import type { BrowserInventoryTotals } from './inventory-scan';
import { readProfileJson, writeProfileJson } from './storage';
import type {
  BrowserDataJob,
  BrowserProfileInventory,
} from '@canopy/protocol/browser-profiles';

interface InventoryRecord {
  schemaVersion: 1;
  profileId: string;
  storageGeneration: number;
  jobId: string;
  measuredAt: number;
  totals: BrowserInventoryTotals;
  cookieDomains: { domain: string; count: number }[];
  cookiesMeasured: boolean;
  truncated: boolean;
}
interface InventoryAuthority {
  withGeneration<T>(
    profileId: string,
    generation: number,
    action: () => Promise<T>,
  ): Promise<T>;
  /** Validated native directory only. A missing unused store remains lazy. */
  directory(profileId: string, generation: number): Promise<string>;
  cookies(
    profileId: string,
    generation: number,
  ): Promise<{
    domains: { domain: string; count: number }[];
    measured: boolean;
    truncated: boolean;
  }>;
  assertAvailable(profileId: string): void;
}

interface ActiveInventoryState {
  jobId: string;
  generation: number;
  handle?: BrowserInventoryHandle;
  completion: Promise<void>;
  cancelled: boolean;
}

function isInventoryTotals(value: unknown): value is BrowserInventoryTotals {
  return (
    isProfileRecord(value) &&
    (value.approximateBytes === null ||
      (Number.isSafeInteger(value.approximateBytes) &&
        Number(value.approximateBytes) >= 0)) &&
    Number.isSafeInteger(value.files) &&
    Number(value.files) >= 0 &&
    Number.isSafeInteger(value.directories) &&
    Number(value.directories) >= 0 &&
    Number.isSafeInteger(value.skippedEntries) &&
    Number(value.skippedEntries) >= 0 &&
    typeof value.partial === 'boolean'
  );
}

function isCookieDomain(
  value: unknown,
): value is { domain: string; count: number } {
  return (
    isProfileRecord(value) &&
    Object.keys(value).every((key) => ['domain', 'count'].includes(key)) &&
    typeof value.domain === 'string' &&
    /^[a-z0-9.:[\]-]+$/i.test(value.domain) &&
    value.domain.length <= 254 &&
    Number.isSafeInteger(value.count) &&
    Number(value.count) >= 0
  );
}

/** User-detail service. Ordinary profile listings do not call this class. */
export class BrowserProfileInventoryService {
  private readonly admissions = new Map<string, Promise<BrowserDataJob>>();
  private readonly active = new Map<string, ActiveInventoryState>();
  constructor(
    readonly root: string,
    private readonly authority: InventoryAuthority,
    private readonly queue: BrowserInventoryQueue,
    private readonly observations: BrowserObservedSites,
    private readonly jobs: BrowserDataJobs,
    private readonly now = Date.now,
  ) {}
  private file(profileId: string, generation: number): string {
    if (
      !isProfileId(profileId) ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid browser inventory identity.',
      );
    return join(this.root, `${profileId}-g${generation}.json`);
  }
  private async record(
    profileId: string,
    generation: number,
  ): Promise<InventoryRecord | undefined> {
    const value = await readProfileJson(this.file(profileId, generation));
    if (value === undefined) return undefined;
    if (
      !isProfileRecord(value) ||
      value.schemaVersion !== 1 ||
      value.profileId !== profileId ||
      value.storageGeneration !== generation ||
      !isProfileId(value.jobId) ||
      typeof value.measuredAt !== 'number' ||
      !Number.isSafeInteger(value.measuredAt) ||
      !isInventoryTotals(value.totals) ||
      typeof value.cookiesMeasured !== 'boolean' ||
      typeof value.truncated !== 'boolean' ||
      !Array.isArray(value.cookieDomains) ||
      value.cookieDomains.length > 1000 ||
      !value.cookieDomains.every(isCookieDomain)
    )
      throw new BrowserProfileError(
        'recovery_required',
        'Browser inventory metadata needs recovery. Original files were preserved.',
      );
    return {
      schemaVersion: 1,
      profileId,
      storageGeneration: generation,
      jobId: value.jobId,
      measuredAt: value.measuredAt,
      totals: value.totals,
      cookieDomains: value.cookieDomains,
      cookiesMeasured: value.cookiesMeasured,
      truncated: value.truncated,
    };
  }
  async get(
    profileId: string,
    generation: number,
    offset = 0,
  ): Promise<BrowserProfileInventory> {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new BrowserProfileError(
        'invalid_request',
        'Invalid inventory page.',
      );
    // Flush before taking the repository writer, since observation publication uses it too.
    const sites = await this.observations.read(profileId, generation);
    return this.authority.withGeneration(profileId, generation, async () => {
      const stored = await this.record(profileId, generation);
      // A process can stop after writing the measurement but before its receipt.
      // Only a completed job publishes it; cancellation never exposes a partial commit.
      const measured =
        stored &&
        (await this.jobs.completed(stored.jobId, profileId, generation))
          ? stored
          : undefined;
      const cookies = measured?.cookieDomains ?? [];
      const nextOffset =
        Math.max(sites.sites.length, cookies.length) > offset + 100
          ? offset + 100
          : undefined;
      return {
        profileId,
        storageGeneration: generation,
        ...(measured ? { jobId: measured.jobId } : {}),
        measuredAt: measured?.measuredAt ?? null,
        approximateBytes: measured?.totals.approximateBytes ?? null,
        coverage: measured || sites.sites.length ? 'partial' : 'unknown',
        classBytes: { cache: null, indexedDB: null, opfs: null },
        sites: sites.sites.slice(offset, offset + 100),
        cookieDomains: cookies.slice(offset, offset + 100),
        truncated: sites.truncated || !!measured?.truncated,
        ...(nextOffset === undefined ? {} : { nextOffset }),
      };
    });
  }
  start(
    operationId: string,
    profileId: string,
    generation: number,
  ): Promise<BrowserDataJob> {
    const operation = (this.admissions.get(profileId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.startSerialized(operationId, profileId, generation));
    this.admissions.set(profileId, operation);
    void operation
      .finally(() => {
        if (this.admissions.get(profileId) === operation)
          this.admissions.delete(profileId);
      })
      .catch(() => undefined);
    return operation;
  }
  private async startSerialized(
    operationId: string,
    profileId: string,
    generation: number,
  ): Promise<BrowserDataJob> {
    this.file(profileId, generation);
    this.authority.assertAvailable(profileId);
    await this.authority.withGeneration(profileId, generation, async () => {});
    const existing = this.active.get(profileId);
    if (existing && !existing.cancelled && existing.generation === generation)
      return this.jobs.get(existing.jobId, { kind: 'user' });
    if (existing) await this.cancelProfile(profileId);
    if (this.active.size >= 128)
      throw new BrowserProfileError(
        'storage_unavailable',
        'Browser inventory is busy. Retry after current measurements finish.',
      );
    const job = await this.jobs.create(
      operationId,
      { kind: 'inventory', profileId, storageGeneration: generation },
      { kind: 'user' },
      { profileId, generation },
    );
    if (job.status !== 'queued') return job;
    const state: ActiveInventoryState = {
      jobId: job.jobId,
      generation,
      completion: Promise.resolve(),
      cancelled: false,
    };
    this.active.set(profileId, state);
    state.completion = this.perform(profileId, state).finally(() => {
      if (this.active.get(profileId) === state) this.active.delete(profileId);
    });
    void state.completion.catch(() => undefined);
    return job;
  }
  private async perform(
    profileId: string,
    state: ActiveInventoryState,
  ): Promise<void> {
    const { jobId, generation } = state;
    let progressWrite: Promise<void> | undefined;
    let latestProgress: BrowserInventoryTotals | undefined;
    try {
      const directory = await this.authority.directory(profileId, generation);
      if (state.cancelled)
        throw new BrowserProfileError(
          'cancelled',
          'Browser inventory was cancelled.',
        );
      this.authority.assertAvailable(profileId);
      await this.jobs.update(jobId, ['queued'], { status: 'running' });
      state.handle = this.queue.run(
        profileId,
        generation,
        directory,
        (totals) => {
          if (state.cancelled) return;
          // Coalesce progress while a metadata write is outstanding.
          latestProgress = totals;
          if (!progressWrite)
            progressWrite = (async (): Promise<void> => {
              while (latestProgress && !state.cancelled) {
                const current = latestProgress;
                latestProgress = undefined;
                await this.jobs.update(jobId, ['running'], {
                  approximateBytes: current.approximateBytes,
                  completedEntries: current.files + current.directories,
                });
              }
            })()
              .catch(() => {
                state.cancelled = true;
                void state.handle?.cancel();
              })
              .finally(() => {
                progressWrite = undefined;
              });
        },
      );
      const totals = await state.handle.result;
      await progressWrite;
      if (state.cancelled)
        throw new BrowserProfileError(
          'cancelled',
          'Browser inventory was cancelled.',
        );
      const cookies = await this.authority.cookies(profileId, generation);
      await this.authority.withGeneration(profileId, generation, async () => {
        this.authority.assertAvailable(profileId);
        if (state.cancelled)
          throw new BrowserProfileError(
            'cancelled',
            'Browser inventory was cancelled.',
          );
        const record: InventoryRecord = {
          schemaVersion: 1,
          profileId,
          storageGeneration: generation,
          jobId,
          measuredAt: this.now(),
          totals,
          cookieDomains: cookies.domains
            .slice(0, 1000)
            .map(({ domain, count }) => ({ domain, count })),
          cookiesMeasured: cookies.measured,
          truncated: cookies.truncated || cookies.domains.length > 1000,
        };
        await this.jobs.update(
          jobId,
          ['running'],
          {
            status: 'complete',
            cancellable: false,
            approximateBytes: totals.approximateBytes,
            completedEntries: totals.files + totals.directories,
          },
          () => writeProfileJson(this.file(profileId, generation), record),
        );
      });
    } catch (error) {
      const job = await this.jobs.get(jobId, { kind: 'user' });
      if (!['cancelled', 'complete'].includes(job.status)) {
        try {
          await this.jobs.update(jobId, [job.status], {
            status: state.cancelled ? 'cancelled' : 'failed',
            cancellable: false,
            message: state.cancelled
              ? 'Browser inventory was cancelled.'
              : error instanceof BrowserProfileError
                ? error.message
                : 'Browser data could not be measured. Retry measurement.',
          });
        } catch (publicationError) {
          // Cancellation can commit while worker exit is publishing its outcome.
          // Preserve the terminal receipt instead of failing cancellation itself.
          if (
            !['cancelled', 'complete'].includes(
              (await this.jobs.get(jobId, { kind: 'user' })).status,
            )
          )
            throw publicationError;
        }
      }
    }
  }
  async cancelProfile(profileId: string, generation?: number): Promise<void> {
    const active = this.active.get(profileId);
    if (
      !active ||
      (generation !== undefined && active.generation !== generation)
    )
      return;
    active.cancelled = true;
    const job = await this.jobs.get(active.jobId, { kind: 'user' });
    if (job.cancellable) {
      try {
        await this.jobs.cancel(active.jobId, { kind: 'user' });
      } catch (error) {
        if (
          ['queued', 'running'].includes(
            (await this.jobs.get(active.jobId, { kind: 'user' })).status,
          )
        )
          throw error;
      }
    }
    await active.handle?.cancel();
    await active.completion;
  }
  async cancelJob(jobId: string): Promise<void> {
    for (const [profileId, active] of Array.from(this.active))
      if (active.jobId === jobId) await this.cancelProfile(profileId);
  }
  async recover(): Promise<void> {
    for (const { job } of await this.jobs.recoveryRecords())
      if (job.kind === 'inventory')
        await this.jobs.update(job.jobId, [job.status], {
          status: 'interrupted',
          cancellable: false,
          message:
            'Measurement was interrupted by restart. Measure again for a current summary.',
        });
  }
  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.active.keys(), (id) => this.cancelProfile(id)),
    );
  }
}

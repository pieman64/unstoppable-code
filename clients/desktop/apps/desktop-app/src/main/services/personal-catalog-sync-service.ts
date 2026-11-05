import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  damagedCopiesOf,
  pruneDamagedCopies,
} from '@canopy/desktop-shared/node/lib/damaged-copies';
import type { PersonalCatalogRegistration } from '@canopy/protocol/org-projects';
import { writeFileAtomically } from '../lib/atomic-file';
import { logMainProcessError } from '../lib/main-process-logging';
import { CanopyCloudClientError } from '../canopy-cloud/client';
import type { PersonalCatalogPayload } from './personal-catalog-payload';

const integer = z.number().int().min(0).max(2147483646);
const coordinate = z.string().regex(/^[a-zA-Z0-9_.-]{1,255}$/);
const payloadSchema = z
  .object({
    personalCatalogId: z.string().uuid(),
    name: z.string().min(1).max(256),
    kind: z.enum(['CODE', 'COWORK']),
    topology: z.enum(['SINGLE_REPO', 'MULTI_REPO']),
    location: z.literal('LOCAL'),
    repositories: z
      .array(
        z
          .object({
            host: coordinate,
            ownerLogin: coordinate,
            repoName: coordinate,
          })
          .strict(),
      )
      .max(100),
    deviceId: z.string().uuid(),
    installationGeneration: integer,
    localWorkspaceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  })
  .strict();
const stateSchema = z
  .object({
    version: z.literal(1),
    accountId: z.string(),
    catalogGeneration: integer,
    revisions: z.record(z.string(), integer),
    accepted: z.record(z.string(), z.string().max(64)),
    /** Fingerprints dropped by the seven-day expiry; identical payloads are not re-queued. */
    expired: z.record(z.string(), z.string().max(64)).default({}),
    /** Permanently rejected payloads remain suppressed until changed or re-enrolled. */
    rejected: z.record(z.string(), z.string().max(64)).default({}),
    queue: z
      .array(
        z
          .object({
            payload: payloadSchema,
            revision: integer,
            queuedAt: z.number(),
            restorePersonalCatalog: z.literal(true).optional(),
          })
          .strict(),
      )
      .max(1000),
  })
  .strict();
type OutboxState = z.infer<typeof stateSchema>;
export interface PersonalCatalogSyncDependencies {
  file: string;
  accountId: string;
  allowed: () => Promise<boolean>;
  send: (body: unknown, signal: AbortSignal) => Promise<unknown>;
  generation: (signal: AbortSignal) => Promise<{
    catalogGeneration: number;
    revisions: Record<string, number>;
    minimumInstallationGeneration?: number;
  }>;
  bumpInstallation: (minimum?: number) => Promise<number>;
  notice: (message: 'collision' | 'removed' | 'full' | 'failed') => void;
}
const restoreMarkerSchema = z
  .object({
    version: z.literal(2),
    accountId: z.string(),
    catalogGeneration: integer,
  })
  .strict();
/** Explicit enrollment intent survives outbox recovery, but never crosses accounts. */
export async function markPersonalCatalogRestore(
  file: string,
  accountId: string,
  catalogGeneration: number,
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFileAtomically(
    `${file}.restore.json`,
    JSON.stringify(
      restoreMarkerSchema.parse({ version: 2, accountId, catalogGeneration }),
    ),
    { mode: 0o600 },
  );
}
const REQUEST_MAX_BYTES = 256 * 1024;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
function isFileSystemError(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  );
}
const replySchema = z.object({
  catalogGeneration: integer,
  registrations: z.array(
    z.object({ personalCatalogId: z.string().uuid(), revision: integer }),
  ),
});

/** One account-bound instance. Credentials belong to the injected sender. */
export class PersonalCatalogSyncService {
  private state: OutboxState | null = null;
  private controller = new AbortController();
  private stopped = false;
  private tail: Promise<void> = Promise.resolve();
  private retryAt = 0;
  private attempts = 0;
  constructor(private readonly deps: PersonalCatalogSyncDependencies) {}
  private serialize(work: () => Promise<void>): Promise<void> {
    const result = this.tail.then(work);
    this.tail = result.catch((): void => {});
    return result;
  }
  private async save(): Promise<void> {
    if (this.stopped || !this.state) return;
    const json = JSON.stringify(this.state);
    if (Buffer.byteLength(json) > MAX_BYTES)
      throw new Error('Personal catalog queue is full');
    await mkdir(dirname(this.deps.file), { recursive: true });
    await writeFileAtomically(this.deps.file, json, { mode: 0o600 });
  }
  private async load(): Promise<void> {
    if (this.state) return;
    try {
      const raw = await readFile(this.deps.file, 'utf8');
      if (Buffer.byteLength(raw) > MAX_BYTES)
        throw new Error('Invalid catalog queue');
      const value = stateSchema.parse(JSON.parse(raw));
      if (value.accountId !== this.deps.accountId)
        throw new Error('Invalid catalog owner');
      this.state = value;
    } catch (error) {
      if (isFileSystemError(error)) {
        if (error.code !== 'ENOENT') throw error;
      } else {
        // Malformed, oversized, unsupported or foreign-account outbox data:
        // recover with empty defaults and keep the file for diagnosis, the
        // same silent fallback every other persisted file follows.
        await this.preserveCorruptFile(error);
      }
      // Never fetch a fresh removal fence for an existing queue or on retries.
      const initial = await this.deps
        .generation(this.controller.signal)
        .catch(async (error: unknown): Promise<never> => {
          await rm(`${this.deps.file}.restore.json`, { force: true });
          throw error;
        });
      this.state = {
        version: 1,
        accountId: this.deps.accountId,
        catalogGeneration: initial.catalogGeneration,
        revisions: initial.revisions,
        accepted: {},
        expired: {},
        rejected: {},
        queue: [],
      };
      await this.save();
    }
  }
  private async hasRestoreIntent(): Promise<boolean> {
    try {
      const marker = restoreMarkerSchema.safeParse(
        JSON.parse(await readFile(`${this.deps.file}.restore.json`, 'utf8')),
      );
      if (
        marker.success &&
        marker.data.accountId === this.deps.accountId &&
        marker.data.catalogGeneration === this.state?.catalogGeneration
      )
        return true;
      await rm(`${this.deps.file}.restore.json`, { force: true });
      return false;
    } catch {
      await rm(`${this.deps.file}.restore.json`, { force: true });
      return false;
    }
  }
  private async preserveCorruptFile(error: unknown): Promise<void> {
    logMainProcessError(
      'Personal catalog outbox was unreadable and has been reset',
      error,
    );
    try {
      await rename(this.deps.file, `${this.deps.file}.corrupt-${Date.now()}`);
    } catch {
      // The fresh save below replaces whatever could not be moved aside.
    }
    await pruneDamagedCopies(damagedCopiesOf(this.deps.file, '.corrupt-'));
  }
  /** Drop entries past the seven-day bound and remember them so an unchanged payload is not renewed. */
  private pruneExpired(now: number): void {
    if (!this.state) return;
    const kept: OutboxState['queue'] = [];
    for (const entry of this.state.queue) {
      if (now - entry.queuedAt < MAX_AGE) kept.push(entry);
      else
        this.state.expired[entry.payload.personalCatalogId] = fingerprint(
          entry.payload,
        );
    }
    this.state.queue = kept;
  }
  enqueue(payloads: PersonalCatalogPayload[]): Promise<void> {
    return this.serialize(async (): Promise<void> => {
      if (this.stopped || !(await this.deps.allowed())) return;
      await this.load();
      if (!this.state || this.stopped) return;
      const now = Date.now();
      this.pruneExpired(now);
      const restore = await this.hasRestoreIntent();
      for (const raw of payloads) {
        const parsed = payloadSchema.safeParse(raw);
        if (!parsed.success) {
          logMainProcessError(
            'Skipped malformed personal catalog workspace',
            new Error('Invalid registration payload'),
          );
          continue;
        }
        const payload = parsed.data;
        const hash = fingerprint(payload);
        if (this.state.rejected[payload.personalCatalogId] === hash) continue;
        delete this.state.rejected[payload.personalCatalogId];
        if (this.state.accepted[payload.personalCatalogId] === hash) continue;
        if (this.state.expired[payload.personalCatalogId] === hash) continue;
        delete this.state.expired[payload.personalCatalogId];
        const index = this.state.queue.findIndex(
          (queued) =>
            queued.payload.personalCatalogId === payload.personalCatalogId,
        );
        const pending = index >= 0 ? this.state.queue[index] : undefined;
        // Unchanged pending work keeps its queuedAt so the expiry can be reached.
        if (pending && fingerprint(pending.payload) === hash) continue;
        const entry: OutboxState['queue'][number] = {
          payload,
          revision: this.state.revisions[payload.personalCatalogId] ?? 0,
          queuedAt: now,
          // Only separately persisted user intent authorizes restoration.
          ...(restore &&
          this.state.catalogGeneration > 0 &&
          (this.state.revisions[payload.personalCatalogId] ?? 0) > 0 &&
          !this.state.accepted[payload.personalCatalogId]
            ? { restorePersonalCatalog: true }
            : {}),
        };
        const queue = [...this.state.queue];
        if (index >= 0) queue[index] = entry;
        else if (queue.length < 1000) queue.push(entry);
        else {
          this.deps.notice('full');
          break;
        }
        if (
          Buffer.byteLength(JSON.stringify({ ...this.state, queue })) >
          MAX_BYTES
        ) {
          this.deps.notice('full');
          break;
        }
        this.state.queue = queue;
      }
      await this.save();
    });
  }
  flush(): Promise<void> {
    return this.serialize(async (): Promise<void> => {
      if (
        this.stopped ||
        Date.now() < this.retryAt ||
        !(await this.deps.allowed())
      )
        return;
      await this.load();
      if (!this.state || this.stopped) return;
      this.pruneExpired(Date.now());
      if (!(await this.hasRestoreIntent())) {
        for (const entry of this.state.queue)
          delete entry.restorePersonalCatalog;
      }
      const entries: OutboxState['queue'] = [];
      const body: {
        catalogGeneration: number;
        registrations: PersonalCatalogRegistration[];
      } = {
        catalogGeneration: this.state.catalogGeneration,
        registrations: [],
      };
      for (const entry of this.state.queue.slice(0, 20)) {
        const registration: PersonalCatalogRegistration = {
          ...entry.payload,
          revision: entry.revision,
          ...(entry.restorePersonalCatalog
            ? { restorePersonalCatalog: true }
            : {}),
        };
        const candidate = {
          ...body,
          registrations: [...body.registrations, registration],
        };
        // One schema-bounded registration fits; always make progress on it.
        if (
          entries.length > 0 &&
          Buffer.byteLength(JSON.stringify(candidate)) > REQUEST_MAX_BYTES
        )
          break;
        entries.push(entry);
        body.registrations.push(registration);
      }
      if (entries.length === 0) return;
      try {
        if (!(await this.deps.allowed()) || this.stopped) return;
        const reply = replySchema.parse(
          await this.deps.send(body, this.controller.signal),
        );
        if (this.stopped || !(await this.deps.allowed())) return;
        if (
          reply.catalogGeneration !== this.state.catalogGeneration ||
          entries.some(
            (entry) =>
              !reply.registrations.some(
                (result) =>
                  result.personalCatalogId === entry.payload.personalCatalogId,
              ),
          )
        )
          throw new Error('Incomplete registration acknowledgement');
        for (const entry of entries) {
          const result = reply.registrations.find(
            (row) => row.personalCatalogId === entry.payload.personalCatalogId,
          );
          if (!result) continue;
          this.state.revisions[result.personalCatalogId] = result.revision;
          this.state.accepted[result.personalCatalogId] = fingerprint(
            entry.payload,
          );
          delete this.state.expired[result.personalCatalogId];
        }
        this.state.queue.splice(0, entries.length);
        if (this.state.queue.length === 0) {
          await rm(`${this.deps.file}.restore.json`, { force: true });
        }
        this.attempts = 0;
        this.retryAt = 0;
        await this.save();
      } catch (error) {
        if (this.stopped) return;
        if (
          error instanceof CanopyCloudClientError &&
          error.serverCode === 'personal_catalog_device_collision'
        ) {
          const current = await this.deps.generation(this.controller.signal);
          if (this.stopped || !(await this.deps.allowed())) return;
          if (current.catalogGeneration !== this.state.catalogGeneration) {
            this.state.queue = [];
            await this.save();
            this.stopped = true;
            this.deps.notice('removed');
            return;
          }
          const generation = await this.deps.bumpInstallation(
            current.minimumInstallationGeneration,
          );
          if (this.stopped) return;
          const recovered = this.withServerRevisions(
            this.state,
            current.revisions,
          );
          for (const entry of recovered.queue)
            entry.payload.installationGeneration = generation;
          this.deps.notice('collision');
          await this.commitRecovery(recovered);
        } else if (
          error instanceof CanopyCloudClientError &&
          error.status === 409 &&
          error.serverCode === 'personal_catalog_removed'
        ) {
          this.state.queue = [];
          this.stopped = true;
          this.deps.notice('removed');
          // Preserve the stale fence. Only an explicit disable/re-enable drops it.
          await mkdir(dirname(this.deps.file), { recursive: true });
          await writeFileAtomically(
            this.deps.file,
            JSON.stringify(this.state),
            { mode: 0o600 },
          );
        } else if (
          error instanceof CanopyCloudClientError &&
          error.status === 409 &&
          error.serverCode === 'conflict' &&
          entries.some((entry) => entry.restorePersonalCatalog)
        ) {
          const current = await this.deps.generation(this.controller.signal);
          if (this.stopped || !(await this.deps.allowed())) return;
          if (current.catalogGeneration !== this.state.catalogGeneration) {
            this.state.queue = [];
            await this.save();
            this.stopped = true;
            this.deps.notice('removed');
            return;
          }
          const advanced = entries.some(
            (entry): boolean =>
              (current.revisions[entry.payload.personalCatalogId] ??
                entry.revision) > entry.revision,
          );
          const recovered = this.withServerRevisions(
            this.state,
            current.revisions,
          );
          if (!advanced) {
            await this.failBatch(entries.length, recovered);
            return;
          }
          await this.commitRecovery(recovered);
        } else if (
          error instanceof CanopyCloudClientError &&
          error.status === 409 &&
          (error.serverCode === 'not_restorable' ||
            error.serverCode === 'catalog_limit')
        ) {
          await this.failBatch(entries.length);
          return;
        } else if (
          error instanceof CanopyCloudClientError &&
          error.status !== undefined &&
          error.status >= 400 &&
          error.status < 500 &&
          error.status !== 429
        ) {
          this.stopped = true;
          this.deps.notice('failed');
        }
        this.attempts += 1;
        this.retryAt =
          Date.now() +
          Math.max(
            error instanceof CanopyCloudClientError
              ? (error.retryAfterMs ?? 0)
              : 0,
            Math.min(300_000, 1000 * 2 ** Math.min(this.attempts, 8)) *
              (0.75 + Math.random() * 0.5),
          );
      }
    });
  }
  private async failBatch(
    count: number,
    base: OutboxState | null = this.state,
  ): Promise<void> {
    if (!base) return;
    const next: OutboxState = {
      ...base,
      rejected: { ...base.rejected },
      queue: base.queue.slice(count),
    };
    // Registration batches are transactional; none of these entries committed.
    for (const entry of base.queue.slice(0, count)) {
      next.rejected[entry.payload.personalCatalogId] = fingerprint(
        entry.payload,
      );
    }
    if (next.queue.length === 0)
      await rm(`${this.deps.file}.restore.json`, { force: true });
    this.attempts = 0;
    this.retryAt = 0;
    await this.commitRecovery(next);
    this.deps.notice('failed');
  }
  /** A copy with refreshed CAS revisions; the live state is replaced only by commitRecovery. */
  private withServerRevisions(
    base: OutboxState,
    revisions: Record<string, number>,
  ): OutboxState {
    const merged = { ...base.revisions, ...revisions };
    const queue = base.queue.map((entry): OutboxState['queue'][number] => {
      const revision =
        revisions[entry.payload.personalCatalogId] ?? entry.revision;
      merged[entry.payload.personalCatalogId] = revision;
      return { ...entry, revision, payload: { ...entry.payload } };
    });
    return { ...base, revisions: merged, queue };
  }
  /**
   * Recovery must never persist past the byte bound: shed the newest queued
   * entries (the next sync re-admits them through enqueue) until it fits.
   */
  private async commitRecovery(next: OutboxState): Promise<void> {
    let size = Buffer.byteLength(JSON.stringify(next));
    let trimmed = false;
    while (next.queue.length > 0 && size > MAX_BYTES) {
      const dropped = next.queue.pop();
      // An array element costs its bytes plus one separator unless it was the last.
      size -=
        Buffer.byteLength(JSON.stringify(dropped)) +
        (next.queue.length > 0 ? 1 : 0);
      trimmed = true;
    }
    this.state = next;
    if (trimmed) this.deps.notice('full');
    await this.save();
  }
  dispose(): void {
    this.stopped = true;
    this.controller.abort();
  }
  disable(): Promise<void> {
    this.dispose();
    return this.serialize(async (): Promise<void> => {
      this.state = null;
      await rm(this.deps.file, { force: true });
      await rm(`${this.deps.file}.restore.json`, { force: true });
    });
  }
}
import { createHash } from 'node:crypto';
function fingerprint(payload: PersonalCatalogPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

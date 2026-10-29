import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isProfileId,
  isProfileRecord,
  isBrowserTaskScope,
  type BrowserTaskScope,
} from '@canopy/protocol/browser-profiles';
import {
  readProfileJson,
  withProfileWriter,
  writeProfileJson,
} from './storage';

export interface BrowserScratchOwner {
  browserId: string;
  profileId: string;
  storageGeneration: number;
  runtimeGeneration: number;
  taskIncarnationId: string;
  taskScope: BrowserTaskScope;
}
interface ScratchRecord {
  id: string;
  owner: BrowserScratchOwner;
  bytes: number;
  extension: 'png' | 'md';
  status: 'reserved' | 'complete' | 'deleting';
  createdAt: number;
}
interface ScratchCatalog {
  schemaVersion: 1;
  records: Record<string, ScratchRecord>;
}
interface ScratchOptions {
  /** Internal dependency for authority and deterministic quota tests, never IPC. */
  withOwner: <T>(
    owner: BrowserScratchOwner,
    commit: () => Promise<T>,
  ) => Promise<T>;
  profileLimitBytes?: number;
  globalLimitBytes?: number;
}
const validCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
function validateOwner(owner: unknown): asserts owner is BrowserScratchOwner {
  if (
    !isProfileRecord(owner) ||
    !isProfileId(owner.browserId) ||
    !isProfileId(owner.profileId) ||
    !isProfileId(owner.taskIncarnationId) ||
    !isBrowserTaskScope(owner.taskScope) ||
    !validCount(owner.storageGeneration) ||
    owner.storageGeneration < 1 ||
    !validCount(owner.runtimeGeneration) ||
    owner.runtimeGeneration < 1
  )
    throw new BrowserProfileError(
      'invalid_request',
      'Invalid browser scratch ownership.',
    );
}

/** Quota covers app-owned files and in-flight reservations, never user downloads. */
export class BrowserOwnedScratch {
  private readonly active = new Map<
    string,
    { owner: BrowserScratchOwner; completion: Promise<string> }
  >();
  constructor(
    readonly root: string,
    private readonly options: ScratchOptions,
  ) {}

  private async directory(): Promise<string> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (!root.isDirectory() || root.isSymbolicLink())
      throw new BrowserProfileError(
        'recovery_required',
        'Browser scratch ownership needs recovery.',
      );
    const directory = join(this.root, 'files');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new BrowserProfileError(
        'recovery_required',
        'Browser scratch ownership needs recovery.',
      );
    return directory;
  }
  private async catalog(): Promise<ScratchCatalog> {
    const value = await readProfileJson(join(this.root, 'jobs.json'));
    if (value === undefined) return { schemaVersion: 1, records: {} };
    if (
      !isProfileRecord(value) ||
      value.schemaVersion !== 1 ||
      !isProfileRecord(value.records)
    )
      throw new BrowserProfileError(
        'recovery_required',
        'Browser scratch records need recovery.',
      );
    const records: Record<string, ScratchRecord> = {};
    for (const [id, record] of Object.entries(value.records)) {
      if (
        !isProfileId(id) ||
        !isProfileRecord(record) ||
        record.id !== id ||
        !validCount(record.bytes) ||
        !validCount(record.createdAt) ||
        !['png', 'md'].includes(String(record.extension)) ||
        !['reserved', 'complete', 'deleting'].includes(String(record.status))
      )
        throw new BrowserProfileError(
          'recovery_required',
          'Browser scratch records need recovery.',
        );
      validateOwner(record.owner);
      const extension = record.extension;
      const status = record.status;
      if (
        (extension !== 'png' && extension !== 'md') ||
        (status !== 'reserved' &&
          status !== 'complete' &&
          status !== 'deleting')
      )
        throw new BrowserProfileError(
          'recovery_required',
          'Browser scratch records need recovery.',
        );
      records[id] = {
        id,
        owner: record.owner,
        bytes: record.bytes,
        extension,
        status,
        createdAt: record.createdAt,
      };
    }
    return { schemaVersion: 1, records };
  }
  private save(value: ScratchCatalog): Promise<void> {
    return writeProfileJson(join(this.root, 'jobs.json'), value);
  }
  write(
    owner: BrowserScratchOwner,
    extension: 'png' | 'md',
    buffer: Buffer,
  ): Promise<string> {
    validateOwner(owner);
    if (!['png', 'md'].includes(extension))
      throw new BrowserProfileError(
        'invalid_request',
        'Unsupported browser scratch type.',
      );
    const captured = structuredClone(owner);
    const id = randomUUID();
    const completion = this.performWrite(id, captured, extension, buffer);
    this.active.set(id, { owner: captured, completion });
    void completion
      .finally(() => this.active.delete(id))
      .catch(() => undefined);
    return completion;
  }
  private async performWrite(
    id: string,
    owner: BrowserScratchOwner,
    extension: 'png' | 'md',
    buffer: Buffer,
  ): Promise<string> {
    const directory = await this.directory();
    const file = join(directory, `${id}.${extension}`);
    await this.options.withOwner(owner, () =>
      withProfileWriter(this.root, async () => {
        const catalog = await this.catalog();
        const records = Object.values(catalog.records);
        const allBytes = records.reduce((sum, record) => sum + record.bytes, 0);
        const profileBytes = records
          .filter((record) => record.owner.profileId === owner.profileId)
          .reduce((sum, record) => sum + record.bytes, 0);
        if (
          records.length >= 10_000 ||
          profileBytes + buffer.byteLength >
            (this.options.profileLimitBytes ?? 256 * 1024 * 1024) ||
          allBytes + buffer.byteLength >
            (this.options.globalLimitBytes ?? 1024 * 1024 * 1024)
        )
          throw new BrowserProfileError(
            'storage_unavailable',
            'Browser temporary data quota reached. Close browser tabs or clear their temporary data, then retry.',
          );
        catalog.records[id] = {
          id,
          owner,
          bytes: buffer.byteLength,
          extension,
          status: 'reserved',
          createdAt: Date.now(),
        };
        await this.save(catalog);
      }),
    );
    let created = false;
    try {
      const handle = await open(file, 'wx', 0o600);
      created = true;
      try {
        await handle.writeFile(buffer);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.options.withOwner(owner, () =>
        withProfileWriter(this.root, async () => {
          const catalog = await this.catalog();
          if (catalog.records[id]?.status !== 'reserved')
            throw new BrowserProfileError(
              'cancelled',
              'Browser temporary data was cancelled.',
            );
          catalog.records[id].status = 'complete';
          await this.save(catalog);
        }),
      );
      return file;
    } catch (error) {
      await withProfileWriter(this.root, async () => {
        const catalog = await this.catalog();
        if (created) {
          await this.directory();
          await rm(file, { force: true });
        }
        delete catalog.records[id];
        await this.save(catalog);
      });
      throw error;
    }
  }

  async drain(match: (owner: BrowserScratchOwner) => boolean): Promise<void> {
    await Promise.allSettled(
      Array.from(this.active.values())
        .filter((entry) => match(entry.owner))
        .map((entry) => entry.completion),
    );
  }

  async cleanup(match: (owner: BrowserScratchOwner) => boolean): Promise<void> {
    await this.directory();
    // Mark before waiting so an in-flight writer cannot publish its file.
    await withProfileWriter(this.root, async () => {
      const catalog = await this.catalog();
      for (const record of Object.values(catalog.records))
        if (match(record.owner)) record.status = 'deleting';
      await this.save(catalog);
    });
    await Promise.allSettled(
      Array.from(this.active.values())
        .filter((entry) => match(entry.owner))
        .map((entry) => entry.completion),
    );
    await withProfileWriter(this.root, async () => {
      const catalog = await this.catalog();
      const directory = await this.directory();
      for (const record of Object.values(catalog.records)) {
        if (record.status !== 'deleting' || !match(record.owner)) continue;
        await rm(join(directory, `${record.id}.${record.extension}`), {
          force: true,
        });
        delete catalog.records[record.id];
      }
      await this.save(catalog);
    });
  }

  /** Called once before new producers start. Never discovers ownership by filename. */
  async recover(): Promise<void> {
    await this.directory();
    const abandoned = new Set<string>();
    const catalog = await withProfileWriter(this.root, () => this.catalog());
    for (const record of Object.values(catalog.records)) {
      if (record.status !== 'complete') {
        abandoned.add(record.id);
        continue;
      }
      try {
        await this.options.withOwner(record.owner, () => Promise.resolve());
      } catch {
        abandoned.add(record.id);
      }
    }
    await withProfileWriter(this.root, async () => {
      const current = await this.catalog();
      const directory = await this.directory();
      for (const id of Array.from(abandoned)) {
        const record = current.records[id];
        if (!record) continue;
        await rm(join(directory, `${record.id}.${record.extension}`), {
          force: true,
        });
        delete current.records[id];
      }
      await this.save(current);
    });
  }
}

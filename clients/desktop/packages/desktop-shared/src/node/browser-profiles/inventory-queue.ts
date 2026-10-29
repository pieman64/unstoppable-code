import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import { isProfileRecord } from '@canopy/protocol/browser-profiles';
import type { BrowserInventoryTotals } from './inventory-scan';

export interface BrowserInventoryWorker {
  once(event: 'exit', listener: (code: number) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  postMessage(message: unknown): void;
  kill(): unknown;
}
export interface BrowserInventoryHandle {
  profileId: string;
  storageGeneration: number;
  result: Promise<BrowserInventoryTotals>;
  cancel(): Promise<void>;
}
interface RecordState {
  profileId: string;
  storageGeneration: number;
  directory: string;
  handle: BrowserInventoryHandle;
  worker?: BrowserInventoryWorker;
  totals?: BrowserInventoryTotals;
  failure?: Error;
  timer?: ReturnType<typeof setTimeout>;
  resolve: (value: BrowserInventoryTotals) => void;
  reject: (error: Error) => void;
  exited: Promise<void>;
  finishExit: () => void;
  onProgress?: (totals: BrowserInventoryTotals) => void;
}
function totals(value: unknown): value is BrowserInventoryTotals {
  if (!isProfileRecord(value)) return false;
  const v = value;
  return (
    (v.approximateBytes === null ||
      (Number.isSafeInteger(v.approximateBytes) &&
        Number(v.approximateBytes) >= 0)) &&
    ['files', 'directories', 'skippedEntries'].every(
      (key) => Number.isSafeInteger(v[key]) && Number(v[key]) >= 0,
    ) &&
    typeof v.partial === 'boolean'
  );
}

/** A result message or a kill request never frees a still-live worker's slot. */
export class BrowserInventoryQueue {
  private readonly queued: RecordState[] = [];
  private readonly active = new Set<RecordState>();
  private readonly records = new Set<RecordState>();
  private shuttingDown = false;
  constructor(
    private readonly spawn: () => BrowserInventoryWorker,
    private readonly timeoutMs = 600_000,
  ) {}

  run(
    profileId: string,
    storageGeneration: number,
    directory: string,
    onProgress?: (totals: BrowserInventoryTotals) => void,
  ): BrowserInventoryHandle {
    if (this.shuttingDown)
      throw new BrowserProfileError(
        'cancelled',
        'Browser inventory is shutting down.',
      );
    const existing = Array.from(this.records).find(
      (record) =>
        record.profileId === profileId &&
        record.storageGeneration === storageGeneration &&
        !record.failure,
    );
    if (existing) return existing.handle;
    if (this.records.size >= 128)
      throw new BrowserProfileError(
        'storage_unavailable',
        'Browser inventory is busy. Retry after current jobs finish.',
      );
    for (const record of Array.from(this.records))
      if (record.profileId === profileId) void record.handle.cancel();
    let resolve: RecordState['resolve'] = () => undefined;
    let reject: RecordState['reject'] = () => undefined;
    const result = new Promise<BrowserInventoryTotals>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    let finishExit = (): void => undefined;
    const exited = new Promise<void>((yes) => {
      finishExit = yes;
    });
    const record: RecordState = {
      profileId,
      storageGeneration,
      directory,
      resolve,
      reject,
      exited,
      finishExit,
      onProgress,
      handle: {
        profileId,
        storageGeneration,
        result,
        cancel: () => {
          this.stop(
            record,
            new BrowserProfileError(
              'cancelled',
              'Browser inventory was cancelled.',
            ),
          );
          return record.exited;
        },
      },
    };
    this.records.add(record);
    this.queued.push(record);
    this.pump();
    return record.handle;
  }
  private finish(record: RecordState, exitCode = 0): void {
    clearTimeout(record.timer);
    this.records.delete(record);
    this.active.delete(record);
    const index = this.queued.indexOf(record);
    if (index >= 0) this.queued.splice(index, 1);
    if (record.failure) record.reject(record.failure);
    else if (exitCode !== 0 || !record.totals)
      record.reject(
        new BrowserProfileError(
          'storage_unavailable',
          'The inventory worker exited before completing its measurement.',
        ),
      );
    else record.resolve(record.totals);
    record.finishExit();
    this.pump();
  }
  private stop(record: RecordState, error: Error): void {
    if (!this.records.has(record)) return;
    record.failure ??= error;
    if (!record.worker) {
      this.finish(record);
      return;
    }
    try {
      record.worker.kill();
    } catch {
      // Keep the slot occupied. The caller may retry cancellation or restart.
    }
  }
  private pump(): void {
    if (this.shuttingDown) return;
    while (this.active.size < 2) {
      const next = this.queued.find(
        (record) =>
          !Array.from(this.active).some(
            (active) => active.profileId === record.profileId,
          ),
      );
      if (!next) return;
      this.queued.splice(this.queued.indexOf(next), 1);
      this.active.add(next);
      try {
        const worker = this.spawn();
        next.worker = worker;
        worker.once('exit', (code) => this.finish(next, code));
        worker.once('error', () =>
          this.stop(
            next,
            new BrowserProfileError(
              'storage_unavailable',
              'The inventory worker failed.',
            ),
          ),
        );
        worker.on('message', (message) => {
          if (next.failure || !this.records.has(next)) return;
          const raw =
            message && typeof message === 'object' && 'data' in message
              ? message.data
              : message;
          if (!isProfileRecord(raw)) {
            this.stop(
              next,
              new BrowserProfileError(
                'storage_unavailable',
                'The inventory worker returned an invalid response.',
              ),
            );
            return;
          }
          const value = raw;
          if (
            value.profileId !== next.profileId ||
            value.storageGeneration !== next.storageGeneration ||
            !['progress', 'complete'].includes(String(value.kind)) ||
            !totals(value.totals)
          ) {
            this.stop(
              next,
              new BrowserProfileError(
                'storage_unavailable',
                'The inventory worker returned an invalid response.',
              ),
            );
            return;
          }
          const measured: BrowserInventoryTotals = {
            approximateBytes: value.totals.approximateBytes,
            files: value.totals.files,
            directories: value.totals.directories,
            skippedEntries: value.totals.skippedEntries,
            partial: value.totals.partial,
          };
          if (value.kind === 'complete') {
            next.totals = measured;
            try {
              worker.postMessage({
                kind: 'ack',
                profileId: next.profileId,
                storageGeneration: next.storageGeneration,
              });
            } catch {
              this.stop(
                next,
                new BrowserProfileError(
                  'storage_unavailable',
                  'The inventory worker could not finish its result handoff.',
                ),
              );
            }
          } else {
            try {
              next.onProgress?.(measured);
            } catch {
              this.stop(
                next,
                new BrowserProfileError(
                  'storage_unavailable',
                  'Browser inventory progress could not be saved.',
                ),
              );
            }
          }
        });
        next.timer = setTimeout(
          () =>
            this.stop(
              next,
              new BrowserProfileError(
                'storage_unavailable',
                'Browser inventory exceeded its time limit.',
              ),
            ),
          this.timeoutMs,
        );
        next.timer.unref?.();
        worker.postMessage({
          profileId: next.profileId,
          storageGeneration: next.storageGeneration,
          directory: next.directory,
        });
      } catch {
        this.stop(
          next,
          new BrowserProfileError(
            'storage_unavailable',
            'The inventory worker could not start.',
          ),
        );
      }
    }
  }
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.all(
      Array.from(this.records, (record) => record.handle.cancel()),
    );
  }
}

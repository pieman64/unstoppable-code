import { randomUUID } from 'node:crypto';
import type { BrowserDataJobs } from '@canopy/desktop-shared/node/browser-profiles/data-jobs';
import type { DownloadItem, Session, WebContents } from 'electron';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types/browser';
import type { BrowserTaskScope } from '@canopy/protocol/browser-profiles';
import {
  BrowserTaskFiles,
  type BrowserTaskFilesScope,
} from './files/task-files';

export interface BrowserDownloadOwner {
  downloadId: string;
  browserId: string;
  projectId: string;
  worktreeId: string;
  taskScope: BrowserTaskScope;
  taskIncarnationId: string;
  profileId: string;
  storageGeneration: number;
  runtimeGeneration: number;
}

/** Download ownership is captured once; replacing its originating view cannot retarget it. */
export class BrowserDownloads {
  private readonly owners = new WeakMap<DownloadItem, BrowserDownloadOwner>();
  private readonly active = new Map<DownloadItem, BrowserDownloadOwner>();
  private readonly sessions = new Map<
    Session,
    (event: Electron.Event, item: DownloadItem, contents: WebContents) => void
  >();
  private readonly writes = new Map<string, Promise<void>>();
  private readonly progressTimers = new Map<
    DownloadItem,
    ReturnType<typeof setTimeout>
  >();
  private readonly stopFailureListener: () => void;
  constructor(
    private readonly resolve: (
      contentsId: number,
    ) => BrowserSessionSnapshot | undefined,
    private jobs?: BrowserDataJobs,
    private readonly taskFiles = new BrowserTaskFiles({
      emit: (): void => undefined,
    }),
  ) {
    // A record the store could not keep is failed; its download must stop.
    this.stopFailureListener = this.taskFiles.onDownloadFailed((id): void => {
      for (const [item, owner] of Array.from(this.active))
        if (owner.downloadId === id) {
          try {
            item.cancel();
          } catch {
            this.active.delete(item);
          }
        }
    });
  }

  private resumeAuthority?: (
    owner: BrowserDownloadOwner,
    resume: () => void,
  ) => Promise<void>;
  setResumeAuthority(
    authorize: NonNullable<BrowserDownloads['resumeAuthority']>,
  ): void {
    this.resumeAuthority = authorize;
  }

  private startObserver?: (browserId: string, url: string) => void;
  /** Hears of every download a known browser starts, admitted or not: the page load that led to it is over either way. */
  setStartObserver(observer: (browserId: string, url: string) => void): void {
    this.startObserver = observer;
  }

  attachJobs(jobs: BrowserDataJobs): void {
    if (this.jobs && this.jobs !== jobs)
      throw new Error('Browser download ownership is already configured.');
    this.jobs = jobs;
  }

  observe(session: Session): void {
    if (this.sessions.has(session)) return;
    const listener = (
      _event: Electron.Event,
      item: DownloadItem,
      contents: WebContents,
    ): void => {
      const source = contents && this.resolve(contents.id);
      if (source) this.startObserver?.(source.id, item.getURL());
      if (!source?.profile || !source.taskScope) {
        // No ambient task/account fallback for detached or unknown producers.
        item.cancel();
        return;
      }
      const owner: BrowserDownloadOwner = {
        downloadId: randomUUID(),
        browserId: source.id,
        projectId: source.projectId,
        worktreeId: source.worktreeId,
        taskScope: structuredClone(source.taskScope),
        taskIncarnationId: source.profile.taskIncarnationId,
        profileId: source.profile.resolvedProfileId,
        storageGeneration: source.profile.storageGeneration,
        runtimeGeneration: source.profile.runtimeGeneration,
      };
      const runtime = {
        browserId: owner.browserId,
        runtimeGeneration: owner.runtimeGeneration,
        taskIncarnationId: owner.taskIncarnationId,
      };
      const admission = this.taskFiles.admitDownload({
        scope: owner,
        runtime,
        downloadId: owner.downloadId,
        suggestedName: item.getFilename(),
        url: item.getURL(),
        mimeType: item.getMimeType(),
        totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null,
        source: this.taskFiles.attributionFor(runtime) ? 'agent' : 'user',
      });
      if (!admission.ok) {
        item.cancel();
        return;
      }
      try {
        item.setSavePath(admission.stagingPath);
      } catch {
        void this.taskFiles.discardDownload(owner.downloadId, 'failed', {
          code: 'download_failed',
          message: 'The download could not be saved.',
        });
        item.cancel();
        return;
      }
      this.owners.set(item, owner);
      this.active.set(item, owner);
      item.on('updated', (_event, state: string): void => {
        if (!this.active.has(item)) return;
        const interrupted = state === 'interrupted';
        this.taskFiles.updateDownload(owner.downloadId, {
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null,
          // The hold for the ownership write is this handler's own. Nothing
          // pauses a download for the user, so a held item is still in progress.
          status: interrupted ? 'interrupted' : 'in_progress',
          canResume: interrupted && item.canResume(),
        });
      });
      const jobs = this.jobs;
      item.pause();
      this.persist(
        owner,
        async () => {
          if (jobs)
            await jobs.create(
              owner.downloadId,
              {
                kind: 'download',
                profileId: owner.profileId,
                storageGeneration: owner.storageGeneration,
              },
              {
                kind: 'agent',
                taskScope: owner.taskScope,
                taskIncarnationId: owner.taskIncarnationId,
              },
              owner,
            );
          await this.taskFiles.drain();
          if (
            this.taskFiles.get(owner, owner.downloadId)?.status === 'failed'
          ) {
            item.cancel();
            return;
          }
          if (this.active.has(item) && item.getState() === 'progressing') {
            if (jobs)
              await jobs.update(owner.downloadId, ['queued'], {
                status: 'running',
              });
            const resume = (): void => {
              if (this.active.has(item) && item.getState() === 'progressing') {
                item.resume();
                this.taskFiles.updateDownload(owner.downloadId, {
                  status: 'in_progress',
                  canResume: false,
                });
              }
            };
            if (this.resumeAuthority) await this.resumeAuthority(owner, resume);
            else resume();
          }
        },
        item,
      );
      if (jobs) {
        item.on('updated', () => {
          if (!this.active.has(item) || this.progressTimers.has(item)) return;
          const timer = setTimeout(() => {
            this.progressTimers.delete(item);
            if (!this.active.has(item)) return;
            let bytes: number;
            try {
              bytes = item.getReceivedBytes();
            } catch {
              return;
            }
            if (!Number.isSafeInteger(bytes) || bytes < 0) return;
            this.persist(
              owner,
              async () => {
                const job = await jobs.get(owner.downloadId, {
                  kind: 'user',
                });
                if (job.status === 'running')
                  await jobs.update(owner.downloadId, ['running'], {
                    approximateBytes: bytes,
                  });
              },
              item,
            );
          }, 250);
          timer.unref?.();
          this.progressTimers.set(item, timer);
        });
      }
      item.once('done', (_event, state: string) => {
        // A disposed handler no longer speaks for its items. They stop as the
        // app quits, which is not the user's cancel: the record is left for
        // the next start to recover as interrupted.
        if (!this.active.delete(item)) return;
        clearTimeout(this.progressTimers.get(item));
        this.progressTimers.delete(item);
        this.taskFiles.updateDownload(owner.downloadId, {
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes() > 0 ? item.getTotalBytes() : null,
        });
        this.persist(
          owner,
          async (): Promise<void> => {
            if (state === 'completed')
              await this.taskFiles.completeDownload(owner.downloadId);
            else
              await this.taskFiles.discardDownload(
                owner.downloadId,
                state === 'cancelled' ? 'cancelled' : 'interrupted',
                state === 'cancelled'
                  ? undefined
                  : {
                      code: 'download_failed',
                      message: 'The download was interrupted.',
                    },
              );
            if (!jobs) return;
            const job = await jobs.get(owner.downloadId, { kind: 'user' });
            if (['complete', 'cancelled', 'interrupted'].includes(job.status))
              return;
            const transfer = this.taskFiles.get(owner, owner.downloadId);
            await jobs.update(owner.downloadId, ['queued', 'running'], {
              status:
                transfer?.status === 'complete'
                  ? 'complete'
                  : transfer?.status === 'cancelled'
                    ? 'cancelled'
                    : 'interrupted',
              cancellable: false,
              ...(transfer?.error ? { message: transfer.error.message } : {}),
            });
          },
          item,
        );
      });
    };
    this.sessions.set(session, listener);
    session.on('will-download', listener);
  }

  private persist(
    owner: BrowserDownloadOwner,
    action: () => Promise<void>,
    item: DownloadItem,
  ): void {
    const operation = (this.writes.get(owner.downloadId) ?? Promise.resolve())
      .then(action)
      .catch(() => {
        // A producer cannot continue without durable ownership; task files owns partial cleanup.
        if (this.active.has(item)) {
          try {
            item.cancel();
          } catch {
            this.active.delete(item);
          }
        }
      });
    this.writes.set(owner.downloadId, operation);
    void operation.finally(() => {
      if (this.writes.get(owner.downloadId) === operation)
        this.writes.delete(owner.downloadId);
    });
  }
  async recover(): Promise<void> {
    if (!this.jobs) return;
    for (const record of await this.jobs.recoveryRecords()) {
      if (record.job.kind !== 'download') continue;
      await this.jobs.update(record.job.jobId, [record.job.status], {
        status: 'interrupted',
        cancellable: false,
        message:
          'Download interrupted by restart. Automatic resume is unavailable.',
      });
    }
  }
  async drain(): Promise<void> {
    while (this.writes.size) await Promise.all(this.writes.values());
    await this.taskFiles.drain();
  }
  /** True means a matching live control was queued; drain and read the transfer to observe authority's outcome. */
  cancelDownload(scope: BrowserTaskFilesScope, id: string): boolean {
    const entry = Array.from(this.active).find(
      ([, owner]): boolean =>
        owner.downloadId === id &&
        owner.projectId === scope.projectId &&
        owner.worktreeId === scope.worktreeId,
    );
    if (!entry) return false;
    const [item, owner] = entry;
    const cancel = (): void => {
      if (this.active.get(item) === owner) item.cancel();
    };
    this.persist(
      owner,
      async (): Promise<void> => {
        try {
          if (this.resumeAuthority) await this.resumeAuthority(owner, cancel);
          else cancel();
        } catch {
          /* Owner authority denied the live control. */
        }
      },
      item,
    );
    return true;
  }
  async resumeDownload(
    scope: BrowserTaskFilesScope,
    id: string,
  ): Promise<boolean> {
    const entry = Array.from(this.active).find(
      ([, owner]): boolean =>
        owner.downloadId === id &&
        owner.projectId === scope.projectId &&
        owner.worktreeId === scope.worktreeId,
    );
    if (!entry) return false;
    const [item, owner] = entry;
    if (item.getState() !== 'interrupted' || !item.canResume()) return false;
    let resumed = false;
    this.persist(
      owner,
      async (): Promise<void> => {
        const resume = (): void => {
          if (
            this.active.get(item) !== owner ||
            item.getState() !== 'interrupted' ||
            !item.canResume()
          )
            return;
          item.resume();
          resumed = true;
          this.taskFiles.updateDownload(id, {
            status: 'in_progress',
            canResume: false,
          });
        };
        try {
          if (this.resumeAuthority) await this.resumeAuthority(owner, resume);
          else resume();
        } catch {
          /* A fenced owner leaves its partial download interrupted. */
        }
      },
      item,
    );
    await this.writes.get(id);
    return resumed;
  }
  cancelJob(jobId: string): void {
    for (const [item, owner] of Array.from(this.active))
      if (owner.downloadId === jobId) item.cancel();
  }
  owner(item: DownloadItem): BrowserDownloadOwner | undefined {
    const owner = this.owners.get(item);
    return owner ? structuredClone(owner) : undefined;
  }
  listActive(): BrowserDownloadOwner[] {
    return Array.from(this.active.values(), (owner) => structuredClone(owner));
  }
  cancelProfile(profileId: string, generation?: number): void {
    for (const [item, owner] of Array.from(this.active))
      if (
        owner.profileId === profileId &&
        (generation === undefined || owner.storageGeneration === generation)
      )
        item.cancel();
  }
  cancelTask(projectId: string, worktreeId: string): void {
    for (const [item, owner] of Array.from(this.active))
      if (owner.projectId === projectId && owner.worktreeId === worktreeId)
        item.cancel();
  }
  /**
   * Quitting is not the user's cancel. Live items stop without a record of
   * one, and the next start recovers their transfers and jobs as interrupted.
   */
  async shutdown(): Promise<void> {
    const items = Array.from(this.active.keys());
    this.dispose();
    for (const item of items) {
      try {
        item.cancel();
      } catch {
        /* The item already went with its session. */
      }
    }
    await this.drain();
  }
  dispose(): void {
    this.stopFailureListener();
    for (const [session, listener] of Array.from(this.sessions))
      session.removeListener('will-download', listener);
    this.sessions.clear();
    for (const timer of Array.from(this.progressTimers.values()))
      clearTimeout(timer);
    this.progressTimers.clear();
    this.active.clear();
  }
}

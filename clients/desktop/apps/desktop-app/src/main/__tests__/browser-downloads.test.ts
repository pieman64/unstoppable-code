import { mkdtempSync } from 'node:fs';
import { BrowserTaskFiles } from '../browser/files/task-files';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserDataJobs } from '@canopy/desktop-shared/node/browser-profiles/data-jobs';
import { EventEmitter } from 'node:events';
import type { DownloadItem, Session, WebContents } from 'electron';
import type { BrowserSessionSnapshot } from '@canopy/desktop-shared/types/browser';
import {
  BrowserDownloads,
  type BrowserDownloadOwner,
} from '../browser/browser-downloads';

function fixture(): {
  native: EventEmitter;
  downloads: BrowserDownloads;
  source: BrowserSessionSnapshot;
  start: () => EventEmitter & { cancel: jest.Mock };
} {
  const source = {
    id: 'tab',
    projectId: 'project',
    worktreeId: 'task',
    taskScope: { kind: 'worktree', projectId: 'project', worktreeId: 'task' },
    profile: {
      selection: { kind: 'named', profileId: 'source' },
      resolvedProfileId: 'source',
      storageGeneration: 1,
      runtimeGeneration: 2,
      taskIncarnationId: 'incarnation',
    },
  } as BrowserSessionSnapshot;
  const native = new EventEmitter();
  const root = mkdtempSync(join(tmpdir(), 'browser-download-owner-'));
  roots.push(root);
  const files = new BrowserTaskFiles({
    emit: (): void => undefined,
    platform: 'linux',
    taskDir: (): string => root,
  });
  const downloads = new BrowserDownloads(
    (id) => (id === 42 ? source : undefined),
    undefined,
    files,
  );
  instances.push(downloads);
  downloads.observe(native as Session);
  return {
    native,
    downloads,
    source,
    start: (): EventEmitter & { cancel: jest.Mock } => {
      const item = Object.assign(new Item(), { cancel: jest.fn() });
      native.emit('will-download', {}, item, { id: 42 } as WebContents);
      return item;
    },
  };
}

const roots: string[] = [];
const instances: BrowserDownloads[] = [];
afterEach(async () => {
  for (const instance of instances.splice(0)) {
    instance.dispose();
    await instance.drain();
  }
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe('native browser download ownership', () => {
  it('captures the originating account once and keeps it after the logical tab switches', () => {
    const { native, downloads, source, start } = fixture();
    downloads.observe(native as Session);
    expect(native.listenerCount('will-download')).toBe(1);
    const item = start();
    const original = downloads.owner(item as unknown as DownloadItem);
    source.profile = {
      ...source.profile,
      resolvedProfileId: 'destination',
      runtimeGeneration: 3,
    } as NonNullable<BrowserSessionSnapshot['profile']>;
    expect(downloads.listActive()).toEqual([original]);
    downloads.cancelProfile('destination');
    expect(item.cancel).not.toHaveBeenCalled();
    downloads.cancelProfile('source');
    expect(item.cancel).toHaveBeenCalledTimes(1);
    item.emit('done', {}, 'completed');
    expect(downloads.listActive()).toEqual([]);
    // This registry never owns a user's selected filesystem destination.
    expect(downloads.owner(item as unknown as DownloadItem)).toEqual(original);
    downloads.dispose();
    expect(native.listenerCount('will-download')).toBe(0);
  });
  it('cancels only downloads belonging to the retiring task, and refuses unknown producers', () => {
    const { native, downloads, source, start } = fixture();
    const first = start();
    source.worktreeId = 'other';
    const other = start();
    downloads.cancelTask('project', 'task');
    expect(first.cancel).toHaveBeenCalledTimes(1);
    expect(other.cancel).not.toHaveBeenCalled();
    const unknown = { cancel: jest.fn() };
    native.emit('will-download', {}, unknown, { id: 99 });
    expect(unknown.cancel).toHaveBeenCalledTimes(1);
    expect(downloads.listActive()).toHaveLength(2);
  });
});

class Item extends EventEmitter {
  paused = false;
  resumed = false;
  state = 'progressing';
  bytes = 23;
  savePath = '';
  calls: string[] = [];
  resumable = true;
  setSavePath(path: string): void {
    this.savePath = path;
    this.calls.push('save');
  }
  getFilename(): string {
    return 'report.csv';
  }
  getURL(): string {
    return 'https://example.com/report?secret#private';
  }
  getMimeType(): string {
    return 'text/csv';
  }
  getTotalBytes(): number {
    return 100;
  }
  canResume(): boolean {
    return this.resumable;
  }
  isPaused(): boolean {
    return this.paused;
  }
  pause(): void {
    this.paused = true;
    this.calls.push('pause');
  }
  resume(): void {
    this.paused = false;
    this.resumed = true;
  }
  getState(): string {
    return this.state;
  }
  getReceivedBytes(): number {
    return this.bytes;
  }
  cancel(): void {
    this.state = 'cancelled';
    this.emit('done', {}, this.state);
  }
}
async function durableFixture(
  action: (context: {
    downloads: BrowserDownloads;
    jobs: BrowserDataJobs;
    native: EventEmitter;
    source: BrowserSessionSnapshot;
    root: string;
    start: () => Item;
    files: BrowserTaskFiles;
  }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'browser-download-job-test-'));
  const jobs = new BrowserDataJobs(join(root, 'jobs'));
  const source = {
    id: randomUUID(),
    projectId: 'project',
    worktreeId: 'task',
    taskScope: { kind: 'worktree', projectId: 'project', worktreeId: 'task' },
    profile: {
      selection: { kind: 'named', profileId: 'account' },
      resolvedProfileId: randomUUID(),
      taskIncarnationId: randomUUID(),
      storageGeneration: 1,
      runtimeGeneration: 1,
    },
  } as BrowserSessionSnapshot;
  const files = new BrowserTaskFiles({
    emit: (): void => undefined,
    taskDir: (): string => root,
    platform: 'linux',
  });
  await files.bind({ projectId: 'project', worktreeId: 'task' });
  const native = new EventEmitter(),
    downloads = new BrowserDownloads(
      (id) => (id === 42 ? source : undefined),
      jobs,
      files,
    );
  downloads.observe(native as Session);
  const start = (): Item => {
    const item = new Item();
    native.emit('will-download', {}, item, { id: 42 });
    return item;
  };
  try {
    await action({ downloads, jobs, native, source, root, start, files });
  } finally {
    downloads.dispose();
    await downloads.drain();
    await rm(root, { recursive: true, force: true });
  }
}
describe('durable source-owned browser download jobs', () => {
  it('pauses until ownership is durable and retains the original account after a switch', async () =>
    durableFixture(async ({ downloads, jobs, source, start }) => {
      const item = start(),
        owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing download owner');
      expect(item.paused).toBe(true);
      expect(item.resumed).toBe(false);
      if (!source.profile) throw new Error('Missing profile');
      source.profile.resolvedProfileId = randomUUID();
      source.profile.runtimeGeneration++;
      await downloads.drain();
      expect(item.resumed).toBe(true);
      expect(await jobs.get(owner.downloadId, { kind: 'user' })).toMatchObject({
        profileId: owner.profileId,
        storageGeneration: 1,
        status: 'running',
      });
      expect(
        (await jobs.getForExecution(owner.downloadId))?.intent,
      ).toMatchObject({ profileId: owner.profileId, runtimeGeneration: 1 });
      await writeFile(item.savePath, 'x'.repeat(item.bytes));
      item.state = 'completed';
      item.emit('done', {}, 'completed');
      await downloads.drain();
      expect((await jobs.get(owner.downloadId, { kind: 'user' })).status).toBe(
        'complete',
      );
    }));
  it('records cancellation that races the initial write without ever resuming the download', async () =>
    durableFixture(async ({ downloads, jobs, start }) => {
      const item = start(),
        owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing download owner');
      item.cancel();
      await downloads.drain();
      expect(item.resumed).toBe(false);
      expect((await jobs.get(owner.downloadId, { kind: 'user' })).status).toBe(
        'cancelled',
      );
    }));
  it('marks abandoned jobs interrupted after restart and never removes user-selected files', async () =>
    durableFixture(async ({ downloads, jobs, source, root, start }) => {
      const file = join(root, 'user-saved.zip');
      await writeFile(file, 'retained user content');
      const item = start(),
        owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing download owner');
      await downloads.drain();
      downloads.dispose();
      const restarted = new BrowserDownloads(() => source, jobs);
      await restarted.recover();
      expect(await jobs.get(owner.downloadId, { kind: 'user' })).toMatchObject({
        status: 'interrupted',
        cancellable: false,
      });
      expect(await readFile(file, 'utf8')).toBe('retained user content');
      expect(
        JSON.stringify(await jobs.getForExecution(owner.downloadId)),
      ).not.toContain(file);
      restarted.dispose();
    }));
  it('does not resume a download when maintenance fences its original profile during ownership persistence', async () =>
    durableFixture(async ({ downloads, jobs, start }) => {
      let fenced = false;
      downloads.setResumeAuthority((_owner, resume) => {
        if (fenced) return Promise.reject(new Error('Profile is paused'));
        resume();
        return Promise.resolve();
      });
      const item = start(),
        owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing download owner');
      fenced = true;
      await downloads.drain();
      expect(item.resumed).toBe(false);
      expect(item.state).toBe('cancelled');
      expect((await jobs.get(owner.downloadId, { kind: 'user' })).status).toBe(
        'cancelled',
      );
    }));
});

const taskFilesScope = { projectId: 'project', worktreeId: 'task' };
describe('named task download integration', () => {
  it('sets a synchronous staging save path before pause and records agent attribution', async () =>
    durableFixture(async ({ downloads, source, files, start }) => {
      if (!source.profile) throw new Error('Missing profile');
      files.setAttribution(
        {
          browserId: source.id,
          runtimeGeneration: source.profile.runtimeGeneration,
          taskIncarnationId: source.profile.taskIncarnationId,
        },
        'action',
      );
      const item = start();
      expect(item.calls.slice(0, 2)).toEqual(['save', 'pause']);
      expect(item.savePath).toMatch(/report\.csv\.download$/);
      const owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing owner');
      expect(files.get(taskFilesScope, owner.downloadId)).toMatchObject({
        source: 'agent',
        actionId: 'action',
        origin: 'https://example.com/report',
      });
      item.cancel();
      await downloads.drain();
    }));
  it('cancels refused downloads without pausing or allowing the native save dialog', async () =>
    durableFixture(async ({ downloads, files, start }) => {
      files.fence(taskFilesScope);
      const item = start();
      expect(item.state).toBe('cancelled');
      expect(item.calls).toEqual([]);
      expect(downloads.listActive()).toEqual([]);
      await downloads.drain();
    }));
  it('retains resumable interruption, keeps the job running, and revalidates captured owner on resume', async () =>
    durableFixture(async ({ downloads, jobs, files, source, start }) => {
      const authorize = jest.fn(
        (_owner: BrowserDownloadOwner, resume: () => void): Promise<void> => {
          resume();
          return Promise.resolve();
        },
      );
      downloads.setResumeAuthority(authorize);
      const item = start();
      const owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing owner');
      await downloads.drain();
      await writeFile(item.savePath, 'partial');
      item.state = 'interrupted';
      item.emit('updated', {}, 'interrupted');
      expect(downloads.listActive()).toHaveLength(1);
      expect(files.get(taskFilesScope, owner.downloadId)).toMatchObject({
        status: 'interrupted',
        canResume: true,
      });
      expect((await jobs.get(owner.downloadId, { kind: 'user' })).status).toBe(
        'running',
      );
      if (!source.profile) throw new Error('Missing profile');
      source.profile = { ...source.profile, runtimeGeneration: 99 };
      expect(
        await downloads.resumeDownload(taskFilesScope, owner.downloadId),
      ).toBe(true);
      expect(authorize).toHaveBeenLastCalledWith(owner, expect.any(Function));
      expect(files.get(taskFilesScope, owner.downloadId)).toMatchObject({
        status: 'in_progress',
        canResume: false,
      });
      item.cancel();
      await downloads.drain();
    }));
  it('denies live resume and cancel for wrong scope or failed authority', async () =>
    durableFixture(async ({ downloads, files, start }) => {
      const item = start();
      const owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing owner');
      await downloads.drain();
      item.state = 'interrupted';
      item.emit('updated', {}, 'interrupted');
      expect(
        await downloads.resumeDownload(
          { ...taskFilesScope, worktreeId: 'other' },
          owner.downloadId,
        ),
      ).toBe(false);
      expect(
        downloads.cancelDownload(
          { ...taskFilesScope, worktreeId: 'other' },
          owner.downloadId,
        ),
      ).toBe(false);
      downloads.setResumeAuthority(
        (): Promise<void> => Promise.reject(new Error('fenced')),
      );
      expect(
        await downloads.resumeDownload(taskFilesScope, owner.downloadId),
      ).toBe(false);
      expect(downloads.cancelDownload(taskFilesScope, owner.downloadId)).toBe(
        true,
      );
      await downloads.drain();
      expect(item.state).toBe('interrupted');
      expect(files.get(taskFilesScope, owner.downloadId)?.canResume).toBe(true);
      item.cancel();
      await downloads.drain();
    }));
  it('cancels live interruption through captured authority and deletes the partial file', async () =>
    durableFixture(async ({ downloads, files, start }) => {
      const item = start();
      const owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing owner');
      await downloads.drain();
      await writeFile(item.savePath, 'partial');
      item.state = 'interrupted';
      item.emit('updated', {}, 'interrupted');
      const authorize = jest.fn(
        (_owner: BrowserDownloadOwner, cancel: () => void): Promise<void> => {
          cancel();
          return Promise.resolve();
        },
      );
      downloads.setResumeAuthority(authorize);
      expect(downloads.cancelDownload(taskFilesScope, owner.downloadId)).toBe(
        true,
      );
      await downloads.drain();
      expect(authorize).toHaveBeenCalledWith(owner, expect.any(Function));
      expect(files.get(taskFilesScope, owner.downloadId)?.status).toBe(
        'cancelled',
      );
      await expect(readFile(item.savePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
      expect(downloads.cancelDownload(taskFilesScope, owner.downloadId)).toBe(
        false,
      );
    }));
  it('treats done interrupted as terminal regardless of canResume, deletes staging and joins store writes', async () =>
    durableFixture(async ({ downloads, files, start }) => {
      const item = start();
      const owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing owner');
      await downloads.drain();
      await writeFile(item.savePath, 'partial');
      item.state = 'interrupted';
      item.emit('done', {}, 'interrupted');
      await downloads.drain();
      expect(downloads.listActive()).toEqual([]);
      expect(files.get(taskFilesScope, owner.downloadId)).toMatchObject({
        status: 'interrupted',
        canResume: false,
        error: { code: 'download_failed' },
      });
      await expect(readFile(item.savePath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }));
  it('updates store progress and publishes complete bytes before finalizing', async () =>
    durableFixture(async ({ downloads, files, start }) => {
      const item = start();
      const owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing owner');
      await downloads.drain();
      item.bytes = 55;
      item.emit('updated', {}, 'progressing');
      expect(files.get(taskFilesScope, owner.downloadId)?.receivedBytes).toBe(
        55,
      );
      await writeFile(item.savePath, 'x'.repeat(55));
      item.state = 'completed';
      item.emit('done', {}, 'completed');
      await downloads.drain();
      expect(files.get(taskFilesScope, owner.downloadId)).toMatchObject({
        receivedBytes: 55,
        status: 'complete',
      });
    }));
  it('reports a download held for its ownership write as in progress, never paused', async () =>
    durableFixture(async ({ downloads, files, start }) => {
      const item = start();
      const owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing owner');
      expect(item.paused).toBe(true);
      item.bytes = 100;
      item.emit('updated', {}, 'progressing');
      expect(files.get(taskFilesScope, owner.downloadId)).toMatchObject({
        status: 'in_progress',
        receivedBytes: 100,
      });
      item.cancel();
      await downloads.drain();
    }));
  it('does not take a file that replaced the partial as its own when the download ends', async () =>
    durableFixture(async ({ downloads, start, root }) => {
      const item = start();
      await downloads.drain();
      await writeFile(item.savePath, 'partial');
      item.bytes = 7;
      item.emit('updated', {}, 'progressing');
      await rename(item.savePath, join(root, 'moved-partial'));
      await writeFile(item.savePath, 'mine');
      // Chromium's last report arrives with the end of the download.
      item.cancel();
      await downloads.drain();
      expect(await readFile(item.savePath, 'utf8')).toBe('mine');
    }));
  it('stops the native download when its record could not be kept', async () => {
    const root = await mkdtemp(join(tmpdir(), 'browser-download-failed-'));
    let failing = false;
    const files = new BrowserTaskFiles({
      emit: (): void => undefined,
      taskDir: (): string => root,
      platform: 'linux',
      beforeCatalogWrite: (): void => {
        if (failing) throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      },
    });
    const source = {
      id: 'tab',
      projectId: 'project',
      worktreeId: 'task',
      taskScope: { kind: 'worktree', projectId: 'project', worktreeId: 'task' },
      profile: {
        selection: { kind: 'named', profileId: 'account' },
        resolvedProfileId: 'account',
        taskIncarnationId: 'incarnation',
        storageGeneration: 1,
        runtimeGeneration: 1,
      },
    } as BrowserSessionSnapshot;
    const native = new EventEmitter();
    const downloads = new BrowserDownloads(
      (id) => (id === 42 ? source : undefined),
      undefined,
      files,
    );
    downloads.observe(native as Session);
    try {
      const item = new Item();
      native.emit('will-download', {}, item, { id: 42 });
      await downloads.drain();
      expect(item.resumed).toBe(true);
      const owner = downloads.owner(item as unknown as DownloadItem);
      if (!owner) throw new Error('Missing owner');
      failing = true;
      item.bytes = 40;
      item.emit('updated', {}, 'progressing');
      await downloads.drain();
      expect(files.get(taskFilesScope, owner.downloadId)?.status).toBe(
        'failed',
      );
      expect(item.state).toBe('cancelled');
      expect(downloads.listActive()).toEqual([]);
    } finally {
      downloads.dispose();
      await downloads.drain();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('leaves downloads the app closed under for the next start to recover as interrupted, never cancelled', async () =>
    durableFixture(async ({ downloads, files, jobs, source, root, start }) => {
      const running = start();
      const stalled = start();
      const runningOwner = downloads.owner(running as unknown as DownloadItem);
      const stalledOwner = downloads.owner(stalled as unknown as DownloadItem);
      if (!runningOwner || !stalledOwner) throw new Error('Missing owner');
      await downloads.drain();
      await writeFile(running.savePath, 'partial');
      await writeFile(stalled.savePath, 'partial');
      stalled.state = 'interrupted';
      stalled.emit('updated', {}, 'interrupted');
      await downloads.drain();
      expect(files.get(taskFilesScope, stalledOwner.downloadId)).toMatchObject({
        status: 'interrupted',
        canResume: true,
      });
      // Quitting stops what is still running. That is not the user's cancel.
      await downloads.shutdown();
      expect([running.state, stalled.state]).toEqual([
        'cancelled',
        'cancelled',
      ]);
      expect(downloads.listActive()).toEqual([]);
      expect(files.get(taskFilesScope, runningOwner.downloadId)?.status).toBe(
        'in_progress',
      );
      expect(files.get(taskFilesScope, stalledOwner.downloadId)?.status).toBe(
        'interrupted',
      );
      for (const owner of [runningOwner, stalledOwner])
        expect(
          (await jobs.get(owner.downloadId, { kind: 'user' })).status,
        ).toBe('running');
      const next = new BrowserTaskFiles({
        emit: (): void => undefined,
        taskDir: (): string => root,
        platform: 'linux',
      });
      const restarted = new BrowserDownloads(() => source, jobs, next);
      await restarted.recover();
      restarted.dispose();
      for (const owner of [runningOwner, stalledOwner])
        expect(
          await jobs.get(owner.downloadId, { kind: 'user' }),
        ).toMatchObject({ status: 'interrupted', cancellable: false });
      await next.bind(taskFilesScope);
      for (const owner of [runningOwner, stalledOwner])
        expect(next.get(taskFilesScope, owner.downloadId)).toMatchObject({
          status: 'interrupted',
          canResume: false,
        });
      for (const item of [running, stalled])
        await expect(readFile(item.savePath)).rejects.toMatchObject({
          code: 'ENOENT',
        });
    }));
});

it('updated nonresumable interruption never leaves partial bytes after done', async () =>
  durableFixture(async ({ downloads, files, start }) => {
    const item = start();
    const owner = downloads.owner(item as unknown as DownloadItem);
    if (!owner) throw new Error('Missing owner');
    await downloads.drain();
    await writeFile(item.savePath, 'partial');
    item.resumable = false;
    item.state = 'interrupted';
    item.emit('updated', {}, 'interrupted');
    item.emit('done', {}, 'interrupted');
    await downloads.drain();
    expect(files.get(taskFilesScope, owner.downloadId)).toMatchObject({
      status: 'interrupted',
      canResume: false,
      error: { code: 'download_failed' },
    });
    await expect(readFile(item.savePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  }));

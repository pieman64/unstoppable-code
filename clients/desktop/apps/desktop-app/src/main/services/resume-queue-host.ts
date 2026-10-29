import { stopAccountProxyQuotaWaits } from '../account-proxy/quota-wait';
import { BrowserWindow } from 'electron';
import { performance } from 'node:perf_hooks';
import {
  IPC_CHANNELS,
  type ResumeQueueSnapshot,
} from '@canopy/desktop-shared/types';
import { getResumeQueueFilePath } from '../lib/paths';
import {
  logMainProcessError,
  logMainProcessInfo,
} from '../lib/main-process-logging';
import {
  ResumeQueueService,
  type ResumeQueueDependencies,
} from './resume-queue-service';
import { ResumeQueueStorage } from './resume-queue-storage';
import { sendToWebContents } from '../lib/web-contents-send';

interface HostDependencies {
  collect?: (queue: ResumeQueueService) => Promise<void>;
  readLiveAutomaticResumeInterruptionKeys?: ResumeQueueDependencies['readLiveAutomaticResumeInterruptionKeys'];
  dispatch: ResumeQueueDependencies['dispatch'];
  reconcile: ResumeQueueDependencies['reconcile'];
  canDispatch: (entries: ResumeQueueSnapshot['entries']) => Promise<boolean>;
}
let queue: ResumeQueueService | undefined;
let dependencies: HostDependencies | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let shuttingDown = false;
let started = false;

function broadcast(snapshot: ResumeQueueSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed())
      sendToWebContents(
        window.webContents,
        IPC_CHANNELS.resumeQueueChanged,
        snapshot,
      );
  }
}

export function configureResumeQueue(deps: HostDependencies): void {
  dependencies = deps;
}

export function getResumeQueue(): ResumeQueueService {
  if (queue) return queue;
  const storage = new ResumeQueueStorage(getResumeQueueFilePath());
  queue = new ResumeQueueService({
    load: (): Promise<ResumeQueueSnapshot | null> => storage.load(),
    save: (snapshot): Promise<void> => storage.save(snapshot),
    now: Date.now,
    changed: broadcast,
    readLiveAutomaticResumeInterruptionKeys: (
      entries,
    ): Promise<ReadonlySet<string> | null> =>
      dependencies?.readLiveAutomaticResumeInterruptionKeys?.(entries) ??
      Promise.resolve(null),
    dispatch: async (entry): Promise<'resumed' | 'skipped'> => {
      if (shuttingDown || !dependencies)
        throw new Error('The application is shutting down.');
      logMainProcessInfo('[resume-queue] Starting session', {
        id: entry.id,
        kind: entry.target.kind,
      });
      const startedAt = performance.now();
      const result = await dependencies.dispatch(entry);
      logMainProcessInfo('[resume-queue] Session dispatched', {
        id: entry.id,
        result,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
      return result;
    },
    reconcile: (entry): ReturnType<ResumeQueueDependencies['reconcile']> => {
      if (!dependencies) throw new Error('Resume queue is not ready.');
      return dependencies.reconcile(entry);
    },
  });
  return queue;
}

/** Called only after interrupted-work recovery, handler registration and renderer readiness. */
export function startResumeQueue(): void {
  if (started || shuttingDown) return;
  started = true;
  const schedule = (): void => {
    timer = setTimeout(() => {
      timer = undefined;
      void (async (): Promise<void> => {
        const service = getResumeQueue();
        await service.initialize();
        if (!service.snapshot().paused && !shuttingDown) {
          try {
            await dependencies?.collect?.(service);
          } catch (error) {
            // Collection is advisory. A transient read or a full history must
            // not prevent already accepted native/manual resumes from running.
            logMainProcessError(
              '[resume-queue] Proxy recovery collection failed',
              error,
            );
          }
        }
        const snapshot = service.snapshot();
        if (
          !snapshot.paused &&
          snapshot.entries.some((entry) => entry.status === 'waiting')
        ) {
          await service.tick((candidate) =>
            dependencies
              ? dependencies.canDispatch([candidate])
              : Promise.resolve(false),
          );
        }
      })()
        .catch((error: unknown) => {
          logMainProcessError('[resume-queue] Scheduling stopped', error);
          queue?.stop(
            'The resume queue stopped unexpectedly. Your saved queue is safe. Restart the app to retry.',
          );
          started = false;
        })
        .finally(() => {
          if (!shuttingDown && started) schedule();
        });
    }, 500);
    timer.unref();
  };
  schedule();
}

export function stopResumeQueue(): void {
  shuttingDown = true;
  stopAccountProxyQuotaWaits();
  if (timer) clearTimeout(timer);
  timer = undefined;
  queue?.stop();
}

export async function flushResumeQueue(): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      queue?.flush(),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 5000);
      }),
    ]);
  } finally {
    if (deadline) clearTimeout(deadline);
  }
}

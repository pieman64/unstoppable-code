import { dialog } from 'electron';
import { watch, type FSWatcher, type WatchListener } from 'node:fs';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { logMainProcessInfo, logMainProcessWarn } from './main-process-logging';

const POLL_INTERVAL_MS = 2_000;
const NATIVE_RETRY_MS = 30_000;
const FALLBACK_CODES = new Set([
  'ENOSPC',
  'EMFILE',
  'ENFILE',
  'EACCES',
  'EPERM',
]);
let warningShown = false;

/** The watch-limit and access errors that native watching cannot ride out. */
export function isWatchFallbackError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    FALLBACK_CODES.has(String(error.code))
  );
}

export type WatchUnavailableSurface = 'worktree' | 'file-tree';

const WARNING_TEXT: Record<
  WatchUnavailableSurface,
  { lead: string; permission: string }
> = {
  worktree: {
    lead: 'Worktree changes are being checked every few seconds. Native file watching will resume automatically when available.',
    permission:
      'Check that your account can access the workspace and its Git directory.',
  },
  'file-tree': {
    lead: 'The file explorer may not show file changes until file watching resumes. Watching resumes automatically, and the explorer then updates.',
    permission: "Check that your account can access the project's folders.",
  },
};

/**
 * Shows the session's one watch-failure warning. Every surface shares the
 * gate, so whichever watcher fails first names itself.
 */
export function warnWatchUnavailableOnce(
  error: unknown,
  surface: WatchUnavailableSurface,
): void {
  if (warningShown) return;
  warningShown = true;
  const code =
    error instanceof Error && 'code' in error ? String(error.code) : '';
  const permission = code === 'EACCES' || code === 'EPERM';
  const text = WARNING_TEXT[surface];
  const detail = [
    text.lead,
    permission
      ? text.permission
      : 'The system has reached a file-watching or open-file limit. Close other applications that watch many files.',
    hostOperatingSystem() === 'linux'
      ? 'On Linux, check fs.inotify.max_user_watches and fs.inotify.max_user_instances. To raise these limits, run sudo sysctl fs.inotify.max_user_watches=524288 and sudo sysctl fs.inotify.max_user_instances=1024. To persist them, add fs.inotify.max_user_watches=524288 and fs.inotify.max_user_instances=1024 to a .conf file in /etc/sysctl.d, then run sudo sysctl --system. Raising limits does not fix permission errors.'
      : 'For open-file limits, check your operating system settings.',
  ].join('\n\n');
  try {
    void dialog
      .showMessageBox({
        type: 'warning',
        message: 'File watching is temporarily unavailable',
        detail,
        buttons: ['OK'],
      })
      .catch((failure: unknown) => {
        logMainProcessWarn('Worktree watch warning could not be shown', {
          error: String(failure),
        });
      });
  } catch (failure) {
    logMainProcessWarn('Worktree watch warning could not be shown', {
      error: String(failure),
    });
  }
}

export interface WorktreeWatch {
  close: () => void;
  /** Stop work immediately while retaining the native handle until shutdown. */
  retire: () => void;
}

interface WatchOptions {
  path: string;
  label: string;
  onChange: WatchListener<string>;
  poll: () => Promise<void>;
  onFatal: (error: unknown) => void;
}

/** Recovery is private to the branch and worktrees-file observers. */
export function createWorktreeWatch(options: WatchOptions): WorktreeWatch {
  let native: FSWatcher | null = null;
  let active = true;
  let fallingBack = false;
  let polling = false;
  let catchUpPending = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function clearTimers(): void {
    if (pollTimer !== null) clearTimeout(pollTimer);
    if (retryTimer !== null) clearTimeout(retryTimer);
    pollTimer = null;
    retryTimer = null;
  }

  function closeNative(): void {
    const watcher = native;
    native = null;
    try {
      watcher?.close();
    } catch {
      /* A failed watcher may already be closed. */
    }
  }

  function schedulePoll(): void {
    if (!active || !fallingBack || pollTimer !== null || polling) return;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void poll();
    }, POLL_INTERVAL_MS);
    pollTimer.unref();
  }

  async function poll(): Promise<void> {
    if (!active || polling) return;
    polling = true;
    try {
      await options.poll();
    } catch {
      // A denied or missing path is checked again only after the fixed delay.
    } finally {
      polling = false;
      if (active && catchUpPending) {
        catchUpPending = false;
        void poll();
      } else {
        schedulePoll();
      }
    }
  }

  function scheduleRetry(): void {
    if (!active || !fallingBack || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      try {
        attach();
      } catch {
        scheduleRetry();
      }
    }, NATIVE_RETRY_MS);
    retryTimer.unref();
  }

  function fallback(error: unknown): void {
    closeNative();
    if (!fallingBack) {
      fallingBack = true;
      logMainProcessWarn('Worktree watch using bounded polling', {
        watcher: options.label,
        error: String(error),
      });
      warnWatchUnavailableOnce(error, 'worktree');
    }
    schedulePoll();
    scheduleRetry();
  }

  function attach(): void {
    if (!active) return;
    try {
      const watcher = watch(
        options.path,
        { persistent: false },
        (event, filename) => {
          if (active && native === watcher) options.onChange(event, filename);
        },
      );
      native = watcher;
      watcher.on('error', (error: unknown) => {
        if (!active || native !== watcher) return;
        if (isWatchFallbackError(error)) {
          fallback(error);
        } else {
          active = false;
          clearTimers();
          closeNative();
          options.onFatal(error);
        }
      });
      if (fallingBack) {
        fallingBack = false;
        clearTimers();
        // Catch the final change between the last poll and the native attach.
        if (polling) catchUpPending = true;
        else void poll();
        logMainProcessInfo('Worktree native watch recovered', {
          watcher: options.label,
        });
      }
    } catch (error) {
      if (isWatchFallbackError(error)) {
        fallback(error);
      } else {
        throw error;
      }
    }
  }

  attach();
  return {
    close(): void {
      active = false;
      clearTimers();
      closeNative();
    },
    retire(): void {
      active = false;
      clearTimers();
    },
  };
}

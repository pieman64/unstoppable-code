import type { CloneJobSnapshot } from '@canopy/desktop-shared/types';
import { useCloneJobsStore } from '@/stores/cloneJobsStore';
import { useGitHubStore } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';

// Background outcomes already announced in this renderer. Main keeps a
// finished job until it is dismissed, so repeated broadcasts (or a remount)
// must not announce it twice. The same guard limits the automatic dismissal
// of a succeeded job to one attempt.
const announcedOutcomes = new Set<string>();

/** Test hook: forget announced outcomes between cases. */
export function resetAnnouncedCloneOutcomesForTests(): void {
  announcedOutcomes.clear();
}

/**
 * Ask main to drop a succeeded job once it has been announced. Main stays the
 * single writer: its broadcast removes the job from the sidebar pill and the
 * clone progress dialog. A failed request is not retried and raises nothing;
 * the finished row keeps its manual Dismiss.
 */
async function dismissAnnouncedCloneJob(jobId: string): Promise<void> {
  try {
    await window.api.dismissCloneJob(jobId);
  } catch {
    // Left for manual dismissal in the clone progress dialog.
  }
}

/**
 * Announce background clone outcomes the Add project dialog is no longer
 * around to report. A finished clone refreshes the sidebar, confirms with a
 * toast and is then dismissed automatically. A failed clone raises a toast
 * that opens the clone progress dialog, where it stays, with its error and
 * recovery details, until the user dismisses it.
 */
export function announceBackgroundCloneOutcomes(
  jobs: readonly CloneJobSnapshot[],
): void {
  for (const job of jobs) {
    if (!job.background) continue;
    const key = `${job.id}:${job.status}`;
    if (job.status === 'succeeded' && !announcedOutcomes.has(key)) {
      announcedOutcomes.add(key);
      const name = job.workspaceName ?? job.repoName;
      void (async (): Promise<void> => {
        try {
          await useProjectsStore.getState().loadProjects();
        } finally {
          useGitHubStore
            .getState()
            .addToast(`Added ${name}.`, 'success', undefined, {
              title: 'Clone finished',
              forceInApp: true,
            });
          // After the toast, and whether or not the refresh succeeded.
          void dismissAnnouncedCloneJob(job.id);
        }
      })();
    } else if (job.status === 'failed' && !announcedOutcomes.has(key)) {
      announcedOutcomes.add(key);
      useGitHubStore
        .getState()
        .addToast(
          `Couldn't clone ${job.repoName}.`,
          'error',
          () => useCloneJobsStore.getState().open(),
          { title: 'Clone failed', forceInApp: true },
        );
    }
  }
}

import { setAuditDayPruneGuard } from '../observability/audit-stream-hooks';

/** Registration only: no files, timers' callbacks, or services run on startup. */
export function registerCostRetentionGuard(): void {
  setAuditDayPruneGuard(async (dayFilename): Promise<boolean> => {
    const { getDesktopCostIndexStore } = await import('./service');
    return getDesktopCostIndexStore().catchUpAndSealDay(dayFilename);
  });
}

/** Loading the projection graph is deferred too, not just its first scan. */
export function scheduleCostIndexStartup(): void {
  const timer = setTimeout((): void => {
    void import('./scheduler')
      .then(({ startCostIndexScheduler }): void => {
        startCostIndexScheduler();
      })
      .catch((): void => {
        /* Retention remains guarded; a later read retries. */
      });
  }, 60_000);
  timer.unref();
}

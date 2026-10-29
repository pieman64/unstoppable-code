'use client';

import { useCallback, useMemo } from 'react';
import { useSettingsHost, useSettingsRouter } from '../host';

/**
 * Finishes a confirmed membership write (create, invitation accept, leave,
 * delete): it moves to the destination, if any, then refreshes the host so
 * its workspace organization list re-reads. Web's protected layout owns that
 * list and survives client navigation; desktop also reloads the page and
 * settings bootstrap, and main broadcasts the updated account separately.
 *
 * The refresh is issued after the push on purpose. Desktop's push updates the
 * hosted location synchronously, and Next.js runs router actions in order, so
 * both hosts refresh the destination, never a page the write just removed.
 *
 * `replace` swaps the current entry for the destination instead of pushing,
 * for a page that must not stay in history (the list's `?create=1`).
 *
 * Call it only after the write succeeded. A refresh failure is logged, never
 * reported as a failed write, so nobody is invited to submit it again.
 */
export function useMembershipChangeFollowUp(): (
  destination?: string,
  options?: { readonly replace?: boolean },
) => void {
  const router = useSettingsRouter();
  const host = useSettingsHost();
  const logger = useMemo(() => host.logger('organization:membership'), [host]);
  return useCallback(
    (destination?: string, options?: { readonly replace?: boolean }): void => {
      if (destination !== undefined) {
        if (options?.replace) router.replace(destination);
        else router.push(destination);
      }
      try {
        router.refresh();
      } catch {
        logger.warn(
          'Refreshing organizations after a membership change failed',
        );
      }
    },
    [logger, router],
  );
}

'use client';

import { useMemo } from 'react';
import {
  useSettingsAccessLostRefresh,
  useSettingsErrorCopy,
  type KnownSettingsError,
} from '../errors';
import { MEMORY_RATE_LIMIT_MESSAGE } from './api';

/**
 * The memory explorer's known failures. The shared search rate limit keeps
 * its own copy; everything else gets the settings load or action copy.
 */
export const MEMORY_KNOWN_ERRORS: readonly KnownSettingsError[] = [
  { status: 429, copy: MEMORY_RATE_LIMIT_MESSAGE },
];

export interface MemoryErrorCopy {
  /** Logs a failed read and returns its copy, for a banner with Retry. */
  loadCopy(error: unknown): string;
  /**
   * Logs a failed action and returns its copy. `action` completes
   * `Couldn't <action>.`, for example `preview retrieval`.
   */
  actionCopy(error: unknown, action: string): string;
}

/**
 * Friendly copy for the memory explorer's failures. Server text goes to the
 * host's log only. A failure that means the viewer lost access to the
 * organization also goes through `useSettingsAccessLostRefresh`, which shows
 * the host's access-lost notice instead of the explorer. Call it where the
 * failure is caught, never during render.
 */
export function useMemoryErrorCopy(): MemoryErrorCopy {
  const errorCopy = useSettingsErrorCopy('memory');
  const refreshOnAccessLost = useSettingsAccessLostRefresh();
  return useMemo(
    (): MemoryErrorCopy => ({
      loadCopy: (error): string => {
        refreshOnAccessLost(error);
        return errorCopy.loadCopy(error, MEMORY_KNOWN_ERRORS);
      },
      actionCopy: (error, action): string => {
        refreshOnAccessLost(error);
        return errorCopy.actionCopy(error, {
          action,
          known: MEMORY_KNOWN_ERRORS,
        });
      },
    }),
    [errorCopy, refreshOnAccessLost],
  );
}

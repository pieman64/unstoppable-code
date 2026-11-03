'use client';

import { useMemo } from 'react';
import {
  useSettingsAccessLostRefresh,
  useSettingsErrorCopy,
  type KnownSettingsError,
  type SettingsFailure,
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
  /**
   * Logs a failed read and returns our sentence with the raw reason beside
   * it, for a banner with Retry and Copy details.
   */
  loadFailure(error: unknown): SettingsFailure;
  /**
   * Logs a failed action and returns its failure. `action` completes
   * `Couldn't <action>.`, for example `preview retrieval`.
   */
  actionFailure(error: unknown, action: string): SettingsFailure;
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
      loadFailure: (error): SettingsFailure => {
        refreshOnAccessLost(error);
        return errorCopy.loadFailure(error, MEMORY_KNOWN_ERRORS);
      },
      actionFailure: (error, action): SettingsFailure => {
        refreshOnAccessLost(error);
        return errorCopy.actionFailure(error, {
          action,
          known: MEMORY_KNOWN_ERRORS,
        });
      },
    }),
    [errorCopy, refreshOnAccessLost],
  );
}

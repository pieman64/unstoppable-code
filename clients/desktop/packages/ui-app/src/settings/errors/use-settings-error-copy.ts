'use client';

import { useMemo } from 'react';
import { useSettingsHost } from '../host/settings-host';
import {
  logSettingsError,
  settingsActionErrorCopy,
  settingsLoadErrorCopy,
  type KnownSettingsError,
  type SettingsActionErrorOptions,
} from './settings-error-copy';

export interface SettingsErrorCopy {
  /** Logs the failure, then returns its load copy (`settingsLoadErrorCopy`). */
  loadCopy(error: unknown, known?: readonly KnownSettingsError[]): string;
  /** Logs the failure, then returns its action copy (`settingsActionErrorCopy`). */
  actionCopy(error: unknown, options: SettingsActionErrorOptions): string;
}

/**
 * Friendly error copy that logs the raw failure through the host's
 * `logger(scope)`. Call it where the failure is caught (a `catch` or effect)
 * and keep the returned copy in state; calling it during render logs on
 * every render.
 */
export function useSettingsErrorCopy(scope: string): SettingsErrorCopy {
  const host = useSettingsHost();
  return useMemo((): SettingsErrorCopy => {
    const logger = host.logger(scope);
    return {
      loadCopy: (error, known): string => {
        logSettingsError(logger, 'load', error);
        return settingsLoadErrorCopy(error, known);
      },
      actionCopy: (error, options): string => {
        logSettingsError(logger, options.action, error);
        return settingsActionErrorCopy(error, options);
      },
    };
  }, [host, scope]);
}

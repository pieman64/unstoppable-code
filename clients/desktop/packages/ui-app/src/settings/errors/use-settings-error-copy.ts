'use client';

import { useMemo } from 'react';
import { useSettingsHost } from '../host/settings-host';
import {
  logSettingsError,
  settingsActionErrorCopy,
  settingsFailure,
  settingsLoadErrorCopy,
  type KnownSettingsError,
  type SettingsActionErrorOptions,
  type SettingsFailure,
} from './settings-error-copy';

export interface SettingsErrorCopy {
  /**
   * Logs the failure, then returns its load copy with the raw reason beside
   * it (`details`, for a `Copy details` action; never rendered).
   */
  loadFailure(
    error: unknown,
    known?: readonly KnownSettingsError[],
  ): SettingsFailure;
  /** Logs the failure, then returns its action copy with the raw reason. */
  actionFailure(
    error: unknown,
    options: SettingsActionErrorOptions,
  ): SettingsFailure;
}

/**
 * Friendly error copy that logs the raw failure through the host's
 * `logger(scope)`. Call it where the failure is caught (a `catch` or effect)
 * and keep the returned failure in state; calling it during render logs on
 * every render. A failure is our sentence (`copy`) and the raw reason
 * (`details`): render `copy`, and hand `details` to `ErrorBanner` (or
 * `CopyDetailsButton`) so it can be copied but never shows.
 */
export function useSettingsErrorCopy(scope: string): SettingsErrorCopy {
  const host = useSettingsHost();
  return useMemo((): SettingsErrorCopy => {
    const logger = host.logger(scope);
    const loadCopy = (
      error: unknown,
      known?: readonly KnownSettingsError[],
    ): string => {
      logSettingsError(logger, 'load', error);
      return settingsLoadErrorCopy(error, known);
    };
    const actionCopy = (
      error: unknown,
      options: SettingsActionErrorOptions,
    ): string => {
      logSettingsError(logger, options.action, error);
      return settingsActionErrorCopy(error, options);
    };
    return {
      loadFailure: (error, known): SettingsFailure =>
        settingsFailure(error, loadCopy(error, known)),
      actionFailure: (error, options): SettingsFailure =>
        settingsFailure(error, actionCopy(error, options)),
    };
  }, [host, scope]);
}

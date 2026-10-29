import { useEffect, useState } from 'react';
import { DEFAULT_SCRIPT_TIMEOUT_SECONDS } from '@canopy/desktop-shared/scripts';
import type { WorkspaceSettingsDataResponse } from '@canopy/desktop-shared/types';
import { subscribePreferencesUpdated } from '@/lib/preferences-events';

export type AddToWorktreeTarget =
  | { mode: 'new' }
  | { mode: 'existing'; worktreeId: string };

export type AddToWorktreeFeedback =
  | { phase: 'idle' }
  | { phase: 'applying'; targetLabel: string };

export function serializeEditableScriptsForSettings(
  input: Record<string, unknown>,
): string {
  const entries = Object.entries(input).sort((left, right) =>
    left[0].localeCompare(right[0]),
  );
  return JSON.stringify(entries);
}

export function getDefaultScriptTimeoutSeconds(
  scriptTimeoutMinutes: number,
): number {
  return Number.isFinite(scriptTimeoutMinutes) && scriptTimeoutMinutes > 0
    ? scriptTimeoutMinutes * 60
    : DEFAULT_SCRIPT_TIMEOUT_SECONDS;
}

export function useDefaultScriptTimeoutSeconds(isOpen: boolean): number {
  const [defaultScriptTimeoutSeconds, setDefaultScriptTimeoutSeconds] =
    useState(DEFAULT_SCRIPT_TIMEOUT_SECONDS);

  useEffect(() => {
    const unsubscribe = subscribePreferencesUpdated((prefs) => {
      setDefaultScriptTimeoutSeconds(
        getDefaultScriptTimeoutSeconds(prefs.scriptTimeoutMinutes),
      );
    });
    return unsubscribe;
  }, []);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((prefs) => {
        if (!cancelled) {
          setDefaultScriptTimeoutSeconds(
            getDefaultScriptTimeoutSeconds(prefs.scriptTimeoutMinutes),
          );
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDefaultScriptTimeoutSeconds(DEFAULT_SCRIPT_TIMEOUT_SECONDS);
        }
      });

    return (): void => {
      cancelled = true;
    };
  }, [isOpen]);

  return defaultScriptTimeoutSeconds;
}

interface UseWorkspaceSettingsDataOptions {
  isOpen: boolean;
  workspaceId: string;
  worktreeId: string | undefined;
  fallbackErrorMessage: string;
}

interface UseWorkspaceSettingsDataResult {
  healthData: WorkspaceSettingsDataResponse | null;
  setHealthData: (next: WorkspaceSettingsDataResponse | null) => void;
  hasLoadedWorkspaceSettingsData: boolean;
  workspaceSettingsLoadError: string | null;
}

/**
 * Shared loader for the source-controlled workspace settings payload used by
 * `ProjectSettingsModal` and `WorkspaceSettingsModal`. Mirrors the
 * cancellation pattern that was previously duplicated across both modals:
 * - When `isOpen` is false, the effect short-circuits — no request is sent.
 * - On every load start, `hasLoadedWorkspaceSettingsData` is reset to false
 *   and `workspaceSettingsLoadError` is cleared. Health data is intentionally
 *   left in place so re-fetches do not flash a stale-empty card.
 * - On success, both the loaded flag and `healthData` are updated together.
 * - On failure, `healthData` is cleared and the error falls back to
 *   `fallbackErrorMessage` if the thrown value is not an `Error`.
 *
 * The returned `setHealthData` setter exists for callers that need to refresh
 * the cached payload after a write (e.g. `Apply to worktree` in the modals).
 */
export function useWorkspaceSettingsData({
  isOpen,
  workspaceId,
  worktreeId,
  fallbackErrorMessage,
}: UseWorkspaceSettingsDataOptions): UseWorkspaceSettingsDataResult {
  const [healthData, setHealthData] =
    useState<WorkspaceSettingsDataResponse | null>(null);
  const [hasLoadedWorkspaceSettingsData, setHasLoadedWorkspaceSettingsData] =
    useState(false);
  const [workspaceSettingsLoadError, setWorkspaceSettingsLoadError] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    let canceled = false;
    setHasLoadedWorkspaceSettingsData(false);
    setWorkspaceSettingsLoadError(null);
    const loadHealth = async (): Promise<void> => {
      try {
        const data = await window.api.getWorkspaceSettingsData({
          workspaceId,
          worktreeId,
        });
        if (!canceled) {
          setHealthData(data);
          setHasLoadedWorkspaceSettingsData(true);
        }
      } catch (cause) {
        if (!canceled) {
          setHealthData(null);
          setWorkspaceSettingsLoadError(
            cause instanceof Error ? cause.message : fallbackErrorMessage,
          );
        }
      }
    };

    void loadHealth();
    return (): void => {
      canceled = true;
    };
  }, [isOpen, workspaceId, worktreeId, fallbackErrorMessage]);

  return {
    healthData,
    setHealthData,
    hasLoadedWorkspaceSettingsData,
    workspaceSettingsLoadError,
  };
}

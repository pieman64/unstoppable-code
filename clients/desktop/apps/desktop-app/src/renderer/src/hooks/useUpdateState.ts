import { useCallback, useEffect, useState } from 'react';
import {
  ACTIONABLE_PHASES,
  type DependencyVersions,
  type UpdateEvent,
  type UpdateState,
} from '@canopy/desktop-shared/types';
import { brandText } from '@/lib/brand';

const INITIAL_UPDATE_STATE: UpdateState = { phase: 'idle' };

function applyUpdateEvent(
  previousState: UpdateState,
  event: UpdateEvent,
): UpdateState {
  const checkedAt = new Date().toISOString();

  switch (event.type) {
    case 'checking':
      if (ACTIONABLE_PHASES.has(previousState.phase)) {
        return previousState;
      }
      return {
        phase: 'checking',
      };
    case 'available':
      return {
        phase: 'available',
        info: event.info,
        checkedAt,
      };
    case 'not-available':
      return {
        phase: 'not-available',
        checkedAt,
        message: `${brandText.appName} is up to date.`,
      };
    case 'download-progress':
      return {
        phase: 'downloading',
        info: previousState.info,
        progress: event.progress,
        checkedAt: previousState.checkedAt,
      };
    case 'downloaded':
      return {
        phase: 'downloaded',
        info: event.info,
        checkedAt,
      };
    case 'install-pending':
      return {
        ...previousState,
        installPending: event.pending,
      };
    case 'error':
      return {
        ...previousState,
        phase: 'error',
        message: event.message,
        installPending: false,
        checkedAt,
      };
  }
}

interface UseUpdateStateResult {
  appVersion: string | null;
  dependencyVersions: DependencyVersions | null;
  state: UpdateState;
  refresh: () => Promise<void>;
}

export function useUpdateState(): UseUpdateStateResult {
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [dependencyVersions, setDependencyVersions] =
    useState<DependencyVersions | null>(null);
  const [state, setState] = useState<UpdateState>(INITIAL_UPDATE_STATE);

  const refresh = useCallback(async (): Promise<void> => {
    const [nextVersion, nextDepVersions, nextState] = await Promise.all([
      window.api.update.getAppVersion(),
      window.api.update.getDependencyVersions(),
      window.api.update.getState(),
    ]);
    setAppVersion(nextVersion);
    setDependencyVersions(nextDepVersions);
    setState(nextState);
  }, []);

  useEffect(() => {
    void refresh();

    const unsubscribe = window.api.update.onUpdateEvent((event) => {
      setState((previousState) => applyUpdateEvent(previousState, event));
    });

    return unsubscribe;
  }, [refresh]);

  return {
    appVersion,
    dependencyVersions,
    state,
    refresh,
  };
}

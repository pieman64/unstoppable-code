import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  GitExecutableInstallProgress,
  GitExecutableStatus,
} from '@canopy/desktop-shared/types';

/**
 * Discriminated state for the desktop Git startup gate.
 *
 * - `not-required` — not a supported desktop build, or Git is already usable, so the gate
 *   must never render and the app proceeds straight to the shell.
 * - `checking` — the initial `getGitExecutableStatus()` probe is in flight. The
 *   shell stays blocked while this resolves so a supported build can never reach
 *   onboarding/the main shell before Git is confirmed.
 * - `required` — Git is required for this build but not yet usable.
 * - `installing` — a Windows installer is running or macOS is waiting for Git.
 * - `detected` — Git became usable after a forced recheck; the gate shows the
 *   detected path and a single `Continue` action.
 * - `error` — detection or installation failed; the gate surfaces the message
 *   and restores the recoverable actions.
 */
export type WindowsGitGateState =
  | { kind: 'not-required' }
  | { kind: 'checking' }
  | { kind: 'required'; status: GitExecutableStatus }
  | {
      kind: 'installing';
      status: GitExecutableStatus | null;
      progress: GitExecutableInstallProgress;
    }
  | { kind: 'detected'; status: GitExecutableStatus }
  | { kind: 'error'; status: GitExecutableStatus | null; message: string };

/** Public surface returned by {@link useWindowsGitRequirement}. */
export interface WindowsGitRequirement {
  state: WindowsGitGateState;
  /** Force a fresh detection pass (drives the gate's `Recheck` action). */
  recheck: () => Promise<void>;
  /** Let the user select a Git executable manually (drives the gate's `Browse` action). */
  browse: () => Promise<void>;
  /** Request the platform installer (drives the gate's `Auto` action). */
  autoInstall: () => Promise<void>;
  /** Dismiss the gate after Git becomes available (the `Continue` action). */
  dismiss: () => void;
  /** Stop waiting locally; the Apple installer remains under user control. */
  cancelInstall: () => void;
}

interface WindowsGitRequirementOptions {
  /**
   * When false, keep the Git startup probe dormant. This lets App.tsx
   * hold all Git detection work until earlier startup gates, such as required
   * cloud sign-in, have completed.
   */
  enabled?: boolean;
}

/** Which top-level startup surface App.tsx should render. */
export type StartupGateView = 'loading' | 'git-gate' | 'app';

const INITIAL_INSTALL_PROGRESS: GitExecutableInstallProgress = {
  phase: 'starting',
  message: 'Starting Git installation…',
};

function requiresGit(): boolean {
  return (
    window.platform === 'win32' ||
    window.platform === 'darwin' ||
    window.platform === 'linux'
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Map a freshly-resolved status to the gate state shown after a user-driven
 * recheck. A still-missing executable keeps the gate in `required`; a usable
 * one advances to the `detected` success step with its `Continue` action.
 */
function resolveRecheckState(status: GitExecutableStatus): WindowsGitGateState {
  if (status.required && !status.ready) {
    return { kind: 'required', status };
  }
  return { kind: 'detected', status };
}

function statusFromState(
  state: WindowsGitGateState,
): GitExecutableStatus | null {
  switch (state.kind) {
    case 'required':
    case 'installing':
    case 'detected':
    case 'error':
      return state.status;
    default:
      return null;
  }
}

/**
 * Pure sequencing helper shared with App.tsx. Existing users are blocked after
 * hydration and any active cloud-auth gate when Git is missing.
 * First-run users are blocked before post-auth onboarding and before normal app
 * usage.
 */
export function resolveStartupGateView(
  appReady: boolean,
  gate: WindowsGitGateState,
): StartupGateView {
  if (!appReady) {
    return 'loading';
  }
  // The Git startup probe is still running — keep blocking the shell.
  if (gate.kind === 'checking') {
    return 'loading';
  }
  // Unsupported builds and already-usable Git resolve here.
  if (gate.kind === 'not-required') {
    return 'app';
  }
  return 'git-gate';
}

/**
 * Drives the desktop Git startup gate. On unsupported builds it resolves
 * to `not-required` synchronously and performs no IPC. On supported platforms it probes `getGitExecutableStatus()` on mount and
 * exposes the Recheck / Auto-install / Continue actions the gate renders.
 */
export function useWindowsGitRequirement(
  options: WindowsGitRequirementOptions = {},
): WindowsGitRequirement {
  const enabled = options.enabled ?? true;
  const [state, setState] = useState<WindowsGitGateState>(() =>
    enabled && requiresGit() ? { kind: 'checking' } : { kind: 'not-required' },
  );
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const installGenerationRef = useRef(0);
  const installTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopInstallPolling = useCallback((): void => {
    installGenerationRef.current++;
    if (installTimerRef.current !== null) clearTimeout(installTimerRef.current);
    installTimerRef.current = null;
  }, []);
  const probeStartedForEnabledRef = useRef(enabled && requiresGit());

  const safeSetState = useCallback((next: WindowsGitGateState): void => {
    if (mountedRef.current) {
      setState(next);
    }
  }, []);

  const clearProgressSubscription = useCallback((): void => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }, []);

  // Initial detection + lifecycle teardown. Unsupported builds never gate.
  useEffect(() => {
    mountedRef.current = true;
    let cancelled = false;

    if (!enabled || !requiresGit()) {
      probeStartedForEnabledRef.current = false;
      clearProgressSubscription();
      stopInstallPolling();
      setState({ kind: 'not-required' });
    } else {
      probeStartedForEnabledRef.current = true;
      setState({ kind: 'checking' });
      void window.api
        .getGitExecutableStatus()
        .then((status) => {
          if (cancelled) return;
          if (status.required && !status.ready) {
            setState({ kind: 'required', status });
          } else {
            // Git is already usable (or not required for this build): proceed
            // without ever showing the gate.
            setState({ kind: 'not-required' });
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          // A failed startup probe must not silently fall through to the shell
          // on supported platforms; surface a recoverable gate instead.
          setState({
            kind: 'error',
            status: null,
            message: errorMessage(
              error,
              'Unable to verify your Git installation.',
            ),
          });
        });
    }

    return (): void => {
      cancelled = true;
      mountedRef.current = false;
      clearProgressSubscription();
      stopInstallPolling();
    };
  }, [clearProgressSubscription, enabled, stopInstallPolling]);

  const recheck = useCallback(async (): Promise<void> => {
    if (!enabled || !requiresGit()) return;
    safeSetState({ kind: 'checking' });
    try {
      const status = await window.api.redetectGitExecutable();
      safeSetState(resolveRecheckState(status));
    } catch (error: unknown) {
      safeSetState({
        kind: 'error',
        status: null,
        message: errorMessage(error, 'No valid Git installation was detected.'),
      });
    }
  }, [enabled, safeSetState]);

  const browse = useCallback(async (): Promise<void> => {
    if (!enabled || !requiresGit()) return;
    safeSetState({ kind: 'checking' });
    try {
      const status = await window.api.browseGitExecutable();
      safeSetState(resolveRecheckState(status));
    } catch (error: unknown) {
      safeSetState({
        kind: 'error',
        status: null,
        message: errorMessage(error, 'No valid Git executable was selected.'),
      });
    }
  }, [enabled, safeSetState]);

  const autoInstall = useCallback(async (): Promise<void> => {
    // Linux installation stays in the user's terminal; never launch a privileged installer.
    if (!enabled || !requiresGit() || window.platform === 'linux') return;
    const priorStatus = statusFromState(state);
    if (window.platform === 'darwin') {
      stopInstallPolling();
      const generation = installGenerationRef.current;
      const active = (): boolean =>
        mountedRef.current && generation === installGenerationRef.current;
      safeSetState({
        kind: 'installing',
        status: priorStatus,
        progress: INITIAL_INSTALL_PROGRESS,
      });
      try {
        await window.api.installGitWithXcode();
        if (!active()) return;
        safeSetState({
          kind: 'installing',
          status: priorStatus,
          progress: {
            phase: 'verifying',
            message:
              "Choose Install in Apple's dialog and accept the license. We'll continue automatically when Git is ready.",
          },
        });
        const poll = async (): Promise<void> => {
          if (!active()) return;
          try {
            const detected = await window.api.redetectGitExecutable();
            if (!active()) return;
            if (detected.ready && detected.path) {
              stopInstallPolling();
              safeSetState({ kind: 'not-required' });
              return;
            }
          } catch {
            /* Transient detection failures are retried silently. */
          }
          if (active())
            installTimerRef.current = setTimeout(() => {
              void poll();
            }, 3000);
        };
        installTimerRef.current = setTimeout(() => {
          void poll();
        }, 3000);
      } catch (error: unknown) {
        if (active())
          safeSetState({
            kind: 'error',
            status: priorStatus,
            message: errorMessage(
              error,
              'Unable to open the Apple installer. Recheck Git or try again.',
            ),
          });
      }
      return;
    }
    // Drop any prior subscription before starting a fresh install.
    clearProgressSubscription();
    safeSetState({
      kind: 'installing',
      status: priorStatus,
      progress: INITIAL_INSTALL_PROGRESS,
    });
    unsubscribeRef.current = window.api.onGitInstallProgress(
      (progress): void => {
        safeSetState({ kind: 'installing', status: priorStatus, progress });
      },
    );
    try {
      const status = await window.api.installGitWithWinget();
      if (status.ready) {
        // Verified install — close the gate automatically.
        safeSetState({ kind: 'not-required' });
      } else {
        safeSetState({
          kind: 'error',
          status,
          message: status.error ?? 'Git installation could not be verified.',
        });
      }
    } catch (error: unknown) {
      safeSetState({
        kind: 'error',
        status: priorStatus,
        message: errorMessage(error, 'Git installation failed.'),
      });
    } finally {
      clearProgressSubscription();
    }
  }, [
    clearProgressSubscription,
    enabled,
    safeSetState,
    state,
    stopInstallPolling,
  ]);

  const cancelInstall = useCallback((): void => {
    stopInstallPolling();
    const priorStatus = statusFromState(state);
    safeSetState(
      priorStatus
        ? { kind: 'required', status: priorStatus }
        : {
            kind: 'error',
            status: null,
            message:
              'Installation checks stopped. Recheck when Git is installed.',
          },
    );
  }, [safeSetState, state, stopInstallPolling]);

  const dismiss = useCallback((): void => {
    safeSetState({ kind: 'not-required' });
  }, [safeSetState]);

  const visibleState: WindowsGitGateState =
    enabled &&
    requiresGit() &&
    state.kind === 'not-required' &&
    !probeStartedForEnabledRef.current
      ? { kind: 'checking' }
      : state;

  return {
    state: visibleState,
    recheck,
    browse,
    autoInstall,
    dismiss,
    cancelInstall,
  };
}

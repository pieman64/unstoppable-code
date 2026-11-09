import { useSyncExternalStore } from 'react';
import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { AgentProviderAuthStatus } from '@canopy/desktop-shared/types';
import { readRemoteControlContext } from '@/stores/remoteControlStore';

export type ProbedRuntime = 'claude' | 'codex';

export interface RuntimeProbeView {
  /** Two distinct consecutive retryable probe failures, not yet recovered. */
  readonly unreachable: boolean;
  /** Raised before going offline; not shown again until a fresh probe fails. */
  readonly revalidating: boolean;
  /** A retry the user asked for is running. */
  readonly retrying: boolean;
}

export type RuntimeProbeSnapshot = Readonly<
  Record<ProbedRuntime, RuntimeProbeView>
>;

/** Fences late and repeated results; taken before the probe is sent. */
export interface RuntimeProbeToken {
  readonly generation: number;
  readonly sequence: number;
  readonly eligible: boolean;
}

export interface RuntimeProbeEnvironment {
  probe: (runtime: ProbedRuntime) => Promise<AgentProviderAuthStatus>;
  isLocal: () => boolean;
  isOnline: () => boolean;
  subscribeConnectivity: (
    onOnline: () => void,
    onOffline: () => void,
  ) => () => void;
}

export interface RuntimeProbeCoordinator {
  begin: () => RuntimeProbeToken;
  observe: (
    runtime: ProbedRuntime,
    token: RuntimeProbeToken,
    status: AgentProviderAuthStatus,
  ) => void;
  retry: (runtime: ProbedRuntime) => void;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => RuntimeProbeSnapshot;
  onRecovered: (listener: (runtime: ProbedRuntime) => void) => () => void;
}

const CONFIRMATION_DELAY_MS = 5_000;
const RECOVERY_RETRY_MS = 30_000;
const RUNTIMES: readonly ProbedRuntime[] = ['claude', 'codex'];

type Phase =
  | 'healthy'
  /** One failure; waiting to send the one fresh confirmation. */
  | 'awaiting-confirmation'
  /** The confirmation is out; the next qualifying failure raises. */
  | 'confirming'
  | 'raised';

interface RuntimeEntry {
  phase: Phase;
  revalidating: boolean;
  retrying: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  inflight: RuntimeProbeToken | null;
  lastApplied: number;
  /** A failure seen before the host subscribed, so it still gets confirmed. */
  pendingFailure: boolean;
}

/**
 * Whether this status can mean the runtime itself couldn't be reached. This is
 * a product assumption: it identifies a retryable probe failure, which does not
 * prove that the bundled binary is defective. A stable unknown (a custom Codex
 * `model_provider`) is an answer, so it does not qualify, and neither does a
 * signed-out result.
 */
export function isRetryableProbeFailure(
  status: AgentProviderAuthStatus,
): boolean {
  return status.probeFailed === true && status.probeRetryable !== false;
}

export function createRuntimeProbeCoordinator(
  environment: RuntimeProbeEnvironment,
): RuntimeProbeCoordinator {
  let generation = 0;
  let sequence = 0;
  let holders = 0;
  let disconnect: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const recoveryListeners = new Set<(runtime: ProbedRuntime) => void>();
  const entries: Record<ProbedRuntime, RuntimeEntry> = {
    claude: createEntry(),
    codex: createEntry(),
  };
  let snapshot = buildSnapshot();

  function createEntry(): RuntimeEntry {
    return {
      phase: 'healthy',
      revalidating: false,
      retrying: false,
      timer: null,
      inflight: null,
      lastApplied: 0,
      pendingFailure: false,
    };
  }

  function viewOf(entry: RuntimeEntry): RuntimeProbeView {
    return {
      unreachable: entry.phase === 'raised',
      revalidating: entry.revalidating,
      retrying: entry.retrying,
    };
  }

  function buildSnapshot(): RuntimeProbeSnapshot {
    return { claude: viewOf(entries.claude), codex: viewOf(entries.codex) };
  }

  function publish(): void {
    const next = buildSnapshot();
    const unchanged = RUNTIMES.every(
      (runtime) =>
        next[runtime].unreachable === snapshot[runtime].unreachable &&
        next[runtime].revalidating === snapshot[runtime].revalidating &&
        next[runtime].retrying === snapshot[runtime].retrying,
    );
    if (unchanged) return;
    snapshot = next;
    listeners.forEach((listener) => {
      listener();
    });
  }

  function stopTimer(entry: RuntimeEntry): void {
    if (entry.timer !== null) clearTimeout(entry.timer);
    entry.timer = null;
  }

  function begin(): RuntimeProbeToken {
    sequence += 1;
    return {
      generation,
      sequence,
      eligible: environment.isLocal() && environment.isOnline(),
    };
  }

  function scheduleRetry(runtime: ProbedRuntime): void {
    const entry = entries[runtime];
    if (
      entry.phase !== 'raised' ||
      entry.timer !== null ||
      entry.inflight !== null ||
      holders === 0 ||
      !environment.isOnline()
    ) {
      return;
    }
    entry.timer = setTimeout((): void => {
      entry.timer = null;
      runProbe(runtime);
    }, RECOVERY_RETRY_MS);
  }

  /** At most one request per runtime, however the triggers overlap. */
  function runProbe(runtime: ProbedRuntime): void {
    const entry = entries[runtime];
    if (holders === 0 || !environment.isLocal() || !environment.isOnline()) {
      return;
    }
    if (entry.inflight !== null) return;
    stopTimer(entry);
    const token = begin();
    entry.inflight = token;
    void Promise.resolve()
      .then(() => {
        if (
          holders === 0 ||
          token.generation !== generation ||
          !environment.isLocal() ||
          !environment.isOnline()
        )
          return undefined;
        return environment.probe(runtime);
      })
      .then((status) => {
        if (status !== undefined) observe(runtime, token, status);
      })
      // A rejected invoke says nothing about the runtime: no count, no recovery.
      .catch((cause: unknown) => {
        reportClientAppError(cause);
      })
      .finally(() => {
        // Superseded by a reset: that reset already owns this entry's state.
        if (entry.inflight !== token) return;
        entry.inflight = null;
        entry.retrying = false;
        // Keep the physical request single-flight across offline/reconnect,
        // but its old result cannot answer the new connectivity context.
        if (
          token.generation !== generation &&
          entry.revalidating &&
          environment.isOnline()
        ) {
          runProbe(runtime);
        }
        // Still unanswered, so the single confirmation raised nothing.
        if (entry.phase === 'confirming') entry.phase = 'healthy';
        scheduleRetry(runtime);
        publish();
      });
  }

  function applyOutcome(runtime: ProbedRuntime, failed: boolean): void {
    const entry = entries[runtime];
    if (!failed) {
      const recovered = entry.phase === 'raised';
      stopTimer(entry);
      entry.phase = 'healthy';
      entry.revalidating = false;
      publish();
      if (recovered) {
        recoveryListeners.forEach((listener) => {
          listener(runtime);
        });
      }
      return;
    }
    if (!environment.isOnline()) return;
    if (entry.phase === 'healthy') {
      entry.phase = 'awaiting-confirmation';
      entry.timer = setTimeout((): void => {
        entry.timer = null;
        entry.phase = 'confirming';
        runProbe(runtime);
        if (entry.inflight === null) entry.phase = 'healthy';
      }, CONFIRMATION_DELAY_MS);
    } else if (entry.phase === 'confirming') {
      entry.phase = 'raised';
    } else if (entry.phase === 'raised') {
      entry.revalidating = false;
    }
    scheduleRetry(runtime);
    publish();
  }

  function observe(
    runtime: ProbedRuntime,
    token: RuntimeProbeToken,
    status: AgentProviderAuthStatus,
  ): void {
    const entry = entries[runtime];
    if (
      !environment.isLocal() ||
      !environment.isOnline() ||
      !token.eligible ||
      token.generation !== generation ||
      token.sequence <= entry.lastApplied
    ) {
      return;
    }
    entry.lastApplied = token.sequence;
    const failed = isRetryableProbeFailure(status);
    if (holders === 0) {
      entry.pendingFailure = failed && environment.isOnline();
      return;
    }
    applyOutcome(runtime, failed);
  }

  function handleOffline(): void {
    generation += 1;
    for (const runtime of RUNTIMES) {
      const entry = entries[runtime];
      stopTimer(entry);
      entry.retrying = false;
      entry.pendingFailure = false;
      if (entry.phase === 'raised') {
        entry.revalidating = true;
      } else {
        entry.phase = 'healthy';
      }
    }
    publish();
  }

  function handleOnline(): void {
    for (const runtime of RUNTIMES) {
      if (entries[runtime].phase === 'raised') runProbe(runtime);
    }
  }

  function activate(): void {
    disconnect = environment.subscribeConnectivity(handleOnline, handleOffline);
    for (const runtime of RUNTIMES) {
      const entry = entries[runtime];
      if (entry.pendingFailure) {
        entry.pendingFailure = false;
        applyOutcome(runtime, true);
      }
    }
  }

  /** Context-bound state ends here: a later holder needs fresh observations. */
  function deactivate(): void {
    disconnect?.();
    disconnect = null;
    generation += 1;
    for (const runtime of RUNTIMES) {
      const entry = entries[runtime];
      stopTimer(entry);
      entry.phase = 'healthy';
      entry.revalidating = false;
      entry.retrying = false;
      entry.inflight = null;
      entry.pendingFailure = false;
    }
    publish();
  }

  return {
    begin,
    observe,
    retry: (runtime): void => {
      const entry = entries[runtime];
      if (entry.phase !== 'raised' || !environment.isOnline()) return;
      entry.retrying = true;
      runProbe(runtime);
      if (entry.inflight === null) entry.retrying = false;
      publish();
    },
    subscribe: (listener): (() => void) => {
      listeners.add(listener);
      holders += 1;
      if (holders === 1) activate();
      return (): void => {
        listeners.delete(listener);
        holders -= 1;
        if (holders === 0) deactivate();
      };
    },
    getSnapshot: () => snapshot,
    onRecovered: (listener): (() => void) => {
      recoveryListeners.add(listener);
      return (): void => {
        recoveryListeners.delete(listener);
      };
    },
  };
}

const coordinator = createRuntimeProbeCoordinator({
  probe: (runtime) =>
    // Bypasses main's cache too, so each attempt is a distinct probe.
    runtime === 'claude'
      ? window.api.getClaudeAuthStatus({ forceRefresh: true })
      : window.api.getCodexAuthStatus({ forceRefresh: true }),
  isLocal: () => readRemoteControlContext().mode === 'local',
  isOnline: () => navigator.onLine,
  subscribeConnectivity: (onOnline, onOffline) => {
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return (): void => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  },
});

export function beginRuntimeAuthProbe(): RuntimeProbeToken {
  return coordinator.begin();
}

export function observeRuntimeAuthProbe(
  runtime: ProbedRuntime,
  token: RuntimeProbeToken,
  status: AgentProviderAuthStatus,
): void {
  coordinator.observe(runtime, token, status);
}

export function retryRuntime(runtime: ProbedRuntime): void {
  coordinator.retry(runtime);
}

/** Fires once per confirmed recovery; pollers never invalidate auth caches. */
export function onRuntimeProbeRecovered(
  listener: (runtime: ProbedRuntime) => void,
): () => void {
  return coordinator.onRecovered(listener);
}

/** Holding this is what runs the timers: mount it only in local mode. */
export function useRuntimeProbeOutcomes(): RuntimeProbeSnapshot {
  return useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);
}

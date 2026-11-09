import { reportClientAppError } from '@canopy/desktop-instrumentation/client';
import type { CanopyApi, OllamaState } from '@canopy/desktop-shared/types';
import { useOllamaConnectionBannerStore } from '@/stores/ollamaConnectionBannerStore';
import { readRemoteControlContext } from '@/stores/remoteControlStore';

const OLLAMA_RECOVERY_RETRY_MS = 30_000;

function isRunning(state: OllamaState): boolean {
  return (
    state.status === 'running-managed' || state.status === 'running-external'
  );
}

/**
 * One local host owns target tracking and unavailable-only polling. Unknown
 * targets stay until next send; a success on another port cannot clear them.
 * Main's Ollama service supports loopback targets only.
 */
export function startOllamaUnavailableRecovery(
  api: Pick<
    Partial<CanopyApi>,
    'testOllamaConnection' | 'onOllamaStatus' | 'getOllamaState'
  >,
): () => void {
  const store = useOllamaConnectionBannerStore;
  let stopped = false;
  let testing = false;
  let statusGeneration = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const isActive = (): boolean =>
    !stopped && readRemoteControlContext().mode === 'local';

  const retest = (): void => {
    const test = api.testOllamaConnection;
    if (!isActive() || testing || typeof test !== 'function') return;
    testing = true;
    const baseline = store.getState().unavailableTargetsByChat;
    const ports = new Set(
      Object.values(baseline).flatMap((target) =>
        target?.port == null ? [] : [target.port],
      ),
    );
    void (async (): Promise<void> => {
      try {
        await Promise.resolve();
        for (const port of ports) {
          if (!isActive()) return;
          try {
            const result = await test(port, { background: true });
            if (
              isActive() &&
              result.ok &&
              result.host === '127.0.0.1' &&
              result.port === port
            ) {
              store.getState().clearRecoveredPort(port, baseline);
            }
          } catch (cause: unknown) {
            reportClientAppError(cause);
          }
        }
      } finally {
        testing = false;
      }
    })();
  };

  const updateTimer = (): void => {
    const unavailable = Object.values(store.getState().unavailableByChat).some(
      (value) => value === true,
    );
    if (unavailable && timer === null)
      timer = setInterval(retest, OLLAMA_RECOVERY_RETRY_MS);
    if (!unavailable && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
  const stopStore = store.subscribe(updateTimer);
  updateTimer();
  const unsubscribe = api.onOllamaStatus?.((state) => {
    if (!isActive()) return;
    statusGeneration++;
    store.getState().setConnectionPort(state.port);
    if (isRunning(state))
      store
        .getState()
        .clearRecoveredPort(
          state.port,
          store.getState().unavailableTargetsByChat,
        );
  });
  const initialGeneration = statusGeneration;
  // Subscribe before reading; an intervening event wins over the initial read.
  void Promise.resolve()
    .then(() => (isActive() ? api.getOllamaState?.() : undefined))
    .then((state) => {
      if (state && isActive() && initialGeneration === statusGeneration)
        store.getState().setConnectionPort(state.port);
    })
    .catch((cause: unknown) => {
      reportClientAppError(cause);
    });

  return (): void => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    stopStore();
    unsubscribe?.();
    store.getState().resetContext();
  };
}

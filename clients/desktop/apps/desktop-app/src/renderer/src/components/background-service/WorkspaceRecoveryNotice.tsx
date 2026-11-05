import { useEffect, useState, type JSX } from 'react';
import { W5RecoveryNotice } from '@canopy/ui-shared/components';
import type { W5RecoveryStatus } from '@canopy/protocol/portal';
import { useCapabilities } from '@canopy/app-state';
import { useRemoteControlStore } from '@/stores/remoteControlStore';

export function WorkspaceRecoveryNotice(): JSX.Element | null {
  const local = useRemoteControlStore(
    (store) => store.context.mode === 'local',
  );
  const capabilities = useCapabilities();
  const [status, setStatus] = useState<W5RecoveryStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const paused =
    status?.state === 'restart-required' ||
    status?.reason === 'request-unavailable';
  useEffect(() => {
    const api = local && !paused ? window.api?.w5Recovery : undefined;
    if (!api) return undefined;
    let active = true;
    let inFlight = false;
    const refresh = async (): Promise<void> => {
      if (inFlight) return;
      inFlight = true;
      try {
        const next = await api.getStatus();
        if (active) setStatus(next);
      } catch {
        /* Background service failures have their own notice. */
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 10_000);
    return (): void => {
      active = false;
      clearInterval(timer);
    };
  }, [local, paused]);
  if (!local || !status) return null;
  return (
    <W5RecoveryNotice
      status={status}
      canRecover={capabilities.workspaceRecovery === true}
      busy={busy}
      onRecover={(): void => {
        if (busy) return;
        setBusy(true);
        void window.api.w5Recovery
          .prepare()
          .then(async (next) => {
            setStatus(next);
            if (next.state === 'restart-required')
              await window.api.restartApp();
          })
          .catch(() => {
            setStatus((previous) =>
              previous
                ? {
                    ...previous,
                    state: 'refused',
                    canRecover: false,
                    reason: 'request-unavailable',
                  }
                : previous,
            );
          })
          .finally(() => setBusy(false));
      }}
    />
  );
}

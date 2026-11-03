import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import {
  BackgroundServiceStatusSchema,
  type BackgroundServiceApi,
  type BackgroundServiceStatus,
} from '@canopy/desktop-shared/lib/background-service-status';

type StatusListener = (event: unknown, payload: unknown) => void;

interface BackgroundServiceIpc {
  invoke(
    channel:
      | typeof IPC_CHANNELS.backgroundServiceStatus
      | typeof IPC_CHANNELS.backgroundServiceRetry,
  ): Promise<unknown>;
  on(
    channel: typeof IPC_CHANNELS.backgroundServiceStatusChanged,
    listener: StatusListener,
  ): void;
  removeListener(
    channel: typeof IPC_CHANNELS.backgroundServiceStatusChanged,
    listener: StatusListener,
  ): void;
}

async function readStatus(
  reply: Promise<unknown>,
): Promise<BackgroundServiceStatus> {
  const parsed = BackgroundServiceStatusSchema.safeParse(await reply);
  if (!parsed.success)
    throw new Error('Background service status was unavailable.');
  return parsed.data;
}

/** `window.api.backgroundService` (CAN-5541); only main's strict status crosses. */
export function createBackgroundServiceApi(
  ipc: BackgroundServiceIpc,
): BackgroundServiceApi {
  return {
    getStatus: () =>
      readStatus(ipc.invoke(IPC_CHANNELS.backgroundServiceStatus)),
    retry: () => readStatus(ipc.invoke(IPC_CHANNELS.backgroundServiceRetry)),
    onStatusChanged: (callback) => {
      const listener: StatusListener = (_event, payload) => {
        const parsed = BackgroundServiceStatusSchema.safeParse(payload);
        if (parsed.success) callback(parsed.data);
      };
      ipc.on(IPC_CHANNELS.backgroundServiceStatusChanged, listener);
      return () => {
        ipc.removeListener(
          IPC_CHANNELS.backgroundServiceStatusChanged,
          listener,
        );
      };
    },
  };
}

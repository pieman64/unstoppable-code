import {
  IPC_CHANNELS,
  type WorkerCardData,
} from '@canopy/desktop-shared/types';
import type { WindowAccessors } from './index';
import { registerIpcHandler } from './register';
import { sendToWindow } from '../lib/window-send';
import { getClaudeWorkerSessionService } from '../integration/claude-worker-session-service';

export function registerWorkerHandlers(
  accessors: Pick<WindowAccessors, 'getMainWindow' | 'getAppAdvisorWindow'>,
): void {
  const service = getClaudeWorkerSessionService();
  service.setEventSender((channel, payload) => {
    sendToWindow(accessors.getMainWindow(), channel, payload);
    sendToWindow(accessors.getAppAdvisorWindow(), channel, payload);
  });

  registerIpcHandler<[], WorkerCardData[]>(IPC_CHANNELS.workersList, () =>
    service.listWorkers(),
  );
  registerIpcHandler<[string], void>(
    IPC_CHANNELS.workerCancel,
    async (_event, workerId) => {
      await service.cancel(workerId);
    },
  );
  registerIpcHandler<[string], void>(
    IPC_CHANNELS.workerRetry,
    async (_event, workerId) => {
      await service.retry(workerId);
    },
  );
}

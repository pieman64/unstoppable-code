import { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import { labsExperimentChoiceRequestSchema } from '@canopy/protocol/experiments';
import type { LabsExperimentsSnapshot } from '@canopy/desktop-shared/lib/labs-experiments';
import { getLabsExperimentsService } from '../services/labs-experiments-runtime';
import { registerIpcHandler } from './register';
import { sendToWebContents } from '../lib/web-contents-send';

export function registerLabsExperimentsHandlers(): void {
  const service = getLabsExperimentsService();
  registerIpcHandler(
    IPC_CHANNELS.experimentsGetSnapshot,
    (): LabsExperimentsSnapshot => service.getSnapshot(),
  );
  registerIpcHandler<[unknown], LabsExperimentsSnapshot>(
    IPC_CHANNELS.experimentsSetChoice,
    (_event, request): Promise<LabsExperimentsSnapshot> =>
      service.setChoice(labsExperimentChoiceRequestSchema.parse(request)),
  );
  service.onSnapshotChanged((snapshot) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed())
        sendToWebContents(
          window.webContents,
          IPC_CHANNELS.experimentsSnapshotChanged,
          snapshot,
        );
  });
}

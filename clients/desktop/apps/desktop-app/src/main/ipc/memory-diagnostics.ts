import { shell } from 'electron';
import {
  IPC_CHANNELS,
  type CreateMemoryReportResult,
  type MemoryDiagnosticsStatus,
} from '@canopy/desktop-shared/types';
import { getMemoryDiagnosticsService } from '../memory-diagnostics';
import { isMemoryReportId } from '../lib/validation';
import { registerIpcHandler } from './register';

export function registerMemoryDiagnosticsHandlers(): void {
  registerIpcHandler<[], MemoryDiagnosticsStatus>(
    IPC_CHANNELS.memoryDiagnosticsGetStatus,
    () => getMemoryDiagnosticsService().getStatus(),
  );

  registerIpcHandler<[], CreateMemoryReportResult>(
    IPC_CHANNELS.memoryDiagnosticsCreateReport,
    () => getMemoryDiagnosticsService().createReport(),
  );

  registerIpcHandler<[unknown], boolean>(
    IPC_CHANNELS.memoryDiagnosticsRevealReport,
    (_event, reportId) => {
      if (!isMemoryReportId(reportId)) {
        return false;
      }

      // The service also checks the folder is a real directory in its root.
      const reportPath =
        getMemoryDiagnosticsService().resolveReportPath(reportId);
      if (reportPath === null) {
        return false;
      }

      shell.showItemInFolder(reportPath);
      return true;
    },
  );
}

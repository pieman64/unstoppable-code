import {
  IPC_CHANNELS,
  type CloneJobSnapshot,
} from '@canopy/desktop-shared/types';
import { getCloneJobs } from '../services/clone-jobs-host';
import { validateId } from '../lib/validation';
import { registerIpcHandler } from './register';

export function registerCloneJobHandlers(): void {
  registerIpcHandler(IPC_CHANNELS.cloneJobsList, (): CloneJobSnapshot[] =>
    getCloneJobs().list(),
  );

  registerIpcHandler(
    IPC_CHANNELS.cloneJobsBackground,
    (_event, jobId: string): boolean => {
      validateId(jobId, 'jobId');
      return getCloneJobs().background(jobId);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.cloneJobsCancel,
    async (_event, jobId: string): Promise<void> => {
      validateId(jobId, 'jobId');
      await getCloneJobs().cancel(jobId);
    },
  );

  registerIpcHandler(
    IPC_CHANNELS.cloneJobsDismiss,
    (_event, jobId: string): void => {
      validateId(jobId, 'jobId');
      getCloneJobs().dismiss(jobId);
    },
  );
}

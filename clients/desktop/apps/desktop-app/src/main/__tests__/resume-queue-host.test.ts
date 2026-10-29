import { performance } from 'node:perf_hooks';
import type { ResumeQueueSnapshot } from '@canopy/desktop-shared/types';
import {
  startResumeQueue,
  stopResumeQueue,
  configureResumeQueue,
} from '../services/resume-queue-host';

const mockTick = jest.fn().mockResolvedValue(undefined);
jest.mock('electron', () => ({
  BrowserWindow: { getAllWindows: (): [] => [] },
}));
jest.mock('node:perf_hooks', () => ({
  performance: { now: jest.fn() },
}));
jest.mock('../lib/paths', () => ({
  getResumeQueueFilePath: (): string => '/queue.json',
}));
jest.mock('../lib/main-process-logging', () => ({
  logMainProcessInfo: jest.fn(),
  logMainProcessError: jest.fn(),
}));
jest.mock('../services/resume-queue-storage', () => ({
  ResumeQueueStorage: jest.fn(),
}));
jest.mock('../services/resume-queue-service', () => ({
  ResumeQueueService: jest.fn(() => ({
    initialize: (): Promise<void> => Promise.resolve(),
    snapshot: (): Pick<ResumeQueueSnapshot, 'paused'> & {
      entries: { status: string }[];
    } => ({ paused: false, entries: [{ status: 'waiting' }] }),
    tick: mockTick,
    stop: jest.fn(),
  })),
}));

it('keeps admitting resumes after a transient recovery collection failure', async () => {
  jest.useFakeTimers();
  try {
    configureResumeQueue({
      collect: jest
        .fn()
        .mockRejectedValueOnce(new Error('The resume queue is full'))
        .mockResolvedValue(undefined),
      dispatch: jest.fn(),
      reconcile: jest.fn(),
      canDispatch: jest.fn().mockResolvedValue(true),
    });
    jest.mocked(performance).now.mockReturnValueOnce(0).mockReturnValue(2000);
    startResumeQueue();
    await jest.advanceTimersByTimeAsync(500);
    expect(mockTick).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(500);
    expect(mockTick).toHaveBeenCalledTimes(2);
  } finally {
    stopResumeQueue();
    jest.useRealTimers();
  }
});

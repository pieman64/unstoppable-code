jest.mock('../../resource-monitor', () => ({
  getResourceMonitorService: (): unknown => ({
    registerProcess: (): unknown => ({ unregister: (): void => undefined }),
  }),
}));

import type {
  ScriptProcessResult,
  ScriptRunTracking,
} from '@canopy/core-runtime/node/script/execution';
import {
  desktopScriptWorker,
  setExternalScriptRuns,
  stopTrackedShellScript,
  type ExternalScriptRuns,
} from '../script-runner';

const tracking: ScriptRunTracking = {
  projectId: 'project',
  worktreeId: 'task',
  scriptKey: 'project:dev',
  kind: 'script',
};
const result: ScriptProcessResult = {
  success: false,
  exitCode: null,
  output: '',
  timedOut: false,
  durationMs: 0,
};

afterEach(() => {
  setExternalScriptRuns(null);
});

it('stops a script key on both hosts when each runs it', async () => {
  let resolveExit: (value: ScriptProcessResult) => void = (): void => undefined;
  const waitForExit = new Promise<ScriptProcessResult>((resolve) => {
    resolveExit = resolve;
  });
  const localStop = jest.fn(() => resolveExit(result));
  const local = {
    stop: localStop,
    drain: (): Promise<void> => Promise.resolve(),
    waitForExit,
    tracking: { ...tracking, runId: 'local' },
  };
  desktopScriptWorker.registry.add(local);
  const externalStop = jest.fn<
    ReturnType<ExternalScriptRuns['stop']>,
    Parameters<ExternalScriptRuns['stop']>
  >(() =>
    Promise.resolve([
      { response: result, tracking: { ...tracking, runId: 'daemon' } },
    ]),
  );
  setExternalScriptRuns({
    list: () => [{ ...tracking, runId: 'daemon' }],
    subscribe: () => (): void => undefined,
    stop: externalStop,
    stopRun: () => Promise.resolve(null),
    drainMatching: () => Promise.resolve([]),
    drainWorktree: () => Promise.resolve(),
    stopAll: () => undefined,
  });
  try {
    const stopped = await stopTrackedShellScript(tracking);
    expect(stopped?.tracking?.runId).toBe('local');
    expect(localStop).toHaveBeenCalledTimes(1);
    expect(externalStop).toHaveBeenCalledWith(tracking);
  } finally {
    desktopScriptWorker.registry.delete(local);
  }
});

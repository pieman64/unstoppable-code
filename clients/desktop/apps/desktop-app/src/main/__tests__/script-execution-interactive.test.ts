import type { ScriptDescriptor } from '@canopy/desktop-shared/types';

const mockStartScriptRunLog = jest.fn<Promise<unknown>, [unknown]>();
const mockCompleteScriptRunLog = jest.fn<Promise<void>, [unknown]>(() =>
  Promise.resolve(),
);
const mockRunShellScript = jest.fn<Promise<unknown>, [unknown]>();

jest.mock('../lib/script-log-store', () => ({
  appendScriptRunLogLines: jest.fn(() => Promise.resolve()),
  completeScriptRunLog: (args: unknown): Promise<void> =>
    mockCompleteScriptRunLog(args),
  startScriptRunLog: (args: unknown): Promise<unknown> =>
    mockStartScriptRunLog(args),
}));
jest.mock('../lib/script-runner', () => ({
  desktopScriptWorker: {},
  runShellScript: (options: unknown): Promise<unknown> =>
    mockRunShellScript(options),
  scriptTimeoutMs: jest.fn(() => null),
}));
jest.mock('../lib/script-execution-place', () => ({
  resolveScriptExecutionPlace: jest.fn(() =>
    Promise.resolve({ cwd: '/checkout', env: {} }),
  ),
}));
jest.mock('../lib/workspace-target-exclusion', () => ({
  assertWorkspaceTargetRuntimeStartAllowed: jest.fn(),
}));
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntime: jest.fn(),
}));
jest.mock('../pipelines/config-paths', () => ({ getEnhancedEnv: jest.fn() }));
jest.mock('../lib/paths', () => ({ getAppAdvisorHomeDir: jest.fn() }));

import { runDesktopScript } from '../lib/script-execution';

const script: ScriptDescriptor = {
  scriptKey: 'project:wizard',
  scriptName: 'wizard',
  label: 'Wizard',
  command: 'npx wizard',
  lifecycle: 'custom',
  target: 'project',
};

function interactiveRun(): Parameters<typeof runDesktopScript>[0] {
  return {
    projectId: 'project-1',
    worktreeId: 'worktree-1',
    context: { kind: 'project' },
    script,
    invocation: 'manual-run',
    command: script.command,
    timeoutSeconds: null,
    interactive: true,
  };
}

describe('interactive script run logs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStartScriptRunLog.mockResolvedValue({ runId: 'run-1' });
  });

  it('completes the run log as cancelled when a cancelled start throws', async () => {
    const stop = new AbortController();
    stop.abort();
    mockRunShellScript.mockRejectedValue(new Error('Script run cancelled.'));

    await expect(
      runDesktopScript(interactiveRun(), { signal: stop.signal }),
    ).rejects.toThrow('Script run cancelled.');

    expect(mockCompleteScriptRunLog).toHaveBeenCalledTimes(1);
    expect(mockCompleteScriptRunLog.mock.calls[0]?.[0]).toMatchObject({
      ref: { runId: 'run-1' },
      response: { success: false, exitCode: null, timedOut: false },
    });
  });

  it('completes the run log as failed when the start throws otherwise', async () => {
    mockRunShellScript.mockRejectedValue(new Error('No terminal.'));

    await expect(runDesktopScript(interactiveRun())).rejects.toThrow(
      'No terminal.',
    );

    expect(mockCompleteScriptRunLog.mock.calls[0]?.[0]).toMatchObject({
      ref: { runId: 'run-1' },
      response: { success: false, exitCode: 1 },
    });
  });
});

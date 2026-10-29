jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/mock/user-data'),
  },
}));

const mockRun = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('../integration/structured-helper-dispatch', () => ({
  codexStructuredHelperRunner: {
    run: (options: unknown): Promise<unknown> => mockRun(options),
  },
}));

const mockRunClaudeStructuredHelperQuery = jest.fn();
jest.mock('@canopy/desktop-shared/lib/structured-helper-query', () => ({
  runClaudeStructuredHelperQuery: (options: unknown): unknown =>
    mockRunClaudeStructuredHelperQuery(options),
}));

const mockSpawnClaudeCodeProcessOffMain = jest.fn();
jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: mockSpawnClaudeCodeProcessOffMain,
}));

const mockFinalizeObservedTask = jest.fn();
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    startObservedTask: jest.fn(),
    finalizeObservedTask: mockFinalizeObservedTask,
    seedTranscript: jest.fn(),
    appendTranscriptRecord: jest.fn(),
    updateObservedTask: jest.fn(),
  })),
}));

import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { generateAutomationIfCommand } from '../automations/if-command-generator';

initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);

describe('If Command generator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunClaudeStructuredHelperQuery.mockResolvedValue({
      value: { command: 'exit 0' },
      usage: {},
    });
  });

  it('hosts Claude generation off the main process', async () => {
    await expect(
      generateAutomationIfCommand({
        description: 'Run when the pull request is approved',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'medium',
      }),
    ).resolves.toEqual({ command: 'exit 0' });

    expect(mockRunClaudeStructuredHelperQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        spawnClaudeCodeProcess: mockSpawnClaudeCodeProcessOffMain,
      }),
    );
  });

  it('finalizes a failed task with usage from the helper error', async () => {
    mockRun.mockRejectedValueOnce(
      Object.assign(new Error('Codex helper failed'), {
        usage: {
          inputTokens: 23,
          outputTokens: 8,
          totalCostUsd: 0.23,
        },
      }),
    );

    await expect(
      generateAutomationIfCommand({
        description: 'Run when the pull request is approved',
        model: 'gpt-5.5',
        thinkingLevel: 'medium',
      }),
    ).rejects.toThrow('Codex helper failed');

    expect(mockFinalizeObservedTask).toHaveBeenCalledWith(
      expect.stringMatching(/^helper:automation-if-command:/),
      'failure',
      'Codex helper failed',
      {
        inputTokens: 23,
        outputTokens: 8,
        totalCostUsd: 0.23,
      },
    );
  });
});

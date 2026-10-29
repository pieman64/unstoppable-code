import { generatePrContentWithUsage } from '../github-pr-generator';
import type { CodexStructuredHelperRunner } from '../structured-helper-query';

const BASE_OPTIONS = {
  repoPath: '/repo',
  branchName: 'feat/routed-pr',
  baseBranch: 'develop',
  diff: 'diff --git a/file b/file',
  commitLog: 'feat: routed pr',
  localMemoryEnabled: false,
  instructions: '',
  instructionMode: 'append',
  prTemplate: '',
};

describe('generatePrContentWithUsage', () => {
  it('seeds a routed gateway model under the Claude harness instead of throwing', async () => {
    const seed = jest.fn(() => Promise.resolve());
    const runner = jest.fn().mockResolvedValue({
      value: { title: 'Routed PR', body: 'Body' },
      usage: {},
    });

    const result = await generatePrContentWithUsage(
      {
        ...BASE_OPTIONS,
        model: 'anthropic/claude-sonnet-5.5',
        executionHarness: 'claude',
        transcriptObserver: { seed, appendEvent: jest.fn() },
      },
      runner,
    );

    expect(seed).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'claude' }),
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      content: { title: 'Routed PR', body: 'Body' },
      source: 'model',
    });
  });

  it('seeds a routed gateway model under the Codex harness instead of throwing', async () => {
    const seed = jest.fn(() => Promise.resolve());
    const run = jest.fn().mockResolvedValue({
      value: { title: 'Routed Codex PR', body: 'Body' },
      usage: {},
    });
    const codexRunner: CodexStructuredHelperRunner = { run };

    const result = await generatePrContentWithUsage({
      ...BASE_OPTIONS,
      model: 'openai/gpt-5.5',
      executionHarness: 'codex',
      transcriptObserver: { seed, appendEvent: jest.fn() },
      codexRunner,
    });

    expect(seed).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex' }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      content: { title: 'Routed Codex PR', body: 'Body' },
      source: 'model',
    });
  });
});

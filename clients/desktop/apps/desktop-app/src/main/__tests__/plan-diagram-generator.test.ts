jest.mock('@canopy/desktop-shared/lib/structured-helper-query', () => ({
  runClaudeStructuredHelperQuery: jest.fn(),
  runCodexStructuredHelperQuery: jest.fn(),
}));

jest.mock('../agents/claude-process-host-runner', () => ({
  spawnClaudeCodeProcessOffMain: jest.fn(),
}));

import type { HelperTranscriptObserver } from '@canopy/desktop-shared/lib/helper-transcript';
import {
  runClaudeStructuredHelperQuery,
  runCodexStructuredHelperQuery,
} from '@canopy/desktop-shared/lib/structured-helper-query';
import { initClaudeModels } from '@canopy/desktop-shared/types';
import { spawnClaudeCodeProcessOffMain } from '../agents/claude-process-host-runner';
import {
  generateDataModelDiffDiagram,
  generateLogicDiffDiagram,
  generateSequenceDiagram,
} from '../lib/plan-diagram-generator';

const mockedRunClaudeStructuredHelperQuery = jest.mocked(
  runClaudeStructuredHelperQuery,
);
const mockedRunCodexStructuredHelperQuery = jest.mocked(
  runCodexStructuredHelperQuery,
);

initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);

function firstClaudeCall(): Record<string, unknown> {
  const call = mockedRunClaudeStructuredHelperQuery.mock.calls[0]?.[0] as
    | Record<string, unknown>
    | undefined;
  expect(call).toBeDefined();
  return call ?? {};
}

describe('plan diagram generator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedRunClaudeStructuredHelperQuery.mockResolvedValue({
      value: null,
      usage: {},
    });
    mockedRunCodexStructuredHelperQuery.mockResolvedValue({
      value: null,
      usage: {},
    });
  });

  it('uses maxTurns 50 for Claude sequence diagrams', async () => {
    await generateSequenceDiagram({
      planText: '# Plan',
      repoPath: '/repo',
      projectId: 'project-a',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });

    expect(mockedRunClaudeStructuredHelperQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 50,
        spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
      }),
    );
  });

  it('uses maxTurns 50 for Claude logic diff diagrams', async () => {
    await generateLogicDiffDiagram({
      planText: '# Plan',
      repoPath: '/repo',
      projectId: 'project-a',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });

    expect(mockedRunClaudeStructuredHelperQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 50,
        spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
      }),
    );
  });

  it('uses maxTurns 50 for Claude data model diff diagrams', async () => {
    await generateDataModelDiffDiagram({
      planText: '# Plan',
      repoPath: '/repo',
      projectId: 'project-a',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });

    expect(mockedRunClaudeStructuredHelperQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        maxTurns: 50,
        spawnClaudeCodeProcess: spawnClaudeCodeProcessOffMain,
      }),
    );
  });

  it('seeds and forwards helper transcript observers', async () => {
    const transcriptObserver: jest.Mocked<HelperTranscriptObserver> = {
      seed: jest.fn(),
      appendEvent: jest.fn(),
    };

    await generateSequenceDiagram({
      planText: '# Plan',
      repoPath: '/repo',
      projectId: 'project-a',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
      transcriptObserver,
    });

    const seed = transcriptObserver.seed.mock.calls[0]?.[0];
    expect(seed?.provider).toBe('claude');
    expect(seed?.originalText).toBe('# Plan\n\n# Plan');
    expect(seed?.originalText).not.toContain('JSON schema');
    expect(seed?.submittedText).toBe('# Plan\n\n# Plan');
    expect(seed?.systemPrompt).toContain('JSON schema');
    expect(seed?.systemPrompt).toContain('PHASE');
    expect(mockedRunClaudeStructuredHelperQuery).toHaveBeenCalledWith(
      expect.objectContaining({ transcriptObserver }),
    );
  });

  it('puts logic diagram rules in the helper system prompt', async () => {
    await generateLogicDiffDiagram({
      planText: '# Plan',
      repoPath: '/repo',
      projectId: 'project-a',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });

    const call = firstClaudeCall();
    expect(call.userMessage).toBe('# Plan\n\n# Plan');
    expect(call.userMessage).not.toContain('Never use `text`');
    expect(call.systemPrompt).toEqual(
      expect.stringContaining('Never use `text`'),
    );
  });

  it('puts data model ERD rules in the helper system prompt', async () => {
    await generateDataModelDiffDiagram({
      planText: '# Plan',
      repoPath: '/repo',
      projectId: 'project-a',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'medium',
    });

    const call = firstClaudeCall();
    expect(call.userMessage).toBe('# Plan\n\n# Plan');
    expect(call.userMessage).not.toContain('Applicability rules');
    expect(call.systemPrompt).toEqual(
      expect.stringContaining('Never use `keyKind`'),
    );
  });
});

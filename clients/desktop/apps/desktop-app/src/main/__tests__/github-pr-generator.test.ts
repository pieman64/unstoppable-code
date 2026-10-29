jest.mock('node:fs/promises');
jest.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: jest.fn(),
}));
jest.mock('@canopy/desktop-shared/pipelines/config-paths', () => ({
  getBundledClaudeBinaryPath: jest.fn(() => '/mock/claude'),
  getBundledRgBinaryPath: jest.fn(() => '/mock/rg'),
  getEnhancedEnv: jest.fn(() => ({ PATH: '/usr/bin' })),
}));
jest.mock('@canopy/desktop-shared/lib/codex-model-config', () => ({
  codexServiceTierForModelConfig: jest.fn((config?: { fastMode?: boolean }) =>
    config?.fastMode === true ? 'priority' : 'default',
  ),
  mapThinkingToReasoningEffort: jest.fn((level: string) => level),
  toSdkThreadOptions: jest.fn((options: unknown) => options),
}));

interface CodexEphemeralRequestForTest {
  profile: {
    environment: Record<string, string>;
    logicalWorkspaceEnvironmentId?: string;
    secretVersionFingerprint?: string;
  };
  params: { config?: unknown };
  turn: { input: Array<{ text?: string }> };
}

interface WorkerRequestForTest {
  prompt: string;
  resumeSessionId?: string;
}

const mockCodexRunEphemeralTurn = jest.fn<
  Promise<unknown>,
  [CodexEphemeralRequestForTest]
>();
const mockCodexDeleteThread = jest.fn(() => Promise.resolve());
const mockCodexStartThread = jest.fn(
  (request: Omit<CodexEphemeralRequestForTest, 'turn'>) =>
    Promise.resolve({
      threadId: 'pr-helper-thread',
      runTurn: (turn: CodexEphemeralRequestForTest['turn']) =>
        mockCodexRunEphemeralTurn({ ...request, turn }),
      delete: mockCodexDeleteThread,
    }),
);
const mockResolveCodexRuntimeEnvironmentProfile = jest.fn(() => ({
  environment: { WORKSPACE_AGENT_ENV: 'enabled' },
  logicalWorkspaceEnvironmentId: 'agent:workspace-agent',
  secretVersionFingerprint: 'workspace-secret-v1',
}));

jest.mock('../codex/runtime-service', () => ({
  getCodexRuntimeService: jest.fn(() => ({
    startThread: mockCodexStartThread,
  })),
}));

jest.mock('../lib/user-environment-runtime', () => ({
  resolveCodexRuntimeEnvironmentProfile:
    mockResolveCodexRuntimeEnvironmentProfile,
}));

jest.mock('../lib/helper-plugin-resolution', () => ({
  runWithOptionalHelperPlugins: jest.fn(),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ canopyBackgroundProcessesMode: 'canopy' }),
  ),
  // Local memory is opt-in (CAN-1969); default off in tests.
  readLocalMemoryEnabledPreference: jest.fn(() => Promise.resolve(false)),
}));

const mockRunWorker = jest.fn<Promise<unknown>, [WorkerRequestForTest]>();

jest.mock('../integration/claude-worker-session-service', () => ({
  getClaudeWorkerSessionService: jest.fn(() => ({
    runWorker: mockRunWorker,
  })),
}));

const startObservedTaskMock = jest.fn();
const finalizeObservedTaskMock = jest.fn();
const seedTranscriptMock = jest.fn();
const appendTranscriptRecordMock = jest.fn();
const updateObservedTaskMock = jest.fn();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    startObservedTask: startObservedTaskMock,
    finalizeObservedTask: finalizeObservedTaskMock,
    seedTranscript: seedTranscriptMock,
    appendTranscriptRecord: appendTranscriptRecordMock,
    updateObservedTask: updateObservedTaskMock,
  })),
}));

import { readFile } from 'node:fs/promises';
import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';
import { getEnhancedEnv } from '@canopy/desktop-shared/pipelines/config-paths';
import {
  initClaudeModels,
  initCodexModels,
} from '@canopy/desktop-shared/types';
import { readPreferencesFile } from '../lib/preferences-store';
import { generatePrContent } from '../lib/github-pr-generator';
import * as helperInvocation from '../ollama/helper-invocation';
import { runWithOptionalHelperPlugins } from '../lib/helper-plugin-resolution';

const mockedReadFile = jest.mocked(readFile);
const mockedClaudeQuery = jest.mocked(claudeQuery);
const mockedGetEnhancedEnv = jest.mocked(getEnhancedEnv);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedRunWithOptionalHelperPlugins = jest.mocked(
  runWithOptionalHelperPlugins,
);

initClaudeModels([{ id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' }]);
initCodexModels([{ id: 'gpt-5.5', label: 'GPT 5.5' }]);

async function* makeMessages(
  messages: unknown[],
): AsyncGenerator<unknown, void> {
  for (const message of messages) {
    await Promise.resolve();
    yield message;
  }
}

function mockClaudeQueryResultOnce(messages: unknown[]): void {
  // @ts-expect-error The async iterator is the only Claude SDK surface used here.
  mockedClaudeQuery.mockImplementationOnce(() => makeMessages(messages));
}

describe('generatePrContent', () => {
  it('cancels while helper preparation is waiting for proxy capacity', async () => {
    const controller = new AbortController();
    let entered: () => void = () => undefined;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release: () => void = () => undefined;
    let receivedSignal: AbortSignal | undefined;
    const resolver = jest.spyOn(helperInvocation, 'resolveHelperInvocation');
    resolver.mockImplementationOnce((_model, _state, routingOptions) => {
      receivedSignal = routingOptions?.signal;
      entered();
      return new Promise((_resolve, reject) => {
        release = (): void => reject(new Error('cancelled capacity wait'));
        receivedSignal?.addEventListener('abort', release, { once: true });
      });
    });
    let settled = false;
    const generation = generatePrContent({
      repoPath: '/repo',
      branchName: 'feat/test',
      baseBranch: 'develop',
      diff: 'diff',
      commitLog: 'change',
      model: 'gpt-5.5',
      abortController: controller,
    }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    try {
      await preparing;
      expect(receivedSignal).toBe(controller.signal);
      controller.abort();
      await generation;
      expect(settled).toBe(true);
      expect(mockedRunWithOptionalHelperPlugins).not.toHaveBeenCalled();
    } finally {
      release();
      await generation;
      resolver.mockRestore();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedReadPreferencesFile.mockResolvedValue({
      canopyBackgroundProcessesMode: 'canopy',
    });
    mockedRunWithOptionalHelperPlugins.mockImplementation((_, run) =>
      run({
        claudePlugins: [],
        claudeMcpServers: {},
        codexProcessEnv: {},
        codexCapabilityRoots: [],
        codexMcpServers: {},
      }),
    );
  });

  it('uses the Claude SDK with repo cwd and structured output', async () => {
    mockedClaudeQuery.mockReturnValue(
      makeMessages([
        {
          type: 'result',
          subtype: 'success',
          result: '',
          structured_output: {
            title: 'Add GitHub PR integration',
            body: 'Summary',
          },
        },
      ]) as ReturnType<typeof claudeQuery>,
    );

    const result = await generatePrContent({
      repoPath: '/tmp/repo',
      branchName: 'feature/prs',
      baseBranch: 'main',
      diff: 'diff --git a/file b/file',
      commitLog: 'abc123 Add feature',
      model: 'claude-sonnet-4-6',
      thinkingLevel: 'max',
      instructions: 'Mention testing.',
      instructionMode: 'append',
    });

    expect(result).toEqual({
      title: 'Add GitHub PR integration',
      body: 'Summary',
    });
    const firstCall = mockedClaudeQuery.mock.calls[0]?.[0];
    expect(firstCall).toBeDefined();
    expect(firstCall?.prompt).toContain('## Diff');
    expect(firstCall?.options?.cwd).toBe('/tmp/repo');
    expect(firstCall?.options?.model).toBe('claude-sonnet-4-6');
    expect(firstCall?.options?.maxTurns).toBe(10);
    expect(firstCall?.options?.pathToClaudeCodeExecutable).toBe('/mock/claude');
    expect(firstCall?.options?.permissionMode).toBe('plan');
    expect(firstCall?.options?.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
    });
    expect(firstCall?.options?.effort).toBe('max');
    expect(firstCall?.options?.sandbox?.ripgrep?.command).toBe('/mock/rg');
    expect(firstCall?.options?.settingSources).toEqual([
      'user',
      'project',
      'local',
    ]);
    expect(firstCall?.options?.systemPrompt).toContain(
      'Return exactly one structured object with two fields: `title` and `body`.',
    );
    expect(firstCall?.options?.systemPrompt).toContain(
      'The `title` value must be only the pull request title text. Do not use placeholder or label text such as "PR Title and Body", "Title", or "PR Title".',
    );
    expect(firstCall?.options?.systemPrompt).toContain(
      'Minimal example response: {"title":"Add GitHub PR generation","body":"## Summary\\n- Add generated PR title and body support"}',
    );
    expect(firstCall?.options?.outputFormat).toMatchObject({
      type: 'json_schema',
    });
  });

  it('retries a transient Claude server error with the chat backoff', async () => {
    jest.useFakeTimers();
    try {
      mockClaudeQueryResultOnce([
        {
          type: 'assistant',
          session_id: 'claude-pr-session',
          error: 'server_error',
          message: {
            content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }],
          },
        },
      ]);
      mockClaudeQueryResultOnce([
        {
          type: 'result',
          subtype: 'success',
          structured_output: {
            title: 'Recover PR generation',
            body: 'Recovered after a transient provider error.',
          },
        },
      ]);

      const resultPromise = generatePrContent({
        repoPath: '/tmp/repo',
        branchName: 'fix/pr-retry',
        baseBranch: 'main',
        diff: 'diff --git a/file b/file',
        commitLog: 'abc123 Add retry coverage',
        model: 'claude-sonnet-4-6',
        thinkingLevel: 'high',
        instructions: '',
        instructionMode: 'append',
      });

      await jest.advanceTimersByTimeAsync(30_000);

      await expect(resultPromise).resolves.toEqual({
        title: 'Recover PR generation',
        body: 'Recovered after a transient provider error.',
      });
      expect(mockedClaudeQuery).toHaveBeenCalledTimes(2);
      expect(updateObservedTaskMock).toHaveBeenCalledWith(
        expect.stringContaining('helper:pr-generation:/tmp/repo:'),
        { attempt: 2 },
      );
      expect(mockedClaudeQuery.mock.calls[1]?.[0]).toMatchObject({
        prompt: 'Continue',
        options: { resume: 'claude-pr-session' },
      });
      expect(
        appendTranscriptRecordMock.mock.calls.some(
          ([, event]) =>
            isRecord(event) && event.type === 'canopy_helper_retry',
        ),
      ).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('records worktree links and transcript records for audit entries', async () => {
    mockClaudeQueryResultOnce([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: '{"title":"Add PR audit links","body":"Summary"}',
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'success',
        structured_output: {
          title: 'Add PR audit links',
          body: 'Summary',
        },
      },
    ]);

    const result = await generatePrContent({
      repoPath: '/tmp/repo',
      branchName: 'feature/prs',
      baseBranch: 'main',
      diff: 'diff --git a/file b/file',
      commitLog: 'abc123 Add feature',
      model: 'claude-sonnet-4-6',
      instructions: 'Mention testing.',
      instructionMode: 'append',
      auditContext: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-1',
        repoLabel: 'repo',
      },
    });

    expect(result).toEqual({
      title: 'Add PR audit links',
      body: 'Summary',
    });
    expect(startObservedTaskMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        repoId: 'repo-1',
        repoLabel: 'repo',
      }),
    );
    expect(startObservedTaskMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      expect.any(Object),
    );
    const firstStartCall: unknown = startObservedTaskMock.mock.calls[0];
    if (!Array.isArray(firstStartCall)) {
      throw new Error('Expected observed task to be started');
    }
    expect(firstStartCall[1]).toEqual(
      expect.objectContaining({
        linkTarget: {
          page: 'main',
          kind: 'worktree-chat',
          projectId: 'project-1',
          worktreeId: 'worktree-1',
        },
      }),
    );
    expect(seedTranscriptMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      expect.objectContaining({
        provider: 'claude',
        originalText: [
          'Branch: feature/prs -> main',
          '',
          '## Commit Log',
          'abc123 Add feature',
          '',
          '## Diff',
          'diff --git a/file b/file',
        ].join('\n'),
        submittedText: [
          'Branch: feature/prs -> main',
          '',
          '## Commit Log',
          'abc123 Add feature',
          '',
          '## Diff',
          'diff --git a/file b/file',
        ].join('\n'),
        planMode: false,
        injectedPrompts: [
          expect.objectContaining({
            applicationCondition: 'helper_task_system_prompt',
          }),
        ],
      }),
    );
    expect(appendTranscriptRecordMock).toHaveBeenCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      expect.objectContaining({ type: 'assistant' }),
    );
  });

  it('retries once before falling back', async () => {
    mockedClaudeQuery
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            result: '{"title":"Missing body"}',
          },
        ]) as ReturnType<typeof claudeQuery>,
      )
      .mockReturnValueOnce(
        makeMessages([
          {
            type: 'result',
            subtype: 'success',
            result: '',
            structured_output: {
              title: 'Recovered title',
              body: 'Recovered body',
            },
          },
        ]) as ReturnType<typeof claudeQuery>,
      );

    const result = await generatePrContent({
      repoPath: '/tmp/repo',
      branchName: 'feature/retry',
      baseBranch: 'main',
      diff: '',
      commitLog: '',
      model: 'claude-sonnet-4-6',
      instructions: '',
      instructionMode: 'append',
    });

    expect(result).toEqual({
      title: 'Recovered title',
      body: 'Recovered body',
    });
    expect(mockedClaudeQuery).toHaveBeenCalledTimes(2);
  });

  it('fails fast when Claude emits an SDK error event', async () => {
    mockClaudeQueryResultOnce([
      {
        type: 'error',
        message:
          'API Error: 529 Overloaded. This is a server-side issue, usually temporary.',
      },
    ]);

    await expect(
      generatePrContent({
        repoPath: '/tmp/repo',
        branchName: 'feature/provider-error',
        baseBranch: 'main',
        diff: '',
        commitLog: '',
        model: 'claude-sonnet-4-6',
        instructions: '',
        instructionMode: 'append',
      }),
    ).rejects.toThrow('Claude query failed: API Error: 529 Overloaded');

    expect(mockedClaudeQuery).toHaveBeenCalledTimes(1);
    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      'failure',
      expect.stringContaining('API Error: 529 Overloaded'),
      undefined,
    );
  });

  it('records Claude usage when a result event is an error', async () => {
    mockClaudeQueryResultOnce([
      {
        type: 'result',
        is_error: true,
        result: 'API Error: 529 Overloaded',
        usage: {
          input_tokens: 12,
          output_tokens: 4,
          cache_read_input_tokens: 2,
          cache_creation_input_tokens: 1,
        },
        total_cost_usd: 0.02,
      },
    ]);

    await expect(
      generatePrContent({
        repoPath: '/tmp/repo',
        branchName: 'feature/provider-error',
        baseBranch: 'main',
        diff: '',
        commitLog: '',
        model: 'claude-sonnet-4-6',
        instructions: '',
        instructionMode: 'append',
      }),
    ).rejects.toThrow('Claude query failed: API Error: 529 Overloaded');

    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      'failure',
      expect.stringContaining('API Error: 529 Overloaded'),
      expect.objectContaining({
        inputTokens: 12,
        outputTokens: 4,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
        totalCostUsd: 0.02,
      }),
    );
  });

  it('fails fast when the Claude SDK stream throws', async () => {
    async function* throwingStream(): ReturnType<typeof claudeQuery> {
      await Promise.resolve();
      const shouldThrow = true;
      if (shouldThrow) {
        throw new Error('API Error: 529 Overloaded');
      }
      yield undefined;
    }

    mockedClaudeQuery.mockReturnValueOnce(throwingStream());

    await expect(
      generatePrContent({
        repoPath: '/tmp/repo',
        branchName: 'feature/provider-throw',
        baseBranch: 'main',
        diff: '',
        commitLog: '',
        model: 'claude-sonnet-4-6',
        instructions: '',
        instructionMode: 'append',
      }),
    ).rejects.toThrow('API Error: 529 Overloaded');

    expect(mockedClaudeQuery).toHaveBeenCalledTimes(1);
    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      'failure',
      'API Error: 529 Overloaded',
      undefined,
    );
  });

  it('accepts StructuredOutput tool input when the final result is sparse', async () => {
    mockClaudeQueryResultOnce([
      {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'StructuredOutput',
              input: {
                title: 'Recovered via tool input',
                body: 'Recovered body',
              },
            },
          ],
        },
      },
      {
        type: 'result',
        subtype: 'error_max_turns',
        is_error: false,
      },
    ]);

    const result = await generatePrContent({
      repoPath: '/tmp/repo',
      branchName: 'feature/retry',
      baseBranch: 'main',
      diff: '',
      commitLog: '',
      model: 'claude-sonnet-4-6',
      instructions: '',
      instructionMode: 'append',
    });

    expect(result).toEqual({
      title: 'Recovered via tool input',
      body: 'Recovered body',
    });
    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      'success',
      undefined,
      expect.objectContaining({
        messageCount: 1,
        assistantMessageCount: 1,
      }),
    );
  });

  it('fails fast when terminal-mode Claude worker fails', async () => {
    mockedReadPreferencesFile.mockResolvedValue({
      canopyBackgroundProcessesMode: 'terminal',
    });
    mockRunWorker.mockResolvedValueOnce({
      workerId: 'worker-1',
      sessionId: 'session-1',
      result: null,
      finalText: 'API Error: 529 Overloaded',
      usage: {
        inputTokens: 12,
        outputTokens: 4,
      },
      transcript: [],
      transcriptJsonl: '',
      status: 'failure',
    });

    await expect(
      generatePrContent({
        repoPath: '/tmp/repo',
        branchName: 'feature/terminal-provider-error',
        baseBranch: 'main',
        diff: '',
        commitLog: '',
        model: 'claude-sonnet-4-6',
        instructions: '',
        instructionMode: 'append',
      }),
    ).rejects.toThrow('API Error: 529 Overloaded');

    expect(mockedClaudeQuery).not.toHaveBeenCalled();
    expect(mockRunWorker).toHaveBeenCalledTimes(1);
    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      'failure',
      'API Error: 529 Overloaded',
      expect.objectContaining({
        inputTokens: 12,
        outputTokens: 4,
      }),
    );
  });

  it('retries a classified transient terminal worker failure', async () => {
    jest.useFakeTimers();
    try {
      mockedReadPreferencesFile.mockResolvedValue({
        canopyBackgroundProcessesMode: 'terminal',
      });
      mockRunWorker
        .mockResolvedValueOnce({
          workerId: 'worker-1',
          sessionId: 'session-1',
          sessionStarted: true,
          result: null,
          finalText: 'API Error: 529 Overloaded',
          usage: { inputTokens: 12, outputTokens: 4 },
          transcript: [],
          transcriptJsonl: JSON.stringify({
            type: 'assistant',
            error: 'server_error',
            message: {
              content: [{ type: 'text', text: 'API Error: 529 Overloaded.' }],
            },
          }),
          status: 'failure',
        })
        .mockResolvedValueOnce({
          workerId: 'worker-2',
          sessionId: 'session-2',
          sessionStarted: true,
          result: {
            title: 'Recover terminal PR generation',
            body: 'Recovered after retry.',
          },
          finalText: '',
          usage: { inputTokens: 10, outputTokens: 3 },
          transcript: [],
          transcriptJsonl: '',
          status: 'success',
        });

      const resultPromise = generatePrContent({
        repoPath: '/tmp/repo',
        branchName: 'feature/terminal-provider-retry',
        baseBranch: 'main',
        diff: '',
        commitLog: '',
        model: 'claude-sonnet-4-6',
        instructions: '',
        instructionMode: 'append',
      });

      await jest.advanceTimersByTimeAsync(30_000);
      await expect(resultPromise).resolves.toEqual({
        title: 'Recover terminal PR generation',
        body: 'Recovered after retry.',
      });
      expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
        expect.stringContaining('helper:pr-generation:/tmp/repo:'),
        'success',
        undefined,
        expect.objectContaining({
          inputTokens: 22,
          outputTokens: 7,
        }),
      );
      expect(mockRunWorker).toHaveBeenCalledTimes(2);
      expect(mockRunWorker.mock.calls[1]?.[0]).toMatchObject({
        prompt: 'Continue',
        resumeSessionId: 'session-1',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('uses the interrupted worker status instead of partial final text', async () => {
    mockedReadPreferencesFile.mockResolvedValue({
      canopyBackgroundProcessesMode: 'terminal',
    });
    mockRunWorker.mockResolvedValueOnce({
      workerId: 'worker-1',
      sessionId: 'session-1',
      result: null,
      finalText: 'Partial assistant output',
      usage: {
        inputTokens: 8,
      },
      transcript: [],
      transcriptJsonl: '',
      status: 'interrupted',
    });

    await expect(
      generatePrContent({
        repoPath: '/tmp/repo',
        branchName: 'feature/terminal-provider-error',
        baseBranch: 'main',
        diff: '',
        commitLog: '',
        model: 'claude-sonnet-4-6',
        instructions: '',
        instructionMode: 'append',
      }),
    ).rejects.toThrow('Claude worker exited before completion.');

    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      'failure',
      'Claude worker exited before completion.',
      expect.objectContaining({
        inputTokens: 8,
      }),
    );
  });

  it('resolves selections and passes Claude plugin runtime to PR generation', async () => {
    mockedRunWithOptionalHelperPlugins.mockImplementationOnce((_, run) =>
      run({
        claudePlugins: [{ type: 'local', path: '/plugins/pr' }],
        claudeMcpServers: {
          helper: { type: 'stdio', command: 'helper-mcp' },
        },
        codexProcessEnv: {},
        codexCapabilityRoots: [],
        codexMcpServers: {},
      }),
    );
    mockClaudeQueryResultOnce([
      {
        type: 'result',
        structured_output: {
          title: 'Plugin PR title',
          body: 'Plugin PR body',
        },
      },
    ]);

    const result = await generatePrContent({
      repoPath: '/tmp/repo',
      branchName: 'feature/prs',
      baseBranch: 'main',
      diff: 'diff --git a/file b/file',
      commitLog: 'abc123 Add feature',
      model: 'claude-sonnet-4-6',
      instructions: '',
      instructionMode: 'append',
      pluginSelections: {
        collectionIds: ['bundle-a'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      auditContext: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(result.title).toBe('Plugin PR title');
    expect(mockedRunWithOptionalHelperPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        worktreeId: 'worktree-1',
        helperName: 'pr-generation',
      }),
      expect.any(Function),
    );
    expect(
      mockedRunWithOptionalHelperPlugins.mock.calls[0]?.[0].selections
        ?.collectionIds,
    ).toEqual(['bundle-a']);
    const queryOptions = mockedClaudeQuery.mock.calls[0]?.[0].options;
    expect(mockedGetEnhancedEnv).toHaveBeenCalledWith({
      environment: { runtime: 'agent', workspaceId: 'project-1' },
    });
    expect(queryOptions?.plugins).toEqual([
      { type: 'local', path: '/plugins/pr' },
    ]);
    expect(queryOptions?.mcpServers).toEqual({
      helper: { type: 'stdio', command: 'helper-mcp' },
    });
  });

  it('passes selected PR capabilities through the shared Codex runtime', async () => {
    mockedRunWithOptionalHelperPlugins.mockImplementationOnce((_, run) =>
      run({
        claudePlugins: [],
        claudeMcpServers: {},
        codexProcessEnv: { CANOPY_TEST_PROFILE: 'pr-plugin' },
        codexCapabilityRoots: [],
        codexMcpServers: {},
      }),
    );
    mockCodexRunEphemeralTurn.mockResolvedValueOnce({
      status: 'completed',
      threadId: 'pr-helper-thread',
      finalText: '{"title":"Codex PR","body":"Codex body"}',
      usage: { inputTokens: 4, outputTokens: 3 },
    });

    const result = await generatePrContent({
      repoPath: '/tmp/repo',
      branchName: 'feature/prs',
      baseBranch: 'main',
      diff: 'diff --git a/file b/file',
      commitLog: 'abc123 Add feature',
      model: 'gpt-5.5',
      modelConfig: { fastMode: true },
      instructions: '',
      instructionMode: 'append',
      pluginSelections: {
        collectionIds: ['bundle-a'],
        skillRefs: [],
        pluginRefs: [],
        mcpServerRefs: [],
      },
      auditContext: {
        projectId: 'project-1',
        worktreeId: 'worktree-1',
      },
    });

    expect(result.title).toBe('Codex PR');
    const runtimeRequest = mockCodexRunEphemeralTurn.mock.calls[0]?.[0];
    const combinedPrompt = runtimeRequest?.turn.input[0]?.text;
    expect(combinedPrompt).toContain(
      'Return exactly one structured object with two fields: `title` and `body`.',
    );
    expect(combinedPrompt).toContain(
      'Do not include an extra PR title, a "Body" label, or a markdown divider',
    );
    expect(combinedPrompt).toContain(
      'Respond with ONLY the JSON object {"title":"...","body":"..."}, with no code fence or explanation.',
    );
    expect(runtimeRequest?.profile.environment).toEqual(
      expect.objectContaining({
        WORKSPACE_AGENT_ENV: 'enabled',
      }),
    );
    expect(runtimeRequest?.profile.environment).not.toHaveProperty(
      'CANOPY_TEST_PROFILE',
    );
    expect(runtimeRequest?.params.config).toEqual({
      mcp_servers: {},
      service_tier: 'priority',
    });
    expect(runtimeRequest?.profile.logicalWorkspaceEnvironmentId).toBe(
      'agent:workspace-agent',
    );
  });

  it('continues a started Codex helper thread for a transient retry', async () => {
    jest.useFakeTimers();
    try {
      mockCodexRunEphemeralTurn
        .mockResolvedValueOnce({
          status: 'failed',
          threadId: 'pr-helper-thread',
          finalText: '',
          error: 'Selected model is at capacity. Please try a different model.',
          usage: {},
        })
        .mockResolvedValueOnce({
          status: 'completed',
          threadId: 'pr-helper-thread',
          finalText: '{"title":"Recovered Codex PR","body":"Recovered body"}',
          usage: { inputTokens: 2, outputTokens: 3 },
        });

      const resultPromise = generatePrContent({
        repoPath: '/tmp/repo',
        branchName: 'fix/codex-pr-retry',
        baseBranch: 'main',
        diff: 'diff',
        commitLog: 'retry',
        model: 'gpt-5.5',
        instructions: '',
        instructionMode: 'append',
      });

      await jest.advanceTimersByTimeAsync(30_000);
      await expect(resultPromise).resolves.toEqual({
        title: 'Recovered Codex PR',
        body: 'Recovered body',
      });
      expect(mockCodexStartThread).toHaveBeenCalledTimes(1);
      expect(mockCodexRunEphemeralTurn).toHaveBeenCalledTimes(2);
      expect(
        mockCodexRunEphemeralTurn.mock.calls[1]?.[0].turn.input[0]?.text,
      ).toBe('Continue');
      expect(mockCodexDeleteThread).toHaveBeenCalledTimes(1);
      expect(updateObservedTaskMock).toHaveBeenCalledWith(
        expect.stringContaining('helper:pr-generation:/tmp/repo:'),
        { attempt: 2 },
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('records fallback PR generation as a failed observability task', async () => {
    mockClaudeQueryResultOnce([
      {
        type: 'result',
        structured_output: { title: '' },
      },
    ]);
    mockClaudeQueryResultOnce([
      {
        type: 'result',
        result: '{"title":"Missing body"}',
      },
    ]);

    const result = await generatePrContent({
      repoPath: '/tmp/repo',
      branchName: 'fix/observability-status',
      baseBranch: 'main',
      diff: '',
      commitLog: '',
      model: 'claude-sonnet-4-6',
      instructions: '',
      instructionMode: 'append',
    });

    expect(result).toEqual({
      title: 'Observability status',
      body: '',
    });
    expect(finalizeObservedTaskMock).toHaveBeenLastCalledWith(
      expect.stringContaining('helper:pr-generation:/tmp/repo:'),
      'failure',
      undefined,
      undefined,
    );
  });
});

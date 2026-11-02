import type { AgentUsage, PersistedChatMessage } from '../../../types';
import {
  setTranscriptModelResolver,
  type TranscriptModelResolver,
} from '../../model-resolver';
import {
  collectLoadedSubagentInputs,
  loadedSubagentSummary,
} from '../native-inputs';

function resolver(label: (model: string) => string): TranscriptModelResolver {
  return {
    resolveModelAlias: (model) => model,
    resolveKnownModel: () => undefined,
    resolveRuntimeModel: () => undefined,
    getModelDisplayName: label,
    getModelContextWindow: () => undefined,
  };
}

const LABELS: Record<string, string> = {
  'claude-sonnet-4-5': 'Claude Sonnet 4.5',
  haiku: 'Haiku 4.5',
};

function agentCall(
  toolUseId: string,
  input: Record<string, unknown>,
): PersistedChatMessage {
  return {
    id: `message-${toolUseId}`,
    role: 'assistant',
    timestamp: 10,
    blocks: [
      {
        type: 'tool_use',
        toolUseId,
        toolName: 'Agent',
        input: JSON.stringify({
          description: toolUseId,
          prompt: 'Go.',
          ...input,
        }),
      },
    ],
  };
}

function usage(model: string): AgentUsage {
  return {
    contextTokens: 0,
    contextWindow: 200_000,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    apiCalls: 1,
    toolUses: 0,
    durationMs: 0,
    model,
  };
}

describe('collectLoadedSubagentInputs model labels', () => {
  beforeAll(() => {
    setTranscriptModelResolver(resolver((model) => LABELS[model] ?? model));
  });

  afterAll(() => {
    setTranscriptModelResolver(resolver((model) => model));
  });

  it('labels a Claude agent with the model its replies reported, else the one its call requested', () => {
    const messages = [
      agentCall('reported', { model: 'haiku' }),
      agentCall('requested', { model: 'haiku' }),
      agentCall('unknown', {}),
    ];
    const labels = Object.fromEntries(
      collectLoadedSubagentInputs(messages, {
        agentUsage: {
          reported: usage('claude-sonnet-4-5'),
          unknown: usage(''),
        },
      }).claudeNative.map((input) => [input.toolUseId, input.modelLabel]),
    );

    expect(labels).toEqual({
      reported: 'Claude Sonnet 4.5',
      requested: 'Haiku 4.5',
      unknown: undefined,
    });
  });
});

describe('collectLoadedSubagentInputs background agents', () => {
  function message(
    id: string,
    role: 'assistant' | 'user',
    timestamp: number,
    blocks: PersistedChatMessage['blocks'],
  ): PersistedChatMessage {
    return { id, role, timestamp, blocks };
  }

  it.each(['abc123', 'task-watch'])(
    'settles a background agent (agentId %s) when its TaskOutput result arrives',
    (agentId) => {
      const messages = [
        agentCall('launch', { run_in_background: true }),
        message('launched', 'user', 20, [
          {
            type: 'tool_result',
            toolUseId: 'launch',
            toolName: 'Agent',
            output: `Async agent launched successfully.\nagentId: ${agentId}`,
            isError: false,
          },
        ]),
        message('poll', 'assistant', 30, [
          {
            type: 'tool_use',
            toolUseId: 'read',
            toolName: 'TaskOutput',
            input: JSON.stringify({ task_id: agentId }),
          },
        ]),
        message('done', 'user', 90, [
          {
            type: 'tool_result',
            toolUseId: 'read',
            toolName: 'TaskOutput',
            output: 'All quiet',
            isError: false,
          },
        ]),
      ];
      const [agent] = collectLoadedSubagentInputs(messages, {
        backgroundSettledAtFor: () => 20,
      }).claudeNative;

      expect(agent).toMatchObject({
        toolUseId: 'launch',
        state: 'completed',
        settledAt: 90,
      });
    },
  );

  const NOT_READY =
    '<retrieval_status>not_ready</retrieval_status>\n\n<task_id>abc123</task_id>\n\n<status>running</status>';

  function read(
    toolUseId: string,
    at: number,
    output: string,
  ): PersistedChatMessage[] {
    return [
      message(`call-${toolUseId}`, 'assistant', at - 1, [
        {
          type: 'tool_use',
          toolUseId,
          toolName: 'TaskOutput',
          input: JSON.stringify({ task_id: 'abc123' }),
        },
      ]),
      message(`result-${toolUseId}`, 'user', at, [
        {
          type: 'tool_result',
          toolUseId,
          toolName: 'TaskOutput',
          output,
          isError: false,
        },
      ]),
    ];
  }

  const launched = [
    agentCall('launch', { run_in_background: true }),
    message('launched', 'user', 20, [
      {
        type: 'tool_result',
        toolUseId: 'launch',
        toolName: 'Agent',
        output: 'Async agent launched successfully.\nagentId: abc123',
        isError: false,
      },
    ]),
  ];

  it('keeps a background agent settled by its completed read when a later read is not ready', () => {
    const messages = [
      ...launched,
      ...read('done', 90, 'Finished: all quiet'),
      ...read('again', 120, NOT_READY),
    ];

    expect(collectLoadedSubagentInputs(messages).claudeNative).toMatchObject([
      { toolUseId: 'launch', state: 'completed', settledAt: 90 },
    ]);
    expect(loadedSubagentSummary(messages).live).toBe(0);
  });

  it('keeps a background agent running when its only read is not ready', () => {
    const messages = [...launched, ...read('early', 40, NOT_READY)];

    const [agent] = collectLoadedSubagentInputs(messages).claudeNative;
    expect(agent).toMatchObject({ toolUseId: 'launch', state: 'running' });
    expect(agent?.settledAt).toBeUndefined();
    expect(loadedSubagentSummary(messages).live).toBe(1);
  });

  it('settles a later sibling when an earlier background sibling reads its completed task', () => {
    const child = (
      id: string,
      role: 'assistant' | 'user',
      timestamp: number,
      parentToolUseId: string,
      blocks: PersistedChatMessage['blocks'],
    ): PersistedChatMessage => ({
      id,
      role,
      timestamp,
      parentToolUseId,
      blocks,
    });
    const launch = (
      toolUseId: string,
      at: number,
      agentId: string,
    ): PersistedChatMessage[] => [
      child(`call-${toolUseId}`, 'assistant', at, 'outer', [
        {
          type: 'tool_use',
          toolUseId,
          toolName: 'Agent',
          input: JSON.stringify({
            description: toolUseId,
            prompt: 'Go.',
            run_in_background: true,
          }),
        },
      ]),
      child(`launched-${toolUseId}`, 'user', at + 1, 'outer', [
        {
          type: 'tool_result',
          toolUseId,
          toolName: 'Agent',
          output: `Async agent launched successfully.\nagentId: ${agentId}`,
          isError: false,
        },
      ]),
    ];
    const messages = [
      agentCall('outer', {}),
      ...launch('reader', 20, 'aaa111'),
      ...launch('target', 30, 'bbb222'),
      child('poll', 'assistant', 40, 'reader', [
        {
          type: 'tool_use',
          toolUseId: 'read',
          toolName: 'TaskOutput',
          input: JSON.stringify({ task_id: 'bbb222' }),
        },
      ]),
      child('polled', 'user', 75, 'reader', [
        {
          type: 'tool_result',
          toolUseId: 'read',
          toolName: 'TaskOutput',
          output: 'Target finished.',
          isError: false,
        },
      ]),
    ];

    const target = collectLoadedSubagentInputs(messages).claudeNative.find(
      (input) => input.toolUseId === 'target',
    );
    expect(target).toMatchObject({ state: 'completed', settledAt: 75 });
  });
});

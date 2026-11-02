import type { ChatTab } from '@/stores/chatStore';
import { toActiveComposerView } from '../types';

function makeTab(messages: ChatTab['messages']): ChatTab {
  return {
    id: 'chat-1',
    title: 'Long-running command',
    kind: 'chat',
    createdAt: '2026-08-31T12:00:00.000Z',
    status: 'streaming',
    error: null,
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', speed: 'standard', fastMode: false },
    fastModeExplicit: false,
    model: 'gpt-6-sol',
    providerType: 'codex',
    messages,
    queuedMessages: [],
  };
}

describe('toActiveComposerView', () => {
  // The composer resolves the chat's plugins with the same project layer as
  // its turns, which depends on this stamp.
  it('carries the live project defaults stamp', () => {
    expect(
      toActiveComposerView({
        ...makeTab([]),
        inheritedPluginDefaultsVersion: 1,
      }).inheritedPluginDefaultsVersion,
    ).toBe(1);
    expect(toActiveComposerView(makeTab([]))).not.toHaveProperty(
      'inheritedPluginDefaultsVersion',
    );
  });

  // CAN-2307: main hands the renderer only the turn id; the composer needs to
  // know whether that turn can be retried and whether retrying repeats work.
  describe('empty-completion recovery', () => {
    const recovery = {
      turnUserMessageId: 'user-1',
      detectedAt: 1000,
      automaticRetryAllowed: false,
    } as const;

    it('omits the recovery view when the turn is not flagged', () => {
      expect(
        toActiveComposerView(
          makeTab([
            {
              id: 'user-1',
              role: 'user' as const,
              timestamp: 1,
              blocks: [{ type: 'text' as const, text: 'go' }],
            },
          ]),
        ).emptyCompletionTurnUserMessageId,
      ).toBeUndefined();
    });

    it('resolves the retry prompt and the repeated-work flag from the transcript', () => {
      const tab: ChatTab = {
        ...makeTab([
          {
            id: 'user-1',
            role: 'user' as const,
            timestamp: 1,
            blocks: [{ type: 'text' as const, text: 'Refactor the parser' }],
          },
        ]),
        emptyCompletionRecovery: recovery,
      };
      expect(toActiveComposerView(tab)).toMatchObject({
        emptyCompletionTurnUserMessageId: 'user-1',
        emptyCompletionRepeatsToolActivity: false,
        emptyCompletionCanRetryPrompt: true,
      });
    });

    it('flags repeated work when the empty turn had already issued a tool call', () => {
      const tab: ChatTab = {
        ...makeTab([
          {
            id: 'user-1',
            role: 'user' as const,
            timestamp: 1,
            blocks: [{ type: 'text' as const, text: 'Deploy it' }],
          },
          {
            id: 'assistant-1',
            role: 'assistant' as const,
            timestamp: 2,
            blocks: [
              {
                type: 'tool_use' as const,
                toolUseId: 'tool-1',
                toolName: 'Bash',
                input: '{"command":"deploy"}',
              },
            ],
          },
        ]),
        emptyCompletionRecovery: recovery,
      };
      expect(toActiveComposerView(tab)).toMatchObject({
        emptyCompletionRepeatsToolActivity: true,
        emptyCompletionCanRetryPrompt: true,
      });
    });
  });

  it('preserves the explicit harness marker for a started Ollama chat', () => {
    const tab = {
      ...makeTab([
        { id: 'user-1', role: 'user' as const, timestamp: 1, blocks: [] },
      ]),
      model: 'ollama-qwen3',
      providerType: 'ollama' as const,
      executionHarness: 'claude' as const,
      executionHarnessExplicitlyChosen: true,
    };
    expect(toActiveComposerView(tab)).toMatchObject({
      lockedHarness: 'claude',
      executionHarnessExplicitlyChosen: true,
    });
  });

  it('keeps execution harness separate from source provider in the composer projection', () => {
    const tab = {
      ...makeTab([]),
      providerType: 'ollama' as const,
      executionHarness: 'codex' as const,
    };
    expect(
      toActiveComposerView(tab, { includeActiveAgentStep: false }),
    ).toMatchObject({ providerType: 'ollama', executionHarness: 'codex' });
  });

  it('reports an unresolved tool call as an active agent step', () => {
    const view = toActiveComposerView(
      makeTab([
        {
          id: 'command-1',
          role: 'system',
          timestamp: Date.now() - 13 * 60_000,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'command-1',
              toolName: 'command',
              input: 'npm run test:electron:captures:built',
            },
          ],
        },
      ]),
      { includeActiveAgentStep: true },
    );

    expect(view.hasActiveAgentStep).toBe(true);
  });

  it('does not report a completed tool call as active', () => {
    const view = toActiveComposerView(
      makeTab([
        {
          id: 'command-1',
          role: 'system',
          timestamp: Date.now() - 13 * 60_000,
          blocks: [
            {
              type: 'tool_use',
              toolUseId: 'command-1',
              toolName: 'command',
              input: 'npm run test:electron:captures:built',
            },
            {
              type: 'tool_result',
              toolUseId: 'command-1',
              toolName: 'command',
              output: 'Done',
              isError: false,
            },
          ],
        },
      ]),
      { includeActiveAgentStep: true },
    );

    expect(view.hasActiveAgentStep).toBe(false);
  });

  it('does not report unresolved tool calls for an idle tab', () => {
    const tab = makeTab([
      {
        id: 'command-1',
        role: 'system',
        timestamp: Date.now() - 13 * 60_000,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'command-1',
            toolName: 'command',
            input: 'npm run test:electron:captures:built',
          },
        ],
      },
    ]);
    tab.status = 'idle';

    expect(
      toActiveComposerView(tab, { includeActiveAgentStep: true })
        .hasActiveAgentStep,
    ).toBe(false);
  });

  it('ignores unresolved tool calls from an earlier turn', () => {
    const tab = makeTab([
      {
        id: 'old-command',
        role: 'system',
        timestamp: 1,
        blocks: [
          {
            type: 'tool_use',
            toolUseId: 'old-command',
            toolName: 'command',
            input: 'sleep 600',
          },
        ],
      },
      {
        id: 'new-user-turn',
        role: 'user',
        timestamp: 2,
        blocks: [{ type: 'text', text: 'Start a new turn' }],
      },
    ]);

    expect(
      toActiveComposerView(tab, { includeActiveAgentStep: true })
        .hasActiveAgentStep,
    ).toBe(false);
  });

  it('prefers the canonical runtime activity timestamp', () => {
    const tab = makeTab([]);
    tab.lastEventAt = 100;

    expect(toActiveComposerView(tab, { lastActivityAt: 200 }).lastEventAt).toBe(
      200,
    );
  });

  it('keeps a fresher optimistic renderer activity timestamp', () => {
    const tab = makeTab([]);
    tab.lastEventAt = 200;

    expect(toActiveComposerView(tab, { lastActivityAt: 100 }).lastEventAt).toBe(
      200,
    );
  });
});

import {
  accumulateImportedTranscriptUsage,
  emptyClaudeTerminalTurnUsage,
} from '../integration/claude-terminal-usage';

interface AssistantEventOptions {
  uuid: string;
  output: number;
  input?: number;
  cacheRead?: number;
  cacheCreation?: number;
}

function assistantEvent(options: AssistantEventOptions): unknown {
  return {
    type: 'assistant',
    uuid: options.uuid,
    message: {
      usage: {
        output_tokens: options.output,
        input_tokens: options.input ?? 0,
        cache_read_input_tokens: options.cacheRead ?? 0,
        cache_creation_input_tokens: options.cacheCreation ?? 0,
      },
    },
  };
}

describe('accumulateImportedTranscriptUsage', () => {
  it('folds incremental (non-replay) syncs by adding output and cache-creation', () => {
    const usage = emptyClaudeTerminalTurnUsage();

    accumulateImportedTranscriptUsage(usage, {
      importedEvents: [
        assistantEvent({ uuid: 'e1', output: 100, cacheCreation: 20 }),
      ],
      importedMessageIds: ['e1'],
      replayedFromStart: false,
    });
    accumulateImportedTranscriptUsage(usage, {
      importedEvents: [
        assistantEvent({ uuid: 'e2', output: 250, cacheCreation: 30 }),
      ],
      importedMessageIds: ['e2'],
      replayedFromStart: false,
    });

    expect(usage.outputTokens).toBe(350);
    expect(usage.cacheCreationInputTokens).toBe(50);
  });

  it('does not double-count when a replay re-reads the whole history', () => {
    const usage = emptyClaudeTerminalTurnUsage();

    // Two incremental turns already folded.
    accumulateImportedTranscriptUsage(usage, {
      importedEvents: [assistantEvent({ uuid: 'e1', output: 100 })],
      importedMessageIds: ['e1'],
      replayedFromStart: false,
    });
    accumulateImportedTranscriptUsage(usage, {
      importedEvents: [assistantEvent({ uuid: 'e2', output: 250 })],
      importedMessageIds: ['e2'],
      replayedFromStart: false,
    });
    expect(usage.outputTokens).toBe(350);

    // A replay re-emits e1+e2 (already counted) plus genuinely-new e3. Only the
    // event matching a new imported message id must be folded.
    accumulateImportedTranscriptUsage(usage, {
      importedEvents: [
        assistantEvent({ uuid: 'e1', output: 100 }),
        assistantEvent({ uuid: 'e2', output: 250 }),
        assistantEvent({ uuid: 'e3', output: 80 }),
      ],
      importedMessageIds: ['e3'],
      replayedFromStart: true,
    });

    expect(usage.outputTokens).toBe(430);
  });

  it('adds nothing when a replay imports no new messages', () => {
    const usage = emptyClaudeTerminalTurnUsage();
    accumulateImportedTranscriptUsage(usage, {
      importedEvents: [assistantEvent({ uuid: 'e1', output: 100 })],
      importedMessageIds: ['e1'],
      replayedFromStart: false,
    });

    accumulateImportedTranscriptUsage(usage, {
      importedEvents: [
        assistantEvent({ uuid: 'e1', output: 100 }),
        assistantEvent({ uuid: 'e2', output: 250 }),
      ],
      importedMessageIds: [],
      replayedFromStart: true,
    });

    expect(usage.outputTokens).toBe(100);
  });

  it('tracks latest input and cache-read tokens rather than summing them', () => {
    const usage = emptyClaudeTerminalTurnUsage();
    accumulateImportedTranscriptUsage(usage, {
      importedEvents: [
        assistantEvent({ uuid: 'e1', output: 10, input: 5, cacheRead: 1000 }),
        assistantEvent({ uuid: 'e2', output: 10, input: 8, cacheRead: 2000 }),
      ],
      importedMessageIds: ['e1', 'e2'],
      replayedFromStart: false,
    });

    expect(usage.outputTokens).toBe(20);
    expect(usage.inputTokens).toBe(8);
    expect(usage.cacheReadInputTokens).toBe(2000);
  });
});

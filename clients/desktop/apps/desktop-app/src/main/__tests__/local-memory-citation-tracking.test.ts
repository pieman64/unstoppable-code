import type { AgentProviderType } from '@canopy/desktop-shared/types';
import {
  emitLocalMemoryCitationComplianceCounter,
  isValidMemoryCitationFileKey,
  parseCompletedTurnMemorySignals,
  parseMemoryCitationFileKeys,
  trackCompletedTurnLocalMemoryCitations,
  type LocalMemoryCitationComplianceCounter,
  type LocalMemoryCitationTrackingDependencies,
} from '../memory/local/citation-tracking';
const mockCreateOperationKey = jest.fn(
  (value: string): string => `operation:${value}`,
);
const mockStartDesktopOperation = jest.fn();
const mockSucceedDesktopOperation = jest.fn();
const mockRecordUsage = jest.fn();

jest.mock('@canopy/desktop-instrumentation', () => ({
  createDesktopInstrumentationOperationKey: (value: string): string =>
    mockCreateOperationKey(value),
}));
jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  startDesktopOperation: (...args: unknown[]): void => {
    mockStartDesktopOperation(...args);
  },
  succeedDesktopOperation: (...args: unknown[]): void => {
    mockSucceedDesktopOperation(...args);
  },
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: (): Promise<{ localMemoryEnabled: boolean }> =>
    Promise.resolve({ localMemoryEnabled: true }),
}));
jest.mock('../memory/local/usage', () => ({
  recordUsage: (...args: unknown[]): void => {
    mockRecordUsage(...args);
  },
}));

interface TestHarness {
  dependencies: LocalMemoryCitationTrackingDependencies;
  emitComplianceCounter: jest.MockedFunction<
    (counter: LocalMemoryCitationComplianceCounter) => void
  >;
  isLocalMemoryEnabled: jest.MockedFunction<() => Promise<boolean>>;
}

function buildHarness(
  options: {
    enabled?: boolean;
  } = {},
): TestHarness {
  const isLocalMemoryEnabled = jest.fn(
    (): Promise<boolean> => Promise.resolve(options.enabled ?? true),
  );
  const emitComplianceCounter: TestHarness['emitComplianceCounter'] = jest.fn();
  return {
    dependencies: {
      isLocalMemoryEnabled,
      emitComplianceCounter,
    },
    emitComplianceCounter,
    isLocalMemoryEnabled,
  };
}

function userPromptLine(submittedText: string): string {
  return JSON.stringify({
    type: 'canopy_user_prompt',
    provider: 'claude',
    original_text: 'Question',
    submitted_text: submittedText,
    plan_mode: false,
  });
}

function claudeAssistantLine(text: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text }] },
  });
}

function trackingOptions(options: {
  submittedText: string;
  assistantText?: string;
  provider?: AgentProviderType;
}): {
  auditEntryId: string;
  provider: AgentProviderType;
  transcriptLines: string[];
} {
  return {
    auditEntryId: 'audit-1',
    provider: options.provider ?? 'claude',
    transcriptLines: [
      userPromptLine(options.submittedText),
      ...(options.assistantText
        ? [claudeAssistantLine(options.assistantText)]
        : []),
    ],
  };
}

describe('local-memory citation parsing', () => {
  it('parses multiple tags, comma-separated keys, MEMORY.md, and de-duplicates', () => {
    expect(
      parseMemoryCitationFileKeys(
        [
          'Answer.',
          '<memory_citation files="topics/testing.md, inbox/2026-08-05-note.md"/>',
          '<memory_citation files="MEMORY.md, topics/testing.md"/>',
        ].join('\n'),
      ),
    ).toEqual(['topics/testing.md', 'inbox/2026-08-05-note.md', 'MEMORY.md']);
  });

  it('ignores malformed and empty attributes', () => {
    expect(
      parseMemoryCitationFileKeys(
        [
          "<memory_citation files='topics/single-quote.md'/>",
          '<memory_citation files=topics/unquoted.md/>',
          '<memory_citation files="topics/unclosed.md">',
          '<memory_citation files=""/>',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it.each([
    '../MEMORY.md',
    'topics/../secret.md',
    'topics/nested/file.md',
    '/topics/absolute.md',
    'topics\\windows.md',
    'other/file.md',
    'topics/file.txt',
    'topics/.md',
  ])('rejects malformed or traversal-looking key %s', (fileKey) => {
    expect(isValidMemoryCitationFileKey(fileKey)).toBe(false);
  });

  it('does not count display-stripped malformed variants as citations', () => {
    const signals = parseCompletedTurnMemorySignals([
      claudeAssistantLine('Answer <memory_citation files="topics/x.md">'),
      claudeAssistantLine('Answer <memory_citation/>'),
    ]);

    expect(signals).toEqual({
      citationFileKeys: [],
      hasCitation: false,
      memoryInjected: false,
    });
  });

  it('extracts raw citations before display parsing and detects injection', () => {
    const signals = parseCompletedTurnMemorySignals([
      'not-json',
      userPromptLine('<local_memory>facts</local_memory>\nQuestion'),
      claudeAssistantLine(
        'Answer <memory_citation files="topics/x.md, topics/x.md"/>',
      ),
    ]);

    expect(signals).toEqual({
      citationFileKeys: ['topics/x.md'],
      hasCitation: true,
      memoryInjected: true,
    });
  });

  it('uses Claude result text when earlier provider chunks did not contain a complete tag', () => {
    const signals = parseCompletedTurnMemorySignals([
      claudeAssistantLine('Answer <memory_cit'),
      claudeAssistantLine('ation files="topics/chunked.md"/>'),
      JSON.stringify({
        type: 'result',
        result: 'Answer <memory_citation files="topics/chunked.md"/>',
      }),
    ]);

    expect(signals.citationFileKeys).toEqual(['topics/chunked.md']);
    expect(signals.hasCitation).toBe(true);
  });

  it('extracts citations from completed Codex agent-message items', () => {
    const signals = parseCompletedTurnMemorySignals([
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'answer-1',
          type: 'agent_message',
          text: 'Answer <memory_citation files="MEMORY.md"/>',
        },
      }),
    ]);

    expect(signals.citationFileKeys).toEqual(['MEMORY.md']);
    expect(signals.hasCitation).toBe(true);
  });
});

describe('local-memory citation compliance gate', () => {
  it('does not write memory usage rows for cited files', async () => {
    const harness = buildHarness();

    await trackCompletedTurnLocalMemoryCitations(
      trackingOptions({
        submittedText: '<local_memory>facts</local_memory>\nQuestion',
        assistantText:
          'Answer <memory_citation files="topics/shared.md, inbox/user-note.md, topics/workspace.md, topics/missing.md, topics/shared.md"/>',
      }),
      harness.dependencies,
    );

    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('gates parsing and counters when disabled', async () => {
    const harness = buildHarness({ enabled: false });

    await trackCompletedTurnLocalMemoryCitations(
      trackingOptions({
        submittedText: '<local_memory>facts</local_memory>\nQuestion',
        assistantText: 'Answer <memory_citation files="topics/existing.md"/>',
      }),
      harness.dependencies,
    );

    expect(harness.emitComplianceCounter).not.toHaveBeenCalled();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it('contains dependency failures instead of rejecting the turn pipeline', async () => {
    const harness = buildHarness();
    harness.emitComplianceCounter.mockImplementation((): void => {
      throw new Error('instrumentation unavailable');
    });

    await expect(
      trackCompletedTurnLocalMemoryCitations(
        trackingOptions({
          submittedText: '<local_memory>facts</local_memory>\nQuestion',
          assistantText: 'Answer <memory_citation files="topics/x.md"/>',
        }),
        harness.dependencies,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('local-memory citation compliance counter', () => {
  it.each([
    {
      label: 'injected without citation',
      submittedText: '<local_memory>facts</local_memory>\nQuestion',
      assistantText: 'Answer without a citation.',
      memoryInjected: true,
      hasCitation: false,
    },
    {
      label: 'injected with citation',
      submittedText: '<local_memory>facts</local_memory>\nQuestion',
      assistantText: 'Answer <memory_citation files="topics/hallucinated.md"/>',
      memoryInjected: true,
      hasCitation: true,
    },
    {
      label: 'not injected',
      submittedText: 'Question',
      assistantText: 'Answer.',
      memoryInjected: false,
      hasCitation: false,
    },
  ])('emits $label', async (testCase) => {
    const harness = buildHarness();

    await trackCompletedTurnLocalMemoryCitations(
      trackingOptions({
        submittedText: testCase.submittedText,
        assistantText: testCase.assistantText,
        provider: 'codex',
      }),
      harness.dependencies,
    );

    expect(harness.emitComplianceCounter).toHaveBeenCalledWith({
      auditEntryId: 'audit-1',
      provider: 'codex',
      memoryInjected: testCase.memoryInjected,
      hasCitation: testCase.hasCitation,
    });
  });

  it('uses a bounded provider/boolean operation context with no transcript data', () => {
    emitLocalMemoryCitationComplianceCounter({
      auditEntryId: 'private-audit-id',
      provider: 'claude',
      memoryInjected: true,
      hasCitation: false,
    });

    const expectedOptions = {
      operationKey: 'operation:local-memory-citation:private-audit-id',
      context: {
        provider: 'claude',
        memory_injected: true,
        citation_present: false,
      },
    };
    expect(mockStartDesktopOperation).toHaveBeenCalledWith(
      'canopy.local_memory_citation_compliance',
      expectedOptions,
    );
    expect(mockSucceedDesktopOperation).toHaveBeenCalledWith(
      'canopy.local_memory_citation_compliance',
      expectedOptions,
    );
  });
});

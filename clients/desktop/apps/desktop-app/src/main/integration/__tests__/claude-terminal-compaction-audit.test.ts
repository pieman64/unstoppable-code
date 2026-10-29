import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const mockObserveChatEvent = jest.fn<void, [string, string, string, unknown]>();

jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    observeChatEvent: (
      projectId: string,
      worktreeId: string,
      chatId: string,
      event: unknown,
    ): void => mockObserveChatEvent(projectId, worktreeId, chatId, event),
  })),
}));

import { syncClaudeTerminalTranscript } from '../claude-terminal-transcript-sync';
import { DefaultClaudeTerminalSessionService } from '../claude-terminal-session-service';

describe('Claude terminal PostCompact audit envelope', () => {
  let runtimeDir = '';

  beforeEach(async () => {
    mockObserveChatEvent.mockClear();
    runtimeDir = await mkdtemp(
      path.join(os.tmpdir(), 'canopy-terminal-compaction-'),
    );
  });

  afterEach(async () => {
    await rm(runtimeDir, { recursive: true, force: true });
  });

  it.each([
    ['auto', 'auto'],
    ['manual', 'manual'],
    ['threshold', 'unknown'],
  ] as const)(
    'emits only a content-free %s compaction envelope and dedupes replay',
    async (trigger, expectedTrigger) => {
      const request = {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        sessionKey: 'session-key',
        sdkSessionId: 'sdk-session',
        hookEventName: 'PostCompact' as const,
        hookPayload: {
          uuid: `compact-${trigger}`,
          trigger,
          preTokens: 1234,
          compact_summary: 'must not leak into audit envelope',
        },
        persistChatState: false,
        runtimeDir,
      };

      const first = await syncClaudeTerminalTranscript(request);
      const envelopes = first.importedEvents.filter(
        (event): event is Record<string, unknown> =>
          typeof event === 'object' &&
          event !== null &&
          'type' in event &&
          event.type === 'canopy_compaction',
      );

      expect(first.compactionAppended).toBe(true);
      expect(envelopes).toHaveLength(1);
      expect(envelopes[0]).toMatchObject({
        type: 'canopy_compaction',
        id: `compact-${trigger}`,
        trigger: expectedTrigger,
        preTokens: 1234,
      });
      expect(typeof envelopes[0]?.at).toBe('string');
      expect(Object.keys(envelopes[0] ?? {}).sort()).toEqual([
        'at',
        'id',
        'preTokens',
        'trigger',
        'type',
      ]);
      expect(JSON.stringify(envelopes[0])).not.toContain('summary');
      expect(JSON.stringify(envelopes[0])).not.toContain('transcriptPath');

      const replay = await syncClaudeTerminalTranscript(request);
      expect(replay.compactionAppended).toBe(false);
      expect(
        replay.importedEvents.some(
          (event) =>
            typeof event === 'object' &&
            event !== null &&
            'type' in event &&
            event.type === 'canopy_compaction',
        ),
      ).toBe(false);
    },
  );

  it('forwards a produced compaction envelope through observeChatEvent', () => {
    const service = new DefaultClaudeTerminalSessionService();
    const feedAuditTranscriptEvents = Reflect.get(
      service,
      'feedAuditTranscriptEvents',
    ) as (
      record: {
        projectId: string;
        worktreeId: string;
        chatId: string;
        auditTurnOpen: boolean;
        turnUsage: {
          inputTokens: number;
          outputTokens: number;
          cacheReadInputTokens: number;
          cacheCreationInputTokens: number;
        };
      },
      result: {
        importedEvents: unknown[];
        importedMessages: Array<{
          id: string;
          role: 'assistant';
          timestamp: number;
          blocks: [];
        }>;
        replayedFromStart: boolean;
      },
    ) => void;
    const envelope = {
      type: 'canopy_compaction',
      id: 'compact-forwarded',
      at: '2026-10-08T12:00:00.000Z',
      trigger: 'manual',
    };

    feedAuditTranscriptEvents.call(
      service,
      {
        projectId: 'project',
        worktreeId: 'worktree',
        chatId: 'chat',
        auditTurnOpen: true,
        turnUsage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      {
        importedEvents: [envelope],
        importedMessages: [
          {
            id: 'compact-forwarded',
            role: 'assistant',
            timestamp: Date.parse(envelope.at),
            blocks: [],
          },
        ],
        replayedFromStart: false,
      },
    );

    expect(mockObserveChatEvent).toHaveBeenCalledWith(
      'project',
      'worktree',
      'chat',
      envelope,
    );
  });
});

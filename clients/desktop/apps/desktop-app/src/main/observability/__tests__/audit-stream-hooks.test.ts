import type { AgentAuditEntry } from '@canopy/desktop-shared/types';
import {
  mayPruneAuditDayFile,
  notifyAuditEntryEnqueued,
  onAuditEntryEnqueued,
  resetAuditStreamHooksForTest,
  setAuditDayPruneGuard,
} from '../audit-stream-hooks';

const DAY_MS = 24 * 60 * 60 * 1000;
const CUTOFF = Date.UTC(2026, 9, 1);

function pruneRequest(daysPastCutoff: number): {
  dayFilename: string;
  fileDayTime: number;
  cutoffTime: number;
  retentionDays: number;
} {
  return {
    dayFilename: 'day.jsonl',
    fileDayTime: CUTOFF - daysPastCutoff * DAY_MS,
    cutoffTime: CUTOFF,
    retentionDays: 7,
  };
}

function auditEntry(overrides: Partial<AgentAuditEntry>): AgentAuditEntry {
  return {
    id: 'entry-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'claude',
    label: 'A private label',
    startedAt: '2026-10-08T12:00:00.000Z',
    tokens: {
      input: 1,
      output: 1,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 1,
    assistantMessageCount: 1,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: {
      thinking: 0,
      bash: 0,
      read: 0,
      readLines: 0,
      writeEdit: 0,
      plan: 0,
      fileEdit: 0,
      fileAdd: 0,
      fileDelete: 0,
      search: 0,
      grep: 0,
      web: 0,
      agent: 0,
      workflow: 0,
      tasks: 0,
      taskStop: 0,
      skills: 0,
      monitor: 0,
      claude: 0,
      scheduleWakeup: 0,
      askUser: 0,
      scriptOutput: 0,
      watcher: 0,
      canopy: 0,
      graph: 0,
      appAdvisor: 0,
      pipelineEditor: 0,
      mcp: 0,
      other: 0,
    },
    hasTranscript: false,
    ...overrides,
  };
}

describe('audit stream hooks', () => {
  afterEach(() => {
    resetAuditStreamHooksForTest();
  });

  describe('mayPruneAuditDayFile', () => {
    it('allows pruning when no reader registered a guard', async () => {
      await expect(mayPruneAuditDayFile(pruneRequest(1))).resolves.toBe(true);
    });

    it('asks the guard about a file that is due', async () => {
      const guard = jest.fn(() => Promise.resolve(false));
      setAuditDayPruneGuard(guard);

      await expect(mayPruneAuditDayFile(pruneRequest(1))).resolves.toBe(false);
      expect(guard).toHaveBeenCalledWith('day.jsonl');

      guard.mockResolvedValue(true);
      await expect(mayPruneAuditDayFile(pruneRequest(1))).resolves.toBe(true);
    });

    it('keeps the file when the guard throws', async () => {
      setAuditDayPruneGuard(() => Promise.reject(new Error('reader is down')));

      await expect(mayPruneAuditDayFile(pruneRequest(1))).resolves.toBe(false);
    });

    it('stops holding a file one retention period past its cutoff', async () => {
      const guard = jest.fn(() => Promise.resolve(false));
      setAuditDayPruneGuard(guard);

      await expect(mayPruneAuditDayFile(pruneRequest(7))).resolves.toBe(false);
      await expect(mayPruneAuditDayFile(pruneRequest(8))).resolves.toBe(true);
    });

    it('gives the reader its catch-up attempt however old the file is', async () => {
      const guard = jest.fn(() => Promise.resolve(true));
      setAuditDayPruneGuard(guard);

      await expect(mayPruneAuditDayFile(pruneRequest(400))).resolves.toBe(true);
      expect(guard).toHaveBeenCalledWith('day.jsonl');
    });
  });

  describe('notifyAuditEntryEnqueued', () => {
    it('tells listeners the ids and status, and nothing else', () => {
      const listener = jest.fn();
      onAuditEntryEnqueued(listener);

      notifyAuditEntryEnqueued(
        auditEntry({
          projectId: 'canopy',
          worktreeId: 'elephant',
          chatId: 'chat-1',
          error: 'a private error',
        }),
      );

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        eventType: 'worktree_chat',
        status: 'success',
        projectId: 'canopy',
        worktreeId: 'elephant',
        chatId: 'chat-1',
      });
    });

    it('stops calling a listener that unsubscribed', () => {
      const listener = jest.fn();
      const unsubscribe = onAuditEntryEnqueued(listener);
      unsubscribe();

      notifyAuditEntryEnqueued(auditEntry({}));

      expect(listener).not.toHaveBeenCalled();
    });

    it('survives a listener that throws', () => {
      const second = jest.fn();
      onAuditEntryEnqueued(() => {
        throw new Error('reader bug');
      });
      onAuditEntryEnqueued(second);

      expect(() => notifyAuditEntryEnqueued(auditEntry({}))).not.toThrow();
      expect(second).toHaveBeenCalledTimes(1);
    });
  });
});

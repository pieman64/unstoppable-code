/**
 * CAN-1521 outbox. The two failure modes that matter are silent:
 *  - malformed JSON on disk must yield `[]`, never a throw that takes down a
 *    fire-and-forget caller;
 *  - the serialized write chain must never reject, so one failed write cannot
 *    poison every later one.
 */

// `node:fs/promises` signatures are heavily overloaded, so `jest.mocked()`
// cannot resolve them. Explicitly-typed mock functions keep the assertions
// type-safe instead.
const mockWrittenPayloads: string[] = [];
const mockWriteFile = jest.fn((_path: string, data: string): Promise<void> => {
  mockWrittenPayloads.push(data);
  return Promise.resolve();
});
const mockReadFile = jest.fn(
  (): Promise<string> => Promise.resolve('{"version":1,"entries":[]}'),
);
const mockMkdir = jest.fn((): Promise<void> => Promise.resolve());

jest.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

jest.mock('../lib/paths', () => ({
  getTurnFeedbackOutboxFilePath: jest.fn(
    () => '/tmp/canopy-test/turn-feedback-outbox.json',
  ),
}));

import type {
  TurnFeedbackOutboxEntry,
  TurnFeedbackOutboxFile,
} from '@canopy/desktop-shared/types';
import {
  amendQueuedTurnFeedback,
  enqueueTurnFeedback,
  readTurnFeedbackOutbox,
  removeQueuedTurnFeedback,
  removeQueuedTurnFeedbackBatch,
} from '../feedback/turn-feedback-outbox';

function entry(
  overrides: Partial<TurnFeedbackOutboxEntry> = {},
): TurnFeedbackOutboxEntry {
  return {
    clientUserMessageId: 'msg-1-1700000000000',
    clientChatId: 'chat-1',
    rating: 'down',
    queuedAt: Date.now(),
    ...overrides,
  };
}

function isOutboxFile(value: unknown): value is TurnFeedbackOutboxFile {
  return (
    typeof value === 'object' &&
    value !== null &&
    'entries' in value &&
    Array.isArray(value.entries)
  );
}

function writtenEntries(): TurnFeedbackOutboxEntry[] {
  const last = mockWrittenPayloads[mockWrittenPayloads.length - 1];
  if (last === undefined) return [];
  const payload: unknown = JSON.parse(last);
  return isOutboxFile(payload) ? payload.entries : [];
}

describe('turn feedback outbox', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWrittenPayloads.length = 0;
    // Re-establish implementations: `mockRejectedValue` in the failure tests
    // persists past `clearAllMocks`, which only clears recorded calls.
    mockMkdir.mockImplementation((): Promise<void> => Promise.resolve());
    mockWriteFile.mockImplementation(
      (_path: string, data: string): Promise<void> => {
        mockWrittenPayloads.push(data);
        return Promise.resolve();
      },
    );
    mockReadFile.mockResolvedValue('{"version":1,"entries":[]}');
  });

  describe('readTurnFeedbackOutbox', () => {
    it('returns [] when the file does not exist', async () => {
      mockReadFile.mockRejectedValue(new Error('ENOENT'));
      await expect(readTurnFeedbackOutbox()).resolves.toEqual([]);
    });

    it('returns [] on malformed JSON rather than throwing', async () => {
      mockReadFile.mockResolvedValue('{ this is not json');
      await expect(readTurnFeedbackOutbox()).resolves.toEqual([]);
    });

    it('returns [] when the file is valid JSON of the wrong shape', async () => {
      mockReadFile.mockResolvedValue('[1, 2, 3]');
      await expect(readTurnFeedbackOutbox()).resolves.toEqual([]);
    });

    it('drops individual malformed entries but keeps the good ones', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          entries: [
            { clientUserMessageId: 'msg-1-1', clientChatId: 'c', rating: 'up' },
            { clientUserMessageId: 'msg-2-2', rating: 'up' }, // no chat id
            { clientUserMessageId: 'msg-3-3', clientChatId: 'c', rating: '?' },
            null,
            'nope',
          ],
        }),
      );
      const entries = await readTurnFeedbackOutbox();
      expect(entries).toHaveLength(1);
      expect(entries[0].clientUserMessageId).toBe('msg-1-1');
    });

    it('drops an unrecognized reason but keeps the rating', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          entries: [
            {
              clientUserMessageId: 'msg-1-1',
              clientChatId: 'c',
              rating: 'down',
              reason: 'vibes-were-off',
            },
          ],
        }),
      );
      const entries = await readTurnFeedbackOutbox();
      expect(entries).toHaveLength(1);
      expect(entries[0].reason).toBeUndefined();
      expect(entries[0].rating).toBe('down');
    });

    it('round-trips the queued-at app version', async () => {
      // Stamped when the rating is queued, not at flush time: a rating queued
      // on one build and uploaded after an update still reports the build the
      // rated turn actually ran on.
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          entries: [
            {
              clientUserMessageId: 'msg-1-1',
              clientChatId: 'c',
              rating: 'up',
              appVersion: '0.26.8',
            },
          ],
        }),
      );
      const entries = await readTurnFeedbackOutbox();
      expect(entries[0].appVersion).toBe('0.26.8');
    });

    it('round-trips a valid work owner and drops a malformed one', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          entries: [
            {
              clientUserMessageId: 'msg-1-1',
              clientChatId: 'c',
              rating: 'up',
              workOwner: 'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            },
            {
              clientUserMessageId: 'msg-2-2',
              clientChatId: 'c',
              rating: 'up',
              workOwner: 'org:not-a-valid-id',
            },
          ],
        }),
      );

      const entries = await readTurnFeedbackOutbox();

      expect(entries[0].workOwner).toBe(
        'org:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      expect(entries[1].workOwner).toBeUndefined();
    });
  });

  describe('write chain', () => {
    it('never rejects when the write fails', async () => {
      mockWriteFile.mockRejectedValue(new Error('EACCES'));
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);

      await expect(enqueueTurnFeedback(entry())).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });

    it('keeps working after a failed write (the chain is not poisoned)', async () => {
      const consoleError = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined);
      mockWriteFile.mockRejectedValueOnce(new Error('EACCES'));

      await enqueueTurnFeedback(entry({ clientUserMessageId: 'msg-1-1' }));
      await expect(
        enqueueTurnFeedback(entry({ clientUserMessageId: 'msg-2-2' })),
      ).resolves.toBeUndefined();

      expect(writtenEntries()).toHaveLength(1);
      consoleError.mockRestore();
    });
  });

  describe('enqueueTurnFeedback', () => {
    it('replaces an earlier queued rating for the same turn', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          entries: [entry({ rating: 'up' })],
        }),
      );

      await enqueueTurnFeedback(entry({ rating: 'down' }));

      const written = writtenEntries();
      expect(written).toHaveLength(1);
      expect(written[0].rating).toBe('down');
    });

    it('drops entries older than the retention window', async () => {
      const stale = entry({
        clientUserMessageId: 'msg-old-1',
        queuedAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
      });
      mockReadFile.mockResolvedValue(
        JSON.stringify({ version: 1, entries: [stale] }),
      );

      await enqueueTurnFeedback(entry({ clientUserMessageId: 'msg-new-1' }));

      const written = writtenEntries();
      expect(written.map((e) => e.clientUserMessageId)).toEqual(['msg-new-1']);
    });

    it('caps the queue at 200 entries, dropping the oldest', async () => {
      const base = Date.now() - 1000;
      const existing = Array.from({ length: 200 }, (_, index) =>
        entry({
          clientUserMessageId: `msg-${index}-1`,
          queuedAt: base + index,
        }),
      );
      mockReadFile.mockResolvedValue(
        JSON.stringify({ version: 1, entries: existing }),
      );

      await enqueueTurnFeedback(entry({ clientUserMessageId: 'msg-new-1' }));

      const written = writtenEntries();
      expect(written).toHaveLength(200);
      expect(written[0].clientUserMessageId).toBe('msg-1-1');
      expect(written[written.length - 1].clientUserMessageId).toBe('msg-new-1');
    });
  });

  describe('amendQueuedTurnFeedback', () => {
    it('attaches the reason and comment to a queued rating', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({ version: 1, entries: [entry()] }),
      );

      const amended = await amendQueuedTurnFeedback({
        clientUserMessageId: 'msg-1-1700000000000',
        reason: 'broke-something',
        comment: '  the build went red  ',
      });

      expect(amended).toBe(true);
      const written = writtenEntries();
      expect(written[0].reason).toBe('broke-something');
      expect(written[0].comment).toBe('the build went red');
    });

    it('reports false when the turn is not queued', async () => {
      await expect(
        amendQueuedTurnFeedback({
          clientUserMessageId: 'msg-missing-1',
          reason: 'got-stuck',
        }),
      ).resolves.toBe(false);
    });
  });

  describe('removeQueuedTurnFeedback', () => {
    it('removes only the named turn', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          entries: [
            entry({ clientUserMessageId: 'msg-1-1' }),
            entry({ clientUserMessageId: 'msg-2-2' }),
          ],
        }),
      );

      await removeQueuedTurnFeedback('msg-1-1');

      expect(writtenEntries().map((e) => e.clientUserMessageId)).toEqual([
        'msg-2-2',
      ]);
    });
  });

  describe('removeQueuedTurnFeedbackBatch', () => {
    it('settles the whole batch in a single write', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          entries: [
            entry({ clientUserMessageId: 'msg-1-1' }),
            entry({ clientUserMessageId: 'msg-2-2' }),
            entry({ clientUserMessageId: 'msg-3-3' }),
          ],
        }),
      );

      await removeQueuedTurnFeedbackBatch(['msg-1-1', 'msg-3-3']);

      // One write, not one per settled id — a full flush used to cost a
      // read+write of the whole file per entry on the main process.
      expect(mockWrittenPayloads).toHaveLength(1);
      expect(writtenEntries().map((e) => e.clientUserMessageId)).toEqual([
        'msg-2-2',
      ]);
    });

    it('does not write at all for an empty batch', async () => {
      await removeQueuedTurnFeedbackBatch([]);
      expect(mockWrittenPayloads).toHaveLength(0);
    });
  });

  describe('account binding', () => {
    it('round-trips the queuing accountId so a flush can tell entries apart', async () => {
      mockReadFile.mockResolvedValue(
        JSON.stringify({
          version: 1,
          entries: [
            entry({ clientUserMessageId: 'msg-1-1', accountId: 'acct-a' }),
            // Queued while signed out — stays unbound.
            entry({ clientUserMessageId: 'msg-2-2' }),
          ],
        }),
      );

      const entries = await readTurnFeedbackOutbox();

      expect(entries.map((e) => e.accountId)).toEqual(['acct-a', undefined]);
    });

    it('writes the file owner-only, since a queued comment rests in plaintext', async () => {
      await enqueueTurnFeedback(entry());

      expect(mockWriteFile).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.objectContaining({ mode: 0o600 }),
      );
    });
  });
});

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ResolvedSendAgentMessageInputs } from '@canopy/desktop-shared/pipelines/host-send-agent-message';
import {
  createSendFingerprint,
  readSendJournal,
  SEND_JOURNAL_FILE,
  writeSendJournal,
  type SendJournalRecord,
} from '../pipelines/host-send-agent-message-state';

const KEY = 'pipeline-host:exec-1:job::send:0:0';

function record(overrides: Partial<SendJournalRecord> = {}): SendJournalRecord {
  return {
    version: 1,
    idempotencyKey: KEY,
    fingerprint: 'fp',
    phase: 'sending',
    ids: {
      commandId: 'cmd-1',
      userMessageId: 'msg-1',
      steerCommandId: 'steer-1',
    },
    chatId: 'chat-1',
    chatCreated: false,
    ...overrides,
  };
}

const chatSend = {
  version: 1,
  address: { kind: 'project', projectId: 'p', taskId: 't', chatId: 'chat-1' },
  userMessageId: 'msg-1',
  state: 'sent',
  chatCreated: false,
  acceptedAt: '2026-10-28T00:00:00.000Z',
} as const;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'canopy-send-state-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

it('round-trips a done record with its send', async () => {
  const written = record({
    phase: 'done',
    result: { status: 'success', outputs: { state: 'sent' }, chatSend },
  });
  await writeSendJournal(dir, written);
  await expect(readSendJournal(dir, KEY)).resolves.toEqual({
    kind: 'present',
    record: written,
  });
});

it('reads a missing journal as absent', async () => {
  await expect(readSendJournal(dir, KEY)).resolves.toEqual({ kind: 'absent' });
});

it("reads another attempt's record as absent", async () => {
  await writeSendJournal(dir, record({ idempotencyKey: 'other-attempt' }));
  await expect(readSendJournal(dir, KEY)).resolves.toEqual({ kind: 'absent' });
});

it.each([
  ['bad JSON', '{not json'],
  ['an unknown version', JSON.stringify({ ...record(), version: 2 })],
  [
    'a malformed send record',
    JSON.stringify({
      ...record({ phase: 'done' }),
      result: {
        status: 'success',
        outputs: {},
        chatSend: { ...chatSend, state: 'delivered' },
      },
    }),
  ],
])('reads %s as corrupt', async (_label, text) => {
  await writeFile(path.join(dir, SEND_JOURNAL_FILE), text, 'utf8');
  await expect(readSendJournal(dir, KEY)).resolves.toEqual({
    kind: 'corrupt',
  });
});

it('refuses to write a malformed send record', async () => {
  const bad = {
    ...record({ phase: 'done' }),
    result: {
      status: 'success' as const,
      outputs: {},
      chatSend: { ...chatSend, userMessageId: '' },
    },
  };
  await expect(writeSendJournal(dir, bad)).rejects.toThrow(
    'send-agent-message journal record is invalid',
  );
  await expect(stat(path.join(dir, SEND_JOURNAL_FILE))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

it('serializes writes to one file in order', async () => {
  await Promise.all([
    writeSendJournal(dir, record({ phase: 'creating' })),
    writeSendJournal(dir, record({ phase: 'sending' })),
    writeSendJournal(dir, record({ phase: 'steering', queuedMessageId: 'q' })),
    writeSendJournal(
      dir,
      record({
        phase: 'done',
        result: { status: 'success', outputs: {}, chatSend },
      }),
    ),
  ]);
  const stored: unknown = JSON.parse(
    await readFile(path.join(dir, SEND_JOURNAL_FILE), 'utf8'),
  );
  expect(stored).toMatchObject({ phase: 'done' });
});

describe('createSendFingerprint', () => {
  const inputs = (
    overrides: Partial<ResolvedSendAgentMessageInputs> = {},
  ): ResolvedSendAgentMessageInputs => ({
    target: { kind: 'project', projectId: 'p', taskId: 't', chatId: 'c' },
    text: 'Nightly report',
    mode: 'queue',
    settings: { thinkingEffort: 'high', fastMode: true },
    ...overrides,
  });
  const fingerprint = (
    value: ResolvedSendAgentMessageInputs,
    owner: unknown = 'personal',
    agentOrigin: unknown = undefined,
  ): string => createSendFingerprint({ inputs: value, owner, agentOrigin });

  it('ignores key order', () => {
    expect(
      fingerprint(
        inputs({ settings: { fastMode: true, thinkingEffort: 'high' } }),
      ),
    ).toBe(fingerprint(inputs()));
  });

  it('is equal for the same attachment realpaths, as a resume of one execution raises', () => {
    // A resumed execution keeps its working folder (the scratch folder is
    // derived from the execution id), so the realpaths repeat.
    const attachments = ['/runs/exec-1/workspace/notes.md'];
    expect(fingerprint(inputs({ attachments }))).toBe(
      fingerprint(inputs({ attachments: [...attachments] })),
    );
  });

  it('differs for text, attachments, mode, owner and agent origin, and never contains the text', () => {
    const base = fingerprint(inputs());
    for (const other of [
      fingerprint(inputs({ text: 'Weekly report' })),
      fingerprint(inputs({ attachments: ['/runs/exec-1/workspace/a.md'] })),
      fingerprint(inputs({ mode: 'steer' })),
      fingerprint(inputs(), 'org:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
      fingerprint(inputs(), 'personal', {
        projectId: 'ap',
        worktreeId: 'aw',
        chatId: 'ac',
      }),
    ]) {
      expect(other).not.toBe(base);
    }
    expect(base).not.toContain('Nightly');
  });
});

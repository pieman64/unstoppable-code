import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/desktop-shared/types';
import { LegacyChatInput } from '../lib/legacy-chat-input';
import { isChatTabsFile } from '../lib/chat-tabs-reader';
import { isRecord } from '../lib/type-guards';

const message = (id: string, text = id): PersistedChatMessage => ({
  id,
  role: 'user',
  timestamp: 1,
  blocks: [{ type: 'text', text }],
});

describe('bounded legacy chat input', () => {
  let root: string;
  let input: LegacyChatInput;
  beforeEach(async (): Promise<void> => {
    root = await mkdtemp(join(tmpdir(), 'legacy-chat-input-'));
    input = await LegacyChatInput.create(join(root, 'scratch'));
  });
  afterEach(async (): Promise<void> => {
    await input.close();
    await rm(root, { recursive: true, force: true });
  });

  it('reads sequential, oversized, and later appended scratch rows without stale bytes', async () => {
    const rows = Array.from({ length: 800 }, (_, i) =>
      message(String(i), '🌲'.repeat(80)),
    );
    const locations = [];
    for (const row of rows) locations.push(await input.spill(row));
    for (const [i, location] of Array.from(locations.entries()))
      expect(await input.read(location)).toEqual(rows[i]);
    const large = message('large', '🌲\ud800'.repeat(30000));
    const largeLocation = await input.spill(large);
    expect(await input.read(largeLocation)).toEqual(large);
    const newest = message('newest');
    expect(await input.read(await input.spill(newest))).toEqual(newest);
    expect(await input.read(locations[0])).toEqual(rows[0]);
  });

  it('spills messages before ids and retains only metadata in the parsed snapshot', async () => {
    const messages = Array.from({ length: 1200 }, (_, i) =>
      message(`m-${i}`, '🌲\n'.repeat(50) + '\ud800'),
    );
    const file = join(root, 'tabs.json');
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        tabs: [
          { messages, title: 'large', id: 'chat', createdAt: '2026-09-05' },
        ],
        activeTabId: 'chat',
      }),
    );
    const snapshot = await input.snapshot(file);
    if (!isChatTabsFile(snapshot)) throw new Error('Invalid chat tabs fixture');
    expect(snapshot.tabs[0].messages).toEqual([]);
    expect(input.messages(snapshot.tabs[0].messages).size).toBe(1200);
    const restored: PersistedChatMessage[] = [];
    for await (const row of input.messages(snapshot.tabs[0].messages).iterate())
      restored.push(row);
    expect(restored).toEqual(messages);
    expect(await readdir(join(root, 'scratch'))).not.toHaveLength(0);
  });

  it('uses last duplicate message content at its first position for legacy snapshots', async () => {
    const file = join(root, 'tabs.json');
    await writeFile(
      file,
      JSON.stringify({
        tabs: [
          {
            messages: [
              message('a', 'old'),
              message('b'),
              message('a', 'latest'),
            ],
          },
        ],
      }),
    );
    const value = await input.snapshot(file);
    if (
      !isRecord(value) ||
      !Array.isArray(value.tabs) ||
      !isRecord(value.tabs[0]) ||
      !Array.isArray(value.tabs[0].messages)
    )
      throw new Error('Invalid chat tabs fixture');
    const rows: PersistedChatMessage[] = [];
    for await (const row of input.messages(value.tabs[0].messages).iterate())
      rows.push(row);
    expect(rows).toEqual([message('a', 'latest'), message('b')]);
  });

  it('streams transcript-bearing journal mutations and rejects an uncommitted tail without changing the source', async () => {
    const record = {
      v: 1,
      revision: 1,
      mutationId: 'one',
      occurredAt: '2026-09-05',
      source: 'provider',
      mutations: [
        {
          type: 'messages.replaced',
          chatId: 'chat',
          messages: [message('a')],
          removedMessageIds: [],
        },
      ],
    };
    const file = join(root, 'journal.jsonl');
    const bytes =
      JSON.stringify(record) +
      '\n' +
      JSON.stringify({ ...record, revision: 2 });
    await writeFile(file, bytes);
    const revisions: number[] = [];
    await expect(
      (async (): Promise<void> => {
        for await (const row of input.journal(file)) {
          revisions.push(row.revision);
          const mutation = row.mutations[0];
          if (mutation.type !== 'messages.replaced') throw new Error('fixture');
          expect(mutation.messages).toEqual([]);
          expect(input.messages(mutation.messages).size).toBe(1);
        }
      })(),
    ).rejects.toThrow('tail');
    expect(revisions).toEqual([1]);
    expect(await readFile(file, 'utf8')).toBe(bytes);
  });

  it('rejects malformed JSON and invalid UTF-8 without changing source files', async () => {
    for (const bytes of [
      Buffer.from('{"tabs": ['),
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]),
    ]) {
      const file = join(root, 'broken.json');
      await writeFile(file, bytes);
      await expect(input.snapshot(file)).rejects.toThrow();
      expect(await readFile(file)).toEqual(bytes);
    }
  });
});

/**
 * Chat-storage work counters on a fake filesystem: every byte the writer hands
 * to a file handle and every sync it requests is observed, so the counts are
 * exact and independent of the host disk.
 */
const writes: Array<{ path: string; bytes: number }> = [];
const syncs: string[] = [];

jest.mock('node:fs/promises', () => ({
  open: jest.fn((path: string) =>
    Promise.resolve({
      write: jest.fn(
        (
          buffer: Buffer,
          offset: number,
          length: number,
        ): Promise<{ bytesWritten: number }> => {
          writes.push({ path, bytes: length });
          void buffer;
          void offset;
          return Promise.resolve({ bytesWritten: length });
        },
      ),
      sync: jest.fn((): Promise<void> => {
        syncs.push(path);
        return Promise.resolve();
      }),
      close: jest.fn((): Promise<void> => Promise.resolve()),
    }),
  ),
}));

import {
  classifyChatStorageFile,
  resetWorkCounters,
  snapshotWorkCounters,
} from '@canopy/desktop-shared/node/work-counters';
import { writeJsonValuesCooperatively } from '../lib/cooperative-json';
import { fsyncDirectory } from '../lib/fsync-directory';

const SCOPE = '/data/workspaces/w1/chat-storage-v2/scope-1';

describe('chat storage write counters', () => {
  it('classifies both physical delta-journal generations as journal work', () => {
    expect(classifyChatStorageFile(`${SCOPE}/delta-journal.log`)).toBe(
      'deltaJournal',
    );
    expect(classifyChatStorageFile(`${SCOPE}/delta-journal-v2.log`)).toBe(
      'deltaJournal',
    );
  });
  it('separates child stream writes without changing legacy or primary classes', () => {
    const child = `${SCOPE}/transcripts/delegations/parent/v2/${'a'.repeat(64)}`;
    const cases: Array<[string, string]> = [
      [`${child}/transcript.jsonl`, 'childTranscript'],
      [`${child}/transcript.active.json`, 'childActiveSidecar'],
      [`${child}/transcript.abc.append.tmp`, 'childAppendStaging'],
      [`${child}/descriptor.json`, 'childStreamMetadata'],
      [`${child}/descriptor.json.checkpoint`, 'childStreamMetadata'],
      [`${child}/transcript.sequence-index.json`, 'childMessageIndex'],
      [`${child}/transcript.index.json`, 'childMessageIndex'],
      [
        `${child}/transcript.index.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp`,
        'childMessageIndex',
      ],
      [`${child}/transcript.turns.json`, 'childMessageIndex'],
      [
        `${child}/transcript.sequence-index.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp`,
        'childMessageIndex',
      ],
      [`${child}/message-index/row.json`, 'childMessageIndex'],
      [
        `${SCOPE}/transcripts/delegations/parent/v2/registry.jsonl`,
        'childStreamMetadata',
      ],
      [
        `${SCOPE}/transcripts/delegations/parent/v2/registry.index.json`,
        'childStreamMetadata',
      ],
      [
        `${SCOPE}/transcripts/delegations/stream-catalog.json`,
        'childStreamMetadata',
      ],
      [
        `${SCOPE}/transcripts/delegations/stream-catalog.json.checkpoint`,
        'childStreamMetadata',
      ],
      [`${SCOPE}/transcripts/delegations/parent/legacy.jsonl`, 'delegationLog'],
      [`${SCOPE}/transcripts/parent.active.json`, 'activeSidecar'],
    ];
    for (const [path, expected] of cases)
      expect(classifyChatStorageFile(path)).toBe(expected);
  });
  beforeEach(() => {
    writes.length = 0;
    syncs.length = 0;
    resetWorkCounters();
  });

  it('counts serialized and written bytes and one file sync per cooperative write', async () => {
    const journal = { v: 2, transactionId: 'tx', writes: [] };
    const index = { version: 2, revision: 4, tabs: [{ id: 'chat-1' }] };
    const rows = [{ id: 'a' }, { id: 'b', text: 'é' }];

    await writeJsonValuesCooperatively(
      `${SCOPE}/metadata-journal.jsonl.0f8fad5b-d9cb-469f-a165-70867728950e.tmp`,
      [journal],
      { pretty: false, separator: '\n', trailingSeparator: true },
    );
    await writeJsonValuesCooperatively(`${SCOPE}/live-index.json`, [index], {
      pretty: false,
    });
    await writeJsonValuesCooperatively(
      `${SCOPE}/transcripts/chat-1.jsonl`,
      rows,
      { pretty: false, separator: '\n', trailingSeparator: true },
    );
    // A writer outside chat storage shares the primitive but is not counted.
    await writeJsonValuesCooperatively('/data/app-advisor/watchers.json', [1], {
      pretty: false,
    });

    const journalBytes = Buffer.byteLength(`${JSON.stringify(journal)}\n`);
    const indexBytes = Buffer.byteLength(JSON.stringify(index));
    const rowBytes = Buffer.byteLength(
      rows.map((row) => `${JSON.stringify(row)}\n`).join(''),
    );
    expect(writes.map(({ bytes }) => bytes)).toEqual([
      journalBytes,
      indexBytes,
      rowBytes,
      1,
    ]);
    expect(syncs).toHaveLength(4);
    expect(snapshotWorkCounters().chatStorage).toEqual({
      'serialized.journal.bytes': journalBytes,
      'written.journal.bytes': journalBytes,
      'serialized.liveIndex.bytes': indexBytes,
      'written.liveIndex.bytes': indexBytes,
      'serialized.transcript.bytes': rowBytes,
      'written.transcript.bytes': rowBytes,
      'syncs.file': 3,
    });
  });

  it('counts each chat storage directory sync once', async () => {
    await fsyncDirectory(SCOPE);
    await fsyncDirectory(`${SCOPE}/transcripts`);
    await fsyncDirectory('/data/workspaces/w1/chats');

    expect(syncs).toEqual(
      process.platform === 'win32'
        ? []
        : [SCOPE, `${SCOPE}/transcripts`, '/data/workspaces/w1/chats'],
    );
    expect(snapshotWorkCounters().chatStorage).toEqual(
      process.platform === 'win32' ? {} : { 'syncs.directory': 2 },
    );
  });

  it('classifies committed visual artifacts and their temporaries, not staging', () => {
    const scope = '/data/workspaces/w1/chat-storage-v2/scope-1';
    const artifactId = `sha256-v1-${'a'.repeat(64)}`;
    const temporaryId = '0f8fad5b-d9cb-469f-a165-70867728950e';

    expect(
      classifyChatStorageFile(
        `${scope}/transcripts/visuals/chat-1/${artifactId}.html`,
      ),
    ).toBe('artifact');
    expect(
      classifyChatStorageFile(
        `${scope}/transcripts/visuals/chat-1/${artifactId}.html.${temporaryId}.tmp`,
      ),
    ).toBe('artifact');
    expect(
      classifyChatStorageFile(`${scope}/visual-staging/chat-1/document.html`),
    ).toBe('other');
  });
});

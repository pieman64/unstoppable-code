import type { PersistedChatMessage } from '../../types';
import {
  isPersistedChatMessageVisible,
  sanitizePersistedChatMessages,
  sanitizePersistedChatMessageStream,
} from '../message-sanitization';

const referenced: PersistedChatMessage = {
  id: 'reference-only',
  role: 'assistant',
  timestamp: 1,
  blocks: [],
  blocksRef: {
    version: 1,
    blockCount: 1,
    manifest: {
      version: 1,
      artifactId: `sha256-v1-${'c'.repeat(64)}`,
      sha256: 'c'.repeat(64),
      byteLength: 200,
      encoding: 'utf-8',
      mediaType: 'text/plain',
    },
  },
};

describe('reference-only message sanitization', () => {
  it('keeps a valid referenced assistant row in both array and point sanitizers', () => {
    expect(isPersistedChatMessageVisible([referenced], 0)).toBe(true);
    expect(sanitizePersistedChatMessages([referenced])).toEqual([referenced]);
  });
  it('keeps the same row in the stream sanitizer used by main search', async () => {
    async function* input(): AsyncGenerator<PersistedChatMessage> {
      yield await Promise.resolve(referenced);
    }
    const output: PersistedChatMessage[] = [];
    for await (const row of sanitizePersistedChatMessageStream(input()))
      output.push(row);
    expect(output).toEqual([referenced]);
  });
  it('still removes empty assistant rows with absent or invalid references (control)', async () => {
    const rows: PersistedChatMessage[] = [
      { id: 'absent', role: 'assistant', timestamp: 1, blocks: [] },
      {
        ...referenced,
        id: 'invalid',
        blocksRef: {
          version: 1,
          blockCount: 0,
          manifest: {
            version: 1,
            artifactId: 'invalid',
            sha256: 'invalid',
            byteLength: 0,
            encoding: 'utf-8',
            mediaType: 'text/plain',
          },
        },
      },
      {
        ...referenced,
        id: 'whitespace',
        blocks: [{ type: 'text', text: '  ' }],
      },
    ];
    expect(sanitizePersistedChatMessages(rows)).toEqual([]);
    async function* input(): AsyncGenerator<PersistedChatMessage> {
      await Promise.resolve();
      yield* rows;
    }
    const output: PersistedChatMessage[] = [];
    for await (const row of sanitizePersistedChatMessageStream(input()))
      output.push(row);
    expect(output).toEqual([]);
  });
});

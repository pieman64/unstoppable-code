import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  delegationTranscriptPaths,
  primaryTranscriptPaths,
} from '../lib/transcript-stream-paths';

describe('primary transcript stream paths', () => {
  const root = join('scope', 'transcripts');
  const paths = primaryTranscriptPaths(root);
  const key = 'chat-1';

  it('pins all primary files and directories', () => {
    expect(paths.directory(key)).toBe(join('scope', 'transcripts'));
    expect(paths.file(key, 'jsonl')).toBe(
      join('scope', 'transcripts', 'chat-1.jsonl'),
    );
    expect(paths.file(key, 'index.json')).toBe(
      join('scope', 'transcripts', 'chat-1.index.json'),
    );
    expect(paths.file(key, 'turns.json')).toBe(
      join('scope', 'transcripts', 'chat-1.turns.json'),
    );
    expect(paths.file(key, 'active.json')).toBe(
      join('scope', 'transcripts', 'chat-1.active.json'),
    );
    expect(paths.file(key, 'stage.append.tmp')).toBe(
      join('scope', 'transcripts', 'chat-1.stage.append.tmp'),
    );
    expect(paths.stagedAppendFile(key, 'stage')).toBe(
      join('scope', 'transcripts', 'chat-1.stage.append.tmp'),
    );
    expect(paths.isStagedAppend(key, 'chat-1.stage.append.tmp')).toBe(true);
    expect(paths.isStagedAppend(key, 'chat-2.stage.append.tmp')).toBe(false);
    expect(paths.locatorParent(key)).toBe(
      join('scope', 'transcripts', 'message-index'),
    );
    expect(paths.locatorDirectory(key)).toBe(
      join('scope', 'transcripts', 'message-index', 'chat-1'),
    );
    expect(paths.locatorFile(key, 'm-1')).toBe(
      join(
        'scope',
        'transcripts',
        'message-index',
        'chat-1',
        'a461b472cb41a9ec3dee5c90cf8e4a78252c9d82319adf75830031b8c309bfc6.json',
      ),
    );
    expect(paths.owner(key)).toBe('chat-1');
  });

  it('preserves the primary invalid identity error', () => {
    expect(() => paths.assertKey('../bad')).toThrow(
      'Invalid transcript identity',
    );
    expect(() => paths.file('../bad', 'jsonl')).toThrow(
      'Invalid transcript identity',
    );
  });
});

it('isolates delegation paths under a tuple-derived stream key', () => {
  const root = join('scope', 'transcripts');
  const target = {
    kind: 'delegation' as const,
    chatId: 'chat-1',
    delegationId: 'd/1',
    runGeneration: 2,
  };
  const key = createHash('sha256')
    .update(JSON.stringify(['delegation', 'chat-1', 'd/1', 2]))
    .digest('hex');
  const paths = delegationTranscriptPaths(root, target);
  expect(paths.owner(key)).toBe('chat-1');
  expect(paths.file(key, 'jsonl')).toBe(
    join(root, 'delegations', 'chat-1', 'v2', key, 'transcript.jsonl'),
  );
  expect(() => paths.assertKey('0'.repeat(64))).toThrow();
});

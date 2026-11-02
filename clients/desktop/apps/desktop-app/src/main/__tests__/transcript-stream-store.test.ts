import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PersistedChatMessage } from '@canopy/agent-transcript/types';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import { ChatTranscriptArtifacts } from '../lib/chat-transcript-artifacts';
import { TranscriptStreamStore } from '../lib/chat-transcript-log';
import * as sequenceIndex from '../lib/child-stream-sequence-index';
import {
  primaryTranscriptPaths,
  type TranscriptStreamPaths,
} from '../lib/transcript-stream-paths';

function message(id: string): PersistedChatMessage {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    blocks: [{ type: 'text', text: id }],
  };
}

describe('transcript stream store with nested per-key layout', () => {
  let root: string;
  let artifacts: ChatTranscriptArtifacts;
  let paths: TranscriptStreamPaths;
  let store: TranscriptStreamStore;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'nested-stream-'));
    artifacts = new ChatTranscriptArtifacts(root);
    const forKey = (key: string): TranscriptStreamPaths =>
      primaryTranscriptPaths(join(root, 'nested', key));
    paths = {
      assertKey: (key): void => forKey(key).assertKey(key),
      directory: (key): string => forKey(key).directory(key),
      file: (key, extension): string => forKey(key).file(key, extension),
      locatorParent: (key): string => forKey(key).locatorParent(key),
      locatorDirectory: (key): string => forKey(key).locatorDirectory(key),
      locatorFile: (key, id): string => forKey(key).locatorFile(key, id),
      stagedAppendFile: (key, id): string =>
        forKey(key).stagedAppendFile(key, id),
      isStagedAppend: (key, basename): boolean =>
        forKey(key).isStagedAppend(key, basename),
      owner: (): string => 'shared-owner',
    };
    store = new TranscriptStreamStore(paths, artifacts);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('isolates append, replacement, reload, recovery and removal while preserving owner artifacts', async () => {
    const externalize = jest.spyOn(artifacts, 'externalize');
    for (const key of ['first', 'second']) {
      await store.initialize(key);
      await store.append(key, [message(`${key}-one`)]);
      await store.replace(key, [message(`${key}-two`)], 2);
      expect(
        (await new TranscriptStreamStore(paths, artifacts).page(key)).messages,
      ).toEqual([message(`${key}-two`)]);
    }
    expect(
      externalize.mock.calls.every(([owner]) => owner === 'shared-owner'),
    ).toBe(true);

    const artifact = await artifacts.put('shared-owner', 'shared content');
    const orphanFirst = paths.stagedAppendFile('first', 'orphan');
    const orphanSecond = paths.stagedAppendFile('second', 'orphan');
    await writeFile(orphanFirst, 'orphan');
    await writeFile(orphanSecond, 'orphan');
    await new TranscriptStreamStore(paths, artifacts).page('first');
    await expect(readFile(orphanFirst)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(orphanSecond)).resolves.toBeDefined();

    await store.remove('first');
    expect(
      (await new TranscriptStreamStore(paths, artifacts).page('second'))
        .messages,
    ).toEqual([message('second-two')]);
    await artifacts.verify('shared-owner', artifact);
    await expect(readFile(paths.file('first', 'jsonl'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

it('rebuilds the child sequence index without retaining row bodies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-index-rebuild-'));
  const build = jest.spyOn(sequenceIndex, 'buildChildStreamSequenceIndex');
  try {
    const store = new TranscriptStreamStore(
      primaryTranscriptPaths(root),
      new ChatTranscriptArtifacts(root),
      undefined,
      { childMode: true },
    );
    await store.initialize('stream');
    const row: DelegationChildRow = {
      ...message('block:large'),
      blocks: [{ type: 'text', text: 'x'.repeat(64 * 1024) }],
      parentBlockId: 'block',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
    };
    await store.appendChildFinalRows('stream', [row], [], 1);
    await rm(join(root, 'stream.sequence-index.json'));
    build.mockClear();
    expect(await store.childStreamRowById('stream', 'block:large')).toEqual(
      row,
    );
    expect(build).toHaveBeenCalledTimes(1);
    for (const input of build.mock.calls[0][0])
      expect(Object.keys(input.row).sort()).toEqual([
        'delegationSequence',
        'id',
      ]);
  } finally {
    build.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('finalizes a later child behind an earlier open row without changing primary rules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-store-'));
  try {
    const artifacts = new ChatTranscriptArtifacts(root);
    const store = new TranscriptStreamStore(
      primaryTranscriptPaths(root),
      artifacts,
      undefined,
      { childMode: true },
    );
    const child = (
      id: string,
      sequence: number,
      final: boolean,
    ): DelegationChildRow => ({
      ...message(id),
      parentBlockId: 'block',
      delegationSequence: sequence,
      itemRevision: 0,
      final,
    });
    await store.initialize('stream');
    const earlier = child('block:earlier', 1, false);
    const later = child('block:later', 2, true);
    await store.writeChildOpenRows('stream', [earlier], 1);
    await store.appendChildFinalRows('stream', [later], [earlier], 2);
    const savedIndex: unknown = JSON.parse(
      await readFile(join(root, 'stream.sequence-index.json'), 'utf8'),
    );
    expect(savedIndex).toMatchObject({
      version: 1,
      entries: [{ id: 'block:later' }],
    });
    expect((await store.page('stream')).messages.map((row) => row.id)).toEqual([
      'block:later',
      'block:earlier',
    ]);
    expect(
      (await store.readChildStreamPage('stream')).rows.map((row) => row.id),
    ).toEqual(['block:later']);
    expect(await store.childStreamRowById('stream', 'block:later')).toEqual(
      later,
    );
    await rm(join(root, 'stream.sequence-index.json'));
    expect(
      (await store.readChildStreamPage('stream')).rows.map((row) => row.id),
    ).toEqual(['block:later']);
    expect(
      (await readFile(join(root, 'stream.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean),
    ).toHaveLength(1);
    await store.appendChildFinalRows('stream', [later], [earlier], 2);
    expect(
      (await readFile(join(root, 'stream.jsonl'), 'utf8'))
        .split('\n')
        .filter(Boolean),
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps only open child bytes in the sidecar across large finalizations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-sidecar-'));
  try {
    const store = new TranscriptStreamStore(
      primaryTranscriptPaths(root),
      new ChatTranscriptArtifacts(root),
      async (boundary) => {
        if (boundary !== 'prepared') return;
        const pending = await readFile(join(root, 'stream.active.json'));
        expect(pending.length).toBeLessThan(8_000);
        expect(pending.toString()).not.toContain('x'.repeat(100));
      },
      { childMode: true },
    );
    await store.initialize('stream');
    const make = (
      id: string,
      final: boolean,
      text: string,
    ): DelegationChildRow => ({
      id,
      role: 'assistant',
      timestamp: 1,
      parentBlockId: 'block',
      delegationSequence: Number(id.split('-')[1]),
      itemRevision: 0,
      final,
      blocks: [{ type: 'text', text }],
    });
    const open = make('item-0', false, 'open');
    for (let batch = 0; batch < 3; batch += 1) {
      const finals = Array.from({ length: 4 }, (_, i) =>
        make(`item-${batch * 4 + i + 1}`, true, 'x'.repeat(16 * 1024)),
      );
      await store.appendChildFinalRows('stream', finals, [open], batch + 1);
      const sidecar = await readFile(join(root, 'stream.active.json'));
      const log = await readFile(join(root, 'stream.jsonl'));
      expect(sidecar.length).toBeLessThan(log.length / 8);
      expect(sidecar.toString()).not.toContain('x'.repeat(100));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('replays child finals once after a crash between staging and sidecar publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-staged-crash-'));
  try {
    const paths = primaryTranscriptPaths(root);
    const artifacts = new ChatTranscriptArtifacts(root);
    const aborted = new TranscriptStreamStore(paths, artifacts, undefined, {
      childMode: true,
      onChildStaged: (): Promise<void> =>
        Promise.reject(new Error('simulated crash before sidecar')),
    });
    await aborted.initialize('stream');
    const finalRows: DelegationChildRow[] = [1, 2, 3].map((sequence) => ({
      id: `block:${sequence}`,
      role: 'assistant',
      timestamp: sequence,
      parentBlockId: 'block',
      delegationSequence: sequence,
      itemRevision: 0,
      final: true,
      blocks: [{ type: 'text', text: 'x'.repeat(16 * 1024) }],
    }));
    await expect(
      aborted.appendChildFinalRows('stream', finalRows, [], 1),
    ).rejects.toThrow('simulated crash');
    expect(await readFile(join(root, 'stream.jsonl'), 'utf8')).toBe('');
    const recovered = new TranscriptStreamStore(paths, artifacts, undefined, {
      childMode: true,
    });
    await recovered.appendChildFinalRows('stream', finalRows, [], 1);
    await recovered.appendChildFinalRows('stream', finalRows, [], 1);
    const log = (await readFile(join(root, 'stream.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    expect(log).toHaveLength(3);
    const persisted = log.map((line): unknown => {
      const parsed: unknown = JSON.parse(line);
      return parsed;
    });
    expect(persisted).toMatchObject(finalRows.map((row) => ({ id: row.id })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('finishes a published child append intent before a read-only reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'child-intent-readonly-'));
  try {
    const paths = primaryTranscriptPaths(root);
    const artifacts = new ChatTranscriptArtifacts(root);
    const row: DelegationChildRow = {
      ...message('block:item'),
      parentBlockId: 'block',
      delegationSequence: 0,
      itemRevision: 0,
      final: true,
    };
    const aborted = new TranscriptStreamStore(
      paths,
      artifacts,
      (point): Promise<void> =>
        point === 'prepared'
          ? Promise.reject(new Error('after child intent'))
          : Promise.resolve(),
      { childMode: true },
    );
    await aborted.initialize('stream');
    await expect(
      aborted.appendChildFinalRows('stream', [row], [], 1),
    ).rejects.toThrow('after child intent');
    const readonly = new TranscriptStreamStore(paths, artifacts, undefined, {
      childMode: true,
      readOnly: true,
    });
    await expect(readonly.activeMessages('stream')).rejects.toThrow(
      'Transcript store is read-only',
    );
    const writable = new TranscriptStreamStore(paths, artifacts, undefined, {
      childMode: true,
    });
    await writable.activeMessages('stream');
    await expect(readonly.activeMessages('stream')).resolves.toEqual([]);
    expect(
      (await readFile(join(root, 'stream.jsonl'), 'utf8')).trim().split('\n'),
    ).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

describe('transcript stream store field modes', () => {
  let root: string;
  let artifacts: ChatTranscriptArtifacts;
  let store: TranscriptStreamStore;
  const big = (label: string): string =>
    `${label} begin\n${`${label} 🌲 body\n`.repeat(8_000)}${label} end`;
  const row = (id: string, text: string): PersistedChatMessage => ({
    id,
    role: 'assistant',
    timestamp: 1,
    blocks: [{ type: 'text', text }],
  });
  const files = async (): Promise<string[]> => {
    try {
      return (await readdir(join(root, 'tool-output', 'chat'))).sort();
    } catch {
      return [];
    }
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-field-mode-'));
    artifacts = new ChatTranscriptArtifacts(root);
    store = new TranscriptStreamStore(primaryTranscriptPaths(root), artifacts);
    await store.initialize('chat');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('keeps the legacy representation unless a write selects format 4', async () => {
    const text = big('legacy');
    await store.append('chat', [row('legacy', text)]);
    expect(await store.readMessage('chat', 'legacy')).toEqual(
      row('legacy', text),
    );
    expect(await files()).toEqual([]);
  });

  it('publishes final rows and keeps open rows inline under format 4', async () => {
    const open = big('open');
    await store.writeActive('chat', [row('open', open)], undefined, 'format4');
    expect(await store.readMessage('chat', 'open')).toEqual(row('open', open));
    expect(await files()).toEqual([]);
    await store.append(
      'chat',
      [row('open', open)],
      undefined,
      undefined,
      'format4',
    );
    const committed = await store.readMessage('chat', 'open');
    const block = committed?.blocks[0];
    expect(block?.type === 'text' && block.textRef).toBeTruthy();
    expect(await files()).toHaveLength(1);
    const parts: string[] = [];
    for (let offset: number | undefined = 0; offset !== undefined; ) {
      const part = await store.readFieldRange(
        'chat',
        'open',
        { blockOrdinal: 0, field: 'text' },
        offset,
      );
      parts.push(part.text);
      offset = part.nextOffset;
    }
    expect(parts.join('')).toBe(open);
  });

  it('re-applies prepared rows in verify mode and never publishes', async () => {
    await expect(
      store.append(
        'chat',
        [row('unbacked', big('unbacked'))],
        undefined,
        undefined,
        'format4-verify',
      ),
    ).rejects.toThrow('without a lossless artifact');
    expect(await files()).toEqual([]);
    // An open row may hold a large field inline; verify accepts it as is.
    await store.writeActive(
      'chat',
      [row('open', big('open'))],
      undefined,
      'format4-verify',
    );
    expect(await files()).toEqual([]);
    const reference = await artifacts.put('chat', big('prepared'));
    const prepared: PersistedChatMessage = {
      id: 'prepared',
      role: 'assistant',
      timestamp: 1,
      blocks: [{ type: 'text', text: 'preview', textRef: reference }],
    };
    await store.replace('chat', [prepared], 1, 'format4-verify');
    expect(await store.readMessage('chat', 'prepared')).toEqual(prepared);
    await rm(join(root, 'tool-output', 'chat', `${reference.artifactId}.txt`));
    await expect(
      store.append(
        'chat',
        [{ ...prepared, id: 'again' }],
        undefined,
        undefined,
        'format4-verify',
      ),
    ).rejects.toThrow();
    expect(await files()).toEqual([]);
  });
});

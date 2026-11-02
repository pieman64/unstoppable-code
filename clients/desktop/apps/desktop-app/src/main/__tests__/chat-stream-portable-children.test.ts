import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BODY_TEXT,
  OLD_TEXT,
  PAGED_TEXT,
  portableFixture,
  portableRows,
} from './helpers/stream-portable-fixture';
import {
  child,
  sourceFixture,
  target,
  parent,
} from './helpers/stream-closure-copy-fixture';
import { format4Scope, reopenFormat4Scope } from './helpers/chat-format4-scope';
import { scopeSource } from './helpers/chat-delta-journal-harness';

jest.setTimeout(120_000);
describe('portable stream children (option off)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'stream-portable-'));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('inlines every page in logical order despite an earlier open row and reversed finalization', async () => {
    const { backend } = await portableFixture(root);
    const rows = await portableRows(backend);
    expect(
      rows
        .filter((row) => row.parentBlockId === 'delegated-agent-delegate')
        .map((row) => row.id),
    ).toEqual(Array.from({ length: 106 }, (_, i) => `row-${i}`));
    expect(rows[1]?.blocks).toEqual([{ type: 'text', text: OLD_TEXT }]);
    expect(JSON.stringify(rows)).not.toContain('transcriptStore');
    expect(
      rows.find((row) => row.parentBlockId === 'delegated-agent-legacy')
        ?.blocks,
    ).toEqual([{ type: 'text', text: 'legacy child exact text' }]);
  });

  it('expands multi-block pages and exact beyond-preview bodies only with fullOutputs', async () => {
    const { backend } = await portableFixture(root);
    const full = (await portableRows(backend)).find(
      (row) => row.id === 'row-1',
    );
    expect(full?.blocks).toEqual([
      { type: 'text', text: 'first logical block' },
      ...Array.from({ length: 20 }, () => ({ type: 'text', text: PAGED_TEXT })),
      {
        type: 'tool_result',
        toolUseId: 'tool',
        toolName: 'Read',
        output: BODY_TEXT,
        isError: false,
      },
    ]);
    expect(full?.blocksRef).toBeUndefined();
    const preview = (await portableRows(backend, false)).find(
      (row) => row.id === 'row-1',
    );
    expect(preview?.blocks).toHaveLength(22);
    const result = preview?.blocks.find(
      (block) => block.type === 'tool_result',
    );
    expect(result).toHaveProperty('fullOutputRef');
    expect(JSON.stringify(preview)).not.toContain(BODY_TEXT);
  });

  it('overlays descriptor card state before stripping the stream marker', async () => {
    // Card state writes need the journal writer, so read the journaled scope.
    const { backend } = await format4Scope(
      root,
      'card',
      scopeSource([{ id: 'chat', messages: [parent()] }]),
    );
    await backend.registerTranscriptStream(target);
    await backend.commitChildStream(target, 'child', [child()]);
    await backend.updateChildStreamCardState(target, 1, {
      version: 1,
      status: 'completed',
      resultIndex: 1,
      error: null,
      usage: null,
      workspaceRevision: null,
      workspaceDiscarded: false,
      stopOutcome: null,
      controlOutcome: null,
      attribution: null,
      capabilitySummary: null,
      nestedChildSummary: null,
      partialPreview: null,
      finalPreview: 'descriptor final answer',
    });
    expect((await portableRows(backend))[0]?.blocks[0]).toMatchObject({
      status: 'completed',
      finalText: 'descriptor final answer',
    });
    expect((await portableRows(backend))[0]?.blocks[0]).not.toHaveProperty(
      'transcriptStore',
    );
  });

  it('strips unknown stream and missing legacy log markers without inventing children', async () => {
    const legacyBlock = { ...parent().blocks[0] };
    // Keep the intentionally stale marker untyped until it reaches storage.
    Reflect.set(legacyBlock, 'transcriptStore', 'chat-log-v1');
    const fixture = await format4Scope(
      root,
      'unknown',
      scopeSource([
        {
          id: 'chat',
          messages: [
            parent(),
            {
              ...parent(),
              id: 'legacy',
              blocks: [legacyBlock],
            },
          ],
        },
      ]),
    );
    await fixture.backend.demoteFromDeltaJournal();
    const { backend } = reopenFormat4Scope(root, 'unknown', {
      deltaJournal: false,
      enableFormat4: false,
    });
    const rows = await portableRows(backend);
    expect(rows).toHaveLength(2);
    expect(JSON.stringify(rows)).not.toContain('transcriptStore');
  });

  it('refuses the legacy managed read for a stream rather than reporting an empty success', async () => {
    const { backend } = await sourceFixture(root);
    await expect(backend.readDelegationItems('chat', target)).rejects.toThrow(
      'Stream-backed delegation requires target-aware transcript reads',
    );
  });
});

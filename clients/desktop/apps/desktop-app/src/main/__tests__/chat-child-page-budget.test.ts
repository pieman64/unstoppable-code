import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationChildRow } from '@canopy/agent-transcript';
import {
  CHILD_PAGE_ROW_BYTES,
  ChildPageRowTooLargeError,
  selectChildPageRows,
  type ChildPageRead,
} from '../lib/child-page-budget';
import { format4Scope } from './helpers/chat-format4-scope';
import { scopeSource } from './helpers/chat-delta-journal-harness';
import { parent, target } from './helpers/stream-closure-copy-fixture';

const scope = { projectId: 'project', worktreeId: 'budget' };

function row(index: number, text = `row ${index}`): DelegationChildRow {
  return {
    id: `agent:row-${index}`,
    role: 'assistant',
    timestamp: index,
    parentBlockId: 'delegated-agent-delegate',
    delegationSequence: index,
    itemRevision: 0,
    final: true,
    blocks: [{ type: 'text', text }],
  };
}

/** The production reader's contract: rows before `before`, newest `limit`. */
function reader(rows: readonly DelegationChildRow[]): {
  read: ChildPageRead;
  limits: number[];
} {
  const limits: number[] = [];
  return {
    limits,
    read: ({ before = rows.length, limit }): ReturnType<ChildPageRead> => {
      limits.push(limit);
      const start = Math.max(0, before - limit);
      return Promise.resolve({
        rows: rows.slice(start, before),
        ...(start > 0 ? { nextBefore: start } : {}),
      });
    },
  };
}

async function walk(
  read: ChildPageRead,
): Promise<{ ids: string[]; pages: number; largest: number }> {
  const ids: string[] = [];
  let pages = 0;
  let largest = 0;
  let before: number | undefined;
  do {
    const page = await selectChildPageRows(read, before);
    pages += 1;
    largest = Math.max(
      largest,
      Buffer.byteLength(JSON.stringify(page.rows), 'utf8'),
    );
    ids.unshift(...page.rows.map((kept) => kept.id));
    before = page.start > 0 ? page.start : undefined;
  } while (before !== undefined);
  return { ids, pages, largest };
}

describe('child page byte budget', () => {
  it('keeps every small row of a full page', async () => {
    const rows = Array.from({ length: 600 }, (_, i) => row(i));
    const page = await selectChildPageRows(reader(rows).read);
    expect(page.rows).toHaveLength(500);
    expect(page.rows[0]?.id).toBe('agent:row-100');
    expect(page).toMatchObject({ start: 100, end: 600 });
  });

  it('returns every row exactly once, in order, across byte-bounded pages', async () => {
    const big = 'x'.repeat(48 * 1024);
    const rows = Array.from({ length: 60 }, (_, i) =>
      row(i, i % 7 === 0 ? 'small' : big),
    );
    const { ids, pages, largest } = await walk(reader(rows).read);
    expect(ids).toEqual(rows.map((each) => each.id));
    expect(pages).toBeGreaterThan(3);
    expect(largest).toBeLessThanOrEqual(CHILD_PAGE_ROW_BYTES);
  });

  it('splits a history shorter than one page when its bytes exceed the budget', async () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      row(i, 'y'.repeat(40 * 1024)),
    );
    const first = await selectChildPageRows(reader(rows).read);
    expect(first.start).toBeGreaterThan(0);
    expect(first.rows.at(-1)?.id).toBe('agent:row-29');
    const { ids } = await walk(reader(rows).read);
    expect(ids).toEqual(rows.map((each) => each.id));
  });

  it('returns a lone oversized row with its blocks omitted, then continues', async () => {
    const rows = [
      row(0),
      row(1),
      {
        ...row(2),
        delegationAuthor: { kind: 'user' as const },
        delegationDelivery: 'steer' as const,
        blocks: [
          { type: 'text' as const, text: 'z'.repeat(2 * 1024 * 1024) },
          { type: 'text' as const, text: 'second' },
        ],
      },
    ];
    const first = await selectChildPageRows(reader(rows).read);
    expect(first.rows).toEqual([
      {
        id: 'agent:row-2',
        role: 'assistant',
        timestamp: 2,
        itemRevision: 0,
        final: true,
        blocks: [],
        blocksOmitted: { blockCount: 2 },
        parentBlockId: 'delegated-agent-delegate',
        delegationAuthor: { kind: 'user' },
        delegationDelivery: 'steer',
      },
    ]);
    expect(first.start).toBe(2);
    const second = await selectChildPageRows(reader(rows).read, first.start);
    expect(second.rows.map((kept) => kept.id)).toEqual([
      'agent:row-0',
      'agent:row-1',
    ]);
    expect(second.start).toBe(0);
  });

  it('stops before an oversized older row instead of skipping it', async () => {
    const rows = [
      row(0),
      {
        ...row(1),
        blocks: [{ type: 'text' as const, text: 'q'.repeat(900_000) }],
      },
      row(2),
    ];
    const first = await selectChildPageRows(reader(rows).read);
    expect(first.rows.map((kept) => kept.id)).toEqual(['agent:row-2']);
    const second = await selectChildPageRows(reader(rows).read, first.start);
    expect(second.rows).toEqual([
      expect.objectContaining({
        id: 'agent:row-1',
        blocks: [],
        blocksOmitted: { blockCount: 1 },
      }),
    ]);
    const third = await selectChildPageRows(reader(rows).read, second.start);
    expect(third.rows.map((kept) => kept.id)).toEqual(['agent:row-0']);
  });

  it('drops oversized extras from the omitted-blocks envelope', async () => {
    const heavy = {
      ...row(0),
      claudeUuid: 'u'.repeat(900_000),
    };
    const page = await selectChildPageRows(reader([heavy]).read);
    expect(page.rows[0]).not.toHaveProperty('claudeUuid');
    expect(page.rows[0]?.blocksOmitted).toEqual({ blockCount: 1 });
  });

  it('refuses a row whose identity alone exceeds the budget', async () => {
    await expect(
      selectChildPageRows(
        reader([{ ...row(0), id: 'i'.repeat(900_000) }]).read,
      ),
    ).rejects.toBeInstanceOf(ChildPageRowTooLargeError);
  });

  it('reads in small batches, never a whole page of rows at once', async () => {
    const big = 'w'.repeat(200 * 1024);
    const source = reader(Array.from({ length: 400 }, (_, i) => row(i, big)));
    await selectChildPageRows(source.read);
    expect(Math.max(...source.limits)).toBeLessThanOrEqual(16);
    expect(source.limits).toHaveLength(1);
  });
});

describe('child page byte budget through the backend', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canopy-child-page-budget-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('pages a large child stream within the budget and reaches every row', async () => {
    const { backend } = await format4Scope(
      root,
      scope.worktreeId,
      scopeSource([{ id: 'chat', messages: [parent()] }]),
    );
    await backend.registerTranscriptStream(target);
    const rows = Array.from({ length: 40 }, (_, i) =>
      row(i, `${i} `.padEnd(48 * 1024, 'b')),
    );
    await backend.commitChildStream(target, 'large-rows', rows);

    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await backend.page('chat', undefined, undefined, {
        ...scope,
        target,
        ...(cursor === undefined ? {} : { cursor }),
      });
      pages += 1;
      expect(
        Buffer.byteLength(JSON.stringify(page.messages), 'utf8'),
      ).toBeLessThanOrEqual(CHILD_PAGE_ROW_BYTES);
      expect(page.totalMessages).toBe(40);
      ids.unshift(...page.messages.map((message) => message.id));
      cursor = page.cursor;
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThan(2);
    expect(ids).toEqual(rows.map((each) => each.id));
  });
});

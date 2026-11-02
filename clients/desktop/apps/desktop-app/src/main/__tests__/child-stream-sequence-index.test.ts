import { readChildStreamCompatibilityPage } from '../lib/chat-delta-journal/child-overlay';
import {
  buildChildStreamSequenceIndex,
  childStreamSequencePage,
  findChildStreamSequenceEntry,
} from '../lib/child-stream-sequence-index';
import type { DelegationChildRow } from '@canopy/agent-transcript';

function row(id: string, delegationSequence: number): DelegationChildRow {
  return {
    id,
    role: 'assistant',
    timestamp: 1,
    parentBlockId: 'block',
    delegationSequence,
    itemRevision: 0,
    final: true,
    blocks: [{ type: 'text', text: id }],
  };
}

it('pages by display sequence even when committed offsets are finalized in another order', () => {
  const index = buildChildStreamSequenceIndex([
    { row: row('late', 9), offset: 0, end: 20 },
    { row: row('early-b', 2), offset: 20, end: 40 },
    { row: row('early-a', 1), offset: 40, end: 60 },
  ]);
  expect(index.map((entry) => entry.id)).toEqual([
    'early-a',
    'early-b',
    'late',
  ]);
  expect(childStreamSequencePage(index, 3, 2)).toMatchObject({
    entries: [index[1], index[2]],
    before: 1,
  });
  expect(findChildStreamSequenceEntry(index, 'early-a')?.offset).toBe(40);
  expect(() =>
    buildChildStreamSequenceIndex([
      { row: row('same', 1), offset: 0, end: 1 },
      { row: row('same', 2), offset: 1, end: 2 },
    ]),
  ).toThrow();
});

it('rejects duplicate sequences at the compatibility read boundary, not as a storage invariant', async () => {
  const entries = buildChildStreamSequenceIndex([
    { row: row('first', 7), offset: 0, end: 10 },
    { row: row('second', 7), offset: 10, end: 20 },
  ]);
  const read = jest.fn(() => Promise.reject(new Error('must not read')));
  await expect(
    readChildStreamCompatibilityPage(
      entries,
      [],
      [],
      read,
      (value) => value.id,
      {
        limit: 2,
        physicalByteBudget: 1024,
        encodedBudget: 1024,
      },
    ),
  ).rejects.toThrow('Duplicate sequence');
  expect(read).not.toHaveBeenCalled();
});

it('selects one gapped newest suffix from index lengths before reading bodies or block references', async () => {
  const size = 5 * 1024 * 1024;
  const entries = [
    { id: 'old', delegationSequence: 7, offset: 0, end: size },
    { id: 'newest', delegationSequence: 11, offset: size, end: 2 * size },
  ];
  const read = jest.fn((entry: { id: string; delegationSequence: number }) => {
    if (entry.id !== 'newest')
      throw new Error('excluded body or blocksRef read');
    return Promise.resolve(row(entry.id, entry.delegationSequence));
  });
  const page = await readChildStreamCompatibilityPage(
    entries,
    [],
    [],
    read,
    (value) => value.id,
    {
      beforeSequence: 12,
      limit: 200,
      physicalByteBudget: 8 * 1024 * 1024,
      encodedBudget: 1024,
    },
  );
  expect(page).toMatchObject({
    items: ['newest'],
    hasMore: true,
    physicalBytes: size,
    activeBytes: 0,
    pendingBytes: 0,
  });
  expect(read).toHaveBeenCalledTimes(1);
  read.mockClear();
  await expect(
    readChildStreamCompatibilityPage(
      entries,
      [],
      [],
      read,
      (value) => value.id,
      {
        beforeSequence: 12,
        limit: 200,
        physicalByteBudget: size - 1,
        encodedBudget: 1024,
      },
    ),
  ).rejects.toThrow('Newest child row exceeds physical read budget');
  expect(read).not.toHaveBeenCalled();
});

it('counts active and journal-pending payloads separately from committed page bytes', async () => {
  const active = row('active', 8);
  const pending = row('pending', 9);
  const read = jest.fn(() =>
    Promise.reject(new Error('unexpected committed read')),
  );
  const page = await readChildStreamCompatibilityPage(
    [],
    [active],
    [pending],
    read,
    (value) => value.id,
    {
      limit: 2,
      physicalByteBudget: 8 * 1024 * 1024,
      encodedBudget: 1024,
    },
  );
  expect(page).toMatchObject({
    items: ['active', 'pending'],
    physicalBytes: 0,
    activeBytes: Buffer.byteLength(JSON.stringify(active)),
    pendingBytes: Buffer.byteLength(JSON.stringify(pending)),
  });
  expect(read).not.toHaveBeenCalled();
});

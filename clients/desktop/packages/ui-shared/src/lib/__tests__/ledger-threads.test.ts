import type { LedgerEntrySearchItem } from '@canopy/protocol/canopy-core';
import { groupLedgerThreads } from '../ledger-threads';

const CHAT = {
  actorId: '00000000-0000-4000-8000-0000000000a1',
  kind: 'chat',
  authorityId: 'authority-1',
} as const;

function entryId(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function at(second: number): string {
  return new Date(Date.UTC(2026, 9, 5, 17, 0, second)).toISOString();
}

function searchItem(
  id: number,
  createdAt: string,
  supersedesEntryId?: string,
): LedgerEntrySearchItem {
  return {
    entryId: entryId(id),
    revision: 1,
    type: 'TASK',
    title: `Entry ${String(id)}`,
    content: `Content for entry ${String(id)}`,
    highlights: [],
    referenceFiles: [],
    status: 'TODO',
    owner: CHAT,
    author: CHAT,
    attributionKind: 'self_reported',
    createdAt,
    updatedAt: createdAt,
    ...(supersedesEntryId === undefined ? {} : { supersedesEntryId }),
    sourceAvailability: 'available',
  };
}

describe('groupLedgerThreads', () => {
  it('nests loaded corrections, flattens chains, and preserves entries and target links', () => {
    const correctionOfCorrection = searchItem(3, at(30), entryId(2));
    const correction = searchItem(2, at(20), entryId(1));
    const root = searchItem(1, at(10));

    const threads = groupLedgerThreads([
      correctionOfCorrection,
      correction,
      root,
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.root).toBe(root);
    expect(threads[0]?.corrections).toEqual([
      correction,
      correctionOfCorrection,
    ]);
    expect(threads[0]?.corrections[0]).toBe(correction);
    expect(threads[0]?.corrections[1]).toBe(correctionOfCorrection);
    expect(correction.supersedesEntryId).toBe(entryId(1));
    expect(correctionOfCorrection.supersedesEntryId).toBe(entryId(2));
    expect(threads[0]?.orphan).toBe(false);
  });

  it('places threads by their first loaded member and sorts corrections oldest first', () => {
    const newestCorrection = searchItem(10, at(30), entryId(13));
    const middleCorrection = searchItem(11, at(20), entryId(13));
    const tiedCorrection = searchItem(12, at(20), entryId(13));
    const otherRoot = searchItem(20, at(19));
    const thirdRoot = searchItem(30, at(18));
    const root = searchItem(13, at(10));

    const threads = groupLedgerThreads([
      newestCorrection,
      otherRoot,
      middleCorrection,
      thirdRoot,
      tiedCorrection,
      root,
    ]);

    expect(threads.map((thread) => thread.root.entryId)).toEqual([
      entryId(13),
      entryId(20),
      entryId(30),
    ]);
    expect(threads[0]?.corrections).toEqual([
      tiedCorrection,
      middleCorrection,
      newestCorrection,
    ]);
    expect(threads[0]?.corrections[0]).toBe(tiedCorrection);
    expect(threads[0]?.corrections[1]).toBe(middleCorrection);
    expect(threads[0]?.corrections[2]).toBe(newestCorrection);
  });

  it('keeps a previously displayed thread in place when a newer correction arrives', () => {
    const correction = searchItem(81, at(30), entryId(80));
    const earlierThread = searchItem(82, at(20));
    const correctedRoot = searchItem(80, at(10));

    const threads = groupLedgerThreads(
      [correction, earlierThread, correctedRoot],
      [earlierThread.entryId, correctedRoot.entryId],
    );

    expect(threads.map((thread) => thread.root.entryId)).toEqual([
      earlierThread.entryId,
      correctedRoot.entryId,
    ]);
  });

  it('inserts a new root before previously placed threads when natural order puts it there', () => {
    const newestRoot = searchItem(83, at(30));
    const firstPlaced = searchItem(84, at(20));
    const secondPlaced = searchItem(85, at(10));

    const threads = groupLedgerThreads(
      [newestRoot, firstPlaced, secondPlaced],
      [firstPlaced.entryId, secondPlaced.entryId],
    );

    expect(threads.map((thread) => thread.root.entryId)).toEqual([
      newestRoot.entryId,
      firstPlaced.entryId,
      secondPlaced.entryId,
    ]);
  });

  it('puts a new entry first even when a new correction moved a shown thread', () => {
    const newest = searchItem(94, at(40));
    const correction = searchItem(95, at(30), entryId(97));
    const first = searchItem(96, at(20));
    const corrected = searchItem(97, at(15));
    const last = searchItem(98, at(10));

    const threads = groupLedgerThreads(
      [newest, correction, first, corrected, last],
      [first.entryId, corrected.entryId, last.entryId],
    );

    expect(threads.map((thread) => thread.root.entryId)).toEqual([
      newest.entryId,
      first.entryId,
      corrected.entryId,
      last.entryId,
    ]);
  });

  it('puts an older new thread after the nearest shown thread before it', () => {
    const correction = searchItem(99, at(40), entryId(101));
    const first = searchItem(100, at(30));
    const corrected = searchItem(101, at(25));
    const arrived = searchItem(102, at(20));
    const last = searchItem(103, at(10));

    const threads = groupLedgerThreads(
      [correction, first, corrected, arrived, last],
      [first.entryId, corrected.entryId, last.entryId],
    );

    // Naturally the corrected thread leads, then first, arrived and last:
    // arrived follows first, the shown thread naturally before it.
    expect(threads.map((thread) => thread.root.entryId)).toEqual([
      first.entryId,
      arrived.entryId,
      corrected.entryId,
      last.entryId,
    ]);
  });

  it("keeps an orphan's place when its target arrives", () => {
    const orphan = searchItem(86, at(30), entryId(87));
    const otherRoot = searchItem(88, at(20));
    const target = searchItem(87, at(10));

    const threads = groupLedgerThreads(
      [otherRoot, orphan, target],
      [orphan.entryId, otherRoot.entryId],
    );

    expect(threads.map((thread) => thread.root.entryId)).toEqual([
      target.entryId,
      otherRoot.entryId,
    ]);
    expect(threads[0]?.orphan).toBe(false);
  });

  it('ignores removed and unknown IDs in the previous order', () => {
    const newRoot = searchItem(89, at(30));
    const placedRoot = searchItem(90, at(20));
    const anotherRoot = searchItem(91, at(10));

    const threads = groupLedgerThreads(
      [newRoot, placedRoot, anotherRoot],
      [entryId(999), placedRoot.entryId, entryId(998)],
    );

    expect(threads.map((thread) => thread.root.entryId)).toEqual([
      newRoot.entryId,
      placedRoot.entryId,
      anotherRoot.entryId,
    ]);
  });

  it("uses today's natural order when no previous order is provided", () => {
    const newestRoot = searchItem(92, at(30));
    const oldestRoot = searchItem(93, at(10));

    const threads = groupLedgerThreads([newestRoot, oldestRoot]);

    expect(threads.map((thread) => thread.root.entryId)).toEqual([
      newestRoot.entryId,
      oldestRoot.entryId,
    ]);
  });

  it('keeps a correction with an unloaded target as an orphan thread', () => {
    const orphanCorrection = searchItem(40, at(20), entryId(41));
    const ordinaryRoot = searchItem(42, at(10));

    const threads = groupLedgerThreads([orphanCorrection, ordinaryRoot]);

    expect(threads.map((thread) => [thread.root, thread.orphan])).toEqual([
      [orphanCorrection, true],
      [ordinaryRoot, false],
    ]);
    expect(threads[0]?.corrections).toEqual([]);
  });

  it('keeps page-one order when a next page resolves an orphan', () => {
    const pageOneCorrection = searchItem(50, at(30), entryId(51));
    const pageOneRoot = searchItem(52, at(20));
    const pageTwoTarget = searchItem(51, at(10));
    const pageTwoRoot = searchItem(53, at(5));
    const pageOneThreads = groupLedgerThreads([pageOneCorrection, pageOneRoot]);

    const threads = groupLedgerThreads([
      pageOneCorrection,
      pageOneRoot,
      pageTwoTarget,
      pageTwoRoot,
    ]);

    expect(pageOneThreads.map((thread) => thread.root.entryId)).toEqual([
      entryId(50),
      entryId(52),
    ]);
    expect(threads.map((thread) => thread.root.entryId)).toEqual([
      entryId(51),
      entryId(52),
      entryId(53),
    ]);
    expect(threads[0]?.root).toBe(pageTwoTarget);
    expect(threads[0]?.corrections).toEqual([pageOneCorrection]);
    expect(threads[0]?.corrections[0]).toBe(pageOneCorrection);
    expect(threads[0]?.orphan).toBe(false);
  });

  it('ignores a self-reference and keeps the entry as a plain root', () => {
    const selfReference = searchItem(60, at(10), entryId(60));

    const threads = groupLedgerThreads([selfReference]);

    expect(threads).toEqual([
      { root: selfReference, corrections: [], orphan: false },
    ]);
  });

  it('groups a cycle once under its first list member without hanging', () => {
    const firstCycleMember = searchItem(62, at(20), entryId(61));
    const secondCycleMember = searchItem(61, at(10), entryId(62));
    const ordinaryRoot = searchItem(63, at(5));

    const threads = groupLedgerThreads([
      firstCycleMember,
      secondCycleMember,
      ordinaryRoot,
    ]);

    expect(threads.map((thread) => thread.root)).toEqual([
      firstCycleMember,
      ordinaryRoot,
    ]);
    expect(threads[0]?.corrections).toEqual([secondCycleMember]);
    expect(threads[0]?.orphan).toBe(false);
  });

  it('keeps only the first occurrence of a repeated entry ID', () => {
    const firstOccurrence = searchItem(70, at(20));
    const repeatedOccurrence = searchItem(70, at(10), entryId(999));
    const correction = searchItem(71, at(15), entryId(70));

    const threads = groupLedgerThreads([
      firstOccurrence,
      repeatedOccurrence,
      correction,
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.root).toBe(firstOccurrence);
    expect(threads[0]?.corrections).toEqual([correction]);
    expect(threads[0]?.corrections[0]).toBe(correction);
    expect(threads[0]?.orphan).toBe(false);
  });

  it('returns no threads for empty input', () => {
    expect(groupLedgerThreads([])).toEqual([]);
  });
});

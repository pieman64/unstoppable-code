import { AbandonedIds } from '../abandoned-ids';

function abandonedIds(...ids: number[]): AbandonedIds {
  const abandoned = new AbandonedIds();
  ids.forEach((id) => abandoned.add(id));
  return abandoned;
}

describe('AbandonedIds', () => {
  it('extends a range by an id adjacent to either end', () => {
    const abandoned = abandonedIds(5);
    abandoned.add(4);
    abandoned.add(6);
    expect(abandoned.rangeCount).toBe(1);
    expect([3, 4, 5, 6, 7].map((id) => abandoned.take(id))).toEqual([
      false,
      true,
      true,
      true,
      false,
    ]);
  });

  it('merges an id that joins ranges on both sides into one range', () => {
    const abandoned = abandonedIds(1, 3);
    expect(abandoned.rangeCount).toBe(2);
    abandoned.add(2);
    expect(abandoned.rangeCount).toBe(1);
    expect([1, 2, 3].map((id) => abandoned.take(id))).toEqual([
      true,
      true,
      true,
    ]);
    expect(abandoned.rangeCount).toBe(0);
  });

  it('splits a range when an interior id is taken', () => {
    const abandoned = abandonedIds(5, 1, 4, 2, 3);
    expect(abandoned.rangeCount).toBe(1);
    expect(abandoned.take(3)).toBe(true);
    expect(abandoned.rangeCount).toBe(2);
    expect([1, 2, 3, 4, 5].map((id) => abandoned.take(id))).toEqual([
      true,
      true,
      false,
      true,
      true,
    ]);
  });

  it('trims range ends, then drops the remaining singleton', () => {
    const abandoned = abandonedIds(7, 8, 9);
    expect(abandoned.take(7)).toBe(true);
    expect(abandoned.take(9)).toBe(true);
    expect(abandoned.rangeCount).toBe(1);
    expect(abandoned.take(8)).toBe(true);
    expect(abandoned.rangeCount).toBe(0);
  });

  it('answers each id at most once and never for ids it was not given', () => {
    const abandoned = abandonedIds(10, 10, 12);
    expect(abandoned.rangeCount).toBe(2);
    expect([0, 9, 11, 13].map((id) => abandoned.take(id))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(abandoned.take(10)).toBe(true);
    expect(abandoned.take(10)).toBe(false);
    expect(abandoned.rangeCount).toBe(1);
    expect(new AbandonedIds().take(1)).toBe(false);
  });

  it('matches an exact id set with minimal ranges under arbitrary order', () => {
    const model = new Set<number>();
    const abandoned = new AbandonedIds();
    const runs = (): number =>
      Array.from(model).filter((id) => !model.has(id - 1)).length;
    let seed = 7;
    const nextId = (): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return 1 + (seed % 64);
    };
    for (let step = 0; step < 2_000; step += 1) {
      const id = nextId();
      if (step % 2 === 1) {
        expect(abandoned.take(id)).toBe(model.delete(id));
      } else {
        abandoned.add(id);
        model.add(id);
      }
      expect(abandoned.rangeCount).toBe(runs());
    }
    for (let id = 0; id <= 65; id += 1)
      expect(abandoned.take(id)).toBe(model.has(id));
    expect(abandoned.rangeCount).toBe(0);
  });
});

import {
  exceedsSerializedBudget,
  measureSerializedBytes,
} from '../lib/serialized-size-budget';

describe('exceedsSerializedBudget', () => {
  it('agrees with JSON.stringify on ordinary values', () => {
    const value = {
      name: 'deploy',
      description: 'Ships the "thing" — with a dash\\ and a\nnewline',
      'key "with" quotes\t':
        'control \u0001 char, emoji 😀, lone \ud800 surrogate',
      count: 3,
      flags: [true, false, null],
      nested: { a: 1.5, b: 'x', skipped: undefined },
    };
    const exact = Buffer.byteLength(JSON.stringify(value), 'utf8');
    expect(exceedsSerializedBudget(value, exact)).toBe(false);
    expect(exceedsSerializedBudget(value, exact - 1)).toBe(true);
    expect(measureSerializedBytes(value, exact)).toEqual({
      bytes: exact,
      exceeded: false,
    });
    // A rejected value reports the work spent, about the budget, so a
    // caller can charge it against a scan-wide allowance.
    const rejected = measureSerializedBytes(value, 10);
    expect(rejected.exceeded).toBe(true);
    expect(rejected.bytes).toBeGreaterThan(10);
    expect(rejected.bytes).toBeLessThan(exact);
  });

  it('stops at the budget on alias-amplified values instead of expanding them', () => {
    // Each level references the same child twice: JSON.stringify would
    // expand this to 2^40 copies of the leaf.
    let node: unknown = { leaf: 'x'.repeat(64) };
    for (let level = 0; level < 40; level += 1) {
      node = { left: node, right: node };
    }
    const started = Date.now();
    expect(exceedsSerializedBudget(node, 16 * 1024)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('treats a cycle or excessive nesting as over budget', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(exceedsSerializedBudget(cyclic, 1_000_000)).toBe(true);
    let deep: unknown = 'leaf';
    for (let level = 0; level < 80; level += 1) deep = [deep];
    expect(exceedsSerializedBudget(deep, 1_000_000)).toBe(true);
  });
});

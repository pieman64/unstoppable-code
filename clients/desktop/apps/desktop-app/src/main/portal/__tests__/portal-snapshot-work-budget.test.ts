import { createPortalSnapshotWorkBudget } from '../portal-snapshot-work-budget';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

describe('snapshot work budget', () => {
  it('yields between warming jobs when foreground arrives and resumes afterward', async () => {
    const budget = createPortalSnapshotWorkBudget();
    const gate = deferred();
    const calls: string[] = [];
    const first = budget.warm(async () => {
      calls.push('first');
      await gate.promise;
    });
    const second = budget.warm(() => {
      calls.push('second');
      return Promise.resolve();
    });
    await tick();
    budget.setForegroundBusy(true);
    gate.resolve();
    await first;
    await tick();
    expect(calls).toEqual(['first']);
    await budget.expensive(() => {
      calls.push('foreground');
      return Promise.resolve();
    });
    expect(calls).toEqual(['first', 'foreground']);
    budget.setForegroundBusy(false);
    await second;
    expect(calls).toEqual(['first', 'foreground', 'second']);
  });

  it('caps independent sections process-wide and releases capacity on failure', async () => {
    const budget = createPortalSnapshotWorkBudget();
    const gate = deferred();
    let active = 0;
    let maximum = 0;
    const tasks = Array.from({ length: 12 }, (_, index) =>
      budget.section(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await gate.promise;
        active -= 1;
        if (index === 0) throw new Error('read failed');
      }),
    );
    const results = Promise.allSettled(tasks);
    await tick();
    expect(active).toBe(4);
    gate.resolve();
    expect(
      (await results).filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(maximum).toBe(4);
  });
});

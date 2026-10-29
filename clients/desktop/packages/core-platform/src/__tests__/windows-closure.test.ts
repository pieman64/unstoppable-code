import {
  createWindowsClosureWitness,
  observeWindowsClosure,
} from '../supervision/windows-closure';

it('is inert outside a qualification run', () => {
  expect(observeWindowsClosure('git')).toBeUndefined();
});
it('accepts only a complete current, original report, not missing/copied/stale evidence', async () => {
  const witness = createWindowsClosureWitness();
  expect(witness.accepts(undefined)).toBe(false);
  await witness.run(() => {
    observeWindowsClosure('git')?.close();
  });
  const report = witness.finalize();
  expect(witness.accepts(report)).toBe(true);
  expect(witness.accepts({ ...report })).toBe(false);
  const other = createWindowsClosureWitness();
  await other.run(() => {
    observeWindowsClosure('git')?.close();
  });
  expect(other.accepts(report)).toBe(false);
  expect(other.accepts(other.finalize())).toBe(true);
});
it.each(['git-host', 'git', 'identity', 'acl'] as const)(
  'does not forget an unsafe %s edge after successful edges',
  async (family) => {
    const witness = createWindowsClosureWitness();
    await witness.run(() => {
      const edge = observeWindowsClosure(family);
      edge?.unsafe();
      edge?.close();
      observeWindowsClosure(family)?.close();
    });
    expect(witness.accepts(witness.finalize())).toBe(false);
  },
);
it('freezes missing closure before emergency teardown', async () => {
  const witness = createWindowsClosureWitness();
  let end = (): void => {};
  await witness.run(() => {
    const edge = observeWindowsClosure('git');
    end = (): void => {
      edge?.close();
    };
  });
  const report = witness.finalize();
  expect(report.pending).toBe(1);
  end();
  expect(witness.accepts(report)).toBe(false);
});
it('rejects duplicate closure and duplicate finalization', async () => {
  const duplicate = createWindowsClosureWitness();
  await duplicate.run(() => {
    const edge = observeWindowsClosure('git');
    edge?.close();
    edge?.close();
  });
  expect(duplicate.accepts(duplicate.finalize())).toBe(false);
  const witness = createWindowsClosureWitness();
  await witness.run(() => {
    observeWindowsClosure('git')?.close();
  });
  const report = witness.finalize();
  expect(witness.accepts(report)).toBe(true);
  witness.finalize();
  expect(witness.accepts(report)).toBe(false);
});
it('fails empty, early, and exhausted evidence instead of truncating to success', async () => {
  const empty = createWindowsClosureWitness();
  await empty.run(() => {});
  expect(empty.accepts(empty.finalize())).toBe(false);
  const early = createWindowsClosureWitness();
  const report = early.finalize();
  await expect(early.run(() => {})).rejects.toThrow();
  expect(early.accepts(report)).toBe(false);
  const exhausted = createWindowsClosureWitness();
  await exhausted.run(() => {
    for (let n = 0; n < 4097; n++) observeWindowsClosure('git')?.close();
  });
  expect(exhausted.accepts(exhausted.finalize())).toBe(false);
});
it('invalidates late creation even if an earlier report was eligible', async () => {
  const witness = createWindowsClosureWitness();
  let late: Promise<void> = Promise.resolve();
  let release = (): void => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await witness.run(() => {
    observeWindowsClosure('git')?.close();
    late = barrier.then(() => {
      observeWindowsClosure('git')?.close();
    });
  });
  const report = witness.finalize();
  expect(witness.accepts(report)).toBe(true);
  release();
  await late;
  expect(witness.accepts(report)).toBe(false);
});
it('isolates overlapping runs and retains late unsafe outcomes', async () => {
  const good = createWindowsClosureWitness();
  const bad = createWindowsClosureWitness();
  let invalidate = (): void => {};
  let release = (): void => {};
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  await Promise.all([
    good.run(async () => {
      const edge = observeWindowsClosure('git');
      invalidate = (): void => {
        edge?.unsafe();
      };
      await barrier;
      edge?.close();
    }),
    bad.run(() => {
      const edge = observeWindowsClosure('acl');
      edge?.unsafe();
      edge?.close();
      release();
    }),
  ]);
  const report = good.finalize();
  expect(report).toMatchObject({ started: 1, pending: 0, unsafe: false });
  expect(good.accepts(report)).toBe(true);
  expect(bad.accepts(bad.finalize())).toBe(false);
  invalidate();
  expect(good.accepts(report)).toBe(false);
});

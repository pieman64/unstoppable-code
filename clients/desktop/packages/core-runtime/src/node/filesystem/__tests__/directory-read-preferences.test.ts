import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import type * as filesystem from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as paths from 'node:path';
import { createDefaultFileIndexingPreferences } from '@canopy/protocol/file-indexing';
import {
  createDirectoryReadPreferenceSource,
  type DirectoryReadPreferences,
  type DirectoryReadPreferenceSnapshot,
} from '../../index';
import { expectNoWrites, instrumentForbiddenWrites } from './no-write-proof';

const ROOT = paths.resolve('/canonical/data');
const PRIMARY = paths.join(ROOT, 'preferences.json');
const LAST_GOOD = paths.join(ROOT, 'preferences.last-good.json');

const DEFAULTS: DirectoryReadPreferences = {
  fileIndexing: { disabledBuiltinGlobIds: [], customGlobs: [] },
  gitExecutablePath: '',
};

type Subset = 'overrides' | 'alternate' | 'malformed' | 'empty';

const SUBSETS: Record<
  Subset,
  { raw: Record<string, unknown>; expected: DirectoryReadPreferences }
> = {
  overrides: {
    raw: {
      fileIndexing: {
        disabledBuiltinGlobIds: ['node-modules', 'bogus', 'node-modules'],
        customGlobs: [
          { id: ' keep ', pattern: '  dist/**  ', enabled: false },
          { pattern: 'dist/**' },
          5,
        ],
      },
      gitExecutablePath: '  /opt/git/bin/git  ',
      unrelated: { ignored: true },
    },
    expected: {
      fileIndexing: {
        disabledBuiltinGlobIds: ['node-modules'],
        customGlobs: [{ id: 'keep', pattern: 'dist/**', enabled: false }],
      },
      gitExecutablePath: '  /opt/git/bin/git  ',
    },
  },
  alternate: {
    raw: {
      fileIndexing: { disabledBuiltinGlobIds: ['gradle'], customGlobs: [] },
      gitExecutablePath: '/usr/local/bin/git',
    },
    expected: {
      fileIndexing: { disabledBuiltinGlobIds: ['gradle'], customGlobs: [] },
      gitExecutablePath: '/usr/local/bin/git',
    },
  },
  malformed: {
    raw: { fileIndexing: ['node-modules'], gitExecutablePath: 42 },
    expected: DEFAULTS,
  },
  empty: { raw: {}, expected: DEFAULTS },
};

type FileState =
  | { kind: 'valid'; subset: Subset }
  | { kind: 'missing' }
  | { kind: 'unreadable' }
  | { kind: 'raw'; label: string; content: string };

const SUBSET_NAMES = Object.keys(SUBSETS) as Subset[];

// Envelope validity is independent of the subset it carries: every unusable
// envelope wraps every subset, so a usable-looking subset never rescues it.
const UNUSABLE_ENVELOPES: Record<string, (subset: Subset) => string> = {
  'version 2': (subset) => envelope(SUBSETS[subset].raw, 2),
  'string version': (subset) => envelope(SUBSETS[subset].raw, '1'),
  'missing version': (subset) =>
    JSON.stringify({ preferences: SUBSETS[subset].raw }),
  'top-level subset': (subset) =>
    JSON.stringify({ version: 1, ...SUBSETS[subset].raw }),
  'array document': (subset) => `[${envelope(SUBSETS[subset].raw)}]`,
};

const UNUSABLE_STATES: FileState[] = [
  { kind: 'missing' },
  { kind: 'unreadable' },
  { kind: 'raw', label: 'corrupt JSON', content: '{"version":1,' },
  { kind: 'raw', label: 'empty file', content: '' },
  ...Object.entries(UNUSABLE_ENVELOPES).flatMap(([label, wrap]) =>
    SUBSET_NAMES.map(
      (subset): FileState => ({
        kind: 'raw',
        label: `${label}/${subset}`,
        content: wrap(subset),
      }),
    ),
  ),
  { kind: 'raw', label: 'null document', content: 'null' },
  {
    kind: 'raw',
    label: 'array preferences',
    content: '{"version":1,"preferences":[]}',
  },
  {
    kind: 'raw',
    label: 'null preferences',
    content: '{"version":1,"preferences":null}',
  },
  { kind: 'raw', label: 'missing preferences', content: '{"version":1}' },
];

const VALID_STATES: FileState[] = SUBSET_NAMES.map((subset) => ({
  kind: 'valid',
  subset,
}));
const ALL_STATES = [...VALID_STATES, ...UNUSABLE_STATES];

function envelope(preferences: unknown, version: unknown = 1): string {
  return JSON.stringify({ version, preferences }, null, 2);
}

function describeState(state: FileState): string {
  switch (state.kind) {
    case 'valid':
      return `valid/${state.subset}`;
    case 'raw':
      return state.label;
    default:
      return state.kind;
  }
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}

function memoryReader(files: Map<string, FileState>): {
  reads: string[];
  readFile: (absolutePath: string, signal: AbortSignal) => Promise<string>;
} {
  const reads: string[] = [];
  return {
    reads,
    readFile: async (absolutePath): Promise<string> => {
      reads.push(absolutePath);
      await Promise.resolve();
      const state = files.get(absolutePath) ?? { kind: 'missing' };
      switch (state.kind) {
        case 'valid':
          return envelope(SUBSETS[state.subset].raw);
        case 'raw':
          return state.content;
        case 'missing':
          throw errorWithCode('ENOENT');
        case 'unreadable':
          throw errorWithCode('EACCES');
      }
    },
  };
}

function expectedSnapshot(
  primary: FileState,
  lastGood: FileState,
): DirectoryReadPreferenceSnapshot {
  if (primary.kind === 'valid') {
    return { source: 'primary', preferences: SUBSETS[primary.subset].expected };
  }
  if (lastGood.kind === 'valid') {
    return {
      source: 'last-good',
      preferences: SUBSETS[lastGood.subset].expected,
    };
  }
  return { source: 'defaults', preferences: DEFAULTS };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('createDirectoryReadPreferenceSource selection', () => {
  const cases = ALL_STATES.flatMap((primary) =>
    ALL_STATES.map((lastGood) => ({
      name: `${describeState(primary)} primary, ${describeState(lastGood)} last-good`,
      primary,
      lastGood,
    })),
  );

  it.each(cases)('$name', async ({ primary, lastGood }) => {
    const reader = memoryReader(
      new Map([
        [PRIMARY, primary],
        [LAST_GOOD, lastGood],
      ]),
    );
    const source = createDirectoryReadPreferenceSource({
      canonicalDataRoot: ROOT,
      paths,
      readFile: reader.readFile,
    });

    await expect(source.read(signal())).resolves.toEqual(
      expectedSnapshot(primary, lastGood),
    );
    expect(reader.reads).toEqual(
      primary.kind === 'valid' ? [PRIMARY] : [PRIMARY, LAST_GOOD],
    );
  });

  it.each<[string, Record<string, unknown>, DirectoryReadPreferences]>([
    [
      'only fileIndexing',
      { fileIndexing: SUBSETS.overrides.raw.fileIndexing },
      { ...DEFAULTS, fileIndexing: SUBSETS.overrides.expected.fileIndexing },
    ],
    [
      'only gitExecutablePath',
      { gitExecutablePath: '/primary/git' },
      { ...DEFAULTS, gitExecutablePath: '/primary/git' },
    ],
    [
      'an explicit empty Git string',
      { fileIndexing: {}, gitExecutablePath: '' },
      DEFAULTS,
    ],
    ['null fields', { fileIndexing: null, gitExecutablePath: null }, DEFAULTS],
    [
      'wrong-typed fileIndexing members',
      {
        fileIndexing: { disabledBuiltinGlobIds: 'gradle', customGlobs: {} },
        gitExecutablePath: ['/usr/local/bin/git'],
      },
      DEFAULTS,
    ],
    [
      'only unknown built-in ids',
      { fileIndexing: { disabledBuiltinGlobIds: ['Gradle', ' gradle'] } },
      DEFAULTS,
    ],
  ])(
    'never borrows last-good fields for a primary with %s',
    async (_name, preferences, expected) => {
      const reader = memoryReader(
        new Map<string, FileState>([
          [
            PRIMARY,
            { kind: 'raw', label: 'partial', content: envelope(preferences) },
          ],
          [LAST_GOOD, { kind: 'valid', subset: 'alternate' }],
        ]),
      );
      const snapshot = await createDirectoryReadPreferenceSource({
        canonicalDataRoot: ROOT,
        paths,
        readFile: reader.readFile,
      }).read(signal());

      expect(snapshot).toEqual({ source: 'primary', preferences: expected });
      expect(reader.reads).toEqual([PRIMARY]);
    },
  );

  it('returns fresh defaults that callers cannot mutate into later reads', async () => {
    const source = createDirectoryReadPreferenceSource({
      canonicalDataRoot: ROOT,
      paths,
      readFile: memoryReader(new Map()).readFile,
    });
    const first = await source.read(signal());
    first.preferences.fileIndexing.disabledBuiltinGlobIds.push('gradle');
    const second = await source.read(signal());

    expect(second).toEqual({ source: 'defaults', preferences: DEFAULTS });
    expect(second.preferences.fileIndexing).not.toBe(
      first.preferences.fileIndexing,
    );
    expect(createDefaultFileIndexingPreferences()).toEqual(
      DEFAULTS.fileIndexing,
    );
  });

  it.each(['', 'relative/data', './data'])(
    'rejects a non-absolute canonical data root %p before reading',
    (canonicalDataRoot) => {
      const read = jest.fn<Promise<string>, [string, AbortSignal]>();
      expect(() =>
        createDirectoryReadPreferenceSource({
          canonicalDataRoot,
          paths,
          readFile: read,
        }),
      ).toThrow(TypeError);
      expect(read).not.toHaveBeenCalled();
    },
  );

  it('reads only the two named files beneath the injected path join', async () => {
    const join = jest.fn((...parts: string[]) => parts.join('|'));
    const reader = memoryReader(new Map());
    await createDirectoryReadPreferenceSource({
      canonicalDataRoot: 'trusted-root',
      paths: { join, isAbsolute: () => true },
      readFile: reader.readFile,
    }).read(signal());

    expect(reader.reads).toEqual([
      'trusted-root|preferences.json',
      'trusted-root|preferences.last-good.json',
    ]);
  });
});

describe('createDirectoryReadPreferenceSource cancellation', () => {
  function source(
    readFile: (absolutePath: string, signal: AbortSignal) => Promise<string>,
  ): ReturnType<typeof createDirectoryReadPreferenceSource> {
    return createDirectoryReadPreferenceSource({
      canonicalDataRoot: ROOT,
      paths,
      readFile,
    });
  }

  it('rejects an already aborted signal without reading', async () => {
    const controller = new AbortController();
    const reason = new Error('cancelled');
    controller.abort(reason);
    const read = jest.fn<Promise<string>, [string, AbortSignal]>();

    await expect(source(read).read(controller.signal)).rejects.toBe(reason);
    expect(read).not.toHaveBeenCalled();
  });

  it('passes the caller signal to each injected read', async () => {
    const controller = new AbortController();
    const reader = jest.fn((_path: string, readSignal: AbortSignal) => {
      expect(readSignal).toBe(controller.signal);
      return Promise.reject(errorWithCode('ENOENT'));
    });
    await source(reader).read(controller.signal);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it.each<[string, () => Promise<string>]>([
    [
      'a missing primary',
      (): Promise<string> => Promise.reject(errorWithCode('ENOENT')),
    ],
    [
      'an unreadable primary',
      (): Promise<string> => Promise.reject(errorWithCode('EACCES')),
    ],
    ['a corrupt primary', (): Promise<string> => Promise.resolve('{')],
    [
      'a valid primary',
      (): Promise<string> => Promise.resolve(envelope(SUBSETS.overrides.raw)),
    ],
  ])(
    'aborting during %s rejects without fallback or defaults',
    async (_name, settle) => {
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const reads: string[] = [];
      const read = source((absolutePath) => {
        reads.push(absolutePath);
        controller.abort(reason);
        return settle();
      });

      await expect(read.read(controller.signal)).rejects.toBe(reason);
      expect(reads).toEqual([PRIMARY]);
    },
  );

  it.each<[string, () => Promise<string>]>([
    ['missing', (): Promise<string> => Promise.reject(errorWithCode('ENOENT'))],
    [
      'valid',
      (): Promise<string> => Promise.resolve(envelope(SUBSETS.alternate.raw)),
    ],
  ])(
    'aborting during a %s last-good read rejects instead of selecting',
    async (_name, settle) => {
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const read = source((absolutePath) => {
        if (absolutePath === PRIMARY) {
          return Promise.reject(errorWithCode('ENOENT'));
        }
        controller.abort(reason);
        return settle();
      });

      await expect(read.read(controller.signal)).rejects.toBe(reason);
    },
  );

  const missing = (): Promise<string> =>
    Promise.reject(errorWithCode('ENOENT'));
  const unreadable = (): Promise<string> =>
    Promise.reject(errorWithCode('EACCES'));
  const corrupt = (): Promise<string> => Promise.resolve('{');
  const validPrimary = (): Promise<string> =>
    Promise.resolve(envelope(SUBSETS.overrides.raw));
  const validLastGood = (): Promise<string> =>
    Promise.resolve(envelope(SUBSETS.alternate.raw));

  it.each<{
    name: string;
    primary: () => Promise<string>;
    lastGood: () => Promise<string>;
    abortAfter: string;
  }>([
    {
      name: 'a valid primary instead of selecting it',
      primary: validPrimary,
      lastGood: validLastGood,
      abortAfter: PRIMARY,
    },
    {
      name: 'a missing primary instead of falling back',
      primary: missing,
      lastGood: validLastGood,
      abortAfter: PRIMARY,
    },
    {
      name: 'a corrupt primary instead of falling back',
      primary: corrupt,
      lastGood: validLastGood,
      abortAfter: PRIMARY,
    },
    {
      name: 'a valid last-good instead of selecting it',
      primary: missing,
      lastGood: validLastGood,
      abortAfter: LAST_GOOD,
    },
    {
      name: 'a missing last-good instead of selecting defaults',
      primary: missing,
      lastGood: missing,
      abortAfter: LAST_GOOD,
    },
    {
      name: 'an unreadable last-good instead of selecting defaults',
      primary: unreadable,
      lastGood: unreadable,
      abortAfter: LAST_GOOD,
    },
    {
      name: 'a corrupt last-good instead of selecting defaults',
      primary: corrupt,
      lastGood: corrupt,
      abortAfter: LAST_GOOD,
    },
  ])(
    'rejects when the abort lands as $name settles',
    async ({ primary, lastGood, abortAfter }) => {
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const reads: string[] = [];
      const read = source((absolutePath) => {
        reads.push(absolutePath);
        const pending = absolutePath === PRIMARY ? primary() : lastGood();
        if (absolutePath === abortAfter) {
          // Registered after the source awaits `pending`, so the abort runs
          // after the source's post-read check and before `read` resumes.
          queueMicrotask(() => {
            const abort = (): void => controller.abort(reason);
            void pending.then(abort, abort);
          });
        }
        return pending;
      });

      await expect(read.read(controller.signal)).rejects.toBe(reason);
      expect(reads).toEqual(
        abortAfter === PRIMARY ? [PRIMARY] : [PRIMARY, LAST_GOOD],
      );
    },
  );

  type CountedOutcome =
    | { kind: 'resolved'; snapshot: DirectoryReadPreferenceSnapshot }
    | { kind: 'rejected'; error: unknown };

  // Far above any sweep case's settlement step; reaching it means the read
  // waits on a timer or I/O, which the chain would otherwise starve forever
  // (including Jest's own timeout).
  const MICROTASK_STEP_BUDGET = 10_000;

  /**
   * Runs `read` beside a self-requeueing microtask chain and optionally
   * aborts on chain step `abortAtStep`. `observedAtStep` is the step count
   * when `read`'s settlement reaction ran; FIFO microtask order means steps
   * below `observedAtStep - 1` ran before `read` settled. Rejects with a
   * diagnostic, and aborts the read, if `read` has not settled within
   * `MICROTASK_STEP_BUDGET` steps.
   */
  async function readCountingMicrotasks(
    readers: {
      primary: () => Promise<string>;
      lastGood: () => Promise<string>;
    },
    abortAtStep: number | null,
  ): Promise<{
    outcome: CountedOutcome;
    observedAtStep: number;
    signal: AbortSignal;
    readsAfterAbort: string[];
  }> {
    const controller = new AbortController();
    const readsAfterAbort: string[] = [];
    let step = 0;
    let settled = false;
    let exhaustBudget: (diagnostic: Error) => void = () => {};
    const budgetExhausted = new Promise<never>((_, reject) => {
      exhaustBudget = reject;
    });
    const tick = (): void => {
      if (settled) {
        return;
      }
      if (step >= MICROTASK_STEP_BUDGET) {
        const diagnostic = new Error(
          `readCountingMicrotasks: read did not settle within ${MICROTASK_STEP_BUDGET} microtask steps; ` +
            'it is waiting on a timer, I/O or a promise that never settles, which this sweep cannot step through',
        );
        controller.abort(diagnostic);
        exhaustBudget(diagnostic);
        return;
      }
      if (step === abortAtStep) {
        controller.abort(new Error(`aborted at step ${step}`));
      }
      step += 1;
      queueMicrotask(tick);
    };
    queueMicrotask(tick);
    let observedAtStep = -1;
    const observe = (outcome: CountedOutcome): CountedOutcome => {
      observedAtStep = step;
      settled = true;
      return outcome;
    };
    const counted = source((absolutePath, readSignal) => {
      if (readSignal.aborted) {
        readsAfterAbort.push(absolutePath);
      }
      return absolutePath === PRIMARY ? readers.primary() : readers.lastGood();
    })
      .read(controller.signal)
      .then(
        (snapshot) => observe({ kind: 'resolved', snapshot }),
        (error: unknown) => observe({ kind: 'rejected', error }),
      );
    const outcome = await Promise.race([counted, budgetExhausted]);
    return {
      outcome,
      observedAtStep,
      signal: controller.signal,
      readsAfterAbort,
    };
  }

  const slowMissing = async (): Promise<string> => {
    await Promise.resolve();
    await Promise.resolve();
    throw errorWithCode('ENOENT');
  };

  it.each<{
    name: string;
    primary: () => Promise<string>;
    lastGood: () => Promise<string>;
    source: DirectoryReadPreferenceSnapshot['source'];
  }>([
    {
      name: 'valid primary',
      primary: validPrimary,
      lastGood: validLastGood,
      source: 'primary',
    },
    {
      name: 'missing primary, valid last-good',
      primary: missing,
      lastGood: validLastGood,
      source: 'last-good',
    },
    {
      name: 'corrupt primary, valid last-good',
      primary: corrupt,
      lastGood: validLastGood,
      source: 'last-good',
    },
    {
      name: 'missing primary and last-good',
      primary: missing,
      lastGood: missing,
      source: 'defaults',
    },
    {
      name: 'unreadable primary and last-good',
      primary: unreadable,
      lastGood: unreadable,
      source: 'defaults',
    },
    {
      name: 'corrupt primary and last-good',
      primary: corrupt,
      lastGood: corrupt,
      source: 'defaults',
    },
    {
      name: 'slow missing primary and last-good',
      primary: slowMissing,
      lastGood: slowMissing,
      source: 'defaults',
    },
  ])(
    'never settles a snapshot after an abort at any microtask step: $name',
    async ({ primary, lastGood, source: expectedSource }) => {
      const readers = { primary, lastGood };
      const baseline = await readCountingMicrotasks(readers, null);
      expect(baseline.outcome).toMatchObject({
        kind: 'resolved',
        snapshot: { source: expectedSource },
      });
      const lastStepBeforeSettlement = baseline.observedAtStep - 2;
      expect(lastStepBeforeSettlement).toBeGreaterThanOrEqual(0);

      for (let step = 0; step <= lastStepBeforeSettlement; step += 1) {
        const run = await readCountingMicrotasks(readers, step);
        const reason: unknown = run.signal.reason;
        expect({ step, outcome: run.outcome }).toEqual({
          step,
          outcome: { kind: 'rejected', error: reason },
        });
        expect(run.readsAfterAbort).toEqual([]);
      }

      // The first step after settlement: proves the sweep reached `read`'s
      // settlement rather than stopping short of it.
      const late = await readCountingMicrotasks(
        readers,
        lastStepBeforeSettlement + 1,
      );
      expect(late.outcome).toEqual(baseline.outcome);
      expect(late.signal.aborted).toBe(true);
    },
  );

  it.each<{ name: string; primary: () => Promise<string> }>([
    {
      name: 'waits on a timer',
      primary: (): Promise<string> =>
        new Promise<string>((_, reject) => {
          setTimeout(() => reject(errorWithCode('ENOENT')), 0);
        }),
    },
    {
      name: 'never settles',
      primary: (): Promise<string> => new Promise<string>(() => {}),
    },
  ])(
    'readCountingMicrotasks fails with a diagnostic when the reader $name',
    async ({ primary }) => {
      // An unbounded chain starves timers, so Jest's timeout cannot catch a
      // lost budget; this caps the chain and fails explicitly instead. The
      // cap is a literal so that mutating the budget cannot also lift it.
      const unboundedChainCap = 100_000;
      expect(MICROTASK_STEP_BUDGET).toBeLessThan(unboundedChainCap);
      const enqueue = queueMicrotask;
      let enqueued = 0;
      let failUnbounded: (error: Error) => void = () => {};
      const unbounded = new Promise<never>((_, reject) => {
        failUnbounded = reject;
      });
      const guard = jest
        .spyOn(globalThis, 'queueMicrotask')
        .mockImplementation((callback) => {
          enqueued += 1;
          if (enqueued > unboundedChainCap) {
            failUnbounded(
              new Error(
                'readCountingMicrotasks kept spinning past its budget without a diagnostic',
              ),
            );
            return;
          }
          enqueue(callback);
        });
      const reads: string[] = [];
      try {
        const pending = readCountingMicrotasks(
          {
            primary: () => {
              reads.push(PRIMARY);
              return primary();
            },
            lastGood: () => {
              reads.push(LAST_GOOD);
              return missing();
            },
          },
          null,
        );

        await expect(Promise.race([pending, unbounded])).rejects.toThrow(
          `read did not settle within ${MICROTASK_STEP_BUDGET} microtask steps`,
        );
      } finally {
        guard.mockRestore();
      }
      // Lets a starved timer read settle: the budget abort must stop fallback.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(reads).toEqual([PRIMARY]);
    },
  );

  it('propagates an AbortError from the reader instead of selecting defaults', async () => {
    const abortError = new DOMException('reader aborted', 'AbortError');
    const reads: string[] = [];
    const read = source((absolutePath) => {
      reads.push(absolutePath);
      return Promise.reject(abortError);
    });

    await expect(read.read(signal())).rejects.toBe(abortError);
    expect(reads).toEqual([PRIMARY]);
  });

  it('cancels the default disk reader through the caller signal', async () => {
    const root = await mkdtemp(paths.join(tmpdir(), 'canopy-dir-prefs-abort-'));
    try {
      await writeFile(
        paths.join(root, 'preferences.json'),
        envelope(SUBSETS.overrides.raw),
      );
      const controller = new AbortController();
      const reason = new Error('cancelled');
      const pending = createDirectoryReadPreferenceSource({
        canonicalDataRoot: root,
        paths,
      }).read(controller.signal);
      controller.abort(reason);

      await expect(pending).rejects.toBe(reason);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('createDirectoryReadPreferenceSource on disk', () => {
  let parent: string;
  let root: string;
  let primary: string;
  let lastGood: string;

  beforeEach(async () => {
    parent = await mkdtemp(paths.join(tmpdir(), 'canopy-dir-prefs-'));
    root = paths.join(parent, 'data');
    primary = paths.join(root, 'preferences.json');
    lastGood = paths.join(root, 'preferences.last-good.json');
    await mkdir(root);
  });

  afterEach(async () => {
    await rm(parent, { recursive: true, force: true });
  });

  function diskSource(): ReturnType<
    typeof createDirectoryReadPreferenceSource
  > {
    return createDirectoryReadPreferenceSource({
      canonicalDataRoot: root,
      paths,
    });
  }

  it('observes edits, removal and repair on every read', async () => {
    const source = diskSource();
    await writeFile(lastGood, envelope(SUBSETS.alternate.raw));
    await writeFile(primary, envelope(SUBSETS.overrides.raw));
    await expect(source.read(signal())).resolves.toEqual({
      source: 'primary',
      preferences: SUBSETS.overrides.expected,
    });

    await writeFile(primary, envelope({ gitExecutablePath: '/edited/git' }));
    await expect(source.read(signal())).resolves.toEqual({
      source: 'primary',
      preferences: { ...DEFAULTS, gitExecutablePath: '/edited/git' },
    });

    await rm(primary);
    await expect(source.read(signal())).resolves.toEqual({
      source: 'last-good',
      preferences: SUBSETS.alternate.expected,
    });

    await writeFile(primary, '{"version":1,"preferences":');
    await expect(source.read(signal())).resolves.toMatchObject({
      source: 'last-good',
    });

    await rm(lastGood);
    await expect(source.read(signal())).resolves.toEqual({
      source: 'defaults',
      preferences: DEFAULTS,
    });

    await writeFile(primary, envelope(SUBSETS.overrides.raw));
    await expect(source.read(signal())).resolves.toEqual({
      source: 'primary',
      preferences: SUBSETS.overrides.expected,
    });
  });

  it('treats a primary that cannot be read as a file as unreadable', async () => {
    await mkdir(primary);
    await writeFile(lastGood, envelope(SUBSETS.alternate.raw));
    await expect(diskSource().read(signal())).resolves.toEqual({
      source: 'last-good',
      preferences: SUBSETS.alternate.expected,
    });
  });

  it('does not read last-good after a valid primary', async () => {
    await writeFile(primary, envelope({}));
    await writeFile(lastGood, envelope(SUBSETS.alternate.raw));
    const reads: string[] = [];
    const snapshot = await createDirectoryReadPreferenceSource({
      canonicalDataRoot: root,
      paths,
      readFile: (absolutePath, readSignal) => {
        reads.push(absolutePath);
        return readFile(absolutePath, { encoding: 'utf8', signal: readSignal });
      },
    }).read(signal());

    expect(snapshot).toEqual({ source: 'primary', preferences: DEFAULTS });
    expect(reads).toEqual([primary]);
  });

  describe('no-write proof', () => {
    const OLD_TIME = new Date('2024-01-02T03:04:05.000Z');

    async function seedFixture(
      files: Record<string, { content: string; mode: number }>,
    ): Promise<void> {
      await mkdir(paths.join(root, 'workspaces', 'nested'), {
        recursive: true,
      });
      const all = {
        ...files,
        'preferences.backup-2026-01-01T00-00-00-000Z.json': {
          content: envelope(SUBSETS.alternate.raw),
          mode: 0o600,
        },
        'preferences.backup-2026-02-01T00-00-00-000Z.json': {
          content: '{"__error":{"reason":"parse"},"rawContent":"{"}',
          mode: 0o640,
        },
        '.preferences.json.123.456-1.tmp': { content: 'partial', mode: 0o600 },
        'sentinel.txt': { content: 'sentinel', mode: 0o644 },
        'workspaces/nested/sentinel.json': { content: '{}', mode: 0o600 },
      };
      for (const [relative, { content, mode }] of Object.entries(all)) {
        const absolute = paths.join(root, relative);
        await writeFile(absolute, content);
        await chmod(absolute, mode);
        await utimes(absolute, OLD_TIME, OLD_TIME);
      }
      for (const directory of ['workspaces/nested', 'workspaces', '.']) {
        await utimes(paths.join(root, directory), OLD_TIME, OLD_TIME);
      }
    }

    it.each<
      [string, Record<string, { content: string; mode: number }>, string]
    >([
      [
        'a valid primary',
        {
          'preferences.json': {
            content: envelope(SUBSETS.overrides.raw),
            mode: 0o600,
          },
          'preferences.last-good.json': {
            content: envelope(SUBSETS.alternate.raw),
            mode: 0o640,
          },
        },
        'primary',
      ],
      [
        'a corrupt primary',
        {
          'preferences.json': { content: '{"version":', mode: 0o644 },
          'preferences.last-good.json': {
            content: envelope(SUBSETS.alternate.raw),
            mode: 0o600,
          },
        },
        'last-good',
      ],
      [
        'an unsupported primary and corrupt last-good',
        {
          'preferences.json': { content: envelope({}, 2), mode: 0o600 },
          'preferences.last-good.json': { content: 'nope', mode: 0o600 },
        },
        'defaults',
      ],
      [
        'an absent primary',
        {
          'preferences.last-good.json': {
            content: envelope(SUBSETS.alternate.raw),
            mode: 0o600,
          },
        },
        'last-good',
      ],
      ['absent primary and last-good', {}, 'defaults'],
    ])('leaves the root unchanged with %s', async (_name, files, expected) => {
      await seedFixture(files);
      await expectNoWrites(root, async () => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await expect(diskSource().read(signal())).resolves.toMatchObject({
            source: expected,
          });
        }
      });
      if (!('preferences.json' in files)) {
        await expect(stat(primary)).rejects.toMatchObject({ code: 'ENOENT' });
      }
    });

    it('does not create an absent canonical data root', async () => {
      const absentRoot = paths.join(parent, 'absent', 'data');
      await writeFile(paths.join(parent, 'sentinel.txt'), 'parent');
      await utimes(parent, OLD_TIME, OLD_TIME);
      await expectNoWrites(parent, async () => {
        await expect(
          createDirectoryReadPreferenceSource({
            canonicalDataRoot: absentRoot,
            paths,
          }).read(signal()),
        ).resolves.toEqual({ source: 'defaults', preferences: DEFAULTS });
      });
      await expect(stat(paths.join(parent, 'absent'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });

    it('detects a forbidden write when one occurs', async () => {
      await seedFixture({});
      const writes = instrumentForbiddenWrites();
      try {
        const promises =
          jest.requireActual<typeof filesystem>('node:fs/promises');
        await promises.writeFile(paths.join(root, 'probe.txt'), 'x');
        await (await promises.open(paths.join(root, 'probe.txt'))).close();
        await (
          await promises.open(paths.join(root, 'probe.txt'), 'r+')
        ).close();
      } finally {
        writes.restore();
      }
      expect(writes.calls).toEqual([
        'fs/promises.writeFile',
        'fs/promises.open',
      ]);
    });
  });
});

it('imports no recovery, writer or desktop module', async () => {
  const source = await readFile(
    paths.join(__dirname, '..', 'directory-read-preferences.ts'),
    'utf8',
  );
  const imports = Array.from(
    source.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)';$/gm),
    ([, bindings, specifier]) => [specifier, bindings.replace(/\s+/g, ' ')],
  );

  expect(imports).toEqual([
    ['node:fs/promises', '{ readFile }'],
    [
      '@canopy/protocol/file-indexing',
      '{ createDefaultFileIndexingPreferences, type FileIndexingPreferences, }',
    ],
    ['./file-indexing', '{ normalizeFileIndexingPreferences }'],
  ]);
  // Side-effect imports (`import './x';`) have no `from` clause above.
  expect(source.match(/^\s*import\b/gm)).toHaveLength(imports.length);
  expect(source).not.toMatch(/\b(?:require|import)\s*\(|^export .* from /m);
});

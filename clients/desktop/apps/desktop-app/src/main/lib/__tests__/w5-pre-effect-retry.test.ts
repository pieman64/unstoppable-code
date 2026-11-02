// W6g (CAN-5498): the A18′ retry rule for outermost pre-effect units.
import { canopyInternalError } from '@canopy/core-runtime';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  W5FileWriteRefusedError,
  W5RevisionConflictError,
  withW5Commit,
} from '../w5-commit-log-file-store';
import { runW5Commit } from '../w5-commit-scope';
import {
  recordW5PortConflict,
  runW5PreEffectUnit,
  setW5PreEffectAttempts,
  w5ConflictCounts,
} from '../w5-pre-effect-retry';

const conflict = (): Error =>
  new W5FileWriteRefusedError('/w5/a/worktrees.json');
const count = (key: string): number => w5ConflictCounts().get(key) ?? 0;

/** Work that fails with each of `failures` in turn, then resolves. */
function failing(...failures: Error[]): jest.Mock<Promise<string>, []> {
  return jest.fn(() => {
    const failure = failures.shift();
    return failure ? Promise.reject(failure) : Promise.resolve('done');
  });
}

let restore: () => void = () => undefined;
afterEach(() => restore());

describe('in-process composition', () => {
  it('runs a unit once and leaves its conflict unchanged', async () => {
    const work = failing(conflict());
    await expect(runW5PreEffectUnit('unit', work)).rejects.toBeInstanceOf(
      W5FileWriteRefusedError,
    );
    expect(work).toHaveBeenCalledTimes(1);
  });
});

describe('daemon-backed composition (3 attempts)', () => {
  beforeEach(() => {
    restore = setW5PreEffectAttempts(3);
  });

  it('retries a returned pre-decision conflict and counts it', async () => {
    const before = count('retry-unit fingerprint retried');
    const work = failing(conflict(), conflict());
    await expect(runW5PreEffectUnit('retry-unit', work)).resolves.toBe('done');
    expect(work).toHaveBeenCalledTimes(3);
    expect(count('retry-unit fingerprint retried')).toBe(before + 2);
  });

  it('surfaces the last conflict once the attempts run out', async () => {
    const last = conflict();
    const work = failing(conflict(), conflict(), last);
    await expect(runW5PreEffectUnit('exhausting-unit', work)).rejects.toBe(
      last,
    );
    expect(work).toHaveBeenCalledTimes(3);
    expect(count('exhausting-unit fingerprint exhausted')).toBe(1);
  });

  it.each([
    ['a revision conflict', new W5RevisionConflictError('worktrees:a', 1, 2)],
    [
      'recovery-required',
      new W5CommitRefusedError('recovery-required', 'needs recovery'),
    ],
    [
      'an unapplied change',
      new W5CommitRefusedError('unapplied-change', 'not applied'),
    ],
    ['a thrown transport failure', canopyInternalError('lost')],
  ])('never retries %s', async (_name, error) => {
    const work = failing(error);
    await expect(runW5PreEffectUnit('unit', work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('runs a nested unit once, leaving the retry to the outermost unit', async () => {
    const inner = failing(conflict());
    const outer = jest.fn(() => runW5PreEffectUnit('inner', inner));
    await expect(runW5PreEffectUnit('outer', outer)).resolves.toBe('done');
    expect(outer).toHaveBeenCalledTimes(2);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('a finished unit does not capture detached work it started, which gets its own attempts', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const late = failing(conflict());
    let detached: Promise<string> | undefined;
    await runW5PreEffectUnit('outer', () => {
      detached = gate.then(() => runW5PreEffectUnit('late', late));
      return Promise.resolve();
    });
    release();
    await expect(detached).resolves.toBe('done');
    expect(late).toHaveBeenCalledTimes(2);
  });

  it('runs once inside a commit scope, whose decision comes later', async () => {
    const work = failing(conflict());
    await expect(
      runW5Commit(
        {},
        { operation: 'scope' },
        () => runW5PreEffectUnit('in-scope', work),
        () => Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('never reruns a unit that opened a commit scope, and counts its conflict as post-effect', async () => {
    const before = count('scoped-unit fingerprint post-effect');
    const work = jest.fn(() =>
      withW5Commit({ operation: 'scope' }, () => Promise.reject(conflict())),
    );
    await expect(
      runW5PreEffectUnit('scoped-unit', work),
    ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(work).toHaveBeenCalledTimes(1);
    expect(count('scoped-unit fingerprint post-effect')).toBe(before + 1);
  });

  it('counts port conflicts outside a unit as surfaced, and leaves those inside to the unit', async () => {
    const before = count('w5.label fingerprint surfaced');
    recordW5PortConflict('w5.label', 'fingerprint');
    await runW5PreEffectUnit('unit', () => {
      recordW5PortConflict('w5.label', 'fingerprint');
      return Promise.resolve();
    });
    recordW5PortConflict('w5.label', 'revision');
    expect(count('w5.label fingerprint surfaced')).toBe(before + 1);
    expect(count('w5.label revision surfaced')).toBe(1);
  });

  it('rejects an attempt bound that is not a positive integer', () => {
    expect(() => setW5PreEffectAttempts(0)).toThrow();
    expect(() => setW5PreEffectAttempts(1.5)).toThrow();
  });
});

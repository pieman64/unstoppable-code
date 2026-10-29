/**
 * A deterministic stand-in for running time in tests: while `run` executes,
 * count the elements, characters and keys that built-in array, string and
 * object methods walk. Code that does its scanning through these built-ins
 * (`includes`, `some`, `split`, `trim`, `Object.entries`, …) and re-scans its
 * input shows up here as quadratic growth, independently of the machine or
 * its load. Indexed character loops and regular expression matching are not
 * counted; see `regexSourcesRun` for pinning the patterns a scan may run.
 *
 * This is a test-only helper, not a published protocol subpath. Tests in other
 * packages and apps import it by relative path, as they do protocol's
 * `__fixtures__`: an `@canopy/protocol/...` specifier would have to be declared
 * in the package `exports` map (see `../subpath-exports.test.ts`).
 */

type Measure = (receiver: unknown, result: unknown) => number;

function lengthOf(value: unknown): number {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  return value instanceof String ? value.length : 0;
}

const receiverLength: Measure = (receiver) => lengthOf(receiver);
const resultLength: Measure = (_receiver, result) => lengthOf(result);

const PATCHES: [object, string, Measure][] = [
  ...[
    'concat',
    'every',
    'filter',
    'find',
    'findIndex',
    'forEach',
    'includes',
    'indexOf',
    'join',
    'lastIndexOf',
    'map',
    'reduce',
    'slice',
    'some',
  ].map((name): [object, string, Measure] => [
    Array.prototype,
    name,
    receiverLength,
  ]),
  ...[
    'endsWith',
    'includes',
    'indexOf',
    'replace',
    'replaceAll',
    'slice',
    'split',
    'startsWith',
    'trim',
    'trimEnd',
    'trimStart',
  ].map((name): [object, string, Measure] => [
    String.prototype,
    name,
    receiverLength,
  ]),
  ...['keys', 'values', 'entries'].map((name): [object, string, Measure] => [
    Object,
    name,
    resultLength,
  ]),
  [JSON, 'stringify', resultLength],
];

/** Run `run` and return its result with the work its built-in calls scanned. */
export function measureWork<T>(run: () => T): { result: T; work: number } {
  let work = 0;
  const restores: (() => void)[] = [];
  try {
    for (const [target, name, measure] of PATCHES) {
      const original: unknown = Reflect.get(target, name);
      if (typeof original !== 'function') continue;
      const counted = function (this: unknown, ...args: unknown[]): unknown {
        const result: unknown = Reflect.apply(original, this, args);
        work += measure(this, result);
        return result;
      };
      const descriptor = Reflect.getOwnPropertyDescriptor(target, name);
      Reflect.defineProperty(target, name, { ...descriptor, value: counted });
      restores.push(() => {
        if (descriptor !== undefined) {
          Reflect.defineProperty(target, name, descriptor);
        }
      });
    }
    const result = run();
    return { result, work };
  } finally {
    for (const restore of restores.reverse()) restore();
  }
}

/**
 * How much the work of `run` grows when its input doubles: the work for
 * `make(2 * size)` divided by the work for `make(size)`. Inputs are built
 * outside the measurement. Linear code roughly doubles its work; code that
 * re-scans its input once per element roughly quadruples it.
 */
export function workGrowth<Input>(
  make: (size: number) => Input,
  run: (input: Input) => unknown,
  size: number,
): number {
  const small = make(size);
  const large = make(2 * size);
  const smallWork = measureWork(() => run(small)).work;
  const largeWork = measureWork(() => run(large)).work;
  return largeWork / Math.max(1, smallWork);
}

/**
 * Run `run` and return its result with the source of every regular
 * expression it executed. `measureWork` cannot see regex cost: matching
 * happens inside the engine, so a backtracking pattern that reads its input
 * once can still take quadratic or worse time on a long whitespace run. Tests
 * of code that must stay linear on attacker-sized text use this to pin the
 * patterns it may run to ones that cannot backtrack. Every regex method
 * (`exec`, `test`, and the `match`, `matchAll`, `replace`, `search` and
 * `split` string methods) executes through `RegExp.prototype.exec`.
 */
export function regexSourcesRun<T>(run: () => T): {
  result: T;
  sources: Set<string>;
} {
  const sources = new Set<string>();
  const original: unknown = Reflect.get(RegExp.prototype, 'exec');
  const descriptor = Reflect.getOwnPropertyDescriptor(RegExp.prototype, 'exec');
  if (typeof original !== 'function' || descriptor === undefined) {
    throw new Error('RegExp.prototype.exec is not a method.');
  }
  const recorded = function (this: RegExp, ...args: unknown[]): unknown {
    sources.add(this.source);
    return Reflect.apply(original, this, args);
  };
  Reflect.defineProperty(RegExp.prototype, 'exec', {
    ...descriptor,
    value: recorded,
  });
  try {
    return { result: run(), sources };
  } finally {
    Reflect.defineProperty(RegExp.prototype, 'exec', descriptor);
  }
}

/**
 * The cooperative writer serializes small plain values with native
 * `JSON.stringify` and walks everything else itself. Both paths must write
 * the same bytes as `JSON.stringify`: whitespace, key order, escaping, and
 * number formatting. The one deliberate exception is inherited from the
 * walker: boxed primitives and class instances are written as their own
 * enumerable properties, so those values always take the walker.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NATIVE_JSON_MAX_CHARS,
  nativeJsonText,
  writeJsonValuesCooperatively,
} from '../lib/cooperative-json';

class WithToJson {
  public constructor(private readonly label: string) {}
  public toJSON(key: string): unknown {
    return { label: this.label, key };
  }
}

const sparse: unknown[] = [1];
sparse[3] = 'hole';

const TRICKY: Array<[string, unknown]> = [
  ['empty string', ''],
  [
    'escapes',
    'quote " backslash \\ slash / tab \t newline \n return \r backspace \b formfeed \f nul \u0000 unit-sep \u001f del \u007f',
  ],
  ['line and paragraph separators', 'a b c'],
  ['astral and combined unicode', '🌲👩‍💻 漢字 é é'],
  ['lone surrogates', 'high \ud800 low \udc00 reversed \udc00\ud800'],
  ['negative zero', -0],
  ['negative zero nested', { a: -0, b: [-0] }],
  [
    'large and small numbers',
    [
      1e21,
      -1e21,
      123456789012345680000,
      Number.MAX_SAFE_INTEGER + 2,
      Number.MAX_VALUE,
      Number.MIN_VALUE,
      5e-324,
      1e-7,
      0.1 + 0.2,
    ],
  ],
  ['non-finite numbers', [NaN, Infinity, -Infinity, { n: NaN }]],
  ['nested empties', { a: {}, b: [], c: [[]], d: [{}], e: { f: { g: {} } } }],
  [
    'undefined, functions and symbols in objects',
    {
      a: undefined,
      b: 1,
      c: (): void => undefined,
      d: Symbol('s'),
      e: null,
    },
  ],
  [
    'undefined, functions and symbols in arrays',
    [undefined, (): void => undefined, Symbol('s'), null],
  ],
  ['sparse array', sparse],
  ['key order with integer-like keys', { b: 1, 2: 'two', a: 2, 1: 'one' }],
  ['unicode and escaped keys', { 'é"\n': 1, '🌲': { ' ': 2 } }],
  ['Date via toJSON', { at: new Date(Date.UTC(2026, 8, 30, 12)) }],
  ['class toJSON receives its key', { item: new WithToJson('x') }],
  ['toJSON in an array receives its index', [new WithToJson('y')]],
  ['top-level toJSON', new WithToJson('top')],
  [
    'own toJSON on a plain object',
    { toJSON: (key: string): string => `own:${key}` },
  ],
  ['null prototype object', Object.assign(Object.create(null), { z: 1 })],
  ['booleans and null', [true, false, null]],
  [
    'chat-shaped row',
    {
      id: 'm1',
      role: 'assistant',
      timestamp: 1_790_000_000_000,
      blocks: [
        { type: 'text', text: 'Hello "world" \n🌲' },
        {
          type: 'tool_result',
          toolUseId: 't',
          toolName: 'shell',
          output: 'a\tb\u0001',
          isError: false,
          extra: undefined,
        },
      ],
    },
  ],
  ['large string above the native threshold', 'x🌲\n'.repeat(40_000)],
  [
    'large array above the native threshold',
    Array.from({ length: 20_000 }, (_, index) => ({ index, text: 'row' })),
  ],
  [
    'deep nesting',
    Array.from({ length: 200 }).reduce<unknown>((inner) => [inner], 'core'),
  ],
];

describe('cooperative JSON writer', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cooperative-json-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const written = async (
    values: readonly unknown[],
    options: {
      pretty: boolean;
      separator?: string;
      trailingSeparator?: boolean;
      nativeMaxChars?: number;
    },
  ): Promise<Buffer> => {
    const path = join(root, `${Math.random().toString(36).slice(2)}.json`);
    await writeJsonValuesCooperatively(path, values, options);
    return readFile(path);
  };

  describe.each([false, true])('pretty %s', (pretty) => {
    it.each(TRICKY)(
      'writes %s exactly as JSON.stringify, on both paths',
      async (_label, value) => {
        const native = await written([value], { pretty });
        const walked = await written([value], { pretty, nativeMaxChars: 0 });
        const expected = JSON.stringify(value, null, pretty ? 2 : undefined);
        expect(native.toString('utf8')).toBe(expected);
        expect(walked.equals(native)).toBe(true);
      },
    );
  });

  it('writes identical JSONL for every value on both paths', async () => {
    const values = TRICKY.map(([, value]) => value);
    const options = { pretty: false, separator: '\n', trailingSeparator: true };
    const native = await written(values, options);
    const walked = await written(values, { ...options, nativeMaxChars: 0 });
    expect(walked.equals(native)).toBe(true);
    expect(native.toString('utf8')).toBe(
      values.map((value) => `${JSON.stringify(value)}\n`).join(''),
    );
  });

  it('writes nothing for a top-level value JSON.stringify cannot represent', async () => {
    const values = [1, undefined, (): void => undefined, Symbol('s'), 2];
    const options = { pretty: false, separator: '\n', trailingSeparator: true };
    const native = await written(values, options);
    const walked = await written(values, { ...options, nativeMaxChars: 0 });
    expect(native.toString('utf8')).toBe('1\n\n\n\n2\n');
    expect(walked.equals(native)).toBe(true);
  });

  it('keeps the walker for boxed primitives, whose bytes differ from JSON.stringify', async () => {
    const values = [new Number(5), new String('ab'), new Boolean(true)];
    const options = { pretty: false, separator: '\n', trailingSeparator: true };
    const native = await written(values, options);
    const walked = await written(values, { ...options, nativeMaxChars: 0 });
    expect(walked.toString('utf8')).toBe('{}\n{"0":"a","1":"b"}\n{}\n');
    expect(native.equals(walked)).toBe(true);
  });

  it('rejects a BigInt and a cycle on both paths', async () => {
    const cycle: Record<string, unknown> = { a: 1 };
    cycle.self = cycle;
    for (const nativeMaxChars of [undefined, 0]) {
      await expect(
        written([{ n: 1n }], { pretty: false, nativeMaxChars }),
      ).rejects.toThrow(TypeError);
      await expect(
        written([cycle], { pretty: false, nativeMaxChars }),
      ).rejects.toThrow('Converting circular structure to JSON');
    }
  });

  describe('native eligibility', () => {
    it('serializes small plain values natively', () => {
      expect(nativeJsonText({ a: [1, 'b', null, true] }, false)).toBe(
        '{"a":[1,"b",null,true]}',
      );
      expect(nativeJsonText([{}], true)).toBe('[\n  {}\n]');
      expect(nativeJsonText(undefined, false)).toBe('');
    });

    it.each<[string, unknown]>([
      ['a string above the threshold', 'x'.repeat(NATIVE_JSON_MAX_CHARS)],
      [
        'an array above the threshold',
        Array.from({ length: NATIVE_JSON_MAX_CHARS }, () => 1),
      ],
      ['a value with toJSON', { at: new Date(0) }],
      ['a class instance', new WithToJson('z')],
      ['a boxed primitive', { n: new Number(1) }],
      ['a function', { f: (): void => undefined }],
      ['a BigInt', { n: 1n }],
      [
        'deep nesting',
        Array.from({ length: 100 }).reduce<unknown>((inner) => [inner], 0),
      ],
    ])('leaves %s to the walker', (_label, value) => {
      expect(nativeJsonText(value, false)).toBeUndefined();
    });

    it('stops walking a cycle at the size budget', () => {
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      expect(nativeJsonText(cycle, false)).toBeUndefined();
    });
  });
});

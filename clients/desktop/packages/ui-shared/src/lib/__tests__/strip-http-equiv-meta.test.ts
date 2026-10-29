/** @jest-environment jsdom */
import {
  stripHttpEquivMetaTags,
  stripHttpEquivMetaTagsWithStats,
} from '../strip-http-equiv-meta';

const HTTP_EQUIV_KEYWORDS = [
  'refresh',
  'content-security-policy',
  'x-dns-prefetch-control',
  'set-cookie',
];
const HTTP_EQUIV_VALUES: ReadonlySet<string> = new Set(HTTP_EQUIV_KEYWORDS);

function hasListedHttpEquivMeta(content: string): boolean {
  const document = new DOMParser().parseFromString(content, 'text/html');
  return Array.from(document.querySelectorAll('meta[http-equiv]')).some(
    (meta) =>
      HTTP_EQUIV_VALUES.has(
        (meta.getAttribute('http-equiv') ?? '').trim().toLowerCase(),
      ),
  );
}

function mixedCase(value: string): string {
  return Array.from(value)
    .map((character, index) =>
      index % 2 === 0 ? character.toUpperCase() : character,
    )
    .join('');
}

function expectCleanAndIdempotent(content: string): string {
  const output = stripHttpEquivMetaTags(content, HTTP_EQUIV_VALUES);
  expect(hasListedHttpEquivMeta(output)).toBe(false);
  expect(stripHttpEquivMetaTags(output, HTTP_EQUIV_VALUES)).toBe(output);
  return output;
}

describe('stripHttpEquivMetaTags', () => {
  it('strips every listed keyword across tag and attribute spellings', () => {
    const forms: Array<(keyword: string) => string> = [
      (keyword: string): string => `<meta http-equiv="${keyword}">`,
      (keyword: string): string => `<meta HTTP-EQUIV='${keyword}'>`,
      (keyword: string): string => `<meta http-equiv=${keyword}>`,
      (keyword: string): string => `<META HTTP-EQUIV=${keyword.toUpperCase()}>`,
      (keyword: string): string => `<MeTa hTtP-EqUiV=${mixedCase(keyword)}>`,
      (keyword: string): string => `<meta  http-equiv \t = \n "${keyword}">`,
      (keyword: string): string => `<meta/http-equiv=${keyword}>`,
      (keyword: string): string => `<meta http-equiv="${keyword}" />`,
      (keyword: string): string => `<meta\nhttp-equiv\n=\n'${keyword}'\n>`,
    ];

    for (const keyword of HTTP_EQUIV_KEYWORDS) {
      for (const form of forms) {
        expect(expectCleanAndIdempotent(form(keyword))).toBe('');
      }
    }
  });

  it('decodes decimal and hexadecimal character references with optional semicolons', () => {
    const inputs = [
      '<meta http-equiv="&#114;efresh">',
      '<meta http-equiv="&#114efresh">',
      '<meta http-equiv="&#x72;efresh">',
      '<meta http-equiv="&#x72&#x65;&#x66;resh">',
      '<meta http-equiv="&#X72;efresh">',
      '<meta http-equiv="&#X72&#X65;fresh">',
    ];

    for (const input of inputs) {
      expect(expectCleanAndIdempotent(input)).toBe('');
    }
  });

  it('decodes named references that produce ASCII whitespace', (): void => {
    const inputs = [
      '<meta http-equiv="&Tab;refresh">',
      '<meta http-equiv="refresh&NewLine;">',
      '<meta http-equiv="&NewLine;&Tab;Set-Cookie&Tab;">',
    ];

    for (const input of inputs) {
      expect(expectCleanAndIdempotent(input)).toBe('');
    }
  });

  it('keeps unsupported named references byte-for-byte', (): void => {
    const domSafeInputs = [
      '<meta http-equiv="&tab;refresh">',
      '<meta http-equiv="&Tab refresh">',
    ];

    for (const input of domSafeInputs) {
      expect(expectCleanAndIdempotent(input)).toBe(input);
    }

    const nonAsciiWhitespace = '<meta http-equiv="&nbsp;refresh">';
    const output = stripHttpEquivMetaTags(
      nonAsciiWhitespace,
      HTTP_EQUIV_VALUES,
    );
    expect(output).toBe(nonAsciiWhitespace);
    expect(stripHttpEquivMetaTags(output, HTTP_EQUIV_VALUES)).toBe(output);
  });

  it('uses the first exact http-equiv attribute, not look-alike attributes or values', () => {
    const inputs = [
      '<meta data-http-equiv="viewport" http-equiv="refresh">',
      '<meta title="http-equiv=x" http-equiv="refresh">',
    ];

    for (const input of inputs) {
      expect(expectCleanAndIdempotent(input)).toBe('');
    }
  });

  it('lets the first duplicate http-equiv decide', () => {
    expect(
      expectCleanAndIdempotent(
        '<meta http-equiv="refresh" http-equiv="viewport">',
      ),
    ).toBe('');
    expect(
      expectCleanAndIdempotent(
        '<meta http-equiv="viewport" http-equiv="refresh">',
      ),
    ).toBe('<meta http-equiv="viewport" http-equiv="refresh">');
  });

  it('keeps other meta tags, metadata look-alikes, and documents without metas unchanged', () => {
    const input =
      '<meta charset="utf-8"><meta name="viewport" content="width=device-width">' +
      '<meta http-equiv="X-UA-Compatible" content="IE=edge"><metadata charset="utf-8">';
    expect(expectCleanAndIdempotent(input)).toBe(input);

    const noMetas =
      '<main><p>ordinary text</p><script>const x = 1;</script></main>';
    expect(stripHttpEquivMetaTags(noMetas, HTTP_EQUIV_VALUES)).toBe(noMetas);
  });

  it('finds real tags after comments, raw text, and malformed look-alikes', () => {
    const cases = [
      ["<!-- ' --><meta http-equiv=refresh>", "<!-- ' -->"],
      [
        `<script>${'İ'.repeat(20)}</script><meta http-equiv=refresh>`,
        `<script>${'İ'.repeat(20)}</script>`,
      ],
      ['</script/><meta http-equiv=refresh>', '</script/>'],
    ];

    for (const [input, expected] of cases) {
      expect(expectCleanAndIdempotent(input)).toBe(expected);
    }
  });

  it('renames instead of removing when removal would join text into a listed tag', () => {
    for (const prefix of ['<', '<m', '<me', '<met', '<meta']) {
      const remainingPrefix = '<meta'.slice(prefix.length);
      const input =
        `${prefix}<meta http-equiv=set-cookie>${remainingPrefix}` +
        ' http-equiv=refresh content="0;url=https://x.example">';
      const output = expectCleanAndIdempotent(input);

      expect(output).toBe(
        input.replace(
          '<meta http-equiv=set-cookie>',
          '<x-meta http-equiv=set-cookie>',
        ),
      );
    }
  });

  it('renames a listed tag that an earlier look-alike with a dangling quote reads into', () => {
    const input =
      '<!-- <meta foo=" --><meta http-equiv="refresh" content="0;url=https://x.example"><p title="">';
    expect(expectCleanAndIdempotent(input)).toBe(
      '<!-- <meta foo=" --><x-meta http-equiv="refresh" content="0;url=https://x.example"><p title="">',
    );
  });

  it('never turns a kept tag into a listed one by removing a tag nested in it', () => {
    const input =
      '<meta a="<meta http-equiv=set-cookie c=">">" http-equiv=refresh content="0;url=https://x.example">';
    const output = expectCleanAndIdempotent(input);

    expect(output).toBe(
      input.replace(
        '<meta http-equiv=set-cookie',
        '<x-meta http-equiv=set-cookie',
      ),
    );
  });

  it('treats a leading equals sign as part of the attribute name', () => {
    expect(
      expectCleanAndIdempotent(
        '<meta ==http-equiv http-equiv=refresh content="0;url=https://x.example">',
      ),
    ).toBe('');
    const unlisted = '<meta =http-equiv=refresh>';
    expect(expectCleanAndIdempotent(unlisted)).toBe(unlisted);
  });

  it('leaves an unterminated tag unchanged', () => {
    const input = '<meta http-equiv="refresh';
    expect(() =>
      stripHttpEquivMetaTags(input, HTTP_EQUIV_VALUES),
    ).not.toThrow();
    expect(stripHttpEquivMetaTags(input, HTTP_EQUIV_VALUES)).toBe(input);
  });

  it('neutralizes remaining occurrences when parser work reaches its budget', () => {
    const input = '<meta x'.repeat(50_000);
    const result = stripHttpEquivMetaTagsWithStats(input, HTTP_EQUIV_VALUES);
    const renamed = result.content.split('<x-meta x').length - 1;
    const untouched = result.content.split('<meta x').length - 1;

    expect(result.usedFallback).toBe(true);
    expect(result.examinedCharacters).toBeLessThanOrEqual(
      4 * input.length + 65_536,
    );
    // Tags examined before the budget ran out never close, so they stay inert.
    expect(renamed + untouched).toBe(50_000);
    expect(untouched).toBeLessThan(10);
    expect(result.content.endsWith('<x-meta x')).toBe(true);
  });

  it('keeps the text before the point where the budget runs out', () => {
    const lead = '<p>kept</p><meta charset="utf-8"><meta http-equiv="refresh">';
    const input = `${lead}${'<meta x'.repeat(50_000)}`;
    const result = stripHttpEquivMetaTagsWithStats(input, HTTP_EQUIV_VALUES);

    expect(result.usedFallback).toBe(true);
    expect(
      result.content.startsWith('<p>kept</p><meta charset="utf-8"><meta x'),
    ).toBe(true);
    expect(result.content.endsWith('<x-meta x')).toBe(true);
    expect(hasListedHttpEquivMeta(result.content)).toBe(false);
  });

  it('uses little parser work for a large ordinary document', () => {
    const input =
      `${'<script></script>'.repeat(2_000)}` +
      '<meta charset="utf-8"><meta http-equiv="refresh"><meta name="viewport">';
    const result = stripHttpEquivMetaTagsWithStats(input, HTTP_EQUIV_VALUES);

    expect(result.content).toBe(
      `${'<script></script>'.repeat(2_000)}` +
        '<meta charset="utf-8"><meta name="viewport">',
    );
    expect(result.usedFallback).toBe(false);
    expect(result.examinedCharacters).toBeLessThan(input.length);
  });
  it('leaves no listed meta in the parsed document for generated hostile markup', () => {
    const fragments = [
      '<meta',
      '<META',
      '<meta ',
      '<meta/',
      '<me',
      '<',
      'ta',
      'meta',
      ' http-equiv=refresh',
      ' http-equiv="refresh"',
      ' http-equiv="&Tab;refresh"',
      ' http-equiv=refresh&NewLine;',
      " HTTP-EQUIV='Set-Cookie'",
      ' http-equiv=&#114;efresh',
      ' http-equiv=viewport',
      ' data-http-equiv=x',
      ' content="0;url=https://x.example"',
      ' a=',
      '=',
      '"',
      "'",
      '>',
      '/>',
      '/',
      ' ',
      '\n',
      'x',
      '<!--',
      '-->',
      '--!>',
      '<script>',
      '</script>',
      '<style>',
      '</style>',
      '<title>',
      '</title>',
      '<textarea>',
      '</textarea>',
      '<svg>',
      '</svg>',
      '<p>',
      '</p>',
      '<template>',
      '</template>',
      '<head>',
      '<body>',
    ];
    // Deterministic generator so a failure reproduces from its index.
    let seed = 0x2f6e2b1;
    const next = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };

    for (let sample = 0; sample < 4_000; sample++) {
      const length = 2 + (next() % 14);
      let input = '';
      for (let part = 0; part < length; part++) {
        input += fragments[next() % fragments.length];
      }
      const output = stripHttpEquivMetaTags(input, HTTP_EQUIV_VALUES);

      if (hasListedHttpEquivMeta(output)) {
        throw new Error(
          `sample ${sample} left a listed meta: ${JSON.stringify(input)}`,
        );
      }
      if (stripHttpEquivMetaTags(output, HTTP_EQUIV_VALUES) !== output) {
        throw new Error(
          `sample ${sample} is not idempotent: ${JSON.stringify(input)}`,
        );
      }
    }
  });
});

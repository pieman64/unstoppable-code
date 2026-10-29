import {
  extractDevServerHits,
  type DevServerHit,
} from '../scriptDevServerDetection';

const FIXED_NOW = 1_700_000_000_000;
const now = (): number => FIXED_NOW;

describe('extractDevServerHits', () => {
  it('returns existing hits unchanged when no patterns are configured', () => {
    const existing: DevServerHit[] = [
      {
        url: 'http://localhost:1234/',
        displayUrl: 'http://localhost:1234',
        patternIndex: 0,
        firstSeenAt: 100,
        openTarget: 'in-app',
      },
    ];
    const result = extractDevServerHits({
      devServerPattern: undefined,
      lines: ['ignored output'],
      existingHits: existing,
      now,
    });
    expect(result).toBe(existing);
  });

  it('returns existing hits unchanged when there are no new lines', () => {
    const existing: DevServerHit[] = [];
    const result = extractDevServerHits({
      devServerPattern: 'https?://\\S+',
      lines: [],
      existingHits: existing,
      now,
    });
    expect(result).toBe(existing);
  });

  it('extracts a single http(s) URL from a streamed line', () => {
    const result = extractDevServerHits({
      devServerPattern: 'https?://\\S+',
      lines: ['Listening on http://localhost:3000'],
      now,
    });
    expect(result).toEqual([
      {
        url: 'http://localhost:3000/',
        displayUrl: 'http://localhost:3000',
        patternIndex: 0,
        firstSeenAt: FIXED_NOW,
        openTarget: 'in-app',
      },
    ]);
  });

  it('defaults bare-string patterns to openTarget "in-app"', () => {
    const result = extractDevServerHits({
      devServerPattern: 'https?://\\S+',
      lines: ['Local: http://localhost:3000'],
      now,
    });
    expect(result).toHaveLength(1);
    expect(result[0].openTarget).toBe('in-app');
  });

  it('carries openTarget "external" from an object pattern', () => {
    const result = extractDevServerHits({
      devServerPattern: {
        pattern: 'https?://\\S+',
        label: 'Docs',
        openTarget: 'external',
      },
      lines: ['Docs: http://localhost:8080'],
      now,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      label: 'Docs',
      openTarget: 'external',
    });
  });

  it('assigns per-entry openTarget across an array of patterns', () => {
    const result = extractDevServerHits({
      devServerPattern: [
        { pattern: '(https?://[\\w.]+:3000\\S*)', openTarget: 'in-app' },
        { pattern: '(https?://[\\w.]+:8080\\S*)', openTarget: 'external' },
      ],
      lines: [
        'app http://localhost:3000/home',
        'docs http://localhost:8080/guide',
      ],
      now,
    });
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      url: 'http://localhost:3000/home',
      openTarget: 'in-app',
    });
    expect(result[1]).toMatchObject({
      url: 'http://localhost:8080/guide',
      openTarget: 'external',
    });
  });

  it('prefers the first non-empty capture group over the full match', () => {
    const result = extractDevServerHits({
      devServerPattern: 'ready on (https?://\\S+)',
      lines: ['server ready on http://localhost:4000/home'],
      now,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      url: 'http://localhost:4000/home',
      displayUrl: 'http://localhost:4000/home',
      patternIndex: 0,
    });
  });

  it('drops non-http(s) URLs', () => {
    const result = extractDevServerHits({
      devServerPattern: '\\S+',
      lines: ['file:///Users/me/index.html'],
      now,
    });
    expect(result).toEqual([]);
  });

  it('uses array priority order and short-circuits lower-priority patterns', () => {
    const result = extractDevServerHits({
      devServerPattern: [
        { pattern: '(https?://[\\w.]+:3000\\S*)', label: 'Primary' },
        { pattern: '(https?://[\\w.]+:3001\\S*)', label: 'Secondary' },
      ],
      lines: [
        'Primary on http://localhost:3000/home and secondary on http://localhost:3001/admin',
      ],
      now,
    });
    // The first pattern matches and produces a valid URL, so the second
    // pattern should not run against this line.
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      url: 'http://localhost:3000/home',
      label: 'Primary',
      patternIndex: 0,
    });
  });

  it('falls through to lower-priority patterns when the higher one yields no valid URL', () => {
    const result = extractDevServerHits({
      devServerPattern: [
        { pattern: '(file://\\S+)', label: 'File' },
        { pattern: '(https?://\\S+)', label: 'Web' },
      ],
      lines: ['stub file://foo and real http://localhost:5173'],
      now,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      url: 'http://localhost:5173/',
      label: 'Web',
      patternIndex: 1,
    });
  });

  it('dedupes URLs across batches and preserves the original label', () => {
    const first = extractDevServerHits({
      devServerPattern: { pattern: 'https?://\\S+', label: 'First Batch' },
      lines: ['http://localhost:8000'],
      existingHits: [],
      now: () => 100,
    });
    expect(first).toHaveLength(1);

    const second = extractDevServerHits({
      devServerPattern: { pattern: 'https?://\\S+', label: 'Second Batch' },
      lines: ['http://localhost:8000 (duplicate)'],
      existingHits: first,
      now: () => 200,
    });
    // Same normalized URL: dedupe should keep first's label and timestamp.
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      url: 'http://localhost:8000/',
      label: 'First Batch',
      firstSeenAt: 100,
    });
  });

  it('caps the returned array at the max-hits limit', () => {
    const lines: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      lines.push(`http://localhost:${1000 + i}/`);
    }
    const result = extractDevServerHits({
      devServerPattern: 'https?://\\S+',
      lines,
      now,
    });
    expect(result).toHaveLength(8);
  });

  it('strips ANSI escape sequences before matching', () => {
    const result = extractDevServerHits({
      devServerPattern: 'https?://\\S+',
      lines: ['[36mhttp://localhost:9999[0m'],
      now,
    });
    expect(result).toHaveLength(1);
    expect(result[0].url).toBe('http://localhost:9999/');
  });

  it('truncates very long lines before regex evaluation', () => {
    const long = `${'x'.repeat(5000)} http://localhost:9999`;
    const result = extractDevServerHits({
      devServerPattern: 'https?://\\S+',
      lines: [long],
      now,
    });
    // The URL sits past the truncation cutoff (4096) so detection should miss it.
    expect(result).toEqual([]);
  });

  it('guards zero-length regex matches from infinite loops', () => {
    // `^` matches empty at the start of the line, which would loop forever
    // without the zero-width guard. We don't expect any valid URL here, just
    // that the call returns.
    const result = extractDevServerHits({
      devServerPattern: '^',
      lines: ['ignored'],
      now,
    });
    expect(result).toEqual([]);
  });

  it('emits multiple hits from a single line via global flag', () => {
    const result = extractDevServerHits({
      devServerPattern: 'https?://\\S+',
      lines: ['Servers: http://localhost:3000 and http://localhost:3001'],
      now,
    });
    expect(result).toHaveLength(2);
    expect(result.map((hit) => hit.url)).toEqual([
      'http://localhost:3000/',
      'http://localhost:3001/',
    ]);
  });

  it('returns identity reference when no new matches are found', () => {
    const existing: DevServerHit[] = [
      {
        url: 'http://localhost:1234/',
        displayUrl: 'http://localhost:1234',
        patternIndex: 0,
        firstSeenAt: 100,
        openTarget: 'in-app',
      },
    ];
    const result = extractDevServerHits({
      devServerPattern: 'https?://\\S+',
      lines: ['boring output with no urls'],
      existingHits: existing,
      now,
    });
    expect(result).toBe(existing);
  });
});

import {
  AGENT_VISUAL_FONT_FACES_SOURCE,
  AGENT_VISUAL_FONT_MAX_BYTES,
  AGENT_VISUAL_FONT_MAX_FACES,
  AGENT_VISUAL_FONT_UNICODE_RANGE_MAX_LENGTH,
  AGENT_VISUAL_FONTS_METHOD,
  agentVisualFontFaceKey,
  buildAgentVisualFontsMessage,
  normalizeFontFamilyName,
  parseFontFaceSourceUrl,
  parseFontFamilyList,
  sanitizeAgentVisualFontFaces,
  type AgentVisualFontFace,
} from '../agent-visual-fonts';

function face(
  overrides: Partial<AgentVisualFontFace> = {},
): AgentVisualFontFace {
  return {
    family: 'Inter',
    style: 'normal',
    weight: '400 500',
    stretch: 'normal',
    unicodeRange: 'U+0-10FFFF',
    data: new ArrayBuffer(8),
    ...overrides,
  };
}

/**
 * A subset face's range as a browser serializes it: a latin subset lists a
 * few hundred code points and spans, well past a plain descriptor's length.
 */
const SUBSET_RANGE = Array.from(
  { length: 120 },
  (_, index) =>
    `U+${(0x20 + index * 16).toString(16).toUpperCase()}-${(0x2a + index * 16).toString(16).toUpperCase()}`,
)
  .concat(['U+4??', 'U+1DC0-1DF5'])
  .join(', ');

/** The frame-side check, evaluated the way the relay and the bridge do. */
function frameCleanFontFaces(value: unknown): unknown[] {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const build = new Function(
    `function isRecord(value){ return typeof value === 'object' && value !== null && !Array.isArray(value); }
     ${AGENT_VISUAL_FONT_FACES_SOURCE}
     return cleanFontFaces;`,
  );
  const clean: unknown = Reflect.apply(build, undefined, []);
  if (typeof clean !== 'function') throw new Error('cleanFontFaces missing');
  const faces: unknown = Reflect.apply(clean, undefined, [value]);
  if (!Array.isArray(faces)) throw new Error('cleanFontFaces returned no list');
  return faces;
}

/** A well-formed range of exactly `length` characters. */
function rangeOfLength(length: number): string {
  // `U+0` parts joined by `, ` take 5 characters each after the first.
  const parts = Math.floor((length - 3) / 5) + 1;
  const range = Array.from({ length: parts }, () => 'U+0').join(', ');
  return range + ' '.repeat(length - range.length);
}

function rangesOf(faces: readonly unknown[]): unknown[] {
  return faces.map((entry): unknown => {
    if (typeof entry !== 'object' || entry === null) return entry;
    const range: unknown = Reflect.get(entry, 'unicodeRange');
    return range;
  });
}

describe('parseFontFamilyList', () => {
  it('names the families in order and drops the generic ones', () => {
    expect(
      parseFontFamilyList(
        "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      ),
    ).toEqual(['Inter', 'Segoe UI', 'Roboto']);
  });

  it('keeps a generated family name and a comma inside quotes', () => {
    expect(
      parseFontFamilyList(
        '"__Inter_4b1f2c", "__Inter_Fallback_4b1f2c", "Odd, Name", monospace',
      ),
    ).toEqual(['__Inter_4b1f2c', '__Inter_Fallback_4b1f2c', 'Odd, Name']);
  });

  it('returns nothing for an empty value and never repeats a family', () => {
    expect(parseFontFamilyList('')).toEqual([]);
    expect(parseFontFamilyList("Inter, 'Inter', sans-serif")).toEqual([
      'Inter',
    ]);
  });
});

describe('normalizeFontFamilyName', () => {
  it('drops the surrounding quotes and collapses whitespace', () => {
    expect(normalizeFontFamilyName('  "JetBrains   Mono" ')).toBe(
      'JetBrains Mono',
    );
    expect(normalizeFontFamilyName("'Inter'")).toBe('Inter');
    expect(normalizeFontFamilyName('Inter')).toBe('Inter');
  });
});

describe('parseFontFaceSourceUrl', () => {
  it('reads the first url of a source list', () => {
    expect(
      parseFontFaceSourceUrl(
        'url("/_next/static/media/inter.woff2") format("woff2")',
      ),
    ).toBe('/_next/static/media/inter.woff2');
    expect(
      parseFontFaceSourceUrl("url('./a.woff2') format('woff2'), url(b.woff)"),
    ).toBe('./a.woff2');
    expect(parseFontFaceSourceUrl('url(./plain.woff2)')).toBe('./plain.woff2');
  });

  it('returns null for a source with no url', () => {
    expect(parseFontFaceSourceUrl('local("Arial")')).toBeNull();
    expect(parseFontFaceSourceUrl('')).toBeNull();
  });
});

describe('sanitizeAgentVisualFontFaces', () => {
  it('keeps well-formed faces', () => {
    const faces = [face(), face({ style: 'italic' })];
    expect(sanitizeAgentVisualFontFaces(faces)).toEqual(faces);
  });

  it('drops a face with markup, quotes, or a function in a descriptor', () => {
    expect(
      sanitizeAgentVisualFontFaces([
        face({ family: 'Inter</style>' }),
        face({ family: '"Inter"' }),
        face({ weight: 'url(x)' }),
        face({ unicodeRange: 'U+0;color:red' }),
        face({ family: '   ' }),
      ]),
    ).toEqual([]);
  });

  it('keeps a subset face whose range lists many code points, on both sides', () => {
    expect(SUBSET_RANGE.length).toBeGreaterThan(256);
    const subset = face({ unicodeRange: SUBSET_RANGE });
    expect(rangesOf(sanitizeAgentVisualFontFaces([subset]))).toEqual([
      SUBSET_RANGE,
    ]);
    expect(rangesOf(frameCleanFontFaces([subset]))).toEqual([SUBSET_RANGE]);
  });

  it('drops a range that is not code points or is past its limit, on both sides', () => {
    const faces = [
      face({ unicodeRange: 'U+0;color:red' }),
      face({ unicodeRange: 'U+0-FF</style>' }),
      face({ unicodeRange: 'U+0-FF, red' }),
      face({
        unicodeRange: rangeOfLength(
          AGENT_VISUAL_FONT_UNICODE_RANGE_MAX_LENGTH + 1,
        ),
      }),
    ];
    expect(rangesOf(sanitizeAgentVisualFontFaces(faces))).toEqual([]);
    expect(rangesOf(frameCleanFontFaces(faces))).toEqual([]);
  });

  it('keeps a valid range exactly at its limit, on both sides', () => {
    const range = rangeOfLength(AGENT_VISUAL_FONT_UNICODE_RANGE_MAX_LENGTH);
    expect(range).toHaveLength(AGENT_VISUAL_FONT_UNICODE_RANGE_MAX_LENGTH);
    const atLimit = face({ unicodeRange: range });
    expect(rangesOf(sanitizeAgentVisualFontFaces([atLimit]))).toEqual([range]);
    expect(rangesOf(frameCleanFontFaces([atLimit]))).toEqual([range]);
  });

  it('drops a face with no bytes, too many bytes, or bytes of another type', () => {
    expect(
      sanitizeAgentVisualFontFaces([
        face({ data: new ArrayBuffer(0) }),
        face({ data: new ArrayBuffer(AGENT_VISUAL_FONT_MAX_BYTES + 1) }),
        { ...face(), data: 'AAAA' },
        { ...face(), data: new Uint8Array(4) },
        null,
        'Inter',
      ]),
    ).toEqual([]);
  });

  it('keeps at most the face limit and ignores a non-array', () => {
    const many = Array.from({ length: AGENT_VISUAL_FONT_MAX_FACES + 3 }, () =>
      face(),
    );
    expect(sanitizeAgentVisualFontFaces(many)).toHaveLength(
      AGENT_VISUAL_FONT_MAX_FACES,
    );
    expect(sanitizeAgentVisualFontFaces({ faces: many })).toEqual([]);
  });
});

describe('the fonts message', () => {
  it('carries sanitized faces under the fonts method', () => {
    const message = buildAgentVisualFontsMessage([
      face(),
      face({ family: 'Bad<' }),
    ]);
    expect(message.jsonrpc).toBe('2.0');
    expect(message.method).toBe(AGENT_VISUAL_FONTS_METHOD);
    expect(message.params.faces).toHaveLength(1);
  });

  it('keys a face by every descriptor', () => {
    expect(agentVisualFontFaceKey(face())).toBe(
      'Inter|normal|400 500|normal|U+0-10FFFF',
    );
    expect(agentVisualFontFaceKey(face({ style: 'italic' }))).not.toBe(
      agentVisualFontFaceKey(face()),
    );
  });
});

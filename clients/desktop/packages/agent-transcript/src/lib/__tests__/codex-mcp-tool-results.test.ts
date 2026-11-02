import {
  CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS,
  CODEX_TOOL_OUTPUT_CHUNK_MAX_CHARS,
  codexMcpToolName,
  codexMcpToolResult,
  codexMcpToolResultChunks,
  previewCodexMcpToolResult,
} from '../codex-mcp-tool-results';

describe('codexMcpToolName', () => {
  it('synthesizes the provider-accurate MCP tool name', () => {
    expect(
      codexMcpToolName('appproxy-internal-hub-prod--opaque', 'query-gcp-logs'),
    ).toBe('mcp__appproxy-internal-hub-prod--opaque__query-gcp-logs');
  });

  it('uses unknown for empty server and tool values', () => {
    expect(codexMcpToolName('', '')).toBe('mcp__unknown__unknown');
    expect(codexMcpToolName('github', '')).toBe('mcp__github__unknown');
    expect(codexMcpToolName('', 'create_issue')).toBe(
      'mcp__unknown__create_issue',
    );
  });

  it('preserves embedded delimiters and pins first-delimiter server parsing', () => {
    expect(codexMcpToolName('server__nested', 'tool__nested')).toBe(
      'mcp__server__nested__tool__nested',
    );
    // Existing parseMcpToolName() consumers split the first segment as the
    // server and retain later delimiters in the tool portion. Keeping the raw
    // values here deliberately pins that behavior instead of silently
    // rewriting provider identifiers.
  });
});

describe('previewCodexMcpToolResult', () => {
  it('joins multiple text content entries with blank lines', () => {
    expect(
      previewCodexMcpToolResult({
        status: 'completed',
        result: {
          content: [
            { type: 'text', text: 'first chunk' },
            { type: 'text', text: 'second chunk' },
          ],
        },
        error: null,
      }),
    ).toEqual({
      output: 'first chunk\n\nsecond chunk',
      isError: false,
    });
  });

  it('retains textual MCP resources', () => {
    expect(
      previewCodexMcpToolResult({
        status: 'completed',
        result: {
          content: [
            {
              type: 'resource',
              resource: {
                uri: 'file:///tmp/report.txt',
                mimeType: 'text/plain',
                text: 'resource text',
              },
            },
          ],
        },
        error: null,
      }),
    ).toEqual({ output: 'resource text', isError: false });
  });

  it('replaces image and audio payloads with safe placeholders', () => {
    expect(
      previewCodexMcpToolResult({
        status: 'completed',
        result: {
          content: [
            {
              type: 'image',
              mimeType: 'image/png',
              data: 'sensitive-image-payload',
            },
            {
              type: 'audio',
              mimeType: 'audio/wav',
              data: 'sensitive-audio-payload',
            },
          ],
        },
        error: null,
      }),
    ).toEqual({
      output: '[image output omitted]\n\n[audio output omitted]',
      isError: false,
    });
  });

  it('gives a transport error message precedence over result content', () => {
    expect(
      previewCodexMcpToolResult({
        status: 'failed',
        result: {
          content: [{ type: 'text', text: 'lower-precedence result' }],
          structuredContent: { lower: 'precedence' },
        },
        error: { message: 'connection reset', _meta: { secret: 'hidden' } },
      }),
    ).toEqual({ output: 'connection reset', isError: true });
  });

  it('retains failure text found only in result content', () => {
    expect(
      previewCodexMcpToolResult({
        status: 'failed',
        result: {
          content: [{ type: 'text', text: 'permission denied' }],
        },
        error: null,
      }),
    ).toEqual({ output: 'permission denied', isError: true });
  });

  it('pretty-prints structuredContent only when content is empty', () => {
    expect(
      previewCodexMcpToolResult({
        status: 'completed',
        result: {
          content: [],
          structuredContent: { issue: { id: 42, state: 'open' } },
        },
        error: null,
      }),
    ).toEqual({
      output: JSON.stringify({ issue: { id: 42, state: 'open' } }, null, 2),
      isError: false,
    });
  });

  it('uses structuredContent when text content entries are empty', () => {
    expect(
      previewCodexMcpToolResult({
        status: 'completed',
        result: {
          content: [{ type: 'text', text: '' }],
          structuredContent: { issue: { id: 42, state: 'open' } },
        },
        error: null,
      }),
    ).toEqual({
      output: JSON.stringify({ issue: { id: 42, state: 'open' } }, null, 2),
      isError: false,
    });
  });

  it('does not append large structuredContent when content text exists', () => {
    const largeValue = 'x'.repeat(500_000);
    const flattened = previewCodexMcpToolResult({
      status: 'completed',
      result: {
        content: [{ type: 'text', text: 'Created issue #42' }],
        structuredContent: { largeValue },
      },
      error: null,
    });

    expect(flattened).toEqual({
      output: 'Created issue #42',
      isError: false,
    });
    expect(flattened.output).not.toContain(largeValue);
  });

  it('bounds oversized textual content before persistence', () => {
    const oversizedText = 'x'.repeat(
      CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS * 16,
    );
    const flattened = previewCodexMcpToolResult({
      status: 'completed',
      result: {
        content: [
          { type: 'text', text: oversizedText },
          { type: 'text', text: 'unreachable trailing content' },
        ],
      },
      error: null,
    });

    expect(flattened.output.length).toBeLessThanOrEqual(
      CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS,
    );
    expect(flattened.output).toContain('[truncated');
    expect(flattened.output).not.toContain('unreachable trailing content');
  });

  it('bounds structuredContent strings before JSON formatting', () => {
    const oversizedValue = 'x'.repeat(
      CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS * 16,
    );
    const flattened = previewCodexMcpToolResult({
      status: 'completed',
      result: {
        content: [],
        structuredContent: {
          visible: true,
          oversizedValue,
          _meta: { token: 'hidden' },
        },
      },
      error: null,
    });

    expect(flattened.output.length).toBeLessThanOrEqual(
      CODEX_MCP_TOOL_RESULT_PREVIEW_MAX_CHARS,
    );
    expect(flattened.output).toContain('[truncated');
    expect(flattened.output).not.toContain(oversizedValue);
    expect(flattened.output).not.toContain('_meta');
    expect(flattened.output).not.toContain('hidden');
  });

  it('JSON-formats unknown serializable content entries', () => {
    expect(
      previewCodexMcpToolResult({
        status: 'completed',
        result: {
          content: [{ type: 'custom', value: { answer: 42 } }],
        },
        error: null,
      }),
    ).toEqual({
      output: JSON.stringify(
        { type: 'custom', value: { answer: 42 } },
        null,
        2,
      ),
      isError: false,
    });
  });

  it('excludes _meta from unknown and structured output', () => {
    const unknownOutput = previewCodexMcpToolResult({
      status: 'completed',
      result: {
        content: [
          {
            type: 'custom',
            value: { visible: true, _meta: { token: 'content-secret' } },
            _meta: { token: 'item-secret' },
          },
        ],
        _meta: { token: 'result-secret' },
      },
      error: null,
    });
    const structuredOutput = previewCodexMcpToolResult({
      status: 'completed',
      result: {
        content: [],
        structuredContent: {
          visible: true,
          _meta: { token: 'structured-secret' },
        },
        _meta: { token: 'result-secret' },
      },
      error: null,
    });

    expect(unknownOutput.output).toContain('"visible": true');
    expect(unknownOutput.output).not.toContain('_meta');
    expect(unknownOutput.output).not.toContain('secret');
    expect(structuredOutput.output).toContain('"visible": true');
    expect(structuredOutput.output).not.toContain('_meta');
    expect(structuredOutput.output).not.toContain('secret');
  });

  it('falls back to Done and Failed for empty terminal results', () => {
    expect(
      previewCodexMcpToolResult({
        status: 'completed',
        result: null,
        error: null,
      }),
    ).toEqual({ output: 'Done', isError: false });
    expect(
      previewCodexMcpToolResult({
        status: 'failed',
        result: { content: [] },
        error: null,
      }),
    ).toEqual({ output: 'Failed', isError: true });
  });
});

describe('codexMcpToolResult canonical', () => {
  const normalize = (
    result: unknown,
    status = 'completed',
    error: unknown = null,
  ): ReturnType<typeof codexMcpToolResult> =>
    codexMcpToolResult({ status, result, error });

  it('retains all text and resource content beyond preview limits', () => {
    const content: Array<Record<string, unknown>> = Array.from(
      { length: 101 },
      () => ({
        type: 'text',
        text: 'x'.repeat(1300),
      }),
    );
    content.push({ type: 'resource', resource: { text: 'last resource' } });
    const output = normalize({ content });
    expect(output.output.length).toBeGreaterThan(131_082);
    expect(output.output).toContain('last resource');
    expect(output.isError).toBe(false);
  });

  it('retains deep and wide structured content while stripping nested metadata', () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index < 3_001; index += 1) wide[`key-${index}`] = index;
    wide._meta = 'secret';
    let deep: unknown = { wide };
    for (let index = 0; index < 50; index += 1)
      deep = { nested: deep, _meta: 'secret' };
    const output = normalize({ content: [], structuredContent: deep }).output;
    expect(output).toContain('"key-3000": 3000');
    expect(output).not.toContain('_meta');
  });

  it('serializes 10,000-deep arrays without a call stack overflow', () => {
    let value: unknown = 'leaf';
    for (let index = 0; index < 10_000; index += 1) value = [value];
    const output = normalize({ structuredContent: value }).output;
    expect(output.startsWith('[\n')).toBe(true);
    // Indentation stops growing at depth 32, so the text stays linear in depth.
    expect(output.length).toBeLessThan(2_000_000);
    let parsed: unknown = JSON.parse(output);
    let depth = 0;
    while (Array.isArray(parsed)) {
      parsed = parsed[0];
      depth += 1;
    }
    expect(depth).toBe(10_000);
    expect(parsed).toBe('leaf');
  });

  it('falls back to the bounded preview when canonical serialization fails', () => {
    let reads = 0;
    const flaky = Object.defineProperty({}, 'value', {
      enumerable: true,
      get: (): string => {
        reads += 1;
        if (reads === 1) throw new Error('first read fails');
        return 'kept';
      },
    });
    expect(normalize({ structuredContent: flaky }).output).toBe(
      JSON.stringify({ value: 'kept' }, null, 2),
    );
  });

  it('distinguishes cycles from repeated references and preserves invalid placeholders', () => {
    const repeated = { value: 1, _meta: 'secret' };
    const cycle: Record<string, unknown> = { repeated };
    cycle.self = cycle;
    const output = normalize({
      structuredContent: {
        first: repeated,
        second: repeated,
        cycle,
        invalid: [undefined, Symbol('x'), BigInt(1), (): void => undefined],
      },
    }).output;
    expect(output.match(/"value": 1/g)).toHaveLength(3);
    expect(output).toContain('[circular output omitted]');
    expect(output).toContain('[unsupported undefined output omitted]');
    expect(output).toContain('[unsupported symbol output omitted]');
    expect(output).toContain('[unsupported bigint output omitted]');
    expect(output).toContain('[unsupported function output omitted]');
    expect(output).not.toContain('_meta');
  });

  it('matches JSON.stringify for ordinary JSON values without toJSON', () => {
    const key = 'k'.repeat(300);
    const value = Object.defineProperty(
      {
        '10': 'ten',
        '2': 'two',
        escaped: 'quote" slash\\ newline\n',
        [key]: 'long',
        nested: [{ _meta: 'hidden', a: true }],
      },
      '__proto__',
      {
        value: { safe: 'own' },
        enumerable: true,
      },
    );
    const expected = {
      '10': 'ten',
      '2': 'two',
      escaped: 'quote" slash\\ newline\n',
      [key]: 'long',
      nested: [{ a: true }],
    };
    Object.defineProperty(expected, '__proto__', {
      value: { safe: 'own' },
      enumerable: true,
    });
    expect(normalize({ structuredContent: value }).output).toBe(
      JSON.stringify(expected, null, 2),
    );
    expect(
      normalize({ structuredContent: { toJSON: () => 'bad', actual: 1 } })
        .output,
    ).toContain('[unsupported function output omitted]');
  });

  it('keeps error signaling and full messages', () => {
    expect(normalize({ isError: true }, 'completed').isError).toBe(true);
    expect(
      normalize(null, 'failed', { message: 'x'.repeat(70_000) }).output,
    ).toHaveLength(70_000);
  });
});

describe('codexMcpToolResultChunks', () => {
  const pair = '\u{1F600}';
  const escapes = 'q"\\\n\r\t\u0000\u001f  ';
  const chunksOf = (options: {
    status: string;
    result: unknown;
    error: unknown;
  }): string[] => Array.from(codexMcpToolResultChunks(options).chunks);
  const shared = { marker: 'shared-marker', _meta: { secret: 'meta' } };
  let deep: Record<string, unknown> = { leaf: 'deep-leaf' };
  for (let depth = 0; depth < 40; depth += 1) deep = { [`d${depth}`]: deep };

  const fixtures: Array<
    [string, { status: string; result: unknown; error: unknown }]
  > = [
    ['empty result', { status: 'completed', result: null, error: null }],
    [
      'failed without body',
      { status: 'failed', result: undefined, error: null },
    ],
    [
      'isError flag',
      { status: 'completed', result: { isError: true }, error: null },
    ],
    [
      'error message',
      {
        status: 'failed',
        result: null,
        error: { message: `boom ${'e'.repeat(70_000)}` },
      },
    ],
    [
      'error without message',
      {
        status: 'failed',
        result: { structuredContent: { a: 1 } },
        error: { code: 3 },
      },
    ],
    [
      'empty content falls back',
      {
        status: 'completed',
        result: {
          content: [{ type: 'text', text: '' }, { type: 'text' }],
          structuredContent: { kept: true },
        },
        error: null,
      },
    ],
    [
      'empty content array',
      { status: 'completed', result: { content: [] }, error: null },
    ],
    [
      'mixed content',
      {
        status: 'completed',
        result: {
          content: [
            { type: 'text', text: 'first' },
            { type: 'text', text: '' },
            { type: 'resource', resource: { text: 'resource-text' } },
            { type: 'resource', resource: { blob: 'AAAA' } },
            { type: 'image', data: 'AAAA', mimeType: 'image/png' },
            { type: 'audio', data: 'AAAA' },
            {
              type: 'custom',
              payload: { nested: [1, 'two', null], _meta: 'x' },
            },
            null,
            7,
            'bare string',
            [1, [2, [3]]],
          ],
        },
        error: null,
      },
    ],
    [
      'large multibyte text across slice boundaries',
      {
        status: 'completed',
        result: {
          content: [
            {
              type: 'text',
              text: `${'a'.repeat(16_383)}${pair}${'é'.repeat(40_000)}${pair.repeat(30_000)}`,
            },
            {
              type: 'text',
              text: `\uD800lone-high${'z'.repeat(16_382)}\uDC00lone-low\uD83D`,
            },
          ],
        },
        error: null,
      },
    ],
    [
      'structured only',
      {
        status: 'completed',
        result: {
          structuredContent: {
            _meta: { secret: 'never' },
            empty: {},
            emptyArray: [],
            first: shared,
            second: shared,
            numbers: [0, -0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21],
            flags: [true, false, null],
            unsupported: [undefined, (): number => 1, BigInt(3)],
            deep,
            [`k${escapes}${pair}`]: `v${escapes}`,
            [`huge-key-${'k'.repeat(20_000)}`]: 1,
            escaped: `${'x'.repeat(8_191)}${pair}${escapes.repeat(20_000)}\uDBFF`,
            wide: Array.from({ length: 5_000 }, (_, index) => ({ index })),
          },
        },
        error: null,
      },
    ],
    [
      'structured giant scalar',
      {
        status: 'completed',
        result: {
          structuredContent: `${escapes}${'s'.repeat(300_000)}${pair}\uDC00`,
        },
        error: null,
      },
    ],
  ];

  it.each(fixtures)('joins to the synchronous output: %s', (_name, options) => {
    const chunks = chunksOf(options);
    expect(chunks.join('') === codexMcpToolResult(options).output).toBe(true);
    expect(codexMcpToolResultChunks(options).isError).toBe(
      codexMcpToolResult(options).isError,
    );
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(
        CODEX_TOOL_OUTPUT_CHUNK_MAX_CHARS,
      );
    }
  });

  it('handles cycles like the synchronous form', () => {
    const cyclic: Record<string, unknown> = { name: 'root' };
    cyclic.self = cyclic;
    cyclic.list = [cyclic, { back: cyclic }];
    const options = {
      status: 'completed',
      result: { structuredContent: cyclic },
      error: null,
    };
    const output = chunksOf(options).join('');
    expect(output).toBe(codexMcpToolResult(options).output);
    expect(output).toContain('[circular output omitted]');
  });

  it('streams a giant scalar in bounded escaped chunks', () => {
    const value = `"${'\n'.repeat(1_000_000)}"`;
    const options = {
      status: 'completed',
      result: { structuredContent: value },
      error: null,
    };
    const chunks = chunksOf(options);
    expect(chunks.length).toBeGreaterThan(30);
    expect(
      Math.max(...chunks.map((chunk) => chunk.length)),
    ).toBeLessThanOrEqual(CODEX_TOOL_OUTPUT_CHUNK_MAX_CHARS);
    expect(chunks.join('')).toBe(JSON.stringify(value));
  });

  it('is lazy and re-iterable', () => {
    let reads = 0;
    const result = {
      get structuredContent(): unknown {
        reads += 1;
        return { a: 'b' };
      },
    };
    const { chunks } = codexMcpToolResultChunks({
      status: 'completed',
      result,
      error: null,
    });
    expect(reads).toBe(0);
    const first = Array.from(chunks).join('');
    expect(Array.from(chunks).join('')).toBe(first);
  });

  it('throws where the synchronous form falls back to a bounded preview', () => {
    const options = {
      status: 'completed',
      result: {
        structuredContent: {
          ok: 'value',
          get broken(): unknown {
            throw new Error('unreadable');
          },
        },
      },
      error: null,
    };
    expect(() => chunksOf(options)).toThrow('unreadable');
    // Its bounded fallback reads the same getter, so it settles on `Done`.
    expect(codexMcpToolResult(options).output).toBe('Done');
  });
});

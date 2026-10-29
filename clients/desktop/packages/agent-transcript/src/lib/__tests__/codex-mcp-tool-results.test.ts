import {
  CODEX_MCP_TOOL_RESULT_MAX_CHARS,
  codexMcpToolName,
  flattenCodexMcpToolResult,
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

describe('flattenCodexMcpToolResult', () => {
  it('joins multiple text content entries with blank lines', () => {
    expect(
      flattenCodexMcpToolResult({
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
      flattenCodexMcpToolResult({
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
      flattenCodexMcpToolResult({
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
      flattenCodexMcpToolResult({
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
      flattenCodexMcpToolResult({
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
      flattenCodexMcpToolResult({
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
      flattenCodexMcpToolResult({
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
    const flattened = flattenCodexMcpToolResult({
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
    const oversizedText = 'x'.repeat(CODEX_MCP_TOOL_RESULT_MAX_CHARS * 16);
    const flattened = flattenCodexMcpToolResult({
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
      CODEX_MCP_TOOL_RESULT_MAX_CHARS,
    );
    expect(flattened.output).toContain('[truncated');
    expect(flattened.output).not.toContain('unreachable trailing content');
  });

  it('bounds structuredContent strings before JSON formatting', () => {
    const oversizedValue = 'x'.repeat(CODEX_MCP_TOOL_RESULT_MAX_CHARS * 16);
    const flattened = flattenCodexMcpToolResult({
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
      CODEX_MCP_TOOL_RESULT_MAX_CHARS,
    );
    expect(flattened.output).toContain('[truncated');
    expect(flattened.output).not.toContain(oversizedValue);
    expect(flattened.output).not.toContain('_meta');
    expect(flattened.output).not.toContain('hidden');
  });

  it('JSON-formats unknown serializable content entries', () => {
    expect(
      flattenCodexMcpToolResult({
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
    const unknownOutput = flattenCodexMcpToolResult({
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
    const structuredOutput = flattenCodexMcpToolResult({
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
      flattenCodexMcpToolResult({
        status: 'completed',
        result: null,
        error: null,
      }),
    ).toEqual({ output: 'Done', isError: false });
    expect(
      flattenCodexMcpToolResult({
        status: 'failed',
        result: { content: [] },
        error: null,
      }),
    ).toEqual({ output: 'Failed', isError: true });
  });
});

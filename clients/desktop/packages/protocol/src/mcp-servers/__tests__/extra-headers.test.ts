import {
  MAX_MCP_EXTRA_HEADERS,
  MAX_MCP_EXTRA_HEADER_VALUE_LENGTH,
  MCP_EXTRA_HEADER_STORED_ALLOWED_STRIPPED,
  isBlockedMcpExtraHeaderName,
  mcpExtraHeadersProblem,
  parseMcpExtraHeaders,
  type McpExtraHeadersProblem,
} from '../index';

function headers(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, index) => [`x-h${index}`, 'v']),
  );
}

describe('mcpExtraHeadersProblem', (): void => {
  it('accepts token names, printable values and a stored X-Api-Key', (): void => {
    const valid = {
      'X-Tenant': 'acme',
      "x-custom!#$%&'*+.^_`|~": 'a\tb c',
      'X-Empty': '',
      'X-Api-Key': 'k'.repeat(MAX_MCP_EXTRA_HEADER_VALUE_LENGTH),
    };
    expect(mcpExtraHeadersProblem(valid)).toBeNull();
    expect(mcpExtraHeadersProblem({})).toBeNull();
    expect(mcpExtraHeadersProblem(headers(MAX_MCP_EXTRA_HEADERS))).toBeNull();
    expect(parseMcpExtraHeaders(valid)).toEqual(valid);
  });

  it.each<[string, unknown, McpExtraHeadersProblem]>([
    ['an array', ['x'], { kind: 'not_object' }],
    ['null', null, { kind: 'not_object' }],
    ['a string', 'x: y', { kind: 'not_object' }],
    [
      'too many entries',
      headers(MAX_MCP_EXTRA_HEADERS + 1),
      { kind: 'too_many' },
    ],
    [
      'a name with a space',
      { 'x tenant': 'v' },
      { kind: 'invalid_name', header: 'x tenant' },
    ],
    ['an empty name', { '': 'v' }, { kind: 'invalid_name', header: '' }],
    [
      'an oversized name',
      { ['x'.repeat(257)]: 'v' },
      { kind: 'invalid_name', header: 'x'.repeat(257) },
    ],
    [
      'a blocked name',
      { Authorization: 'Bearer x' },
      { kind: 'blocked_name', header: 'Authorization' },
    ],
    [
      'a case-insensitive duplicate',
      { 'X-Tenant': 'a', 'x-tenant': 'b' },
      { kind: 'duplicate_name', header: 'x-tenant' },
    ],
    [
      'a line break in a value',
      { 'X-Tenant': 'a\nb' },
      { kind: 'invalid_value', header: 'X-Tenant' },
    ],
    [
      'a non-string value',
      { 'X-Tenant': 1 },
      { kind: 'invalid_value', header: 'X-Tenant' },
    ],
    [
      'an oversized value',
      { 'X-Tenant': 'v'.repeat(MAX_MCP_EXTRA_HEADER_VALUE_LENGTH + 1) },
      { kind: 'value_too_long', header: 'X-Tenant' },
    ],
  ])('reports %s', (_label, value, problem): void => {
    expect(mcpExtraHeadersProblem(value)).toEqual(problem);
    expect(parseMcpExtraHeaders(value)).toBeNull();
  });

  it.each([
    'authorization',
    'Proxy-Authorization',
    'HOST',
    'content-length',
    'Transfer-Encoding',
    'connection',
    'accept-encoding',
    'Cookie',
    'mcp-session-id',
    'TE',
    'trailer',
    'upgrade',
    'keep-alive',
    'x-canopy-workspace',
    'X-Canopy-Worktree',
    'X-Canopy-Org-Project',
    'X-Canopy-Work-Owner',
  ])('blocks %s case-insensitively', (name): void => {
    expect(isBlockedMcpExtraHeaderName(name)).toBe(true);
  });

  it('lets a connection store X-Api-Key', (): void => {
    expect([...MCP_EXTRA_HEADER_STORED_ALLOWED_STRIPPED]).toEqual([
      'x-api-key',
    ]);
    expect(isBlockedMcpExtraHeaderName('X-Api-Key')).toBe(false);
  });

  it('keeps a __proto__ name as data', (): void => {
    const parsed = parseMcpExtraHeaders(JSON.parse('{"__proto__":"v"}'));
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.entries(parsed ?? {})).toEqual([['__proto__', 'v']]);
  });
});

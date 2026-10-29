import {
  cursorLoadsPluginMemberKind,
  cursorPluginFacetProvider,
  cursorPluginFacetSupport,
  type CursorLoadablePluginDetails,
} from '../cursor-support';

const details = (
  overrides: Partial<CursorLoadablePluginDetails> = {},
): CursorLoadablePluginDetails => ({
  mcpServers: [],
  skills: [],
  commands: [],
  ...overrides,
});
const one = [{ name: 'member' }];

describe('cursorPluginFacetProvider', () => {
  it('reads the Claude facet when there is one, else native Codex, never a compat facet', () => {
    expect(cursorPluginFacetProvider({ claude: {}, codex: {} })).toBe('claude');
    expect(cursorPluginFacetProvider({ codex: {} })).toBe('codex');
    expect(cursorPluginFacetProvider({})).toBe('codex');
    expect(cursorPluginFacetProvider({ codexCompatibility: {} })).toBe('codex');
  });
});

describe('cursorLoadsPluginMemberKind', () => {
  it('loads MCP servers and skills from either provider and commands from a Claude plugin only', () => {
    expect(cursorLoadsPluginMemberKind('claude', 'mcpServers')).toBe(true);
    expect(cursorLoadsPluginMemberKind('codex', 'mcpServers')).toBe(true);
    expect(cursorLoadsPluginMemberKind('claude', 'skills')).toBe(true);
    expect(cursorLoadsPluginMemberKind('codex', 'skills')).toBe(true);
    expect(cursorLoadsPluginMemberKind('claude', 'commands')).toBe(true);
    expect(cursorLoadsPluginMemberKind('codex', 'commands')).toBe(false);
  });
});

describe('cursorPluginFacetSupport', () => {
  it('reads the Claude facet when there is one, else the native Codex facet', () => {
    expect(
      cursorPluginFacetSupport({
        claude: { details: details() },
        codex: { details: details({ skills: one }) },
      }),
    ).toEqual({ provider: 'claude', supported: false });
    expect(
      cursorPluginFacetSupport({
        codex: { details: details({ skills: one }) },
      }),
    ).toEqual({ provider: 'codex', supported: true });
    expect(cursorPluginFacetSupport({})).toEqual({
      provider: 'codex',
      supported: false,
    });
  });

  it('counts MCP servers and skills from either facet', () => {
    expect(
      cursorPluginFacetSupport({
        claude: { details: details({ mcpServers: one }) },
      }).supported,
    ).toBe(true);
    expect(
      cursorPluginFacetSupport({
        claude: { details: details({ skills: one }) },
      }).supported,
    ).toBe(true);
    expect(
      cursorPluginFacetSupport({
        codex: { details: details({ mcpServers: one }) },
      }).supported,
    ).toBe(true);
    expect(
      cursorPluginFacetSupport({ codex: { details: details({ skills: one }) } })
        .supported,
    ).toBe(true);
  });

  it('counts commands from a Claude facet only', () => {
    expect(
      cursorPluginFacetSupport({
        claude: { details: details({ commands: one }) },
      }).supported,
    ).toBe(true);
    expect(
      cursorPluginFacetSupport({
        codex: { details: details({ commands: one }) },
      }).supported,
    ).toBe(false);
  });

  it('reports a facet with nothing a Cursor session loads as unsupported', () => {
    // Hooks, agents, LSP servers, and apps are not in the loadable shape at
    // all; a facet carrying only those has three empty lists here.
    expect(
      cursorPluginFacetSupport({ claude: { details: details() } }).supported,
    ).toBe(false);
    expect(cursorPluginFacetSupport({ claude: {} }).supported).toBe(false);
    expect(
      cursorPluginFacetSupport({ claude: { details: null } }).supported,
    ).toBe(false);
  });
});

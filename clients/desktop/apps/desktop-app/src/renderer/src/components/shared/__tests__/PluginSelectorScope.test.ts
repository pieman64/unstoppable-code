import { getUnsupportedReason } from '../pluginSelectorScope';

describe('getUnsupportedReason', () => {
  it('returns null when support is undefined', () => {
    expect(getUnsupportedReason(undefined, 'claude')).toBeNull();
    expect(getUnsupportedReason(undefined, 'codex')).toBeNull();
  });

  it('returns null for every plugin under mixed scope', () => {
    expect(
      getUnsupportedReason({ claude: 'none', codex: 'native' }, 'mixed'),
    ).toBeNull();
    expect(
      getUnsupportedReason({ claude: 'native', codex: 'none' }, 'mixed'),
    ).toBeNull();
  });

  describe('claude scope', () => {
    it('allows Claude-native plugins', () => {
      expect(
        getUnsupportedReason({ claude: 'native', codex: 'native' }, 'claude'),
      ).toBeNull();
      expect(
        getUnsupportedReason({ claude: 'native', codex: 'none' }, 'claude'),
      ).toBeNull();
    });

    it('disables Codex-only plugins with the expected tooltip', () => {
      expect(
        getUnsupportedReason({ claude: 'none', codex: 'native' }, 'claude'),
      ).toBe('Only available for Codex');
    });
  });

  describe('ollama scope', () => {
    it('mirrors claude-scope behavior: Claude-native is allowed', () => {
      expect(
        getUnsupportedReason({ claude: 'native', codex: 'native' }, 'ollama'),
      ).toBeNull();
    });

    it('disables Codex-only plugins for Ollama sessions', () => {
      expect(
        getUnsupportedReason({ claude: 'none', codex: 'native' }, 'ollama'),
      ).toBe('Only available for Codex');
    });
  });

  describe('codex scope', () => {
    it('allows Codex-native plugins', () => {
      expect(
        getUnsupportedReason({ claude: 'none', codex: 'native' }, 'codex'),
      ).toBeNull();
    });

    it('allows Claude-derived compat plugins', () => {
      expect(
        getUnsupportedReason({ claude: 'native', codex: 'compat' }, 'codex'),
      ).toBeNull();
    });

    it('disables plugins that have no Codex story', () => {
      expect(
        getUnsupportedReason({ claude: 'native', codex: 'none' }, 'codex'),
      ).toBe('Only available for Claude');
    });
  });
});

describe('cursor scope', () => {
  it('allows every plugin row: only its MCP servers are loaded, the rest is ignored', () => {
    expect(
      getUnsupportedReason({ claude: 'native', codex: 'none' }, 'cursor'),
    ).toBeNull();
    expect(
      getUnsupportedReason({ claude: 'none', codex: 'native' }, 'cursor'),
    ).toBeNull();
  });
});

import { resolveDiscoveryProviderType } from '../discovery';

describe('resolveDiscoveryProviderType', () => {
  it('keeps the Ollama discovery key before a fresh tab captures a harness', () => {
    expect(
      resolveDiscoveryProviderType({
        providerType: 'ollama',
        model: 'ollama-qwen3',
      }),
    ).toBe('ollama');
  });
  it('uses Claude discovery for a gateway model selected on Claude', () => {
    expect(
      resolveDiscoveryProviderType({
        providerType: 'codex',
        model: 'gateway-model',
        executionHarness: 'claude',
      }),
    ).toBe('claude');
  });

  it('uses Codex discovery for an Ollama model captured on the Codex harness', () => {
    expect(
      resolveDiscoveryProviderType({
        providerType: 'ollama',
        model: 'ollama-qwen3',
        executionHarness: 'codex',
      }),
    ).toBe('codex');
  });

  it('keeps Ollama discovery for an Ollama model captured on the Claude harness', () => {
    expect(
      resolveDiscoveryProviderType({
        providerType: 'ollama',
        model: 'ollama-qwen3',
        executionHarness: 'claude',
      }),
    ).toBe('ollama');
  });
});

import { shouldMaterializeCodexThread } from '../codex-thread-materialization';

describe('shouldMaterializeCodexThread', () => {
  it('defers an existing Ollama-source thread captured on Codex until send', () => {
    expect(
      shouldMaterializeCodexThread({
        providerType: 'ollama',
        executionHarness: 'codex',
        sdkSessionId: 'thread-1',
      }),
    ).toBe(false);
  });

  it('does not materialize an Ollama-source thread captured on Claude', () => {
    expect(
      shouldMaterializeCodexThread({
        providerType: 'ollama',
        executionHarness: 'claude',
        sdkSessionId: 'session-1',
      }),
    ).toBe(false);
  });
});

describe('Ollama disabled build behavior', () => {
  const globalWithOllamaFlag = globalThis as typeof globalThis & {
    __CANOPY_OLLAMA_ENABLED__: boolean;
  };
  const originalOllamaEnabled = globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__;

  beforeEach(() => {
    globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__ = false;
  });

  afterAll(() => {
    globalWithOllamaFlag.__CANOPY_OLLAMA_ENABLED__ = originalOllamaEnabled;
  });

  it('returns an empty model registry and rejects startup paths', async () => {
    const { getOllamaService, OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE } =
      await import('../ollama/service');

    const service = getOllamaService();
    await service.initialize();

    expect((await service.getState()).models).toEqual([]);
    await expect(service.ensureServerRunning('chat')).rejects.toThrow(
      OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE,
    );
    await expect(service.pullModel('llama3')).rejects.toThrow(
      OLLAMA_UNSUPPORTED_PLATFORM_MESSAGE,
    );
  });
});

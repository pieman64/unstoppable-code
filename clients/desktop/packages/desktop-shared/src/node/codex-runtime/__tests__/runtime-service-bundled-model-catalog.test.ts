import { createCodexRuntimeService } from '../runtime-service';

describe('CodexRuntimeService bundled model catalog', () => {
  it('returns catalog data through the runtime-owned loader', async () => {
    const catalog = { models: [{ slug: 'gpt-test' }] };
    const loader = jest.fn(() => Promise.resolve(catalog));
    const service = createCodexRuntimeService({
      bundledModelCatalogLoader: loader,
    });

    await expect(service.getBundledModelCatalog()).resolves.toBe(catalog);
    expect(loader).toHaveBeenCalledTimes(1);
    await service.shutdown();
  });

  it('aborts an in-flight catalog read during shutdown', async () => {
    let loaderSignal: AbortSignal | undefined;
    const loader = jest.fn(
      (signal: AbortSignal) =>
        new Promise<unknown>((_resolve, reject) => {
          loaderSignal = signal;
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    const service = createCodexRuntimeService({
      bundledModelCatalogLoader: loader,
    });

    const load = service.getBundledModelCatalog();
    const shutdown = service.shutdown();
    await expect(load).rejects.toThrow('aborted');
    await expect(shutdown).resolves.toBeUndefined();
    expect(loaderSignal?.aborted).toBe(true);
  });
});

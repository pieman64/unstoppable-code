import {
  sharedProjectDiscovery,
  withSharedProjectDiscovery,
} from '../pipelines/shared-project-discovery';

describe('shared project discovery', () => {
  it('discovers a checkout once per key inside a shared scope', async () => {
    const discover = jest.fn(() => Promise.resolve([]));
    await withSharedProjectDiscovery(async () => {
      await Promise.all(
        Array.from({ length: 5 }, () => sharedProjectDiscovery('a', discover)),
      );
      await sharedProjectDiscovery('b', discover);
    });
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it('discovers every time outside one', async () => {
    const discover = jest.fn(() => Promise.resolve([]));
    await sharedProjectDiscovery('a', discover);
    await sharedProjectDiscovery('a', discover);
    expect(discover).toHaveBeenCalledTimes(2);
  });
});

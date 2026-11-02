const mockCanopyPathsLoaded = jest.fn();
jest.mock('../../../canopy-paths', () => {
  mockCanopyPathsLoaded();
  return { getCanopyDataDir: (): string => '/mock/home/.canopy' };
});

// Many suites mock canopy-paths with factories that read `const`s declared
// after their imports; loading it while atomic-file loads hits their TDZ.
it('loads atomic-file without loading canopy-paths', async () => {
  await import('../atomic-file');
  expect(mockCanopyPathsLoaded).not.toHaveBeenCalled();
});

// win32 skips membership, so it never resolves the data root.
const posix = process.platform === 'win32' ? it.skip : it;
posix(
  'resolves canopy-paths when a shared write checks membership',
  async () => {
    const cohort = await import('../../w5-host-cohort');
    await expect(cohort.ensureW5HostMembership()).rejects.toMatchObject({
      reason: 'unregistered-writer',
    });
    expect(mockCanopyPathsLoaded).toHaveBeenCalledTimes(1);
  },
);

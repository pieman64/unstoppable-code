import {
  hostW5ConfinementAddon,
  selectW5ConfinementAddon,
  type W5ConfinementAddonHost,
} from '../confinement-addon';

const windowsHost: W5ConfinementAddonHost = {
  os: 'win32',
  runtimeMode: 'prod',
  arch: 'x64',
  resourcesPath: 'C:\\Program Files\\Canopy\\resources',
  sourceDirectory: 'D:\\src\\canopy\\.cache\\native-owned-child',
};

it.each([
  [
    'an installed app: its staged CLI resources',
    {},
    'C:\\Program Files\\Canopy\\resources\\cli\\core-owned-child.node',
  ],
  [
    'an rc build: its staged CLI resources',
    { runtimeMode: 'rc' },
    'C:\\Program Files\\Canopy\\resources\\cli\\core-owned-child.node',
  ],
  [
    'a dev runtime: the build:owned-child output of the build',
    { runtimeMode: 'dev' },
    'D:\\src\\canopy\\.cache\\native-owned-child\\win32-x64\\core-owned-child.node',
  ],
  [
    'a dev arm64 runtime: its own architecture',
    { runtimeMode: 'dev', arch: 'arm64' },
    'D:\\src\\canopy\\.cache\\native-owned-child\\win32-arm64\\core-owned-child.node',
  ],
  [
    'a dev bundle without the build location',
    { runtimeMode: 'dev', sourceDirectory: undefined },
    undefined,
  ],
  [
    'an installed runtime outside Electron',
    { resourcesPath: undefined },
    undefined,
  ],
  ['macOS', { os: 'darwin' }, undefined],
  ['Linux', { os: 'linux', runtimeMode: 'dev' }, undefined],
  ['an unsupported OS', { os: null }, undefined],
] as const)('selects for %s', (_name, overrides, expected) => {
  expect(selectW5ConfinementAddon({ ...windowsHost, ...overrides })).toBe(
    expected,
  );
});

it('never resolves the dev addon against the working directory', () => {
  const sourceDirectory = 'D:\\src\\canopy\\.cache\\native-owned-child';
  const cwd = jest.spyOn(process, 'cwd').mockReturnValue('C:\\elsewhere');
  try {
    expect(
      selectW5ConfinementAddon({
        ...windowsHost,
        runtimeMode: 'dev',
        sourceDirectory,
      }),
    ).toBe(`${sourceDirectory}\\win32-x64\\core-owned-child.node`);
    expect(cwd).not.toHaveBeenCalled();
  } finally {
    cwd.mockRestore();
  }
});

it('selects nothing in a process that is neither Electron nor a bundled build', () => {
  // No `process.resourcesPath`, and no build-time source directory.
  expect(hostW5ConfinementAddon()).toBeUndefined();
});

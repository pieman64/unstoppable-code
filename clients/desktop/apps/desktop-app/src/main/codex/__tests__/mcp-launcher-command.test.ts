import { resolve } from 'node:path';
import { BRAND } from '@canopy/brand/current';
import { daemonName } from '@canopy/protocol/brand';
import { resolveDesktopCodexMcpLauncher } from '../mcp-launcher-command';

const mockApp = { isPackaged: true };
const mockOperatingSystem = jest.fn<string, []>(() => 'darwin');

jest.mock('electron', (): { readonly app: typeof mockApp } => ({
  get app(): typeof mockApp {
    return mockApp;
  },
}));
jest.mock(
  '@canopy/desktop-shared/pipelines/config-paths',
  (): { getBundledBinDir: () => string } => ({
    getBundledBinDir: (): string => '/opt/brand/bin',
  }),
);
jest.mock(
  '@canopy/core-platform',
  (): { hostPlatformOperatingSystem: () => string } => ({
    hostPlatformOperatingSystem: (): string => mockOperatingSystem(),
  }),
);

it('projects the daemon executable, never the CLI', () => {
  const name = daemonName(BRAND);

  mockApp.isPackaged = true;
  mockOperatingSystem.mockReturnValue('darwin');
  const packaged = resolveDesktopCodexMcpLauncher();
  expect(packaged).toEqual({ command: `/opt/brand/bin/${name}`, args: [] });

  mockOperatingSystem.mockReturnValue('win32');
  const windows = resolveDesktopCodexMcpLauncher();
  expect(windows.command.endsWith(`${name}.exe`)).toBe(true);

  mockApp.isPackaged = false;
  mockOperatingSystem.mockReturnValue('darwin');
  const unpackaged = resolveDesktopCodexMcpLauncher();
  expect(unpackaged).toEqual({
    command: resolve('dist/core-daemon', name),
    args: [],
  });

  for (const launcher of [packaged, windows, unpackaged]) {
    const lastSegment = launcher.command.split(/[\\/]/).pop();
    expect(lastSegment).not.toBe(BRAND.cliName);
    expect(lastSegment).not.toBe(`${BRAND.cliName}.exe`);
    expect(launcher).not.toHaveProperty('cwd');
  }
});

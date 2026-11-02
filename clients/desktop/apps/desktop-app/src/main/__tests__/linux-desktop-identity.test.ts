import { BRAND } from '@canopy/brand/current';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import canopyBrand from '../../../../../brands/canopy/brand.json';
import unstoppableCodeBrand from '../../../../../brands/unstoppable-code/brand.json';
import { configureLinuxDesktopIdentity } from '../lib/linux-desktop-identity';

jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: jest.fn(() => 'linux'),
}));

import { hostOperatingSystem } from '@canopy/core-platform/host-platform';

const originalDesktopName = process.env.CHROME_DESKTOP;
const originalReleaseFlavor: unknown = Reflect.get(
  globalThis,
  '__CANOPY_RELEASE_FLAVOR__',
);
const root = join(__dirname, '../../../../..');

afterEach(() => {
  if (originalDesktopName === undefined) delete process.env.CHROME_DESKTOP;
  else process.env.CHROME_DESKTOP = originalDesktopName;
  if (typeof originalReleaseFlavor === 'string')
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', originalReleaseFlavor);
  else Reflect.deleteProperty(globalThis, '__CANOPY_RELEASE_FLAVOR__');
  jest.mocked(hostOperatingSystem).mockReturnValue('linux');
});

describe.each([canopyBrand, unstoppableCodeBrand])(
  '$id Linux identity',
  (brand) => {
    it.skip.each(['stable', 'rc', 'internal'])(
      'matches the generated %s desktop entry for windows and notifications',
      (flavor) => {
        Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', flavor);
        const config: unknown = JSON.parse(
          readFileSync(
            execFileSync(
              process.execPath,
              [
                join(
                  root,
                  'scripts/brand/generate-electron-builder-config.mjs',
                ),
                '--brand',
                brand.id,
                '--release-flavor',
                flavor,
                '--no-current',
              ],
              { cwd: root, encoding: 'utf8' },
            ).trim(),
            'utf8',
          ),
        );
        const app = { setName: jest.fn<void, [string]>() };
        process.env.CHROME_DESKTOP = 'electron.desktop';

        configureLinuxDesktopIdentity(app, brand);

        expect(app.setName).toHaveBeenCalledTimes(1);
        // Electron 42 strips this suffix for WM_CLASS, Wayland app_id and the
        // libnotify desktop-entry hint, which GNOME uses to resolve Name/Icon.
        const appId = process.env.CHROME_DESKTOP?.replace(/\.desktop$/, '');
        expect(config).toMatchObject({
          extraMetadata: { desktopName: process.env.CHROME_DESKTOP },
          linux: {
            executableName: appId,
            desktop: {
              entry: {
                Name: app.setName.mock.calls[0]?.[0],
                StartupWMClass: appId,
                Icon: appId,
              },
            },
          },
        });
      },
    );
  },
);

it('uses the injected brand by default', () => {
  Reflect.deleteProperty(globalThis, '__CANOPY_RELEASE_FLAVOR__');
  const app = { setName: jest.fn<void, [string]>() };
  configureLinuxDesktopIdentity(app);
  expect(app.setName).toHaveBeenCalledWith(BRAND.displayName);
  expect(process.env.CHROME_DESKTOP).toBe(`${BRAND.cliName}-desktop.desktop`);
});

it.each(['darwin', 'win32', null] as const)(
  'leaves the app name and desktop identity unchanged on %s',
  (platform) => {
    jest.mocked(hostOperatingSystem).mockReturnValue(platform);
    process.env.CHROME_DESKTOP = 'inherited.desktop';
    const app = { setName: jest.fn<void, [string]>() };
    configureLinuxDesktopIdentity(app);
    expect(app.setName).not.toHaveBeenCalled();
    expect(process.env.CHROME_DESKTOP).toBe('inherited.desktop');
  },
);

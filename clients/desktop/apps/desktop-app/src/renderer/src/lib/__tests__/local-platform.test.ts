/** @jest-environment jsdom */
import { shouldReserveSidebarTrafficLightRegion } from '@/components/sidebar-layout';
import { localPlatform } from '../local-platform';

type PlatformWindow = Window & {
  platform?: NodeJS.Platform;
  localPlatform?: NodeJS.Platform;
};

function setPlatforms(
  platform: NodeJS.Platform | undefined,
  local: NodeJS.Platform | undefined,
): void {
  const target: PlatformWindow = window;
  Object.defineProperty(target, 'platform', {
    configurable: true,
    value: platform,
  });
  Object.defineProperty(target, 'localPlatform', {
    configurable: true,
    value: local,
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, 'platform');
  Reflect.deleteProperty(window, 'localPlatform');
});

describe('localPlatform', () => {
  it("reads this computer's platform in a window that shows another one", () => {
    // A Mac controlling a Linux computer: paths are Linux, the window is a Mac's.
    setPlatforms('linux', 'darwin');
    expect(localPlatform()).toBe('darwin');
    expect(shouldReserveSidebarTrafficLightRegion(localPlatform())).toBe(true);
  });

  it('falls back to window.platform outside a remote window', () => {
    setPlatforms('win32', undefined);
    expect(localPlatform()).toBe('win32');
  });
});

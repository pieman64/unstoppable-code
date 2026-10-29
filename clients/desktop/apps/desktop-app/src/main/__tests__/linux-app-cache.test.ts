import { detectInstalledApps, refreshDetectedApps } from '../lib/app-detection';
import { detectLinuxDesktopApps } from '../lib/linux-desktop-apps';
import type { DetectedApp } from '@canopy/desktop-shared/types';

jest.mock('@canopy/core-platform/host-platform', () => ({
  hostOperatingSystem: (): 'linux' => 'linux',
}));
jest.mock('../lib/linux-desktop-apps', () => ({
  detectLinuxDesktopApps: jest.fn(),
  linuxDesktopLaunchSpec: jest.fn(),
}));

test('old in-flight failure cannot invalidate the refresh generation', async () => {
  let rejectOld: (error: Error) => void = () => {};
  const old = new Promise<DetectedApp[]>((_resolve, reject) => {
    rejectOld = reject;
  });
  jest
    .mocked(detectLinuxDesktopApps)
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce([]);
  const loading = refreshDetectedApps();
  const rejected = expect(loading).rejects.toThrow('old failure');
  await expect(refreshDetectedApps()).resolves.toEqual([]);
  rejectOld(new Error('old failure'));
  await rejected;
  await expect(detectInstalledApps()).resolves.toEqual([]);
  expect(detectLinuxDesktopApps).toHaveBeenCalledTimes(2);
});

test('old successful scan cannot replace refreshed results', async () => {
  let resolveOld: (apps: DetectedApp[]) => void = () => {};
  const old = new Promise<DetectedApp[]>((resolve) => {
    resolveOld = resolve;
  });
  jest
    .mocked(detectLinuxDesktopApps)
    .mockReturnValueOnce(old)
    .mockResolvedValueOnce([]);
  const loading = refreshDetectedApps();
  await refreshDetectedApps();
  resolveOld([{ id: 'old', name: 'Old', category: 'editor', icon: '' }]);
  await loading;
  await expect(detectInstalledApps()).resolves.toEqual([]);
});

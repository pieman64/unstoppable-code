import { BRAND } from '@canopy/brand/current';

export type CanopyReleaseFlavor = 'stable' | 'rc' | 'internal';

export function getCanopyReleaseFlavor(): CanopyReleaseFlavor {
  if (typeof __CANOPY_RELEASE_FLAVOR__ === 'undefined') {
    return 'stable';
  }

  if (__CANOPY_RELEASE_FLAVOR__ === 'internal') {
    return 'internal';
  }

  if (__CANOPY_RELEASE_FLAVOR__ === 'rc') {
    return 'rc';
  }

  return 'stable';
}

export function getRuntimeAppUserModelId(appId: string = BRAND.appId): string {
  const flavor = getCanopyReleaseFlavor();
  if (flavor === 'internal') {
    return `${appId}.dev`;
  }
  if (flavor === 'rc') {
    return `${appId}.rc`;
  }
  return appId;
}

export function getRuntimeAppName(
  displayName: string = BRAND.displayName,
): string {
  const flavor = getCanopyReleaseFlavor();
  if (flavor === 'internal') {
    return `${displayName} (Internal)`;
  }
  if (flavor === 'rc') {
    return `${displayName} (RC)`;
  }
  return displayName;
}

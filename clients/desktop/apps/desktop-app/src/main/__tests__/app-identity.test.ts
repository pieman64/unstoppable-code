import {
  getCanopyReleaseFlavor,
  getRuntimeAppName,
  getRuntimeAppUserModelId,
} from '../lib/app-identity';

describe('app identity', () => {
  beforeEach(() => {
    Reflect.deleteProperty(globalThis, '__CANOPY_RELEASE_FLAVOR__');
  });

  it('defaults to the stable app identity', () => {
    expect(getCanopyReleaseFlavor()).toBe('stable');
    expect(getRuntimeAppName('Canopy')).toBe('Canopy');
    expect(getRuntimeAppUserModelId('com.canopy.ui')).toBe('com.canopy.ui');
  });

  it('keeps stable builds on the public app identity', () => {
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'stable');

    expect(getCanopyReleaseFlavor()).toBe('stable');
    expect(getRuntimeAppName('Canopy')).toBe('Canopy');
    expect(getRuntimeAppUserModelId('com.canopy.ui')).toBe('com.canopy.ui');
  });

  it('uses a separate app identity for internal builds', () => {
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'internal');

    expect(getCanopyReleaseFlavor()).toBe('internal');
    expect(getRuntimeAppName('Canopy')).toBe('Canopy (Internal)');
    expect(getRuntimeAppUserModelId('com.canopy.ui')).toBe('com.canopy.ui.dev');
  });

  it('uses a separate app identity for release candidate builds', () => {
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'rc');

    expect(getCanopyReleaseFlavor()).toBe('rc');
    expect(getRuntimeAppName('Canopy')).toBe('Canopy (RC)');
    expect(getRuntimeAppUserModelId('com.canopy.ui')).toBe('com.canopy.ui.rc');
  });

  it('treats unknown release flavor values as stable', () => {
    Reflect.set(globalThis, '__CANOPY_RELEASE_FLAVOR__', 'preview');

    expect(getCanopyReleaseFlavor()).toBe('stable');
    expect(getRuntimeAppName('Canopy')).toBe('Canopy');
    expect(getRuntimeAppUserModelId('com.canopy.ui')).toBe('com.canopy.ui');
  });
});

import type * as PortalClientPlatformModule from '../portal-client-platform';
const mockHostPlatformOperatingSystem = jest.fn();

jest.mock('@canopy/core-platform', () => ({
  hostPlatformOperatingSystem: mockHostPlatformOperatingSystem,
}));

const {
  isPortalHostCode,
  portalClientPlatformFor,
  resolvePortalClientPlatform,
} = jest.requireActual<typeof PortalClientPlatformModule>(
  '../portal-client-platform',
);

describe('Portal client platform', () => {
  it('maps supported operating systems to protocol platform names', () => {
    expect(portalClientPlatformFor('darwin')).toBe('mac');
    expect(portalClientPlatformFor('win32')).toBe('windows');
    expect(portalClientPlatformFor('linux')).toBe('linux');
  });

  it('returns undefined for unsupported operating systems', () => {
    for (const operatingSystem of ['freebsd', 'aix', '']) {
      expect(portalClientPlatformFor(operatingSystem)).toBeUndefined();
    }
  });

  it('returns undefined when host operating-system detection throws', () => {
    mockHostPlatformOperatingSystem.mockImplementation(() => {
      throw new Error('unavailable');
    });

    expect(resolvePortalClientPlatform()).toBeUndefined();
  });

  it('accepts a ten-character lowercase Crockford base32 host code', () => {
    expect(isPortalHostCode('k3m9p2x7qa')).toBe(true);
  });

  it.each([
    'K3M9P2X7QA',
    'k3m9p2x7q',
    'k3m9p2x7qaa',
    'iiiiiiiiii',
    'llllllllll',
    'oooooooooo',
    'uuuuuuuuuu',
  ])('rejects invalid host code %s', (value) => {
    expect(isPortalHostCode(value)).toBe(false);
  });

  it('rejects values that are not strings as host codes', () => {
    for (const value of [undefined, null, 123, {}, []]) {
      expect(isPortalHostCode(value)).toBe(false);
    }
  });
});

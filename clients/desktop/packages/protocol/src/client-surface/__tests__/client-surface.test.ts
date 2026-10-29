import {
  CLIENT_SURFACE_HEADER,
  CLIENT_SURFACE_VERSION_HEADER,
  parseClientSurfaceHeader,
  parseClientVersionHeader,
} from '../index';

describe('client surface headers', () => {
  it('exports the canonical header names', () => {
    expect(CLIENT_SURFACE_HEADER).toBe('x-canopy-client');
    expect(CLIENT_SURFACE_VERSION_HEADER).toBe('x-canopy-client-version');
  });

  it.each(['web', 'mobile', 'desktop'] as const)(
    'accepts the exact surface %s',
    (surface) => {
      expect(parseClientSurfaceHeader(surface)).toBe(surface);
    },
  );

  it.each([null, '', 'WEB', ' web', 'web ', 'other', 'web,mobile'])(
    'rejects the surface value %p',
    (value) => {
      expect(parseClientSurfaceHeader(value)).toBeNull();
    },
  );
});

describe('client version headers', () => {
  it.each(['1', '1.2.3', 'build+42', 'alpha-beta', 'A'.repeat(32)])(
    'accepts the version value %p',
    (value) => {
      expect(parseClientVersionHeader(value)).toBe(value);
    },
  );

  it.each([null, '', 'A'.repeat(33), '1.0 beta', '1_0', '1/0', '1.0,2.0'])(
    'rejects the version value %p',
    (value) => {
      expect(parseClientVersionHeader(value)).toBeNull();
    },
  );
});

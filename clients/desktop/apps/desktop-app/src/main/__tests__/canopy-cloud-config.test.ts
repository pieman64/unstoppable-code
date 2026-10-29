// Unit tests for the Canopy Cloud base-URL resolution, including the
// build-gated E2E runtime override seam (`CANOPY_E2E_CLOUD_BASE_URL`).
// Jest bakes `__CANOPY_E2E__ === false`, so these tests pin the production
// (gate-OFF) behavior: the runtime env var must be ignored and the
// build-time `__CANOPY_CLOUD_BASE_URL__` constant must win. The gate-ON
// behavior is exercised by the Playwright portal E2E suite, which points a
// real E2E build at a per-run web server.

import {
  getCanopyCloudBaseUrl,
  normalizeCanopyCloudBaseUrl,
  resetCanopyCloudBaseUrlCacheForTest,
} from '../canopy-cloud/config';

describe('getCanopyCloudBaseUrl (gate-OFF / production)', () => {
  const originalOverride = process.env.CANOPY_E2E_CLOUD_BASE_URL;

  beforeEach(() => {
    resetCanopyCloudBaseUrlCacheForTest();
  });

  afterEach(() => {
    if (originalOverride === undefined) {
      delete process.env.CANOPY_E2E_CLOUD_BASE_URL;
    } else {
      process.env.CANOPY_E2E_CLOUD_BASE_URL = originalOverride;
    }
    resetCanopyCloudBaseUrlCacheForTest();
  });

  it('ignores CANOPY_E2E_CLOUD_BASE_URL in production builds', () => {
    process.env.CANOPY_E2E_CLOUD_BASE_URL = 'http://127.0.0.1:4061';
    // Jest's globals bake `__CANOPY_CLOUD_BASE_URL__` for tests; whatever it
    // resolves to, it must not be the runtime override above.
    let resolved: string | null = null;
    try {
      resolved = getCanopyCloudBaseUrl();
    } catch {
      // A build without a baked base URL throws `base-url-not-configured`;
      // that is still correct gate-OFF behavior (the override is ignored).
    }
    expect(resolved).not.toBe('http://127.0.0.1:4061');
  });
});

describe('normalizeCanopyCloudBaseUrl', () => {
  it('trims trailing slashes and whitespace', () => {
    expect(normalizeCanopyCloudBaseUrl(' https://cloud.example.com/ ')).toBe(
      'https://cloud.example.com',
    );
  });
});

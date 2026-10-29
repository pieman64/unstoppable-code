import {
  buildOctokitClientOptions,
  resolveOctokitClientOptions,
} from '../lib/github-octokit-options';

describe('buildOctokitClientOptions', () => {
  it('omits baseUrl when none is provided', () => {
    expect(buildOctokitClientOptions('tok')).toEqual({ auth: 'tok' });
  });

  it('omits baseUrl when undefined is provided', () => {
    expect(buildOctokitClientOptions('tok', undefined)).toEqual({
      auth: 'tok',
    });
  });

  it('omits baseUrl when an empty string is provided', () => {
    expect(buildOctokitClientOptions('tok', '')).toEqual({ auth: 'tok' });
  });

  it('includes baseUrl when a non-empty string is provided', () => {
    expect(buildOctokitClientOptions('tok', 'http://127.0.0.1:4011')).toEqual({
      auth: 'tok',
      baseUrl: 'http://127.0.0.1:4011',
    });
  });

  it('preserves the auth token verbatim', () => {
    const options = buildOctokitClientOptions(
      'ghp_secret',
      'http://example.test',
    );
    expect(options.auth).toBe('ghp_secret');
  });
});

describe('resolveOctokitClientOptions (gate-OFF / production)', () => {
  const originalBaseUrl = process.env.CANOPY_GITHUB_API_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.CANOPY_GITHUB_API_BASE_URL;
    } else {
      process.env.CANOPY_GITHUB_API_BASE_URL = originalBaseUrl;
    }
  });

  it('never applies the E2E base URL even when the env var is set', () => {
    process.env.CANOPY_GITHUB_API_BASE_URL = 'http://127.0.0.1:4011';
    expect(resolveOctokitClientOptions('tok')).toEqual({ auth: 'tok' });
  });
});

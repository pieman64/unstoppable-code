import {
  isProfileSocialPlatform,
  isPublicProfileArtifactCard,
  RESERVED_USERNAMES,
  validatePublicUsername,
  validateSocialLinks,
} from '../profile';

describe('validatePublicUsername', () => {
  it('accepts and lowercases a valid handle', () => {
    expect(validatePublicUsername('  Alice-01 ')).toEqual({
      ok: true,
      username: 'alice-01',
    });
  });

  it('rejects handles that are too short or too long', () => {
    expect(validatePublicUsername('ab')).toEqual({
      ok: false,
      error: 'length',
    });
    expect(validatePublicUsername('a'.repeat(41))).toEqual({
      ok: false,
      error: 'length',
    });
  });

  it('rejects disallowed characters', () => {
    expect(validatePublicUsername('bad_name')).toEqual({
      ok: false,
      error: 'charset',
    });
    expect(validatePublicUsername('-leading')).toEqual({
      ok: false,
      error: 'charset',
    });
  });

  it('rejects trailing and double hyphens', () => {
    expect(validatePublicUsername('trailing-')).toEqual({
      ok: false,
      error: 'hyphen',
    });
    expect(validatePublicUsername('do--uble')).toEqual({
      ok: false,
      error: 'hyphen',
    });
  });

  it('rejects reserved usernames (route + brand collisions)', () => {
    for (const reserved of ['api', 'account', 'profile', 'canopy', 'admin']) {
      expect(RESERVED_USERNAMES.has(reserved)).toBe(true);
      expect(validatePublicUsername(reserved)).toEqual({
        ok: false,
        error: 'reserved',
      });
    }
  });
});

describe('validateSocialLinks', () => {
  it('accepts a normalized https link set', () => {
    const result = validateSocialLinks([
      { platform: 'github', url: 'https://github.com/alice' },
      { platform: 'x', url: 'https://x.com/alice' },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.links).toHaveLength(2);
      expect(result.links[0]).toEqual({
        platform: 'github',
        url: 'https://github.com/alice',
      });
    }
  });

  it('rejects non-https urls', () => {
    expect(
      validateSocialLinks([
        { platform: 'website', url: 'http://insecure.dev' },
      ]),
    ).toEqual({ ok: false, error: 'not-https' });
  });

  it('rejects unknown platforms and duplicates', () => {
    expect(
      validateSocialLinks([{ platform: 'myspace', url: 'https://a.dev' }]),
    ).toEqual({ ok: false, error: 'unknown-platform' });
    expect(
      validateSocialLinks([
        { platform: 'github', url: 'https://github.com/a' },
        { platform: 'github', url: 'https://github.com/b' },
      ]),
    ).toEqual({ ok: false, error: 'duplicate-platform' });
  });

  it('rejects more than five links', () => {
    const many = Array.from({ length: 6 }, () => ({
      platform: 'website',
      url: 'https://a.dev',
    }));
    expect(validateSocialLinks(many)).toEqual({ ok: false, error: 'too-many' });
  });
});

describe('platform + card guards', () => {
  it('recognizes known platforms', () => {
    expect(isProfileSocialPlatform('github')).toBe(true);
    expect(isProfileSocialPlatform('tiktok')).toBe(false);
  });

  it('validates artifact card discriminants', () => {
    expect(
      isPublicProfileArtifactCard({
        kind: 'plan',
        id: 'x',
        title: 't',
        publishedAt: 'now',
      }),
    ).toBe(true);
    expect(isPublicProfileArtifactCard({ kind: 'nope', id: 'x' })).toBe(false);
    expect(isPublicProfileArtifactCard(null)).toBe(false);
  });
});

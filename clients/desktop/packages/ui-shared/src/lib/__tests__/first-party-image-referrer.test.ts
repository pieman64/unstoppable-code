import { imageReferrerPolicyFor } from '../first-party-image-referrer';

const SHA = 'a'.repeat(64);

describe('imageReferrerPolicyFor', () => {
  it.each([
    [
      'a relative first-party logo',
      `/api/v1/marketplace/plugins/m/p/logo?v=${SHA}`,
    ],
    ['a relative path without a leading slash', 'brand/logo.png'],
    [
      'an absolute gateway logo',
      `https://gateway.example/agent/v1/marketplace/plugins/m/p/logo?v=${SHA}`,
    ],
    [
      'an absolute logo under /api',
      `https://web.example/api/v1/marketplace/plugins/m%2Fx/p%20q/logo?v=${SHA}`,
    ],
  ])('sends the page origin for %s', (_label, src) => {
    expect(imageReferrerPolicyFor(src)).toBe('origin');
  });

  it.each([
    ['an unrelated third-party logo', 'https://cdn.example/logo.png'],
    [
      'a third-party host with a non-logo plugin route',
      'https://gateway.example/agent/v1/marketplace/plugins/m/p/files?path=x',
    ],
    [
      'an unknown prefix',
      `https://gateway.example/other/v1/marketplace/plugins/m/p/logo?v=${SHA}`,
    ],
    [
      'extra path segments',
      `https://gateway.example/agent/v1/marketplace/plugins/m/p/q/logo?v=${SHA}`,
    ],
    ['a protocol-relative URL', '//cdn.example/logo.png'],
    ['a data URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['a blob URL', 'blob:https://web.example/1234'],
    ['an empty source', ''],
    ['no source', undefined],
  ])('withholds the referrer for %s', (_label, src) => {
    expect(imageReferrerPolicyFor(src)).toBe('no-referrer');
  });
});

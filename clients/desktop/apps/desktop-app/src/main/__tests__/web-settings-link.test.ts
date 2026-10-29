import { resolveWebSettingsLink } from '../browser/web-settings-link';

const ORIGIN = 'https://app.example.test';
const ORG = 'org_123';
const SUFFIX = '?ref=chat#section';

describe('resolveWebSettingsLink', () => {
  it.each([
    '/account',
    '/account/profile',
    '/account/digests/dg_1',
    '/account/notifications',
    '/account/integrations',
    '/account/security',
    '/account/billing',
    '/account/billing/invoices/in_1',
    '/account/labs',
    '/organization',
    `/organization/${ORG}`,
    `/organization/${ORG}/feed/item_1`,
    `/organization/${ORG}/statistics`,
    `/organization/${ORG}/projects`,
    `/organization/${ORG}/teams`,
    `/organization/${ORG}/digests/dg_1`,
    `/organization/${ORG}/members`,
    `/organization/${ORG}/members/user_1`,
    `/organization/${ORG}/members/user_1/digests/dg_1`,
    `/organization/${ORG}/memory`,
    `/organization/${ORG}/memory/graph`,
    `/organization/${ORG}/memory/ops`,
    `/organization/${ORG}/memory/fact/fact_1`,
    `/organization/${ORG}/billing/invoices/in_1`,
  ])('resolves %s with its query and fragment', (path) => {
    expect(resolveWebSettingsLink(`${ORIGIN}${path}${SUFFIX}`, ORIGIN)).toBe(
      `${path}${SUFFIX}`,
    );
  });

  it.each(['general', 'policies', 'integrations', 'usage', 'billing'])(
    'resolves the organization settings %s tab',
    (tab) => {
      const path = `/organization/${ORG}/settings?tab=${tab}#top`;
      expect(resolveWebSettingsLink(`${ORIGIN}${path}`, ORIGIN)).toBe(path);
    },
  );

  it.each([
    ['a pricing page', `${ORIGIN}/pricing`],
    ['a share page', `${ORIGIN}/share/abc`],
    ['a legal page', `${ORIGIN}/legal/terms`],
    ['the docs', `${ORIGIN}/docs`],
    ['the changelog', `${ORIGIN}/changelog`],
    ['checkout', `${ORIGIN}/checkout`],
    ['an auth callback', `${ORIGIN}/auth/callback`],
    ['an unknown account page', `${ORIGIN}/account/unknown`],
    ['an invoice link without an id', `${ORIGIN}/account/billing/invoices`],
    ['an unknown organization page', `${ORIGIN}/organization/${ORG}/unknown`],
    ['an invalid organization id', `${ORIGIN}/organization/bad%20id`],
    ['a foreign origin', 'https://evil.example/account/billing'],
    [
      'an http link to an https origin',
      'http://app.example.test/account/billing',
    ],
    ['a different port', 'https://app.example.test:8443/account/billing'],
    ['an invalid URL', 'not a url'],
    ['a mailto link', 'mailto:billing@app.example.test'],
    ['a javascript link', 'javascript:alert(1)'],
  ])('ignores %s', (_label, url) => {
    expect(resolveWebSettingsLink(url, ORIGIN)).toBeNull();
  });

  it.each([
    ['empty', ''],
    ['invalid', 'not an origin'],
  ])(
    'ignores every link when the configured origin is %s',
    (_label, origin) => {
      expect(
        resolveWebSettingsLink(`${ORIGIN}/account/billing`, origin),
      ).toBeNull();
    },
  );

  it.each([
    ['a trailing slash', `${ORIGIN}/`],
    ['a path', `${ORIGIN}/some/base`],
    ['the default port', 'https://app.example.test:443'],
    ['a different host case', 'https://APP.Example.TEST'],
  ])('matches a configured origin with %s', (_label, origin) => {
    expect(resolveWebSettingsLink(`${ORIGIN}/account/billing`, origin)).toBe(
      '/account/billing',
    );
  });

  // The parser owns the route grammar; these pin what it accepts today.
  it.each([
    ['a trailing slash', '/account/billing/', '/account/billing/'],
    ['an uppercase path', '/Account/Billing', null],
    ['a percent-encoded segment', '/account/%62illing', '/account/%62illing'],
    ['duplicate slashes', '//account//billing', '//account//billing'],
  ])('pins the parser for %s', (_label, path, expected) => {
    expect(resolveWebSettingsLink(`${ORIGIN}${path}`, ORIGIN)).toBe(expected);
  });
});

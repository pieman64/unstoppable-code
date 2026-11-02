import {
  authenticatedPortalPathSchema,
  authenticatedPortalRequestSchema,
  authenticatedPortalResultSchema,
  classifyAuthenticatedPortalPath,
  normalizeAuthenticatedPortalOrigin,
} from '../authenticated-portal-request';

const request = {
  requireAuthentication: true,
  kind: 'signed-in',
  path: '/account?x=1#profile',
  accountId: 'acct-1',
  webOrigin: 'http://localhost:3000',
};

it('accepts strict requests and enforces account/path limits', () => {
  expect(authenticatedPortalRequestSchema.parse(request)).toEqual(request);
  expect(
    authenticatedPortalRequestSchema.safeParse({
      ...request,
      accountId: 'x'.repeat(256),
    }).success,
  ).toBe(true);
  expect(
    authenticatedPortalPathSchema.safeParse('/' + 'x'.repeat(2047)).success,
  ).toBe(true);
  for (const fields of [
    { extra: true },
    { requireAuthentication: false },
    { kind: 'legacy' },
    { accountId: '' },
    { accountId: 'x'.repeat(257) },
    { path: '/' + 'x'.repeat(2048) },
  ]) {
    expect(
      authenticatedPortalRequestSchema.safeParse({ ...request, ...fields })
        .success,
    ).toBe(false);
  }
});

it.each([
  '',
  'account',
  'https://example.test/account',
  '//evil.test',
  '/\\evil.test',
  '/account\\billing',
  '/account\n',
  '/account billing',
  '/account\u007f',
  '/account\u0085',
  '/account\u00a0',
])('rejects unsafe paths: %j', (path) => {
  expect(authenticatedPortalPathSchema.safeParse(path).success).toBe(false);
  expect(classifyAuthenticatedPortalPath(path)).toBeNull();
});

it.each([
  ['https://EXAMPLE.test:443/', 'https://example.test'],
  ['http://localhost:3000', 'http://localhost:3000'],
  ['http://localhost:3001/', 'http://localhost:3001'],
])('normalizes origins including ports: %s', (value, origin) => {
  expect(normalizeAuthenticatedPortalOrigin(value)).toBe(origin);
});

it.each([
  'https://example.test/path',
  'https://example.test/path/..',
  'https://example.test/./',
  'https://user:pass@example.test',
  'https://@example.test',
  'https://example.test?',
  'https://example.test#',
  'https://example.test?q=1',
  'ftp://example.test',
  '//example.test',
  ' https://example.test',
  'https://example.test\\',
  'https:example.test',
  null,
])('rejects non-origins: %j', (value) => {
  expect(normalizeAuthenticatedPortalOrigin(value)).toBeNull();
});

it.each([
  '/account/billing',
  '/account/billing/',
  '/account/billing/invoices?x=1#latest',
  '/organization/org%3Aone/settings?x=1&tab=general&tab=billing#credits',
  '/organization/org-1/settings/?tab=billing&tab=general',
  '/organization/org-1/settings?%74ab=%62illing',
  '/organization/org-1/billing',
  '/organization/org-1/billing/invoices/',
  '/subscribe',
  '/subscribe/?plan=pro',
  '/checkout#payment',
  '/checkout/',
])('classifies payment destinations: %s', (path) => {
  expect(classifyAuthenticatedPortalPath(path)).toBe('payment');
});

it.each([
  '/account/billing-help',
  '/account',
  '/organization/org-1/settings?tab=general#tab=billing',
  '/organization/org-1/settings-more?tab=billing',
  '/organization/org-1/billing-help',
  '/organizations/org-1/billing',
  '/subscribe/more',
  '/checkout/more',
  '/payment',
])('keeps other valid paths signed-in: %s', (path) => {
  expect(classifyAuthenticatedPortalPath(path)).toBe('signed-in');
});

it.each([
  true,
  false,
  null,
  {},
  { ok: true, extra: true },
  { ok: false },
  { ok: false, reason: 'forbidden' },
  { ok: false, reason: 'unknown' },
])('rejects legacy/malformed strict replies: %j', (result) => {
  expect(authenticatedPortalResultSchema.safeParse(result).success).toBe(false);
});

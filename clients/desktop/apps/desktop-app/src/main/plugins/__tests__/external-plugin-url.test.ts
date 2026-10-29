/**
 * SSRF/local-access boundary tests for the external-plugin clone-URL allowlist
 * (portal PR B1 hardening). A malicious marketplace manifest can name an
 * arbitrary plugin `source.url`; these tests pin that everything but a
 * public-host https URL is refused with the stable `invalid_payload` code.
 */
jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));

import { lookup } from 'node:dns/promises';
import {
  assertSafeExternalPluginCloneUrl,
  UnsafeExternalPluginUrlError,
} from '../external-plugin-url';

const mockedLookup = jest.mocked(lookup);

beforeEach(() => {
  jest.clearAllMocks();
  // Default: any resolved host is public. Overridden per-test as needed.
  mockedLookup.mockResolvedValue([
    { address: '140.82.113.3', family: 4 },
  ] as Awaited<ReturnType<typeof lookup>>);
});

describe('assertSafeExternalPluginCloneUrl — refusals', () => {
  const cases: Array<[string, string]> = [
    ['file:///etc/passwd', 'file scheme'],
    ['file://localhost/etc/passwd', 'file host'],
    ['ssh://git@github.com/acme/repo.git', 'ssh scheme'],
    ['git://github.com/acme/repo.git', 'git scheme'],
    ['http://github.com/acme/repo.git', 'plain http'],
    ['git@github.com:acme/repo.git', 'SCP-style git address'],
    ['https://user:token@github.com/acme/repo.git', 'embedded credentials'],
    ['https://169.254.169.254/latest/meta-data', 'link-local metadata IP'],
    ['https://127.0.0.1/acme/repo.git', 'loopback IPv4'],
    ['https://10.0.0.5/acme/repo.git', 'RFC1918 10/8'],
    ['https://192.168.1.10/acme/repo.git', 'RFC1918 192.168/16'],
    ['https://172.16.9.9/acme/repo.git', 'RFC1918 172.16/12'],
    ['https://0.0.0.0/acme/repo.git', '0.0.0.0'],
    ['https://[::1]/acme/repo.git', 'IPv6 loopback literal'],
    ['https://[2606:4700:4700::1111]/acme/repo.git', 'public IPv6 literal'],
    ['https://localhost/acme/repo.git', 'localhost'],
    ['https://api.localhost/acme/repo.git', '*.localhost'],
    ['https://internalhost/acme/repo.git', 'dotless hostname'],
    ['not-a-url', 'unparseable'],
  ];

  it.each(cases)('rejects %s (%s)', async (url) => {
    await expect(assertSafeExternalPluginCloneUrl(url)).rejects.toBeInstanceOf(
      UnsafeExternalPluginUrlError,
    );
    await expect(assertSafeExternalPluginCloneUrl(url)).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });

  it('rejects a public hostname that resolves to a private address (static DNS SSRF)', async () => {
    mockedLookup.mockResolvedValue([
      { address: '10.1.2.3', family: 4 },
    ] as Awaited<ReturnType<typeof lookup>>);
    await expect(
      assertSafeExternalPluginCloneUrl(
        'https://sneaky.example.com/acme/repo.git',
      ),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('rejects when any resolved address is private, even if one is public', async () => {
    mockedLookup.mockResolvedValue([
      { address: '140.82.113.3', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ] as Awaited<ReturnType<typeof lookup>>);
    await expect(
      assertSafeExternalPluginCloneUrl(
        'https://mixed.example.com/acme/repo.git',
      ),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('rejects when the host does not resolve', async () => {
    mockedLookup.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      assertSafeExternalPluginCloneUrl(
        'https://ghost.example.com/acme/repo.git',
      ),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('short-circuits literal-IP / scheme refusals before any DNS lookup', async () => {
    await expect(
      assertSafeExternalPluginCloneUrl('https://169.254.169.254/'),
    ).rejects.toBeInstanceOf(UnsafeExternalPluginUrlError);
    await expect(
      assertSafeExternalPluginCloneUrl('ssh://git@github.com/x.git'),
    ).rejects.toBeInstanceOf(UnsafeExternalPluginUrlError);
    expect(mockedLookup).not.toHaveBeenCalled();
  });
});

describe('assertSafeExternalPluginCloneUrl — allows', () => {
  it('accepts a public GitHub https URL', async () => {
    await expect(
      assertSafeExternalPluginCloneUrl('https://github.com/acme/reviewer.git'),
    ).resolves.toBeUndefined();
    expect(mockedLookup).toHaveBeenCalledWith('github.com', {
      all: true,
      verbatim: true,
    });
  });

  it('accepts a public non-GitHub git host (safe-host predicate, not github-only)', async () => {
    await expect(
      assertSafeExternalPluginCloneUrl('https://gitlab.com/acme/reviewer.git'),
    ).resolves.toBeUndefined();
  });

  it('accepts a public IPv4 literal without a DNS lookup', async () => {
    await expect(
      assertSafeExternalPluginCloneUrl('https://140.82.113.3/acme/repo.git'),
    ).resolves.toBeUndefined();
    expect(mockedLookup).not.toHaveBeenCalled();
  });
});

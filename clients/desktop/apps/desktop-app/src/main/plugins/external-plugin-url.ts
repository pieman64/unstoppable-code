import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isNonPublicIpAddress } from '../mcp/network-address';

/**
 * Thrown when a resolved external-plugin clone URL fails the SSRF/local-access
 * allowlist. Carries the stable `invalid_payload` portal failure code so the
 * portal adapter maps it onto `portal.command.failed` with a clear message.
 */
export class UnsafeExternalPluginUrlError extends Error {
  readonly code = 'invalid_payload';
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeExternalPluginUrlError';
  }
}

/**
 * Validate a git clone URL that originated from a MARKETPLACE MANIFEST before
 * it is handed to `git clone`.
 *
 * This is the SSRF/local-file boundary for the portal external-install path: a
 * portal session can add an attacker-controlled marketplace whose manifest
 * names an arbitrary plugin `source.url`, and that URL flows to `git clone`.
 * `git clone -- <url>` blocks OPTION injection but still honors `ssh://`,
 * `file://`, SCP-style `git@host:path`, and http(s) to loopback/private/
 * link-local/internal hosts — every one an SSRF or local-file-read primitive.
 *
 * Allowlist decision: NOT github-only. External plugin sources in the Claude
 * plugin ecosystem are ordinary git URLs that legitimately point at any public
 * git host (github.com, gitlab.com, self-hosted forges, …), so restricting to
 * a domain list would break valid non-GitHub marketplaces. Instead we gate by
 * the same SAFE-HOST predicate the MCP remote-image fetcher uses
 * ({@link isNonPublicIpAddress}) plus a strict scheme/credential/shape check:
 *
 * - scheme MUST be `https:` (rejects ssh/file/git/http and, via URL parsing,
 *   SCP-style `git@host:path` which is not a valid URL);
 * - no embedded credentials (userinfo);
 * - IPv6 literals are rejected outright; IPv4 literals must be public;
 * - hostnames must be dotted FQDNs (rejects `localhost`, `*.localhost`, and
 *   bare/dotless internal names) and must RESOLVE to only public addresses
 *   (rejects a public name pointed at `127.0.0.1` / `169.254.169.254` / RFC1918).
 *
 * Residual: git re-resolves DNS when it connects, so a rebinding name that
 * flips to a private address between this check and the clone is not fully
 * closed (git cannot be IP-pinned here); the literal-IP, credential, scheme,
 * and static-DNS-to-private vectors — everything the enumerated finding lists —
 * are.
 */
export async function assertSafeExternalPluginCloneUrl(
  rawUrl: string,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeExternalPluginUrlError(
      'External plugin source must be an https:// URL.',
    );
  }
  if (url.protocol !== 'https:') {
    throw new UnsafeExternalPluginUrlError(
      `External plugin source must use https (got "${url.protocol}").`,
    );
  }
  if (url.username !== '' || url.password !== '') {
    throw new UnsafeExternalPluginUrlError(
      'External plugin source must not embed credentials.',
    );
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') {
    throw new UnsafeExternalPluginUrlError(
      'External plugin source has no host.',
    );
  }

  const family = isIP(host);
  if (family === 6) {
    throw new UnsafeExternalPluginUrlError(
      'External plugin source must not target an IPv6 literal.',
    );
  }
  if (family === 4) {
    if (isNonPublicIpAddress(host)) {
      throw new UnsafeExternalPluginUrlError(
        'External plugin source must not target a non-public address.',
      );
    }
    return;
  }

  // Hostname (not an IP literal).
  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new UnsafeExternalPluginUrlError(
      'External plugin source must not target localhost.',
    );
  }
  if (!host.includes('.')) {
    throw new UnsafeExternalPluginUrlError(
      'External plugin source host must be a fully-qualified domain name.',
    );
  }

  let resolved;
  try {
    resolved = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeExternalPluginUrlError(
      'External plugin source host could not be resolved.',
    );
  }
  if (
    resolved.length === 0 ||
    resolved.some(
      ({ address }) => isIP(address) === 0 || isNonPublicIpAddress(address),
    )
  ) {
    throw new UnsafeExternalPluginUrlError(
      'External plugin source host resolves to a non-public address.',
    );
  }
}

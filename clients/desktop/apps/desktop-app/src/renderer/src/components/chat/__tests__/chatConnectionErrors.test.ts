import { isMcpConnectionError } from '../chatConnectionErrors';

describe('isMcpConnectionError last-resort fallback', () => {
  it('still matches an explicit MCP authentication error', () => {
    expect(isMcpConnectionError('MCP server authentication required')).toBe(
      true,
    );
    expect(
      isMcpConnectionError('OAuth token expired for this MCP server'),
    ).toBe(true);
  });

  // The structured `authFailure` only exists for HTTP MCP servers that
  // completed OAuth through Canopy's proxy. Codex pairing is unimplemented,
  // stdio servers never traverse the proxy, and static-header HTTP servers
  // have no `loadedOAuth`, so a 401 status line is still the only signal
  // available for those (CAN-1814 review).
  it.each([
    'Error POSTing to endpoint (HTTP 401): {"error":"invalid_token"}',
    'MCP error -32603: HTTP 401 Unauthorized',
    'request failed with status 401 Unauthorized',
    'Unauthorized (HTTP 401)',
  ])('matches a real 401 status line: %s', (message) => {
    expect(isMcpConnectionError(message)).toBe(true);
  });

  it('does not fire on a 401 that is not an auth status', () => {
    expect(isMcpConnectionError('Processed 401 events, 0 failures')).toBe(
      false,
    );
    expect(isMcpConnectionError('exited with code 401')).toBe(false);
  });

  // The regression this PR actually fixes, stated in before/after terms.
  // Measured against the merge-base: each of these DID match (via the old bare
  // `/\bHTTP\s+401\b/` alternative) and must not now. Note the old rule needed
  // the literal `HTTP 401` — a bare number like "Processed 401 events" never
  // matched, so that is not an example of the bug despite reading like one.
  it.each([
    'Scanned nginx.log: 87 lines with HTTP 401, 3 with HTTP 500.',
    'Deploy summary: HTTP 401 rate dropped to 0.2% this week.',
  ])('no longer fires on a log/metric mention of HTTP 401: %s', (message) => {
    expect(isMcpConnectionError(message)).toBe(false);
  });

  // Adjacency alone was too weak: restoring the bare-number alternative also
  // let an errored MCP tool relaying a THIRD-PARTY upstream body claim to be
  // an MCP auth failure, and those fetch/proxy-style servers are exactly the
  // ones the structured producer cannot reach (CAN-1814 review round 2). The
  // number now has to sit in a status position.
  it.each([
    'Error 401: Unauthorized from the GitHub API',
    'Upstream said 401 - Unauthorized (retry with a new PAT)',
    'unauthorized: the upstream API returned 401 for user 42',
  ])('does not fire on a relayed upstream 401: %s', (message) => {
    expect(isMcpConnectionError(message)).toBe(false);
  });

  // The counter-direction: this module has a history of trading one defect
  // for its opposite, so pin the status-line shapes that must keep matching.
  //
  // NOTE — `{"status":401,...}` is a DELIBERATE WIDENING, not preserved
  // behaviour. Measured against the merge-base implementation it did NOT match
  // before (the old alternatives needed a literal `HTTP 401`, or MCP/OAuth next
  // to an auth keyword), and it matches now. Kept on purpose: a JSON body is
  // the shape fetch/proxy-style MCP servers return, and those are exactly the
  // servers the structured producer cannot reach — for them this fallback is
  // the only signal there is. The contrasting relayed-third-party cases above
  // (`... from the GitHub API`) still correctly do not match.
  it.each([
    'HTTP/1.1 401 Unauthorized',
    'MCP error -32603: statusCode: 401 (Unauthorized)',
    '{"status":401,"message":"Unauthorized"}',
  ])('matches a 401 in a status position: %s', (message) => {
    expect(isMcpConnectionError(message)).toBe(true);
  });

  it('does not fire on ordinary output', () => {
    expect(isMcpConnectionError('Wrote 3 files.')).toBe(false);
  });
});

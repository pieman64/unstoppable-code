import { isValidAuthDependencyFailure } from '@canopy/protocol/auth-recovery';
import {
  classifyMcpAuthFailure,
  type McpAuthFailureInput,
} from '../mcp-auth-classifier';

function input(
  overrides: Partial<McpAuthFailureInput> = {},
): McpAuthFailureInput {
  return {
    serverId: 'srv-1',
    configId: 'cfg-1',
    displayName: 'Prod MCP server',
    statusCode: 401,
    diagnostic:
      'OAuth token was rejected by the upstream MCP server (HTTP 401).',
    ...overrides,
  };
}

describe('classifyMcpAuthFailure', () => {
  it('maps 401 to expired with an inline mcp_oauth recovery naming the server', () => {
    const out = classifyMcpAuthFailure(input());
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.dependencyClass).toBe('mcp');
    expect(out.dependencyId).toBe('srv-1:cfg-1');
    expect(out.displayName).toBe('Prod MCP server');
    expect(out.failureClass).toBe('expired');
    expect(out.recovery).toEqual({
      kind: 'mcp_oauth',
      serverId: 'srv-1',
      configId: 'cfg-1',
    });
    expect(isValidAuthDependencyFailure(out)).toBe(true);
  });

  it('maps 403 to insufficient_scope with NO recovery action', () => {
    const out = classifyMcpAuthFailure(input({ statusCode: 403 }));
    expect(out).not.toBeNull();
    if (!out) return;
    expect(out.failureClass).toBe('insufficient_scope');
    expect(out.recovery).toEqual({ kind: 'none' });
    expect(isValidAuthDependencyFailure(out)).toBe(true);
  });

  it('returns null for statuses that are not authentication failures', () => {
    expect(classifyMcpAuthFailure(input({ statusCode: 500 }))).toBeNull();
    expect(classifyMcpAuthFailure(input({ statusCode: 404 }))).toBeNull();
    expect(classifyMcpAuthFailure(input({ statusCode: 200 }))).toBeNull();
  });

  it('redacts credentials from the diagnostic', () => {
    const out = classifyMcpAuthFailure(
      input({ diagnostic: 'sent Bearer sk-leakedtokenvalue and got 401' }),
    );
    expect(out?.detail).not.toContain('sk-leakedtokenvalue');
  });

  // `detail` is persisted onto the transcript block and crosses into the web
  // Portal on a shared run, so it is a real egress path. It must carry the
  // repo's whole declared secret vocabulary (`redactSecrets`), not a
  // hand-rolled subset (CAN-1814 review).
  it.each([
    [
      'a JWT',
      'upstream returned eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
      'eyJhbGciOiJIUzI1NiJ9',
    ],
    [
      'a GitHub fine-grained PAT',
      'header carried github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz012345',
      'github_pat_11ABCDEFG0',
    ],
    [
      'a GitHub app token',
      'header carried ghu_abcdefghijklmnopqrstuvwxyz0123456789',
      'ghu_abcdefghijklmnopqrstuvwxyz0123456789',
    ],
    [
      'a Slack bot token',
      'proxied xoxb-1234567890-1234567890123-abcdefghijklmnopqrstuvwx',
      'xoxb-1234567890',
    ],
    [
      'an AWS access key id',
      'env had AKIAIOSFODNN7EXAMPLE set',
      'AKIAIOSFODNN7EXAMPLE',
    ],
    [
      'an OpenAI project key',
      'used sk-proj-abcdefghijklmnopqrstuvwxyz0123',
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123',
    ],
    [
      'an X-Api-Key header',
      'X-Api-Key: abcdef0123456789abcdef',
      'abcdef0123456789abcdef',
    ],
    ['an auth_token assignment', 'auth_token: hunter2secretvalue', 'hunter2'],
    [
      'a PEM private key block',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      'MIIEowIBAAKCAQEA',
    ],
  ])('redacts %s out of the diagnostic', (_label, diagnostic, secret) => {
    const out = classifyMcpAuthFailure(input({ diagnostic }));
    expect(out?.detail).not.toContain(secret);
  });

  it('bounds the diagnostic length', () => {
    const out = classifyMcpAuthFailure(input({ diagnostic: 'x'.repeat(5000) }));
    expect(out?.detail?.length).toBeLessThanOrEqual(512);
  });
});

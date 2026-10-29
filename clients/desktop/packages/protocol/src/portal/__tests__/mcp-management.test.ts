import {
  isPortalMcpTestConnectionResult,
  projectPortalMcpStatus,
  PORTAL_CAPABILITY_MCP_MANAGEMENT,
  PORTAL_COMMAND_TYPES_SET,
  PORTAL_SMALL_RPC_COMMAND_TYPES,
} from '..';

it('registers management with deletion alone on the small-RPC path', () => {
  expect(PORTAL_CAPABILITY_MCP_MANAGEMENT).toBe('mcp_management');
  expect(PORTAL_COMMAND_TYPES_SET.has('portal.mcp.test_connection')).toBe(true);
  expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.mcp.delete_server')).toBe(
    true,
  );
  expect(PORTAL_SMALL_RPC_COMMAND_TYPES.has('portal.mcp.test_connection')).toBe(
    false,
  );
});

it('serializes only selected status fields, including nested configuration fields', () => {
  const projected = projectPortalMcpStatus({
    connectionStatus: 'auth_required',
    reachability: 'reachable',
    handler: 'canopy',
    lastCheckedAt: '2026-10-18T12:00:00Z',
    lastError: 'TOP_SECRET',
    credentials: { token: 'TOP_SECRET' },
    configs: [
      {
        configId: 'cfg',
        authStatus: 'expired',
        canRefresh: true,
        expiresAt: '2026-10-18T11:00:00Z',
        lastError: 'TOP_SECRET',
        authErrorRevision: 'TOP_SECRET',
        config: { headers: { Authorization: 'TOP_SECRET' } },
      },
    ],
  });
  expect(JSON.parse(JSON.stringify(projected))).toEqual({
    connectionStatus: 'auth_required',
    reachability: 'reachable',
    handler: 'canopy',
    lastCheckedAt: '2026-10-18T12:00:00Z',
    configs: [
      {
        configId: 'cfg',
        authStatus: 'expired',
        canRefresh: true,
        expiresAt: '2026-10-18T11:00:00Z',
      },
    ],
  });
  expect(JSON.stringify(projected)).not.toContain('TOP_SECRET');
});

it('degrades unknown enums and invalid timestamps without inventing freshness', () => {
  expect(projectPortalMcpStatus(undefined)).toBeUndefined();
  expect(
    projectPortalMcpStatus({
      connectionStatus: 'future',
      reachability: 'future',
      handler: 'future',
      lastCheckedAt: 'yesterday',
      configs: [
        { configId: 'cfg', authStatus: 'future' },
        { configId: 'cfg2', authStatus: 'connected', expiresAt: 'garbage' },
      ],
    }),
  ).toEqual({
    connectionStatus: 'unknown',
    reachability: 'unknown',
    configs: [{ configId: 'cfg2', authStatus: 'connected' }],
  });
});

it.each([
  { responseTime: Infinity },
  { responseTime: -1 },
  { success: 'yes' },
  { tools: ['arbitrary server output'] },
  { tools: Array(1001).fill('tool') },
  { message: 'x'.repeat(513) },
])('rejects invalid test results %p', (extra) => {
  expect(
    isPortalMcpTestConnectionResult({
      serverId: 'abc',
      configId: 'def',
      success: true,
      message: 'Connected',
      ...extra,
    }),
  ).toBe(false);
});

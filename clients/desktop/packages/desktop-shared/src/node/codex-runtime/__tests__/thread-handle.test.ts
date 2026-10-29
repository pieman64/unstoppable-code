import { createHeadlessMcpElicitationPolicy } from '../thread-handle';

describe('headless MCP elicitation policy', () => {
  const call = {
    serverName: 'github',
    toolName: 'create_issue',
    arguments: { title: 'Retry safety' },
    normalizedArguments: '{"title":"Retry safety"}',
    approvalKind: 'mcp_tool_call',
  };

  it('approves an exact selected-server call when mutations are allowed', async () => {
    const policy = createHeadlessMcpElicitationPolicy({
      allowedServers: ['github'],
      allowExternalMutation: true,
    });

    await expect(Promise.resolve(policy.evaluate(call))).resolves.toEqual({
      approved: true,
      externalMutation: true,
    });
  });

  it('rejects mismatched servers and approval kinds', async () => {
    const policy = createHeadlessMcpElicitationPolicy({
      allowedServers: ['github'],
      allowExternalMutation: true,
    });

    await expect(
      Promise.resolve(policy.evaluate({ ...call, serverName: 'slack' })),
    ).resolves.toEqual({
      approved: false,
      externalMutation: true,
    });
    await expect(
      Promise.resolve(policy.evaluate({ ...call, approvalKind: 'unknown' })),
    ).resolves.toEqual({
      approved: false,
      externalMutation: true,
    });
  });

  it('classifies all headless MCP calls as external mutations', async () => {
    const policy = createHeadlessMcpElicitationPolicy({
      allowedServers: ['github'],
      allowExternalMutation: false,
    });

    await expect(Promise.resolve(policy.evaluate(call))).resolves.toEqual({
      approved: true,
      externalMutation: true,
    });
    expect(policy.allowExternalMutation).toBe(false);
  });
});

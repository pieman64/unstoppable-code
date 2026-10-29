import { mcpSelectionToEnvironmentRequirement } from '../share-requirement';

describe('mcpSelectionToEnvironmentRequirement', () => {
  it('uses a curated catalog id without exposing host configuration', async () => {
    const requirement = await mcpSelectionToEnvironmentRequirement(
      { serverId: 'local-linear', configId: 'private-config' },
      () =>
        Promise.resolve({
          name: 'Linear workspace',
          curatedKey: 'linear',
          command: 'npx secret-server',
          url: 'https://private.example.test/mcp',
        }),
    );

    expect(requirement).toEqual({
      id: 'mcp:linear',
      kind: 'mcp',
      displayName: 'linear',
      required: true,
      affectedSteps: [],
      setupHint: 'Connect Linear workspace in Settings.',
    });
    expect(JSON.stringify(requirement)).not.toContain('private-config');
    expect(JSON.stringify(requirement)).not.toContain('npx');
    expect(JSON.stringify(requirement)).not.toContain('private.example');
  });

  it('falls back to the display name for an uncurated server', async () => {
    await expect(
      mcpSelectionToEnvironmentRequirement(
        { serverId: 'local-review', configId: 'config' },
        () => Promise.resolve({ name: 'Review tools' }),
      ),
    ).resolves.toMatchObject({
      id: 'mcp:local-review',
      displayName: 'Review tools',
      setupHint: 'Connect Review tools in Settings.',
    });
  });
});

import type { McpServerRef } from '../../mcp-servers';
import type {
  CollectionConfig,
  CollectionIndexEntry,
  CollectionMcpRef,
  CollectionPluginRef,
  CollectionSkillRef,
} from '../index';

describe('local Collection catalog contract', () => {
  it('constructs local item refs by installed identity', () => {
    const skill: CollectionSkillRef = {
      sourceId: 'builtin:app',
      skillName: 'commit-messages',
    };
    const plugin: CollectionPluginRef = {
      marketplaceId: 'builtin/app',
      pluginName: 'browser',
    };
    const mcp: CollectionMcpRef = { serverId: 'srv-1', configId: 'cfg-1' };
    expect(JSON.parse(JSON.stringify(skill))).toEqual(skill);
    expect(JSON.parse(JSON.stringify(plugin))).toEqual(plugin);
    expect(JSON.parse(JSON.stringify(mcp))).toEqual(mcp);

    // CollectionMcpRef is an alias of the mcp-servers module's McpServerRef.
    const asServerRef: McpServerRef = mcp;
    expect(asServerRef).toBe(mcp);
  });

  it('constructs index entries and full configs', () => {
    const entry: CollectionIndexEntry = {
      id: 'col-1',
      name: 'Review pack',
      description: 'Skills used during code review',
      updatedAt: '2026-08-27T00:00:00Z',
      skillCount: 2,
      pluginCount: 1,
      mcpServerCount: 1,
    };
    expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);

    const added: CollectionIndexEntry = {
      ...entry,
      id: 'col-2',
      sharedSource: {
        remoteId: 'remote-1',
        contentHash: 'hash-1',
        fromPublicShare: true,
      },
    };
    expect(JSON.parse(JSON.stringify(added))).toEqual(added);

    const config: CollectionConfig = {
      id: 'col-1',
      name: 'Review pack',
      description: 'Skills used during code review',
      skills: [{ sourceId: 'github:acme/skills', skillName: 'brainstorming' }],
      plugins: [{ marketplaceId: 'curated/cloud', pluginName: 'linter' }],
      mcpServers: [{ serverId: 'srv-1', configId: 'cfg-1' }],
      createdAt: '2026-08-27T00:00:00Z',
      updatedAt: '2026-08-27T00:00:00Z',
      sharedSource: {
        remoteId: 'remote-1',
        fetchedAt: '2026-08-27T00:00:00Z',
      },
    };
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });
});

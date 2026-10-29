import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentArtifactStore } from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import type {
  MaterializedCapabilityOverlay,
  AgentMcpSelection,
} from '@canopy/desktop-shared/node/delegation/agent-artifacts';
import {
  selectHomeCapabilityOverlay,
  mergeHomeCapabilityOverlay,
  isHomeOnlyCapabilityOverlay,
} from '../home-overlay';
function home(): MaterializedCapabilityOverlay {
  const ref = { marketplaceId: 'market', pluginName: 'tool' };
  const selection: AgentMcpSelection = {
    source: 'plugin',
    ...ref,
    serverName: 'review',
    root: 'home/review',
    configDigest: 'a'.repeat(64),
  };
  Reflect.set(selection, 'source', 'inherited-plugin');
  Reflect.set(selection, 'installationDigest', 'b'.repeat(64));
  const entry = {
    root: 'home/review',
    kind: 'plugin' as const,
    name: 'tool',
    origin: 'claude' as const,
    pluginRef: ref,
  };
  return {
    version: 3,
    pluginFiles: {
      'home/review/.claude-plugin/plugin.json': '{"name":"review"}',
      'home/review/skills/review/SKILL.md': 'FROZEN_INSTALLED_RULES',
    },
    capabilities: {
      claudePluginRoots: ['home/review'],
      codexCapabilityRoots: ['home/review'],
      claudeSkillNames: ['review:review'],
      mcpSelections: [selection],
      mcpHttpAuthPreferences: [
        {
          target: { kind: 'plugin', ...ref, serverName: 'review' },
          handler: 'canopy',
          source: 'default',
        },
      ],
      hookDeclarations: [],
    },
    provenance: {
      roots: { 'home/review': 'inherited' },
      mcpSelections: ['inherited'],
    },
    items: [],
    homeEntries: [entry],
  };
}
it('preserves installed MCP provenance and auth pins through nested home inheritance', () => {
  const original = home();
  const nested = selectHomeCapabilityOverlay(original);
  expect(nested?.capabilities.mcpSelections).toEqual(
    original.capabilities.mcpSelections,
  );
  expect(nested?.capabilities.mcpHttpAuthPreferences).toEqual(
    original.capabilities.mcpHttpAuthPreferences,
  );
  expect(nested?.provenance.mcpSelections).toEqual(['inherited']);
  expect(isHomeOnlyCapabilityOverlay(original, nested)).toBe(true);
});
it('lets an explicitly selected plugin replace the same inherited plugin without duplicate content or MCP', () => {
  const original = home();
  const selected: MaterializedCapabilityOverlay = {
    version: 3,
    pluginFiles: {
      'plugins/picked/.claude-plugin/plugin.json': '{"name":"tool"}',
    },
    capabilities: {
      claudePluginRoots: ['plugins/picked'],
      codexCapabilityRoots: ['plugins/picked'],
      claudeSkillNames: [],
      mcpSelections: [],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: { roots: { 'plugins/picked': 'explicit' }, mcpSelections: [] },
    items: [
      {
        id: 'plugin:market/tool',
        name: 'tool',
        source: 'explicit',
        ref: { kind: 'plugin', marketplaceId: 'market', pluginName: 'tool' },
      },
    ],
  };
  const merged = mergeHomeCapabilityOverlay(selected, original);
  expect(merged).toEqual(selected);
});
it('keeps installed MCP when another selected skill is added', () => {
  const selected: MaterializedCapabilityOverlay = {
    version: 3,
    pluginFiles: { 'skills/picked/SKILL.md': 'PICKED' },
    capabilities: {
      claudePluginRoots: ['skills/picked'],
      codexCapabilityRoots: ['skills/picked'],
      claudeSkillNames: ['picked:picked'],
      mcpSelections: [],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: { roots: { 'skills/picked': 'explicit' }, mcpSelections: [] },
    items: [],
  };
  const original = home();
  const merged = mergeHomeCapabilityOverlay(selected, original);
  expect(merged?.capabilities.mcpSelections).toEqual(
    original.capabilities.mcpSelections,
  );
  expect(merged?.capabilities.mcpHttpAuthPreferences).toEqual(
    original.capabilities.mcpHttpAuthPreferences,
  );
  expect(merged?.provenance.mcpSelections).toEqual(['inherited']);
});

it('skips home-only metadata that exceeds the complete artifact budget', async () => {
  const original = home();
  const ref = { marketplaceId: 'm'.repeat(250), pluginName: 'p'.repeat(190) };
  const servers = Array.from({ length: 128 }, (_, index) => ({
    serverName: 's'.repeat(245) + index,
    configDigest: 'a'.repeat(64),
  }));
  const inherited: MaterializedCapabilityOverlay = {
    ...original,
    pluginFiles: {
      ...original.pluginFiles,
      ...Object.fromEntries(
        Array.from({ length: 15 }, (_, index) => [
          `home/review/skills/review/guidance-${index}.md`,
          'x'.repeat(58_000),
        ]),
      ),
    },
    capabilities: {
      ...original.capabilities,
      mcpSelections: servers.map((server) => ({
        ...server,
        ...ref,
        root: 'home/review',
        source: 'inherited-plugin',
        installationDigest: 'b'.repeat(64),
      })),
      mcpHttpAuthPreferences: servers.map((server) => ({
        target: { kind: 'plugin', ...ref, serverName: server.serverName },
        handler: 'provider',
        source: 'override',
      })),
    },
    provenance: {
      roots: { 'home/review': 'inherited' },
      mcpSelections: servers.map(() => 'inherited'),
    },
    homeEntries: [
      {
        root: 'home/review',
        kind: 'plugin',
        name: ref.pluginName,
        origin: 'claude',
        pluginRef: ref,
      },
    ],
  };
  expect(Buffer.byteLength(JSON.stringify(inherited.pluginFiles))).toBeLessThan(
    900_000,
  );
  expect(Buffer.byteLength(JSON.stringify(inherited))).toBeGreaterThan(
    1_048_576,
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), 'home-only-budget-'));
  try {
    const store = new AgentArtifactStore(directory);
    // The metadata is valid: the same declarations fit with smaller content.
    await expect(
      store.retainCapabilityOverlay({
        ...inherited,
        pluginFiles: original.pluginFiles,
      }),
    ).resolves.toBeDefined();
    await expect(store.retainCapabilityOverlay(inherited)).rejects.toThrow(
      'Invalid capability overlay',
    );
    const skipped = jest.fn();
    expect(
      mergeHomeCapabilityOverlay(undefined, inherited, skipped),
    ).toBeUndefined();
    expect(skipped).toHaveBeenCalledWith(inherited.homeEntries?.[0]);
    expect(mergeHomeCapabilityOverlay(undefined, original)).toEqual(original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

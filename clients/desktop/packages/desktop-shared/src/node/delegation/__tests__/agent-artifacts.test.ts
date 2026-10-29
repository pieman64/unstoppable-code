import { createHash } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
  readdir,
  symlink,
  link,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AgentArtifactStore,
  EMPTY_AGENT_CAPABILITIES,
  capabilityOverlayFromAgentProjection,
  isEmptyCapabilityOverlayInput,
  type CapabilityOverlayInput,
  type AgentCapabilitySnapshot,
  type AgentProjectionInput,
  type MaterializedAgentProjection,
  validAgentProjectionMember,
} from '../agent-artifacts';
import * as privateStorage from '../private-storage';
import { projectAgentRoute } from '../route';
import { routeFixture } from './fixtures';

function projection(): AgentProjectionInput & {
  capabilities: AgentCapabilitySnapshot;
} {
  return {
    agentDefinitionId: 'agent_model_reviewer',
    agentDefinitionRevision: '2026-09-08T00:00:00.000Z',
    agentDefinitionHash: createHash('sha256')
      .update('original definition')
      .digest('hex'),
    systemPromptAppend: 'PRIVATE_REVIEW_PROMPT',
    pluginFiles: { 'skills/review/SKILL.md': 'PRIVATE_SELECTED_SKILL' },
    toolNames: ['read', 'search'],
    capabilities: {
      claudePluginRoots: ['skills/review'],
      claudeSkillNames: ['review:review'],
      codexCapabilityRoots: ['skills/review'],
      mcpSelections: [],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
  };
}

function capabilityOverlay(): CapabilityOverlayInput {
  return {
    pluginFiles: {
      'skills/review/SKILL.md': 'selected skill',
      'plugins/review/manifest.json': 'selected plugin',
    },
    capabilities: {
      claudePluginRoots: ['plugins/review'],
      claudeSkillNames: ['review:review'],
      codexCapabilityRoots: ['skills/review'],
      mcpSelections: [
        {
          source: 'standalone',
          serverId: 'server',
          configId: 'default',
          configDigest: 'b'.repeat(64),
        },
      ],
      mcpHttpAuthPreferences: [],
      hookDeclarations: [],
    },
    provenance: {
      roots: {
        'plugins/review': 'explicit',
        'skills/review': 'inherited',
      },
      mcpSelections: ['loaded'],
    },
    items: [
      {
        id: `deferred:v1:${'A'.repeat(43)}`,
        name: 'Review skill',
        source: 'explicit',
        ref: {
          kind: 'skill',
          sourceId: 'workspace:skills',
          skillName: 'review',
        },
      },
      {
        id: `deferred:v1:${'B'.repeat(43)}`,
        name: 'Review plugin',
        source: 'inherited',
        ref: {
          kind: 'plugin',
          marketplaceId: 'builtin/review',
          pluginName: 'review',
        },
      },
      {
        id: `deferred:v1:${'C'.repeat(43)}`,
        name: 'Review server',
        source: 'loaded',
        ref: { kind: 'mcp', serverId: 'server id', configId: 'default' },
      },
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('Expected test record');
  return value;
}

function cloneOverlay(input: CapabilityOverlayInput): Record<string, unknown> {
  const value: unknown = JSON.parse(JSON.stringify(input));
  return record(value);
}

async function expectInvalidCapabilityOverlay(
  store: AgentArtifactStore,
  input: unknown,
): Promise<void> {
  // @ts-expect-error Exercise runtime validation with untrusted material.
  await expect(store.retainCapabilityOverlay(input)).rejects.toThrow(
    'Invalid capability overlay',
  );
}

const invalidToolProjection: AgentProjectionInput = {
  ...projection(),
  // @ts-expect-error unsupported tool names must be rejected by the static contract
  toolNames: ['Bash'],
};
void invalidToolProjection;

describe('retained Agent materialization', () => {
  let directory: string;
  let store: AgentArtifactStore;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'delegation-artifacts-'));
    store = new AgentArtifactStore(directory);
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('retains the exact prompt and selected file bytes across source mutation and a new store instance', async () => {
    const files = { 'skills/review/SKILL.md': 'PRIVATE_SELECTED_SKILL' };
    const input = { ...projection(), pluginFiles: files };
    const snapshot = await store.retain(input);
    input.systemPromptAppend = 'edited definition';
    files['skills/review/SKILL.md'] = 'edited plugin';
    const restored = await new AgentArtifactStore(directory).load(snapshot);
    expect(restored.systemPromptAppend).toBe('PRIVATE_REVIEW_PROMPT');
    expect(restored.pluginFiles).toEqual({
      'skills/review/SKILL.md': 'PRIVATE_SELECTED_SKILL',
    });
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.pluginFiles)).toBe(true);
    expect(Object.isFrozen(restored.toolNames)).toBe(true);
    expect(restored.version).toBe(2);
    expect(restored.capabilities).toEqual(input.capabilities);
    expect(Object.isFrozen(restored.capabilities)).toBe(true);
    const publicText = JSON.stringify(
      projectAgentRoute(routeFixture({ agentOverlay: snapshot })),
    );
    expect(publicText).not.toMatch(
      /PRIVATE_|artifactId|manifestHash|systemPromptAppend|pluginFiles|toolNames/,
    );
    expect(snapshot.agentDefinitionRevision).toBe(
      input.agentDefinitionRevision,
    );
    expect(snapshot.artifact.formatVersion).toBe(2);
  });

  it('deduplicates concurrent equivalent projections but retains edits as a different artifact', async () => {
    const first = projection();
    const [left, right] = await Promise.all([
      store.retain(first),
      store.retain({ ...first, toolNames: ['search', 'read'] }),
    ]);
    expect(left).toEqual(right);
    const changed = await store.retain({
      ...first,
      pluginFiles: { 'skills/review/SKILL.md': 'new bytes' },
    });
    expect(changed.artifact.artifactId).not.toBe(left.artifact.artifactId);
    expect((await store.load(left)).pluginFiles).toEqual(first.pluginFiles);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.json')),
    ).toHaveLength(2);
  });

  it('loads an existing version-one artifact without changing its digest', async () => {
    const { capabilities: _capabilities, ...legacyInput } = projection();
    void _capabilities;
    const legacy = { version: 1, ...legacyInput };
    const text = JSON.stringify(legacy);
    const hash = createHash('sha256').update(text).digest('hex');
    const pluginProjectionHash = createHash('sha256')
      .update(
        JSON.stringify({
          files: legacy.pluginFiles,
          tools: legacy.toolNames,
        }),
      )
      .digest('hex');
    await writeFile(path.join(directory, `${hash}.json`), text);
    const restored = await store.load({
      agentDefinitionId: legacy.agentDefinitionId,
      agentDefinitionRevision: legacy.agentDefinitionRevision,
      agentDefinitionHash: legacy.agentDefinitionHash,
      pluginProjectionHash,
      systemPromptAppend: legacy.systemPromptAppend,
      artifact: { artifactId: hash, manifestHash: hash, formatVersion: 1 },
    });
    expect(restored.version).toBe(1);
    expect(restored.pluginFiles).toEqual(legacy.pluginFiles);
  });

  it('rejects changed artifact bytes and never repairs a corrupted retained artifact implicitly', async () => {
    const input = projection();
    const snapshot = await store.retain(input);
    const file = path.join(directory, `${snapshot.artifact.artifactId}.json`);
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace(
        'PRIVATE_SELECTED_SKILL',
        'tampered',
      ),
    );
    await expect(store.load(snapshot)).rejects.toThrow(
      'Agent artifact verification failed',
    );
    await expect(store.retain(input)).rejects.toThrow(
      'Agent artifact verification failed',
    );
  });

  it('checks the directory ACL before reading, as resume loads without a prior persist', async () => {
    const snapshot = await store.retain(projection());
    const acl = jest
      .spyOn(privateStorage, 'assertPrivateDirectoryAcl')
      .mockRejectedValue(
        new Error('Delegation storage directory is not private'),
      );
    try {
      await expect(
        new AgentArtifactStore(directory).load(snapshot),
      ).rejects.toThrow('Agent artifact verification failed');
      expect(acl).toHaveBeenCalledWith(directory);
    } finally {
      acl.mockRestore();
    }
  });

  it('verifies protected snapshot metadata as well as the manifest digest', async () => {
    const snapshot = await store.retain(projection());
    await expect(
      store.load({ ...snapshot, agentDefinitionRevision: 'changed' }),
    ).rejects.toThrow('Agent artifact verification failed');
    await expect(
      store.load({ ...snapshot, pluginProjectionHash: 'changed' }),
    ).rejects.toThrow('Agent artifact verification failed');
    await expect(
      store.load({
        ...snapshot,
        artifact: { ...snapshot.artifact, artifactId: '../outside' },
      }),
    ).rejects.toThrow('Agent artifact verification failed');
  });

  it.each([
    '../outside',
    '/absolute',
    'skills/../outside',
    'skills\\outside',
    '.codex/auth.json',
    '.env',
    'skills/review/.env',
  ])('rejects unsafe materialized member %s', async (name) => {
    await expect(
      store.retain({ ...projection(), pluginFiles: { [name]: 'bytes' } }),
    ).rejects.toThrow('Invalid Agent projection');
  });

  it('rejects unsupported tools, colliding paths and oversized projections before writing', async () => {
    await expect(
      store.retain({
        ...projection(),
        toolNames: ['read', 'Bash'],
      } as unknown as AgentProjectionInput),
    ).rejects.toThrow('Invalid Agent projection');
    await expect(
      store.retain({
        ...projection(),
        pluginFiles: { 'skills/A.md': 'one', 'skills/a.md': 'two' },
      }),
    ).rejects.toThrow('Invalid Agent projection');
    await expect(
      store.retain({
        ...projection(),
        systemPromptAppend: 'x'.repeat(1_100_000),
      }),
    ).rejects.toThrow('Invalid Agent projection');
    expect(await readdir(directory)).toEqual([]);
  });

  it('rejects capability roots outside the retained file map and invalid MCP identities', async () => {
    await expect(
      store.retain({
        ...projection(),
        capabilities: {
          ...projection().capabilities,
          claudePluginRoots: ['../outside'],
        },
      }),
    ).rejects.toThrow('Invalid Agent projection');
    await expect(
      store.retain({
        ...projection(),
        capabilities: {
          ...projection().capabilities,
          mcpSelections: [
            {
              source: 'standalone',
              serverId: '../outside',
              configId: 'default',
              configDigest: 'a'.repeat(64),
            },
          ],
        },
      }),
    ).rejects.toThrow('Invalid Agent projection');
    expect(await readdir(directory)).toEqual([]);
  });

  it.each(['builtin/app', 'pipeline-package:abc123'])(
    'retains plugin MCP capabilities with marketplace ID %s',
    async (marketplaceId) => {
      const input = projection();
      const capabilities = {
        ...input.capabilities,
        mcpSelections: [
          {
            source: 'plugin' as const,
            marketplaceId,
            pluginName: 'browser',
            serverName: 'search',
            root: 'skills/review',
            configDigest: 'a'.repeat(64),
          },
        ],
        mcpHttpAuthPreferences: [
          {
            handler: 'canopy' as const,
            target: {
              kind: 'plugin' as const,
              marketplaceId,
              pluginName: 'browser',
              serverName: 'search',
            },
          },
        ],
      };
      const snapshot = await store.retain({ ...input, capabilities });
      // A pin without provenance reads back as the user's own override.
      expect(
        (await new AgentArtifactStore(directory).load(snapshot)).capabilities,
      ).toEqual({
        ...capabilities,
        mcpHttpAuthPreferences: capabilities.mcpHttpAuthPreferences.map(
          (pin) => ({ ...pin, source: 'override' }),
        ),
      });
    },
  );

  it.each(['github', 'custom:11111111-2222-4333-8444-555555555555'])(
    'retains account MCP selections keyed by server key %s',
    async (serverId) => {
      const input = projection();
      const capabilities = {
        ...input.capabilities,
        mcpSelections: [
          {
            source: 'account' as const,
            serverId,
            configId: 'default',
            configDigest: 'a'.repeat(64),
          },
        ],
      };
      const snapshot = await store.retain({ ...input, capabilities });
      expect(
        (await new AgentArtifactStore(directory).load(snapshot)).capabilities,
      ).toEqual(capabilities);
    },
  );

  it.each(['account:connection', 'custom:../outside', 'custom:'])(
    'rejects unsafe account MCP server key %s',
    async (serverId) => {
      const input = projection();
      await expect(
        store.retain({
          ...input,
          capabilities: {
            ...input.capabilities,
            mcpSelections: [
              {
                source: 'account',
                serverId,
                configId: 'default',
                configDigest: 'a'.repeat(64),
              },
            ],
          },
        }),
      ).rejects.toThrow('Invalid Agent projection');
    },
  );

  it.each(['../outside', '/absolute', 'market/../outside', 'market\\outside'])(
    'rejects unsafe plugin marketplace ID %s',
    async (marketplaceId) => {
      const input = projection();
      await expect(
        store.retain({
          ...input,
          capabilities: {
            ...input.capabilities,
            mcpSelections: [
              {
                source: 'plugin',
                marketplaceId,
                pluginName: 'browser',
                serverName: 'search',
                root: 'skills/review',
                configDigest: 'a'.repeat(64),
              },
            ],
          },
        }),
      ).rejects.toThrow('Invalid Agent projection');
    },
  );

  it.each([undefined, 'not-a-digest'])(
    'rejects inherited plugin installation pin %s',
    async (installationDigest) => {
      const input = capabilityOverlay();
      const selection = {
        source: 'plugin' as const,
        marketplaceId: 'market',
        pluginName: 'tool',
        serverName: 'review',
        root: 'skills/review',
        configDigest: 'a'.repeat(64),
      };
      Reflect.set(selection, 'source', 'inherited-plugin');
      Reflect.set(selection, 'installationDigest', installationDigest);
      await expect(
        store.retainCapabilityOverlay({
          ...input,
          capabilities: { ...input.capabilities, mcpSelections: [selection] },
          provenance: { ...input.provenance, mcpSelections: ['inherited'] },
        }),
      ).rejects.toThrow();
    },
  );

  it('retains inherited-plugin MCP provenance without treating it as a marketplace installation', async () => {
    const input = capabilityOverlay();
    const selection = {
      source: 'plugin' as const,
      marketplaceId: 'market',
      pluginName: 'tool',
      serverName: 'review',
      root: 'skills/review',
      configDigest: 'a'.repeat(64),
    };
    // Simulate the new persisted discriminator without weakening the input's type.
    Reflect.set(selection, 'source', 'inherited-plugin');
    Reflect.set(selection, 'installationDigest', 'b'.repeat(64));
    const snapshot = await store.retainCapabilityOverlay({
      ...input,
      capabilities: { ...input.capabilities, mcpSelections: [selection] },
      provenance: { ...input.provenance, mcpSelections: ['inherited'] },
      homeEntries: [
        {
          root: 'skills/review',
          kind: 'plugin',
          name: 'tool',
          origin: 'claude',
          pluginRef: { marketplaceId: 'market', pluginName: 'tool' },
        },
      ],
    });
    const restored = await new AgentArtifactStore(
      directory,
    ).loadCapabilityOverlay(snapshot);
    expect(restored.capabilities.mcpSelections).toEqual([selection]);
    expect(restored.provenance.mcpSelections).toEqual(['inherited']);
  });

  it('retains home entry provenance and copied bytes across a fresh artifact store', async () => {
    const input = {
      ...capabilityOverlay(),
      homeEntries: [
        {
          root: 'skills/review',
          kind: 'skill' as const,
          name: 'Home review',
          origin: 'claude' as const,
        },
      ],
    };
    const snapshot = await store.retainCapabilityOverlay(input);
    input.homeEntries[0].name = 'Changed parent name';
    input.pluginFiles = {};
    const restored = await new AgentArtifactStore(
      directory,
    ).loadCapabilityOverlay(snapshot);
    expect(restored).toMatchObject({
      homeEntries: [
        {
          root: 'skills/review',
          kind: 'skill' as const,
          name: 'Home review',
          origin: 'claude' as const,
        },
      ],
    });
    expect(restored.pluginFiles['skills/review/SKILL.md']).toBe(
      'selected skill',
    );
    const publicText = JSON.stringify(
      projectAgentRoute(routeFixture({ capabilityOverlay: snapshot })),
    );
    expect(publicText).not.toMatch(
      /Home review|homeEntries|selected skill|skills\/review/,
    );
  });

  it('includes home entry identity in the retained capability hash', async () => {
    const base = capabilityOverlay();
    const firstInput = {
      ...base,
      homeEntries: [
        {
          root: 'skills/review',
          kind: 'skill' as const,
          name: 'Home review',
          origin: 'claude' as const,
        },
      ],
    };
    const secondInput = {
      ...base,
      homeEntries: [
        {
          root: 'skills/review',
          kind: 'skill' as const,
          name: 'Home review',
          origin: 'codex' as const,
        },
      ],
    };
    const first = await store.retainCapabilityOverlay(firstInput);
    const second = await store.retainCapabilityOverlay(secondInput);
    expect(second.capabilityProjectionHash).not.toBe(
      first.capabilityProjectionHash,
    );
    expect(second.artifact.artifactId).not.toBe(first.artifact.artifactId);
  });

  it.each([
    [{ root: '../outside', kind: 'skill', name: 'Review', origin: 'claude' }],
    [{ root: 'missing/root', kind: 'skill', name: 'Review', origin: 'claude' }],
    [
      {
        root: 'plugins/review',
        kind: 'skill',
        name: 'Review',
        origin: 'claude',
      },
    ],
    [
      {
        root: 'skills/review',
        kind: 'skill',
        name: 'bad\nlabel',
        origin: 'claude',
      },
    ],
    [{ root: 'skills/review', kind: 'hook', name: 'Review', origin: 'claude' }],
    [
      {
        root: 'skills/review',
        kind: 'skill',
        name: 'Review',
        origin: 'unknown',
      },
    ],
  ])('rejects invalid or non-inherited home provenance %j', async (entry) => {
    await expectInvalidCapabilityOverlay(store, {
      ...capabilityOverlay(),
      homeEntries: [entry],
    });
  });

  it('rejects duplicate home roots and path-bearing home names', async () => {
    const entry = {
      root: 'skills/review',
      kind: 'skill',
      name: 'Review',
      origin: 'claude',
    };
    await expectInvalidCapabilityOverlay(store, {
      ...capabilityOverlay(),
      homeEntries: [entry, entry],
    });
    await expectInvalidCapabilityOverlay(store, {
      ...capabilityOverlay(),
      homeEntries: [{ ...entry, name: '/Users/private/skill' }],
    });
  });

  it('retains a normalized v3 overlay with stable hashes', async () => {
    const input = capabilityOverlay();
    const snapshot = await store.retainCapabilityOverlay(input);
    const freshStore = new AgentArtifactStore(directory);
    const restored = await freshStore.loadCapabilityOverlay(snapshot);
    const text = await readFile(
      path.join(directory, `${snapshot.artifact.artifactId}.json`),
      'utf8',
    );
    const capabilityHash = createHash('sha256')
      .update(
        JSON.stringify({
          files: restored.pluginFiles,
          capabilities: restored.capabilities,
          provenance: restored.provenance,
          items: restored.items,
        }),
      )
      .digest('hex');
    expect(text).toBe(JSON.stringify(restored));
    expect(snapshot.artifact.manifestHash).toBe(
      createHash('sha256').update(text).digest('hex'),
    );
    expect(snapshot.capabilityProjectionHash).toBe(capabilityHash);
    expect(restored.version).toBe(3);
    expect(restored.pluginFiles).toEqual({
      'plugins/review/manifest.json': 'selected plugin',
      'skills/review/SKILL.md': 'selected skill',
    });
    expect(restored.items.map((item) => item.id)).toEqual(
      input.items.map((item) => item.id),
    );
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.artifact)).toBe(true);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.pluginFiles)).toBe(true);
    expect(Object.isFrozen(restored.capabilities)).toBe(true);
    expect(Object.isFrozen(restored.capabilities.claudePluginRoots)).toBe(true);
    expect(Object.isFrozen(restored.capabilities.mcpSelections)).toBe(true);
    expect(Object.isFrozen(restored.capabilities.mcpSelections[0])).toBe(true);
    expect(Object.isFrozen(restored.provenance)).toBe(true);
    expect(Object.isFrozen(restored.provenance.roots)).toBe(true);
    expect(Object.isFrozen(restored.provenance.mcpSelections)).toBe(true);
    expect(Object.isFrozen(restored.items)).toBe(true);
    expect(Object.isFrozen(restored.items[0])).toBe(true);
    expect(Object.isFrozen(restored.items[0]?.ref)).toBe(true);
    expect(isEmptyCapabilityOverlayInput(input)).toBe(false);
  });

  it('keeps pin provenance and reads a pin without a source as an explicit override', async () => {
    // REG-3033: a synthesized pin (the parent's inherited default) must stay
    // distinguishable from a user override in the child. Artifacts written
    // before provenance existed carry no `source`; they stay overrides.
    const input = projection();
    const explicit = {
      handler: 'canopy' as const,
      target: {
        kind: 'plugin' as const,
        marketplaceId: 'builtin/app',
        pluginName: 'browser',
        serverName: 'search',
      },
    };
    const synthesized = {
      handler: 'account' as const,
      source: 'default' as const,
      target: {
        kind: 'standalone' as const,
        serverId: 'server',
        configId: 'default',
      },
    };
    const snapshot = await store.retain({
      ...input,
      capabilities: {
        ...input.capabilities,
        mcpHttpAuthPreferences: [explicit, synthesized],
      },
    });
    expect(
      (await new AgentArtifactStore(directory).load(snapshot)).capabilities
        .mcpHttpAuthPreferences,
    ).toEqual([{ ...explicit, source: 'override' }, synthesized]);
  });

  it('retains an account auth preference in a v3 overlay', async () => {
    const input = capabilityOverlay();
    const accountPreference = {
      handler: 'account' as const,
      target: {
        kind: 'standalone' as const,
        serverId: 'server',
        configId: 'default',
      },
    };
    const snapshot = await store.retainCapabilityOverlay({
      ...input,
      capabilities: {
        ...input.capabilities,
        mcpHttpAuthPreferences: [accountPreference],
      },
    });
    const restored = await new AgentArtifactStore(
      directory,
    ).loadCapabilityOverlay(snapshot);
    expect(restored.capabilities.mcpHttpAuthPreferences).toEqual([
      { ...accountPreference, source: 'override' },
    ]);
  });

  it('rejects tampered v3 content, format and capability hashes', async () => {
    const snapshot = await store.retainCapabilityOverlay(capabilityOverlay());
    await expect(
      store.loadCapabilityOverlay({
        ...snapshot,
        capabilityProjectionHash: '0'.repeat(64),
      }),
    ).rejects.toThrow('Capability overlay verification failed');
    const wrongFormat = {
      ...snapshot,
      artifact: { ...snapshot.artifact, formatVersion: 2 },
    };
    // @ts-expect-error Verify the runtime rejects swapped artifact versions.
    await expect(store.loadCapabilityOverlay(wrongFormat)).rejects.toThrow(
      'Capability overlay verification failed',
    );

    const file = path.join(directory, `${snapshot.artifact.artifactId}.json`);
    await writeFile(
      file,
      (await readFile(file, 'utf8')).replace('selected skill', 'tampered'),
    );
    await expect(store.loadCapabilityOverlay(snapshot)).rejects.toThrow(
      'Capability overlay verification failed',
    );
  });

  it('keeps Agent and capability formats exclusive', async () => {
    const capabilitySnapshot =
      await store.retainCapabilityOverlay(capabilityOverlay());
    // @ts-expect-error A capability artifact is not an Agent artifact.
    await expect(store.load(capabilitySnapshot)).rejects.toThrow(
      'Agent artifact verification failed',
    );
    const agentSnapshot = await store.retain(projection());
    // @ts-expect-error An Agent artifact is not a capability artifact.
    await expect(store.loadCapabilityOverlay(agentSnapshot)).rejects.toThrow(
      'Capability overlay verification failed',
    );
  });

  it('rejects invalid provenance and malformed items', async () => {
    const input = capabilityOverlay();
    const missingRoot = cloneOverlay(input);
    record(missingRoot.provenance).roots = {
      'plugins/review': 'explicit',
    };
    const extraRoot = cloneOverlay(input);
    record(extraRoot.provenance).roots = {
      'plugins/review': 'explicit',
      'skills/review': 'inherited',
      'plugins/extra': 'loaded',
    };
    const wrongMcpLength = cloneOverlay(input);
    record(wrongMcpLength.provenance).mcpSelections = [];
    const invalidSource = cloneOverlay(input);
    record(invalidSource.provenance).roots = {
      'plugins/review': 'unknown',
      'skills/review': 'inherited',
    };
    const duplicateIds = cloneOverlay(input);
    const duplicateItems = duplicateIds.items;
    if (!Array.isArray(duplicateItems)) throw new Error('Expected test items');
    duplicateItems.push(duplicateItems[0]);
    const badId = cloneOverlay(input);
    if (!Array.isArray(badId.items)) throw new Error('Expected test items');
    record(badId.items[0]).id = 'not-a-deferred-id';
    const newlineName = cloneOverlay(input);
    if (!Array.isArray(newlineName.items))
      throw new Error('Expected test items');
    record(newlineName.items[0]).name = 'bad\nname';

    await expectInvalidCapabilityOverlay(store, missingRoot);
    await expectInvalidCapabilityOverlay(store, extraRoot);
    await expectInvalidCapabilityOverlay(store, wrongMcpLength);
    await expectInvalidCapabilityOverlay(store, invalidSource);
    await expectInvalidCapabilityOverlay(store, duplicateIds);
    await expectInvalidCapabilityOverlay(store, badId);
    await expectInvalidCapabilityOverlay(store, newlineName);
    expect(await readdir(directory)).toEqual([]);
  });

  it('maps v1/v2 Agent projections to agent provenance', async () => {
    const { capabilities: _capabilities, ...legacyInput } = projection();
    void _capabilities;
    const legacy = { version: 1 as const, ...legacyInput };
    const text = JSON.stringify(legacy);
    const hash = createHash('sha256').update(text).digest('hex');
    const pluginProjectionHash = createHash('sha256')
      .update(
        JSON.stringify({ files: legacy.pluginFiles, tools: legacy.toolNames }),
      )
      .digest('hex');
    await writeFile(path.join(directory, `${hash}.json`), text);
    const v1Projection = await store.load({
      agentDefinitionId: legacy.agentDefinitionId,
      agentDefinitionRevision: legacy.agentDefinitionRevision,
      agentDefinitionHash: legacy.agentDefinitionHash,
      pluginProjectionHash,
      systemPromptAppend: legacy.systemPromptAppend,
      artifact: { artifactId: hash, manifestHash: hash, formatVersion: 1 },
    });
    const v1Overlay = capabilityOverlayFromAgentProjection(v1Projection);
    if (!v1Overlay) throw new Error('Expected v1 capability overlay');
    expect(v1Overlay.capabilities).toEqual(EMPTY_AGENT_CAPABILITIES);
    expect(Object.keys(v1Overlay.provenance.roots)).toEqual([]);
    expect(v1Overlay.items).toEqual([]);

    const v2Input = projection();
    const v2Snapshot = await store.retain({
      ...v2Input,
      capabilities: {
        ...v2Input.capabilities,
        mcpSelections: [
          {
            source: 'standalone',
            serverId: 'server',
            configId: 'default',
            configDigest: 'b'.repeat(64),
          },
        ],
      },
    });
    const v2Projection = await store.load(v2Snapshot);
    const v2Overlay = capabilityOverlayFromAgentProjection(v2Projection);
    if (!v2Overlay) throw new Error('Expected v2 capability overlay');
    expect(Object.values(v2Overlay.provenance.roots)).toEqual(['agent']);
    expect(v2Overlay.provenance.mcpSelections).toEqual(['agent']);
    expect(v2Overlay.items).toEqual([]);
  });

  it('omits an overlay for an empty Agent projection', async () => {
    const snapshot = await store.retain({
      ...projection(),
      pluginFiles: {},
      capabilities: EMPTY_AGENT_CAPABILITIES,
    });
    const emptyProjection: MaterializedAgentProjection =
      await store.load(snapshot);
    expect(
      capabilityOverlayFromAgentProjection(emptyProjection),
    ).toBeUndefined();
    expect(
      isEmptyCapabilityOverlayInput({
        pluginFiles: {},
        capabilities: EMPTY_AGENT_CAPABILITIES,
        provenance: { roots: {}, mcpSelections: [] },
        items: [],
      }),
    ).toBe(true);
  });

  it.each(['symbolic', 'hard'])(
    'rejects a %s linked manifest',
    async (kind) => {
      const snapshot = await store.retain(projection());
      const file = path.join(directory, `${snapshot.artifact.artifactId}.json`);
      const replacement = path.join(directory, 'replacement');
      await writeFile(replacement, await readFile(file));
      await unlink(file);
      if (kind === 'symbolic') await symlink(replacement, file);
      else await link(replacement, file);
      await expect(store.load(snapshot)).rejects.toThrow(
        'Agent artifact verification failed',
      );
    },
  );
});

describe('validAgentProjectionMember', () => {
  it('rejects Win32 name aliases only on Windows', () => {
    for (const member of [
      'skills/demo.',
      'skills/demo /SKILL.md',
      'skills/DEMOSK~1/SKILL.md',
      'skills/nul',
      'skills/demo/con.md',
      'skills/COM9.txt',
    ]) {
      expect(validAgentProjectionMember(member, 'win32')).toBe(false);
      expect(validAgentProjectionMember(member, 'darwin')).toBe(true);
    }
    for (const member of [
      'skills/demo/SKILL.md',
      'skills/COM0',
      'skills/lpt0.md',
    ])
      expect(validAgentProjectionMember(member, 'win32')).toBe(true);
  });
});

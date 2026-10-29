import {
  buildSharedCollectionPayload,
  convertLocalCollectionToEditable,
  hydrateEditableSharedCollection,
  type EditableSharedCollection,
} from '../sharedCollections';
import type {
  CollectionConfig,
  SharedCollectionDetail,
  SharedCollectionItem,
} from '@canopy/desktop-shared/types/collections';
import type {
  InstalledSkillInfo,
  SharedSkillDetail,
} from '@canopy/desktop-shared/types/skills';

const { readFileSync } = jest.requireActual<{
  readFileSync: (path: string, encoding: 'utf8') => string;
}>('node:fs');

interface RawWriteDocument {
  version: number;
  name: string;
  description: string;
  items: Array<Record<string, unknown>>;
}

function makeSharedSkillDetail(
  overrides: Partial<SharedSkillDetail> = {},
): SharedSkillDetail {
  return {
    id: 'srv-skill-1',
    name: 'helper',
    description: 'a helper',
    contentHash: 'hash-1',
    shareScope: 'private',
    owner: { type: 'user', id: 'u1', name: 'Alice' },
    createdBy: { id: 'u1', name: 'Alice', email: 'alice@example.com' },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    canUpdate: true,
    canDelete: true,
    rawSkill: '---\nname: helper\ndescription: a helper\n---\nbody\n',
    ...overrides,
  };
}

describe('hydrateEditableSharedCollection', () => {
  it('maps every linked custom_skill to EditableLinkedCustomSkillItem with remote skillId', () => {
    const detail: SharedCollectionDetail = {
      id: 'remote-1',
      name: 'My collection',
      description: 'desc',
      contentHash: 'hash-collection-1',
      itemCounts: { skills: 0, plugins: 0, customSkills: 1 },
      shareScope: 'private',
      owner: { type: 'user', id: 'u1', name: 'Alice' },
      createdBy: { id: 'u1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      rawCollection: '{}',
      collection: {
        version: 1,
        name: 'My collection',
        description: 'desc',
        items: [
          {
            type: 'custom_skill',
            skillId: 'srv-skill-1',
            skill_name: 'helper',
            contentHash: 'hash-1',
          },
        ],
      },
      customSkills: [makeSharedSkillDetail()],
    };

    const { editable, warnings } = hydrateEditableSharedCollection(detail);

    expect(warnings).toEqual([]);
    expect(editable.items).toHaveLength(1);
    const item = editable.items[0];
    expect(item.kind).toBe('linked_custom_skill');
    if (item.kind === 'linked_custom_skill') {
      expect(item.skillId).toBe('srv-skill-1');
      expect(item.contentHash).toBe('hash-1');
    }
  });

  it('preserves external skills and plugins', () => {
    const detail: SharedCollectionDetail = {
      id: 'remote-2',
      name: 'External Collection',
      description: '',
      contentHash: 'hash-collection-2',
      itemCounts: { skills: 1, plugins: 1, customSkills: 0 },
      shareScope: 'private',
      owner: { type: 'user', id: 'u1', name: 'Alice' },
      createdBy: { id: 'u1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      rawCollection: '{}',
      collection: {
        version: 1,
        name: 'External Collection',
        description: '',
        items: [
          {
            type: 'skill',
            source: { type: 'builtin', id: 'canopy' },
            skill_name: 'summarize',
          },
          {
            type: 'claude_plugin',
            marketplace: { type: 'github', repo: 'acme/marketplace' },
            plugin_name: 'browser',
          },
        ],
      },
      customSkills: [],
    };

    const { editable } = hydrateEditableSharedCollection(detail);
    expect(editable.items).toEqual([
      {
        kind: 'external_skill',
        source: { type: 'builtin', id: 'canopy' },
        skillName: 'summarize',
      },
      {
        kind: 'external_plugin',
        marketplace: { type: 'github', repo: 'acme/marketplace' },
        pluginName: 'browser',
      },
    ]);
  });

  it('surfaces a warning for unknown item types instead of throwing', () => {
    const detail: SharedCollectionDetail = {
      id: 'remote-3',
      name: 'Bad Collection',
      description: '',
      contentHash: 'hash-collection-3',
      itemCounts: { skills: 0, plugins: 0, customSkills: 0 },
      shareScope: 'private',
      owner: { type: 'user', id: 'u1', name: 'Alice' },
      createdBy: { id: 'u1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      rawCollection: '{}',
      collection: {
        version: 1,
        name: 'Bad Collection',
        description: '',
        items: [
          { type: 'unknown_future_type' } as unknown as SharedCollectionItem,
        ],
      },
      customSkills: [],
    };

    const { editable, warnings } = hydrateEditableSharedCollection(detail);
    expect(editable.items).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain('unknown_future_type');
  });
});

describe('buildSharedCollectionPayload', () => {
  it('keeps the pinned legacy draft_custom_skill shape installable', async () => {
    const editable = JSON.parse(
      readFileSync(
        `${__dirname}/../../../../../../../packages/protocol/src/__fixtures__/legacy-shares/collection/editable-draft.2026-09-22.json`,
        'utf8',
      ),
    ) as EditableSharedCollection;
    const result = await buildSharedCollectionPayload({
      name: editable.name,
      description: editable.description,
      items: editable.items,
      customSkillReader: () => Promise.resolve('# Legacy helper'),
    });
    expect(result.customSkills).toEqual([
      expect.objectContaining({ clientKey: 'legacy-helper' }),
    ]);
  });

  it('emits no customSkills payload entries for linked custom skills', async () => {
    const editable: EditableSharedCollection = {
      remoteId: 'remote-1',
      name: 'My collection',
      description: 'd',
      items: [
        {
          kind: 'linked_custom_skill',
          skillId: 'srv-skill-1',
          skillName: 'helper',
          contentHash: 'hash-1',
        },
      ],
    };

    const result = await buildSharedCollectionPayload({
      name: editable.name,
      description: editable.description,
      items: editable.items,
      customSkillReader: () => {
        throw new Error('reader should not be called for linked items');
      },
    });

    expect(result.customSkills).toEqual([]);
    const parsed = JSON.parse(result.rawCollection) as RawWriteDocument;
    expect(parsed.items[0]).toEqual({
      type: 'custom_skill',
      skillId: 'srv-skill-1',
      skill_name: 'helper',
      contentHash: 'hash-1',
    });
  });

  it('emits a customSkills payload entry per draft item with matching clientKey', async () => {
    const editable: EditableSharedCollection = {
      remoteId: '',
      name: 'My collection',
      description: 'd',
      items: [
        {
          kind: 'draft_custom_skill',
          clientKey: 'client-1',
          localSkillId: 'custom:app/helper',
          skillName: 'helper',
        },
      ],
    };
    const reads: string[] = [];
    const reader = (localSkillId: string): Promise<string> => {
      reads.push(localSkillId);
      return Promise.resolve('---\nname: helper\n---\nbody');
    };

    const result = await buildSharedCollectionPayload({
      name: editable.name,
      description: editable.description,
      items: editable.items,
      customSkillReader: reader,
    });

    expect(reads).toEqual(['custom:app/helper']);
    expect(result.customSkills).toHaveLength(1);
    expect(result.customSkills[0].clientKey).toBe('client-1');
    expect(result.customSkills[0].rawSkill).toBe(
      '---\nname: helper\n---\nbody',
    );
    const parsed = JSON.parse(result.rawCollection) as RawWriteDocument;
    expect(parsed.items[0]).toEqual({
      type: 'custom_skill',
      clientKey: 'client-1',
      skill_name: 'helper',
    });
  });

  it('rejects duplicate clientKeys', async () => {
    const editable: EditableSharedCollection = {
      remoteId: '',
      name: 'X',
      description: '',
      items: [
        {
          kind: 'draft_custom_skill',
          clientKey: 'k',
          localSkillId: 'custom:app/a',
          skillName: 'a',
        },
        {
          kind: 'draft_custom_skill',
          clientKey: 'k',
          localSkillId: 'custom:app/b',
          skillName: 'b',
        },
      ],
    };
    await expect(
      buildSharedCollectionPayload({
        name: editable.name,
        description: editable.description,
        items: editable.items,
        customSkillReader: () => Promise.resolve('body'),
      }),
    ).rejects.toThrow(/Duplicate clientKey/);
  });
});

describe('convertLocalCollectionToEditable', () => {
  function makeSkill(
    overrides: Partial<InstalledSkillInfo>,
  ): InstalledSkillInfo {
    return {
      name: 'helper',
      sourceId: 'custom:app',
      description: '',
      source: 'custom:app',
      installedAt: '',
      updatedAt: '',
      updateAvailable: false,
      custom: true,
      ...overrides,
    };
  }

  it('returns readiness requirements for Collection MCP refs without blocking sharing', () => {
    const config: CollectionConfig = {
      id: 'c1',
      name: 'C',
      description: '',
      skills: [],
      plugins: [],
      mcpServers: [{ serverId: 's', configId: 'cfg' }],
      createdAt: '',
      updatedAt: '',
    };
    expect(
      convertLocalCollectionToEditable({
        config,
        installedSkills: [],
        marketplaces: [],
      }).environmentRequirements,
    ).toEqual([
      expect.objectContaining({
        id: 'mcp:s',
        kind: 'mcp',
        displayName: 's',
        required: true,
      }),
    ]);
  });

  it('emits a draft_custom_skill for each custom:app skill ref', () => {
    const config: CollectionConfig = {
      id: 'c1',
      name: 'C',
      description: '',
      skills: [{ sourceId: 'custom:app', skillName: 'helper' }],
      plugins: [],
      mcpServers: [],
      createdAt: '',
      updatedAt: '',
    };
    const result = convertLocalCollectionToEditable({
      config,
      installedSkills: [makeSkill({})],
      marketplaces: [],
      generateClientKey: () => 'client-1',
    });
    expect(result.editable.items).toEqual([
      {
        kind: 'draft_custom_skill',
        clientKey: 'client-1',
        localSkillId: 'custom:app/helper',
        skillName: 'helper',
      },
    ]);
  });

  it('emits a draft_custom_skill for a local-filesystem skill ref', () => {
    const config: CollectionConfig = {
      id: 'c-local',
      name: 'Local skills',
      description: '',
      skills: [
        { sourceId: 'local:release-fixture', skillName: 'release-notes' },
      ],
      plugins: [],
      mcpServers: [],
      createdAt: '',
      updatedAt: '',
    };
    const result = convertLocalCollectionToEditable({
      config,
      installedSkills: [
        makeSkill({
          name: 'release-notes',
          sourceId: 'local:release-fixture',
          source: '/fixtures/release-notes',
          custom: false,
          shareableSource: undefined,
        }),
      ],
      marketplaces: [],
      generateClientKey: () => 'client-local',
    });

    expect(result.editable.items).toEqual([
      {
        kind: 'draft_custom_skill',
        clientKey: 'client-local',
        localSkillId: 'local:release-fixture/release-notes',
        skillName: 'release-notes',
      },
    ]);
  });

  it('emits an external_skill for built-in / GitHub-backed skills', () => {
    const config: CollectionConfig = {
      id: 'c2',
      name: 'C',
      description: '',
      skills: [
        { sourceId: 'builtin:app', skillName: 'summarize' },
        { sourceId: 'github:acme/skills', skillName: 'lint' },
      ],
      plugins: [],
      mcpServers: [],
      createdAt: '',
      updatedAt: '',
    };
    const result = convertLocalCollectionToEditable({
      config,
      installedSkills: [
        makeSkill({
          name: 'summarize',
          sourceId: 'builtin:app',
          custom: false,
          builtIn: true,
          shareableSource: { type: 'builtin', id: 'canopy' },
        }),
        makeSkill({
          name: 'lint',
          sourceId: 'github:acme/skills',
          custom: false,
          shareableSource: { type: 'github', repo: 'acme/skills' },
        }),
      ],
      marketplaces: [],
    });
    expect(result.editable.items).toEqual([
      {
        kind: 'external_skill',
        source: { type: 'builtin', id: 'canopy' },
        skillName: 'summarize',
      },
      {
        kind: 'external_skill',
        source: { type: 'github', repo: 'acme/skills' },
        skillName: 'lint',
      },
    ]);
  });

  // Review on #3180: a shared Collection is uploaded to Cloud and read by
  // recipients, so a credential-bearing marketplace URL must be REFUSED, not
  // normalized into a public reference — and the refusal must not echo the URL
  // that carries the credential.
  it.each([
    ['userinfo', 'https://user:token@github.com/acme/marketplace'],
    ['query', 'https://github.com/acme/marketplace?token=secret-value'],
    ['fragment', 'https://github.com/acme/marketplace#token=secret-value'],
  ])(
    'refuses a marketplace URL carrying a credential in the %s',
    (_label, sourceUrl) => {
      const config: CollectionConfig = {
        id: 'c4',
        name: 'C',
        description: '',
        skills: [],
        plugins: [{ marketplaceId: 'creds', pluginName: 'p' }],
        mcpServers: [],
        createdAt: '',
        updatedAt: '',
      };
      let thrown: unknown;
      try {
        convertLocalCollectionToEditable({
          config,
          installedSkills: [],
          marketplaces: [{ id: 'creds', sourceUrl }],
        });
      } catch (error: unknown) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      const message = thrown instanceof Error ? thrown.message : '';
      expect(message).toMatch(/unsupported marketplace/);
      // The message reaches the browser; it must not leak the credential.
      expect(message).not.toContain('secret-value');
      expect(message).not.toContain('token');
      expect(message).not.toContain(sourceUrl);
    },
  );

  it('throws when a plugin references an unsupported marketplace', () => {
    const config: CollectionConfig = {
      id: 'c3',
      name: 'C',
      description: '',
      skills: [],
      plugins: [{ marketplaceId: 'local', pluginName: 'p' }],
      mcpServers: [],
      createdAt: '',
      updatedAt: '',
    };
    expect(() =>
      convertLocalCollectionToEditable({
        config,
        installedSkills: [],
        marketplaces: [{ id: 'local', sourceUrl: '/some/local/dir' }],
      }),
    ).toThrow(/unsupported marketplace/);
  });
});

describe('round-trip: hydrate then save with no edits', () => {
  it('does not fork any linked custom skill into a draft', async () => {
    const detail: SharedCollectionDetail = {
      id: 'remote-1',
      name: 'My collection',
      description: '',
      contentHash: 'hash-collection-1',
      itemCounts: { skills: 0, plugins: 0, customSkills: 1 },
      shareScope: 'private',
      owner: { type: 'user', id: 'u1', name: 'Alice' },
      createdBy: { id: 'u1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      canUpdate: true,
      canDelete: true,
      rawCollection: '{}',
      collection: {
        version: 1,
        name: 'My collection',
        description: '',
        items: [
          {
            type: 'custom_skill',
            skillId: 'srv-skill-1',
            skill_name: 'helper',
            contentHash: 'hash-1',
          },
        ],
      },
      customSkills: [makeSharedSkillDetail()],
    };

    const { editable } = hydrateEditableSharedCollection(detail);
    const payload = await buildSharedCollectionPayload({
      name: editable.name,
      description: editable.description,
      items: editable.items,
      customSkillReader: () => {
        throw new Error('should not read for linked items');
      },
    });

    expect(payload.customSkills).toEqual([]);
    const parsed = JSON.parse(payload.rawCollection) as RawWriteDocument;
    expect(parsed.items[0].skillId).toBe('srv-skill-1');
    expect(parsed.items[0].clientKey).toBeUndefined();
  });
});

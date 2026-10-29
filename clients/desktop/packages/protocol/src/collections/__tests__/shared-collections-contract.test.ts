import {
  COLLECTION_SHARE_SCOPES,
  MAX_SHARED_COLLECTION_BYTES,
  MCP_SHARE_BLOCKED_MESSAGE,
  SHARED_COLLECTION_API_VERSION,
  validateSharedCollectionDocument,
  type CreateSharedCollectionRequest,
  type SharedCollectionCustomSkillPayload,
  type SharedCollectionDocument,
  type SharedCollectionSummary,
  type SharedCollectionWriteDocument,
  type UpdateSharedCollectionRequest,
} from '../index';

describe('shared-Collection API contract', () => {
  it('pins version, scopes, and byte ceiling', () => {
    expect(SHARED_COLLECTION_API_VERSION).toBe(1);
    expect(MAX_SHARED_COLLECTION_BYTES).toBe(1024 * 1024);
    expect(COLLECTION_SHARE_SCOPES).toEqual([
      'private',
      'team',
      'organization',
    ]);
    expect(MCP_SHARE_BLOCKED_MESSAGE).toBe(
      'Collections with MCP server configs cannot be shared. Remove MCP servers before sharing.',
    );
  });

  it('keeps DTOs serializable through JSON.stringify / parse', () => {
    const summary: SharedCollectionSummary = {
      id: 'col-1',
      name: 'Web sharing pack',
      description: 'Skills used during code review',
      contentHash: 'sha256:abc',
      itemCounts: { skills: 3, plugins: 1, customSkills: 1 },
      shareScope: 'organization',
      owner: { type: 'organization', id: 'org-1', name: 'Acme' },
      createdBy: { id: 'u-1', name: 'Alice', email: 'alice@example.com' },
      createdAt: '2026-05-22T00:00:00Z',
      updatedAt: '2026-05-22T00:00:00Z',
      canUpdate: true,
      canDelete: true,
    };
    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);

    const create: CreateSharedCollectionRequest = {
      serverId: 'srv-1',
      rawCollection: JSON.stringify({
        version: 1,
        name: 'X',
        description: '',
        items: [],
      }),
      customSkills: [],
      shareScope: 'team',
      teamId: 'team-1',
    };
    expect(JSON.parse(JSON.stringify(create))).toEqual(create);

    const update: UpdateSharedCollectionRequest = {
      serverId: 'srv-1',
      collectionId: 'col-1',
      rawCollection: create.rawCollection,
      customSkills: [],
      expectedContentHash: 'sha256:abc',
    };
    expect(JSON.parse(JSON.stringify(update))).toEqual(update);

    const payload: SharedCollectionCustomSkillPayload = {
      clientKey: 'draft-1',
      name: 'helper',
      rawSkill: '---\nname: helper\n---\nBody',
    };
    expect(JSON.parse(JSON.stringify(payload))).toEqual(payload);
  });

  it('accepts write-side drafts with inline custom skills', () => {
    const write: SharedCollectionWriteDocument = {
      version: 1,
      name: 'pack',
      description: 'desc',
      items: [
        {
          type: 'skill',
          source: { type: 'builtin', id: 'canopy' },
          skill_name: 'commit-messages',
        },
        {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'acme/marketplace' },
          plugin_name: 'browser',
        },
        {
          type: 'codex_plugin',
          marketplace: { type: 'codex-builtin', id: 'openai-curated' },
          plugin_name: 'codex-security',
        },
        {
          type: 'custom_skill',
          clientKey: 'draft-1',
          skill_name: 'helper',
          required: true,
        },
      ],
    };

    // Should be plain JSON-friendly.
    expect(JSON.parse(JSON.stringify(write))).toEqual(write);
  });
});

describe('validateSharedCollectionDocument', () => {
  it('accepts a well-formed v1 document', () => {
    const doc: SharedCollectionDocument = {
      version: 1,
      name: 'pack',
      description: 'desc',
      items: [
        {
          type: 'skill',
          source: { type: 'builtin', id: 'canopy' },
          skill_name: 'commit-messages',
        },
        {
          type: 'claude_plugin',
          marketplace: { type: 'github', repo: 'acme/marketplace' },
          plugin_name: 'browser',
        },
        {
          type: 'codex_plugin',
          marketplace: { type: 'codex-builtin', id: 'openai-curated' },
          plugin_name: 'codex-security',
        },
        {
          type: 'custom_skill',
          skillId: 'sk-1',
          skill_name: 'helper',
          contentHash: 'sha256:abc',
          required: true,
        },
      ],
    };
    expect(validateSharedCollectionDocument(doc)).toEqual(doc);
  });

  it('accepts a codex_plugin item with a Codex built-in marketplace source', () => {
    const doc: SharedCollectionDocument = {
      version: 1,
      name: 'pack',
      description: 'desc',
      items: [
        {
          type: 'codex_plugin',
          marketplace: { type: 'codex-builtin', id: 'openai-curated' },
          plugin_name: 'codex-security',
        },
      ],
    };
    expect(validateSharedCollectionDocument(doc)).toEqual(doc);
  });

  it('accepts a claude_plugin item with a built-in marketplace source', () => {
    const doc: SharedCollectionDocument = {
      version: 1,
      name: 'pack',
      description: 'desc',
      items: [
        {
          type: 'claude_plugin',
          marketplace: { type: 'builtin', id: 'app' },
          plugin_name: 'example-plugin',
        },
      ],
    };
    expect(validateSharedCollectionDocument(doc)).toEqual(doc);
  });

  it('rejects claude_plugin items with an unknown marketplace source', () => {
    expect(() =>
      validateSharedCollectionDocument({
        version: 1,
        name: 'a',
        description: '',
        items: [
          {
            type: 'claude_plugin',
            marketplace: { type: 'local', path: '/tmp' },
            plugin_name: 'x',
          },
        ],
      }),
    ).toThrow(/marketplace type/);
  });

  it('rejects claude_plugin items without a marketplace object', () => {
    expect(() =>
      validateSharedCollectionDocument({
        version: 1,
        name: 'a',
        description: '',
        items: [
          {
            type: 'claude_plugin',
            plugin_name: 'x',
          },
        ],
      }),
    ).toThrow(/marketplace/);
  });

  it('rejects codex_plugin items with a non-Codex marketplace source', () => {
    expect(() =>
      validateSharedCollectionDocument({
        version: 1,
        name: 'a',
        description: '',
        items: [
          {
            type: 'codex_plugin',
            marketplace: { type: 'github', repo: 'acme/marketplace' },
            plugin_name: 'x',
          },
        ],
      }),
    ).toThrow(/marketplace type/);
  });

  it('rejects non-object payloads', () => {
    expect(() => validateSharedCollectionDocument(null)).toThrow();
    expect(() => validateSharedCollectionDocument('hi')).toThrow();
    expect(() => validateSharedCollectionDocument([])).toThrow();
  });

  it('rejects unknown versions', () => {
    expect(() =>
      validateSharedCollectionDocument({
        version: 99,
        name: 'a',
        description: '',
        items: [],
      }),
    ).toThrow(/version/);
  });

  it('rejects malformed custom-skill refs (missing skillId)', () => {
    expect(() =>
      validateSharedCollectionDocument({
        version: 1,
        name: 'a',
        description: '',
        items: [
          {
            type: 'custom_skill',
            skill_name: 'helper',
            contentHash: 'sha256:abc',
          },
        ],
      }),
    ).toThrow(/skillId/);
  });

  it('rejects custom-skill refs without a contentHash', () => {
    expect(() =>
      validateSharedCollectionDocument({
        version: 1,
        name: 'a',
        description: '',
        items: [
          {
            type: 'custom_skill',
            skill_name: 'helper',
            skillId: 'sk-1',
          },
        ],
      }),
    ).toThrow(/contentHash/);
  });

  it('rejects skill items with unknown source types', () => {
    expect(() =>
      validateSharedCollectionDocument({
        version: 1,
        name: 'a',
        description: '',
        items: [
          {
            type: 'skill',
            source: { type: 'local', path: '/tmp' },
            skill_name: 'helper',
          },
        ],
      }),
    ).toThrow(/source type/);
  });

  it('rejects items with unknown discriminator', () => {
    expect(() =>
      validateSharedCollectionDocument({
        version: 1,
        name: 'a',
        description: '',
        items: [{ type: 'mystery' }],
      }),
    ).toThrow(/unknown type/);
  });
});

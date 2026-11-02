import {
  LEGACY_BLUEPRINT_SHARE_PATH_PREFIX,
  LEGACY_WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX,
  MAX_DEFAULT_AGENT_INSTRUCTIONS_LENGTH,
  MAX_SHARED_WORKSPACE_TEMPLATE_BYTES,
  MAX_SHARED_WORKSPACE_TEMPLATE_NAME_LENGTH,
  MAX_WORKSPACE_TEMPLATE_CUSTOM_SKILLS,
  MAX_WORKSPACE_TEMPLATE_GITHUB_REPOSITORIES,
  MAX_WORKSPACE_TEMPLATE_MCP_SERVER_REFS,
  MAX_WORKSPACE_TEMPLATE_PLUGIN_REFS,
  MAX_WORKSPACE_DESCRIPTION_LENGTH,
  WORKSPACE_TEMPLATE_SHARE_LABEL,
  WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER,
  WORKSPACE_TEMPLATE_SHARE_LABEL_PLURAL,
  WORKSPACE_TEMPLATE_SHARE_LABEL_PLURAL_LOWER,
  WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX,
  validateSharedWorkspaceTemplateDocument,
  workspaceTemplateSharePath,
} from '..';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const validDocument = {
  version: 1 as const,
  name: 'Biology 101',
  description: 'Course workspace',
  color: '#22c55e',
  instructions: 'Answer as a patient tutor.',
  plugins: [
    {
      type: 'skill' as const,
      source: { type: 'github' as const, repo: 'Example/Course-Skills' },
      skill_name: 'study-guide',
    },
  ],
  customSkills: [
    {
      clientKey: 'skill-1',
      name: 'flashcards',
      rawSkill: '---\nname: flashcards\n---\nBuild flashcards.',
    },
  ],
};

it.each(['document-v1.2026-09-22.json', 'document-v2.2026-09-22.json'])(
  'accepts pinned legacy Blueprint fixture %s',
  (filename) => {
    const fixture: unknown = JSON.parse(
      readFileSync(
        join(__dirname, '../../__fixtures__/legacy-shares/blueprint', filename),
        'utf8',
      ),
    );
    expect(validateSharedWorkspaceTemplateDocument(fixture).ok).toBe(true);
  },
);

describe('workspace template protocol', () => {
  it('builds the canonical share path and normalizes portable refs', () => {
    expect(workspaceTemplateSharePath('share-id')).toBe(
      '/portal/plugins/project-templates/share-id',
    );
    expect(validateSharedWorkspaceTemplateDocument(validDocument)).toEqual({
      ok: true,
      document: {
        ...validDocument,
        version: 2,
        starterPrompts: [],
        plugins: [
          {
            type: 'skill',
            source: { type: 'github', repo: 'example/course-skills' },
            skill_name: 'study-guide',
          },
        ],
      },
    });
  });

  it('accepts v2 starter prompts and normalizes v1 to an empty list', () => {
    const normalizedV1 = validateSharedWorkspaceTemplateDocument(validDocument);
    expect(normalizedV1.ok).toBe(true);
    if (normalizedV1.ok) {
      expect(normalizedV1.document.version).toBe(2);
      expect(normalizedV1.document.starterPrompts).toEqual([]);
    }

    const normalizedV2 = validateSharedWorkspaceTemplateDocument({
      ...validDocument,
      version: 2,
      starterPrompts: [
        { id: 'launch-plan', text: 'Draft a launch plan for this product.' },
      ],
    });
    expect(normalizedV2.ok).toBe(true);
    if (normalizedV2.ok) {
      expect(normalizedV2.document.starterPrompts).toEqual([
        { id: 'launch-plan', text: 'Draft a launch plan for this product.' },
      ]);
    }
  });

  it('preserves a valid v2 start page and omits it when absent', () => {
    const withoutStartPage = validateSharedWorkspaceTemplateDocument({
      ...validDocument,
      version: 2,
      starterPrompts: [],
    });
    expect(withoutStartPage.ok).toBe(true);
    if (withoutStartPage.ok) {
      expect(withoutStartPage.document).not.toHaveProperty('startPage');
    }

    const withStartPage = validateSharedWorkspaceTemplateDocument({
      ...validDocument,
      version: 2,
      starterPrompts: [],
      startPage: { kind: 'file', path: 'README.md' },
    });
    expect(withStartPage.ok).toBe(true);
    if (withStartPage.ok) {
      expect(withStartPage.document.startPage).toEqual({
        kind: 'file',
        path: 'README.md',
      });
    }
  });

  it('rejects a malformed v2 start page', () => {
    expect(
      validateSharedWorkspaceTemplateDocument({
        ...validDocument,
        version: 2,
        starterPrompts: [],
        startPage: { kind: 'file', path: '../secret' },
      }).ok,
    ).toBe(false);
  });

  it.each([
    { starterPrompts: [{ id: '', text: 'Valid text' }] },
    { starterPrompts: [{ id: 'valid-id', text: '' }] },
    {
      starterPrompts: [
        { id: 'duplicate', text: 'One' },
        { id: 'duplicate', text: 'Two' },
      ],
    },
  ])('rejects malformed v2 starter prompts %#', ({ starterPrompts }) => {
    expect(
      validateSharedWorkspaceTemplateDocument({
        ...validDocument,
        version: 2,
        starterPrompts,
      }).ok,
    ).toBe(false);
  });

  it('exports the canonical and legacy path prefixes', () => {
    expect(WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX).toBe(
      '/portal/plugins/project-templates',
    );
    expect(LEGACY_BLUEPRINT_SHARE_PATH_PREFIX).toBe('/share/blueprints');
    expect(LEGACY_WORKSPACE_TEMPLATE_SHARE_PATH_PREFIX).toBe(
      '/share/workspaces',
    );
  });

  it('exports the project-template labels', () => {
    expect(WORKSPACE_TEMPLATE_SHARE_LABEL).toBe('Project template');
    expect(WORKSPACE_TEMPLATE_SHARE_LABEL_PLURAL).toBe('Project templates');
    expect(WORKSPACE_TEMPLATE_SHARE_LABEL_LOWER).toBe('project template');
    expect(WORKSPACE_TEMPLATE_SHARE_LABEL_PLURAL_LOWER).toBe(
      'project templates',
    );
  });

  it('enforces the shared default-instructions limit', () => {
    expect(
      validateSharedWorkspaceTemplateDocument({
        ...validDocument,
        instructions: 'x'.repeat(MAX_DEFAULT_AGENT_INSTRUCTIONS_LENGTH + 1),
      }),
    ).toEqual({
      ok: false,
      error: `Workspace template instructions exceed ${MAX_DEFAULT_AGENT_INSTRUCTIONS_LENGTH} characters.`,
    });
  });

  it('keeps the pinned name within its database contract', () => {
    expect(
      validateSharedWorkspaceTemplateDocument({
        ...validDocument,
        name: 'x'.repeat(MAX_SHARED_WORKSPACE_TEMPLATE_NAME_LENGTH + 1),
      }),
    ).toEqual({
      ok: false,
      error: `Workspace template name exceeds ${MAX_SHARED_WORKSPACE_TEMPLATE_NAME_LENGTH} characters.`,
    });
  });

  it('keeps descriptions within the canonical cloud workspace contract', () => {
    expect(
      validateSharedWorkspaceTemplateDocument({
        ...validDocument,
        description: 'x'.repeat(MAX_WORKSPACE_DESCRIPTION_LENGTH + 1),
      }),
    ).toEqual({
      ok: false,
      error: `Workspace template description exceeds ${MAX_WORKSPACE_DESCRIPTION_LENGTH} characters.`,
    });
  });

  it('enforces the custom-skill count and serialized byte limits', () => {
    expect(
      validateSharedWorkspaceTemplateDocument({
        ...validDocument,
        customSkills: Array.from(
          { length: MAX_WORKSPACE_TEMPLATE_CUSTOM_SKILLS + 1 },
          (_, index) => ({
            clientKey: `skill-${index}`,
            name: `skill-${index}`,
            rawSkill: 'content',
          }),
        ),
      }),
    ).toEqual({
      ok: false,
      error: `Workspace templates support at most ${MAX_WORKSPACE_TEMPLATE_CUSTOM_SKILLS} custom skills.`,
    });

    const oversized = {
      ...validDocument,
      customSkills: [
        {
          clientKey: 'oversized',
          name: 'oversized',
          rawSkill: 'x'.repeat(MAX_SHARED_WORKSPACE_TEMPLATE_BYTES),
        },
      ],
    };
    expect(validateSharedWorkspaceTemplateDocument(oversized)).toEqual({
      ok: false,
      error: `Shared workspace template document exceeds ${MAX_SHARED_WORKSPACE_TEMPLATE_BYTES} bytes.`,
    });
  });

  it('accepts a v1 document at the historical serialized byte limit', () => {
    const atLimit = {
      ...validDocument,
      plugins: [],
      customSkills: [
        {
          clientKey: 'at-limit',
          name: 'at-limit',
          rawSkill: '',
        },
      ],
    };
    const emptyRawSkillBytes = new TextEncoder().encode(
      JSON.stringify(atLimit),
    ).byteLength;
    atLimit.customSkills[0].rawSkill = 'x'.repeat(
      MAX_SHARED_WORKSPACE_TEMPLATE_BYTES - emptyRawSkillBytes,
    );

    expect(new TextEncoder().encode(JSON.stringify(atLimit))).toHaveLength(
      MAX_SHARED_WORKSPACE_TEMPLATE_BYTES,
    );
    expect(validateSharedWorkspaceTemplateDocument(atLimit).ok).toBe(true);
  });

  it('bounds portable refs and distinct GitHub repositories', () => {
    expect(
      validateSharedWorkspaceTemplateDocument({
        ...validDocument,
        plugins: Array.from(
          { length: MAX_WORKSPACE_TEMPLATE_PLUGIN_REFS + 1 },
          (_, index) => ({
            type: 'skill' as const,
            source: { type: 'builtin' as const, id: 'app' },
            skill_name: `skill-${index}`,
          }),
        ),
      }),
    ).toEqual({
      ok: false,
      error: `Workspace templates support at most ${MAX_WORKSPACE_TEMPLATE_PLUGIN_REFS} plugin refs.`,
    });

    expect(
      validateSharedWorkspaceTemplateDocument({
        ...validDocument,
        plugins: Array.from(
          { length: MAX_WORKSPACE_TEMPLATE_GITHUB_REPOSITORIES + 1 },
          (_, index) => ({
            type: 'plugin' as const,
            marketplace: {
              type: 'github' as const,
              repo: `example/repository-${index}`,
            },
            plugin_name: 'plugin',
          }),
        ),
      }),
    ).toEqual({
      ok: false,
      error: `Workspace templates support refs from at most ${MAX_WORKSPACE_TEMPLATE_GITHUB_REPOSITORIES} GitHub repositories.`,
    });
  });

  it.each([
    null,
    {},
    { ...validDocument, version: 2 },
    { ...validDocument, name: '' },
    { ...validDocument, description: null },
    { ...validDocument, color: 42 },
    { ...validDocument, color: 'green' },
    { ...validDocument, color: '#0f0' },
    { ...validDocument, color: '#1234567' },
    { ...validDocument, instructions: null },
    { ...validDocument, customSkills: 'nope' },
    {
      ...validDocument,
      customSkills: [{ clientKey: '', name: 'skill', rawSkill: 'content' }],
    },
    {
      ...validDocument,
      customSkills: [
        { clientKey: 'duplicate', name: 'one', rawSkill: 'content' },
        { clientKey: 'duplicate', name: 'two', rawSkill: 'content' },
      ],
    },
  ])('rejects malformed input %#', (value) => {
    expect(validateSharedWorkspaceTemplateDocument(value).ok).toBe(false);
  });

  it('rejects MCP refs instead of treating them as portable plugins', () => {
    expect(
      validateSharedWorkspaceTemplateDocument({
        ...validDocument,
        plugins: [{ type: 'mcp', name: 'secret-bearing-server' }],
      }),
    ).toEqual({
      ok: false,
      error: 'Workspace template plugins must all be shareable plugin refs.',
    });
  });

  it('carries account MCP server refs by server key on v2 documents', () => {
    const result = validateSharedWorkspaceTemplateDocument({
      ...validDocument,
      version: 2,
      starterPrompts: [],
      mcpServerRefs: [
        { serverId: 'github', configId: 'default' },
        {
          serverId: 'custom:11111111-2222-4333-8444-555555555555',
          configId: 'default',
        },
        { serverId: 'github', configId: 'default' },
      ],
    });
    expect(result.ok && result.document.mcpServerRefs).toEqual([
      { serverId: 'github', configId: 'default' },
      {
        serverId: 'custom:11111111-2222-4333-8444-555555555555',
        configId: 'default',
      },
    ]);
    const plain = validateSharedWorkspaceTemplateDocument({
      ...validDocument,
      version: 2,
      starterPrompts: [],
      mcpServerRefs: [],
    });
    expect(plain.ok && 'mcpServerRefs' in plain.document).toBe(false);
  });

  it.each([
    ['not an array', 'github'],
    [
      'a legacy connection id',
      [{ serverId: 'account:x', configId: 'default' }],
    ],
    ['a missing config', [{ serverId: 'github' }]],
    [
      'too many refs',
      Array.from(
        { length: MAX_WORKSPACE_TEMPLATE_MCP_SERVER_REFS + 1 },
        (_, index) => ({ serverId: `server-${index}`, configId: 'default' }),
      ),
    ],
  ])('rejects MCP server refs with %s', (_label, mcpServerRefs) => {
    expect(
      validateSharedWorkspaceTemplateDocument({
        ...validDocument,
        version: 2,
        starterPrompts: [],
        mcpServerRefs,
      }).ok,
    ).toBe(false);
  });
});

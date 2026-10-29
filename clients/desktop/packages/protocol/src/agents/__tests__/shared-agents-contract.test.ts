import type { ShareablePluginRef } from '../../plugins';
import {
  CANOPY_SERVER_CAPABILITIES,
  REQUIRED_CANOPY_SERVER_CAPABILITIES,
} from '../../canopy-server';
import {
  AGENT_DEFAULT_BASE_MODEL,
  AGENT_SHARE_PATH_PREFIX,
  AGENT_SHARE_SCOPES,
  MAX_SHARED_AGENT_BYTES,
  MAX_SHARED_AGENT_ID_LENGTH,
  MAX_SHARED_AGENT_INSTRUCTIONS_BYTES,
  MAX_SHARED_AGENT_NAME_LENGTH,
  SHARED_AGENT_API_VERSION,
  agentSharePath,
  formatAgentRouteModelId,
  isSharedAgentDocument,
  isValidSharedAgentModelId,
  parseAgentRouteModelId,
  isSameModelSelection,
  serializeSharedAgentForHash,
  validateSharedAgentDocument,
  type AgentShareScope,
  type CreateSharedAgentRequest,
  type DeleteSharedAgentRequest,
  type ListSharedAgentsRequest,
  type ListSharedAgentsResponse,
  type SharedAgentDetail,
  type SharedAgentDocument,
  type SharedAgentSummary,
  type UpdateSharedAgentRequest,
} from '../index';

const pluginRef: ShareablePluginRef = {
  type: 'skill',
  source: { type: 'builtin', id: 'app' },
  skill_name: 'commit-messages',
};

function makeDocument(
  overrides: Partial<SharedAgentDocument> = {},
): SharedAgentDocument {
  return {
    version: 1,
    id: 'agent_model_code_reviewer',
    name: 'Code Reviewer',
    baseModel: 'sonnet',
    instructions: 'Review diffs carefully.',
    plugins: [pluginRef],
    ...overrides,
  };
}

describe('shared-Agent API contract', () => {
  it('builds the canonical public Agent share path', () => {
    expect(AGENT_SHARE_PATH_PREFIX).toBe('/portal/plugins/agents');
    expect(agentSharePath('agent-id')).toBe('/portal/plugins/agents/agent-id');
  });
  it('pins version, scope set, and byte ceilings', () => {
    expect(SHARED_AGENT_API_VERSION).toBe(1);
    expect(MAX_SHARED_AGENT_BYTES).toBe(256 * 1024);
    expect(MAX_SHARED_AGENT_ID_LENGTH).toBe(200);
    expect(MAX_SHARED_AGENT_INSTRUCTIONS_BYTES).toBe(64 * 1024);
    expect(MAX_SHARED_AGENT_NAME_LENGTH).toBe(200);
    expect(AGENT_SHARE_SCOPES).toEqual(['private', 'team', 'organization']);
  });

  it('AgentShareScope union spans the scope tuple', () => {
    const cases: AgentShareScope[] = ['private', 'team', 'organization'];
    for (const value of cases) {
      expect(AGENT_SHARE_SCOPES).toContain(value);
    }
  });

  it('advertises shared Agent CRUD as optional server capability', () => {
    expect(CANOPY_SERVER_CAPABILITIES).toContain('agents-crud-v1');
    expect(REQUIRED_CANOPY_SERVER_CAPABILITIES).not.toContain('agents-crud-v1');
  });

  describe('validateSharedAgentDocument', () => {
    it('accepts a well-formed structured document', () => {
      const result = validateSharedAgentDocument(makeDocument());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.document).toEqual(makeDocument());
      }
      expect(isSharedAgentDocument(makeDocument())).toBe(true);
    });

    it('rejects an unsupported version', () => {
      const result = validateSharedAgentDocument(
        makeDocument({ version: 2 as 1 }),
      );
      expect(result.ok).toBe(false);
    });

    it('requires an agent_model_ ID prefix', () => {
      const result = validateSharedAgentDocument(
        makeDocument({ id: 'code_reviewer' }),
      );
      expect(result.ok).toBe(false);
    });

    it('requires a locally manageable Agent model ID suffix', () => {
      expect(isValidSharedAgentModelId('agent_model_code_reviewer')).toBe(true);
      expect(isValidSharedAgentModelId('agent_model_code_reviewer_2')).toBe(
        true,
      );
      for (const id of [
        'agent_model_',
        'agent_model_bad-id',
        'agent_model_bad__id',
        'agent_model_bad_',
        'agent_model_Bad',
      ]) {
        expect(validateSharedAgentDocument(makeDocument({ id })).ok).toBe(
          false,
        );
        expect(isValidSharedAgentModelId(id)).toBe(false);
      }
    });

    it('requires an agent id within the database-backed length limit', () => {
      const result = validateSharedAgentDocument(
        makeDocument({ id: `agent_model_${'x'.repeat(200)}` }),
      );
      expect(result.ok).toBe(false);
    });

    it('requires a non-empty name within the length limit', () => {
      expect(validateSharedAgentDocument(makeDocument({ name: '' })).ok).toBe(
        false,
      );
      expect(
        validateSharedAgentDocument(
          makeDocument({ name: 'x'.repeat(MAX_SHARED_AGENT_NAME_LENGTH + 1) }),
        ).ok,
      ).toBe(false);
    });

    it('requires a base model that is not itself an Agent', () => {
      expect(
        validateSharedAgentDocument(makeDocument({ baseModel: '' })).ok,
      ).toBe(false);
      expect(
        validateSharedAgentDocument(
          makeDocument({ baseModel: 'agent_model_other' }),
        ).ok,
      ).toBe(false);
    });

    it('keeps an inherited default base model through validation and hashing', () => {
      const result = validateSharedAgentDocument(
        makeDocument({ baseModel: AGENT_DEFAULT_BASE_MODEL }),
      );
      expect(result).toEqual({
        ok: true,
        document: makeDocument({ baseModel: 'default' }),
      });
      const inherited = serializeSharedAgentForHash(
        makeDocument({ baseModel: AGENT_DEFAULT_BASE_MODEL }),
      );
      expect(JSON.parse(inherited)).toMatchObject({ baseModel: 'default' });
      expect(inherited).not.toBe(serializeSharedAgentForHash(makeDocument()));
    });

    it('rejects a chat route id as a base model', () => {
      expect(
        validateSharedAgentDocument(
          makeDocument({
            baseModel: formatAgentRouteModelId('agent_model_other', 'sonnet'),
          }),
        ).ok,
      ).toBe(false);
    });

    it('rejects instructions over the byte ceiling', () => {
      const result = validateSharedAgentDocument(
        makeDocument({
          instructions: 'x'.repeat(MAX_SHARED_AGENT_INSTRUCTIONS_BYTES + 1),
        }),
      );
      expect(result.ok).toBe(false);
    });

    it('rejects a document over the total serialized byte ceiling', () => {
      // Keep each field under its own limit but push the whole document over
      // MAX_SHARED_AGENT_BYTES via a large plugin list.
      const plugins: ShareablePluginRef[] = Array.from(
        { length: 20_000 },
        (_unused, index) => ({
          type: 'skill',
          source: { type: 'builtin', id: 'app' },
          skill_name: `skill-${index}`,
        }),
      );
      const result = validateSharedAgentDocument(makeDocument({ plugins }));
      expect(result.ok).toBe(false);
    });

    it('rejects plugins that are not shareable plugin refs', () => {
      const result = validateSharedAgentDocument(
        makeDocument({
          plugins: [{ nonsense: true } as unknown as ShareablePluginRef],
        }),
      );
      expect(result.ok).toBe(false);
    });
  });

  describe('Agent route model ids', () => {
    it('round-trips an inheriting Agent and its resolved base model', () => {
      const id = formatAgentRouteModelId(
        'agent_model_code_reviewer',
        'ollama:llama3.1@latest',
      );
      expect(id).toBe('agent_model_code_reviewer@ollama:llama3.1@latest');
      expect(parseAgentRouteModelId(id)).toEqual({
        agentId: 'agent_model_code_reviewer',
        baseModel: 'ollama:llama3.1@latest',
      });
    });

    it.each([
      'agent_model_code_reviewer',
      'sonnet',
      'agent_model_code_reviewer@',
      'agent_model_code_reviewer@default',
      'agent_model_code_reviewer@agent_model_other',
      'agent_model_Bad@sonnet',
      'cursor@sonnet',
    ])('does not parse %s as a route id', (model) => {
      expect(parseAgentRouteModelId(model)).toBeNull();
    });

    it('matches a chosen Agent with the route it is stored as', () => {
      const agent = 'agent_model_code_reviewer';
      expect(isSameModelSelection(`${agent}@sonnet`, agent)).toBe(true);
      expect(isSameModelSelection(agent, agent)).toBe(true);
      expect(isSameModelSelection('sonnet', 'sonnet')).toBe(true);
      expect(isSameModelSelection('sonnet', agent)).toBe(false);
      expect(isSameModelSelection(`${agent}@sonnet`, 'sonnet')).toBe(false);
      expect(isSameModelSelection(undefined, agent)).toBe(false);
    });
  });

  it('round-trips summary / detail DTO shapes through JSON', () => {
    const summary: SharedAgentSummary = {
      // Server-side shared resource UUID — distinct from the portable model ID.
      id: '11111111-2222-3333-4444-555555555555',
      name: 'Code Reviewer',
      modelId: 'agent_model_code_reviewer',
      baseModel: 'sonnet',
      instructionsPreview: 'Review diffs carefully.',
      contentHash: 'sha256:abc',
      shareScope: 'team',
      owner: { type: 'team', id: 'team-1', name: 'Platform', slug: 'platform' },
      createdAt: '2026-07-03T00:00:00Z',
      updatedAt: '2026-07-03T00:00:00Z',
      createdBy: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
      canUpdate: true,
      canDelete: false,
    };
    const detail: SharedAgentDetail = { ...summary, agent: makeDocument() };

    expect(JSON.parse(JSON.stringify(summary))).toEqual(summary);
    expect(JSON.parse(JSON.stringify(detail))).toEqual(detail);

    // The resource UUID and the portable Agent model ID are different values
    // living on different fields.
    expect(detail.id).not.toBe(detail.modelId);
    expect(detail.modelId).toBe(detail.agent.id);
  });

  it('carries an import-compatible document on the detail shape', () => {
    const detail: SharedAgentDetail = {
      id: 'resource-uuid',
      name: 'Code Reviewer',
      modelId: 'agent_model_code_reviewer',
      baseModel: 'sonnet',
      instructionsPreview: 'Review diffs carefully.',
      contentHash: 'sha256:abc',
      shareScope: 'private',
      owner: { type: 'user', id: 'user-1', name: 'Alice' },
      createdAt: '2026-07-03T00:00:00Z',
      updatedAt: '2026-07-03T00:00:00Z',
      createdBy: { id: 'user-1', name: 'Alice', email: 'alice@example.com' },
      canUpdate: true,
      canDelete: true,
      agent: makeDocument(),
    };

    // The embedded agent document must itself pass document validation, so an
    // importer can persist it verbatim.
    expect(isSharedAgentDocument(detail.agent)).toBe(true);
  });

  it('keeps list / create / update / delete requests serializable', () => {
    const list: ListSharedAgentsRequest = {
      serverId: 'srv-1',
      limit: 25,
      cursor: 'cursor-token',
      query: 'review',
      createdBy: 'me',
    };
    const create: CreateSharedAgentRequest = {
      serverId: 'srv-1',
      agent: makeDocument(),
      shareScope: 'organization',
      organizationId: 'org-1',
    };
    const update: UpdateSharedAgentRequest = {
      serverId: 'srv-1',
      agentId: 'resource-uuid',
      agent: makeDocument({ instructions: 'Updated.' }),
      expectedContentHash: 'sha256:abc',
      shareScope: 'team',
      teamId: 'team-1',
    };
    const del: DeleteSharedAgentRequest = {
      serverId: 'srv-1',
      agentId: 'resource-uuid',
    };

    expect(JSON.parse(JSON.stringify(list))).toEqual(list);
    expect(JSON.parse(JSON.stringify(create))).toEqual(create);
    expect(JSON.parse(JSON.stringify(update))).toEqual(update);
    expect(JSON.parse(JSON.stringify(del))).toEqual(del);
  });

  it('list response carries optional cursor', () => {
    const response: ListSharedAgentsResponse = { agents: [] };
    expect(JSON.parse(JSON.stringify(response))).toEqual(response);

    const withCursor: ListSharedAgentsResponse = {
      agents: [],
      nextCursor: 'opaque-token',
    };
    expect(JSON.parse(JSON.stringify(withCursor))).toEqual(withCursor);
  });
});

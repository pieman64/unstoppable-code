// The helper reads bundled action manifests through `action-resolver`. We mock
// that module so the test is deterministic and independent of whether the
// brand-prepared resources are present in the test environment. Branding
// placeholder resolution is handled by the brand-prepare/action build step
// (verified against the prepared resources), not by this helper.
jest.mock('../pipelines/action-resolver', () => ({
  listBuiltinActions: jest.fn(() => ['agent-prompt', 'router']),
  resolveAction: jest.fn((usesRef: string) => {
    if (usesRef === 'builtin/agent-prompt') {
      return { name: 'Agent Prompt', description: 'Run a single prompt.' };
    }
    if (usesRef === 'builtin/router') {
      return { name: 'Router', description: 'Classify text into a route.' };
    }
    return null;
  }),
  readBuiltinActionRawManifest: jest.fn((name: string) => {
    if (name === 'agent-prompt') {
      return 'name: Agent Prompt\ndescription: Run a single prompt.\n';
    }
    if (name === 'router') {
      return 'name: Router\n';
    }
    return null;
  }),
}));

import {
  getBuiltinActionDefinition,
  listBuiltinActionSummaries,
  normalizeBuiltinActionName,
} from '../pipeline-editor/builtin-actions';
import { getPipelineEditorSystemPrompt } from '../pipeline-editor/system-prompt';

describe('pipeline editor system prompt', () => {
  it('reserves deferred-tool discovery for unavailable capabilities', () => {
    const prompt = getPipelineEditorSystemPrompt();
    expect(prompt).toContain(
      "absent from the agent's current Skills list and callable tool surface",
    );
    expect(prompt).toContain(
      'never search for or load a skill, plugin, MCP server, or command that is already available',
    );
  });
});

describe('normalizeBuiltinActionName', () => {
  it('strips the builtin/ prefix and surrounding whitespace', () => {
    expect(normalizeBuiltinActionName('  builtin/agent-prompt ')).toBe(
      'agent-prompt',
    );
    expect(normalizeBuiltinActionName('agent-prompt')).toBe('agent-prompt');
    expect(normalizeBuiltinActionName('Builtin/Agent-Prompt')).toBe(
      'Agent-Prompt',
    );
  });
});

describe('listBuiltinActionSummaries', () => {
  it('enumerates bundled actions with their descriptions', () => {
    const summaries = listBuiltinActionSummaries();
    expect(summaries).toEqual([
      { name: 'agent-prompt', description: 'Run a single prompt.' },
      { name: 'router', description: 'Classify text into a route.' },
    ]);
  });
});

describe('getBuiltinActionDefinition', () => {
  it('returns the raw action.yml for a known action (prefixed or bare)', () => {
    const bare = getBuiltinActionDefinition('agent-prompt');
    expect(bare.found).toBe(true);
    expect(bare.uses).toBe('builtin/agent-prompt');
    expect(bare.description).toBe('Run a single prompt.');
    expect(bare.yaml).toContain('name: Agent Prompt');

    const prefixed = getBuiltinActionDefinition('builtin/agent-prompt');
    expect(prefixed.found).toBe(true);
    expect(prefixed.yaml).toBe(bare.yaml);
  });

  it('returns a not-found result with available actions for an unknown name', () => {
    const result = getBuiltinActionDefinition('does-not-exist');
    expect(result.found).toBe(false);
    expect(result.error).toContain('does-not-exist');
    expect(result.availableActions).toEqual(['agent-prompt', 'router']);
  });

  it('rejects an empty name', () => {
    expect(getBuiltinActionDefinition('   ').found).toBe(false);
    expect(getBuiltinActionDefinition('builtin/').found).toBe(false);
  });

  it('rejects a path-traversal name (not in the bundled set)', () => {
    const result = getBuiltinActionDefinition('../../etc/passwd');
    expect(result.found).toBe(false);
  });
});

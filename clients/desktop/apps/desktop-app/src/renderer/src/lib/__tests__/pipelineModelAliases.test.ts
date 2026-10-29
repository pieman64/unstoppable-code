import type {
  PipelineModelAlias,
  PipelineModelAliasPreference,
} from '@canopy/desktop-shared/types/pipeline';
import {
  aliasDefaultsToPreference,
  areAliasPreferencesBlocked,
  resolveEffectiveAliasPreference,
  validateEffectiveAliasPreference,
} from '../pipelineModelAliases';

const inlineAlias: PipelineModelAlias = {
  id: 'reviewer',
  name: 'Reviewer',
  defaults: { base: 'claude-sonnet-4-6', instructions: 'Be terse' },
};

const agentAlias: PipelineModelAlias = {
  id: 'planner',
  name: 'Planner',
  defaults: { agent_id: 'agent_model_planner' },
};

const requiredAlias: PipelineModelAlias = {
  id: 'writer',
  name: 'Writer',
};

const emptyCtx = {
  pluginCollectionIds: new Set<string>(),
  availableAgentIds: new Set<string>(),
};

describe('aliasDefaultsToPreference', () => {
  it('converts inline defaults to an inline preference', () => {
    expect(aliasDefaultsToPreference(inlineAlias.defaults)).toEqual({
      mode: 'inline',
      base: 'claude-sonnet-4-6',
      instructions: 'Be terse',
    });
  });

  it('converts Agent defaults to an agent preference', () => {
    expect(aliasDefaultsToPreference(agentAlias.defaults)).toEqual({
      mode: 'agent',
      agent_id: 'agent_model_planner',
    });
  });

  it('returns undefined when there are no defaults', () => {
    expect(aliasDefaultsToPreference(undefined)).toBeUndefined();
  });
});

describe('resolveEffectiveAliasPreference', () => {
  it('uses a draft inline override and marks it customized', () => {
    const draft: PipelineModelAliasPreference = {
      mode: 'inline',
      base: 'claude-opus-4-6',
    };
    const state = resolveEffectiveAliasPreference(
      inlineAlias,
      undefined,
      draft,
    );
    expect(state).toMatchObject({
      preference: draft,
      source: 'draft',
      required: false,
      customized: true,
    });
  });

  it('falls back to the pipeline default when the draft is absent', () => {
    const state = resolveEffectiveAliasPreference(
      inlineAlias,
      undefined,
      undefined,
    );
    expect(state.source).toBe('default');
    expect(state.customized).toBe(false);
    expect(state.preference).toEqual({
      mode: 'inline',
      base: 'claude-sonnet-4-6',
      instructions: 'Be terse',
    });
  });

  it('reports required when there is no default and no preference', () => {
    const state = resolveEffectiveAliasPreference(
      requiredAlias,
      undefined,
      undefined,
    );
    expect(state.required).toBe(true);
    expect(state.preference).toBeNull();
  });

  it('reset marker overrides a stored preference and resolves to defaults', () => {
    // Regression guard: a stored inline pref must NOT reapply once reset.
    const stored: PipelineModelAliasPreference = {
      mode: 'inline',
      base: 'stored-model',
    };
    const state = resolveEffectiveAliasPreference(inlineAlias, stored, {
      mode: 'reset',
    });
    expect(state.source).toBe('default');
    expect(state.customized).toBe(false);
    expect(state.preference).toEqual({
      mode: 'inline',
      base: 'claude-sonnet-4-6',
      instructions: 'Be terse',
    });
  });

  it('reset marker with no defaults resolves to required', () => {
    const state = resolveEffectiveAliasPreference(requiredAlias, undefined, {
      mode: 'reset',
    });
    expect(state.required).toBe(true);
    expect(state.preference).toBeNull();
  });

  it('uses a stored preference when the draft is absent', () => {
    const stored: PipelineModelAliasPreference = {
      mode: 'agent',
      agent_id: 'agent_model_stored',
    };
    const state = resolveEffectiveAliasPreference(
      requiredAlias,
      stored,
      undefined,
    );
    expect(state.source).toBe('stored');
    expect(state.customized).toBe(true);
    expect(state.preference).toEqual(stored);
  });
});

describe('validateEffectiveAliasPreference', () => {
  it('flags a required unconfigured alias', () => {
    const state = resolveEffectiveAliasPreference(
      requiredAlias,
      undefined,
      undefined,
    );
    expect(validateEffectiveAliasPreference(state, emptyCtx)).toBe(
      'Choose a model or Agent for this alias.',
    );
  });

  it('flags an empty inline base', () => {
    const state = resolveEffectiveAliasPreference(requiredAlias, undefined, {
      mode: 'inline',
      base: '',
    });
    expect(validateEffectiveAliasPreference(state, emptyCtx)).toBe(
      'Base model is required.',
    );
  });

  it('flags an unknown plugin collection reference', () => {
    const state = resolveEffectiveAliasPreference(requiredAlias, undefined, {
      mode: 'inline',
      base: 'claude-sonnet-4-6',
      plugin_collection_id: 'missing',
    });
    expect(validateEffectiveAliasPreference(state, emptyCtx)).toBe(
      'Choose an existing plugin collection.',
    );
  });

  it('flags an Agent that is not available locally', () => {
    const state = resolveEffectiveAliasPreference(requiredAlias, undefined, {
      mode: 'agent',
      agent_id: 'agent_model_missing',
    });
    expect(validateEffectiveAliasPreference(state, emptyCtx)).toBe(
      'Agent is not available locally.',
    );
  });

  it('passes a valid inline preference', () => {
    const ctx = {
      pluginCollectionIds: new Set(['reviewers']),
      availableAgentIds: new Set<string>(),
    };
    const state = resolveEffectiveAliasPreference(requiredAlias, undefined, {
      mode: 'inline',
      base: 'claude-sonnet-4-6',
      plugin_collection_id: 'reviewers',
    });
    expect(validateEffectiveAliasPreference(state, ctx)).toBeUndefined();
  });
});

describe('areAliasPreferencesBlocked', () => {
  it('blocks when a required alias is unconfigured', () => {
    expect(areAliasPreferencesBlocked([requiredAlias], {}, emptyCtx)).toBe(
      true,
    );
  });

  it('does not block when an alias carries valid defaults', () => {
    expect(areAliasPreferencesBlocked([inlineAlias], {}, emptyCtx)).toBe(false);
  });

  it('blocks when a draft Agent preference is unavailable locally', () => {
    expect(
      areAliasPreferencesBlocked(
        [requiredAlias],
        { writer: { mode: 'agent', agent_id: 'agent_model_x' } },
        emptyCtx,
      ),
    ).toBe(true);
  });

  it('does not block once a required alias is configured with an available Agent', () => {
    expect(
      areAliasPreferencesBlocked(
        [requiredAlias],
        { writer: { mode: 'agent', agent_id: 'agent_model_x' } },
        {
          pluginCollectionIds: new Set<string>(),
          availableAgentIds: new Set(['agent_model_x']),
        },
      ),
    ).toBe(false);
  });
});

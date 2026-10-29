import type {
  GlobalInstructionsSection,
  ScopedGlobalInstruction,
} from '../../types/global-instructions';
import {
  appendUserOverallPreferencesBlock,
  buildPipelineGlobalInstructionsBlock,
  buildUserOverallPreferencesBlock,
  computeGlobalInstructionOverlapWarnings,
  normalizeGlobalInstructionsConfig,
  resolveGlobalInstructions,
  scopedGlobalInstructionApplies,
  USER_OVERALL_PREFERENCES_HEADER,
} from '../global-instructions';

function scoped(
  overrides: Partial<ScopedGlobalInstruction>,
): ScopedGlobalInstruction {
  return {
    id: overrides.id ?? 'item',
    text: overrides.text ?? 'scoped text',
    mode: overrides.mode ?? 'append',
    harnesses: overrides.harnesses ?? [],
    models: overrides.models ?? [],
    workspaceTypes: overrides.workspaceTypes ?? [],
  };
}

function section(
  overall: string,
  scopedItems: ScopedGlobalInstruction[] = [],
): GlobalInstructionsSection {
  return { overall, scoped: scopedItems };
}

const CLAUDE_CODE_CONTEXT = {
  harness: 'claude',
  model: 'claude-opus-5',
  workspaceType: 'code',
} as const;

describe('scopedGlobalInstructionApplies', () => {
  it('applies everywhere when no narrowing options are selected', () => {
    expect(
      scopedGlobalInstructionApplies(scoped({}), CLAUDE_CODE_CONTEXT),
    ).toBe(true);
  });

  it('matches when the session harness is selected', () => {
    const item = scoped({ harnesses: ['claude'] });
    expect(scopedGlobalInstructionApplies(item, CLAUDE_CODE_CONTEXT)).toBe(
      true,
    );
    expect(
      scopedGlobalInstructionApplies(item, {
        harness: 'codex',
        model: 'gpt-5-codex',
        workspaceType: 'code',
      }),
    ).toBe(false);
  });

  it('matches when the session model is selected (mix-and-match union)', () => {
    const item = scoped({ harnesses: ['codex'], models: ['claude-opus-5'] });
    // Not a codex session, but the model matches.
    expect(scopedGlobalInstructionApplies(item, CLAUDE_CODE_CONTEXT)).toBe(
      true,
    );
  });

  it('matches when the chat project type is selected', () => {
    const item = scoped({ workspaceTypes: ['cowork'] });
    expect(
      scopedGlobalInstructionApplies(item, {
        harness: 'claude',
        model: 'claude-opus-5',
        workspaceType: 'cowork',
      }),
    ).toBe(true);
    expect(scopedGlobalInstructionApplies(item, CLAUDE_CODE_CONTEXT)).toBe(
      false,
    );
  });

  it('never matches workspace-type-only items in contexts without a project type', () => {
    const item = scoped({ workspaceTypes: ['code'] });
    expect(
      scopedGlobalInstructionApplies(item, {
        harness: 'claude',
        model: 'claude-opus-5',
      }),
    ).toBe(false);
  });
});

describe('resolveGlobalInstructions', () => {
  it('returns the trimmed overall text when no scoped items apply', () => {
    const result = resolveGlobalInstructions(
      section('  overall text  ', [scoped({ harnesses: ['codex'] })]),
      CLAUDE_CODE_CONTEXT,
    );
    expect(result).toBe('overall text');
  });

  it('appends applicable items after the overall text in list order', () => {
    const result = resolveGlobalInstructions(
      section('overall', [
        scoped({ id: 'a', text: 'first', harnesses: ['claude'] }),
        scoped({ id: 'b', text: 'skipped', harnesses: ['codex'] }),
        scoped({ id: 'c', text: 'second', models: ['claude-opus-5'] }),
      ]),
      CLAUDE_CODE_CONTEXT,
    );
    expect(result).toBe('overall\n\nfirst\n\nsecond');
  });

  it('lets the first applicable replace fully overwrite the construction', () => {
    const result = resolveGlobalInstructions(
      section('overall', [
        scoped({ id: 'a', text: 'earlier append', harnesses: ['claude'] }),
        scoped({
          id: 'b',
          text: 'replacement',
          mode: 'replace',
          harnesses: ['claude'],
        }),
        scoped({ id: 'c', text: 'never reached', harnesses: ['claude'] }),
        scoped({
          id: 'd',
          text: 'later replace never used',
          mode: 'replace',
          harnesses: ['claude'],
        }),
      ]),
      CLAUDE_CODE_CONTEXT,
    );
    expect(result).toBe('replacement');
  });

  it('ignores replace items that do not apply to the session', () => {
    const result = resolveGlobalInstructions(
      section('overall', [
        scoped({
          id: 'a',
          text: 'codex only',
          mode: 'replace',
          harnesses: ['codex'],
        }),
      ]),
      CLAUDE_CODE_CONTEXT,
    );
    expect(result).toBe('overall');
  });

  it('skips empty-text items entirely, including empty replaces', () => {
    const result = resolveGlobalInstructions(
      section('overall', [
        scoped({
          id: 'a',
          text: '   ',
          mode: 'replace',
          harnesses: ['claude'],
        }),
        scoped({ id: 'b', text: 'kept', harnesses: ['claude'] }),
      ]),
      CLAUDE_CODE_CONTEXT,
    );
    expect(result).toBe('overall\n\nkept');
  });

  it('returns an empty string when nothing is configured', () => {
    expect(resolveGlobalInstructions(section(''), CLAUDE_CODE_CONTEXT)).toBe(
      '',
    );
  });
});

describe('buildUserOverallPreferencesBlock', () => {
  it('wraps resolved text under the User Overall Preferences header', () => {
    const block = buildUserOverallPreferencesBlock(
      section('be terse'),
      CLAUDE_CODE_CONTEXT,
    );
    expect(block).toBe(`${USER_OVERALL_PREFERENCES_HEADER}\n\nbe terse`);
  });

  it('returns an empty string when nothing resolves', () => {
    expect(
      buildUserOverallPreferencesBlock(section(''), CLAUDE_CODE_CONTEXT),
    ).toBe('');
  });
});

describe('appendUserOverallPreferencesBlock', () => {
  it('returns the base unchanged when the block is empty', () => {
    expect(appendUserOverallPreferencesBlock('base', '')).toBe('base');
    expect(appendUserOverallPreferencesBlock(undefined, '')).toBeUndefined();
  });

  it('appends the block after a non-empty base', () => {
    expect(appendUserOverallPreferencesBlock('base', 'block')).toBe(
      'base\n\nblock',
    );
    expect(appendUserOverallPreferencesBlock(undefined, 'block')).toBe('block');
    expect(appendUserOverallPreferencesBlock('   ', 'block')).toBe('block');
  });
});

describe('buildPipelineGlobalInstructionsBlock', () => {
  const pipelineSectionJson = JSON.stringify({
    overall: 'pipeline overall',
    scoped: [
      {
        id: 'codex-only',
        text: 'codex agents only',
        mode: 'append',
        harnesses: ['codex'],
        models: [],
        workspaceTypes: [],
      },
    ],
  });

  it('resolves the block from serialized section JSON per agent context', () => {
    expect(
      buildPipelineGlobalInstructionsBlock(pipelineSectionJson, {
        harness: 'codex',
        model: 'gpt-5-codex',
      }),
    ).toBe(
      `${USER_OVERALL_PREFERENCES_HEADER}\n\npipeline overall\n\ncodex agents only`,
    );
    expect(
      buildPipelineGlobalInstructionsBlock(pipelineSectionJson, {
        harness: 'claude',
        model: 'claude-opus-5',
      }),
    ).toBe(`${USER_OVERALL_PREFERENCES_HEADER}\n\npipeline overall`);
  });

  it('resolves empty for missing or malformed payloads', () => {
    expect(
      buildPipelineGlobalInstructionsBlock(undefined, {
        harness: 'claude',
        model: 'claude-opus-5',
      }),
    ).toBe('');
    expect(
      buildPipelineGlobalInstructionsBlock('{not json', {
        harness: 'claude',
        model: 'claude-opus-5',
      }),
    ).toBe('');
  });

  it('ignores chat workspace-type narrowing in the pipelines section', () => {
    const json = JSON.stringify({
      overall: '',
      scoped: [
        {
          id: 'stray-workspace-scope',
          text: 'should apply everywhere after project types are stripped',
          mode: 'append',
          harnesses: [],
          models: [],
          workspaceTypes: ['cowork'],
        },
      ],
    });
    expect(
      buildPipelineGlobalInstructionsBlock(json, {
        harness: 'claude',
        model: 'claude-opus-5',
      }),
    ).toBe(
      `${USER_OVERALL_PREFERENCES_HEADER}\n\nshould apply everywhere after project types are stripped`,
    );
  });
});

describe('computeGlobalInstructionOverlapWarnings', () => {
  const modelsByHarness = {
    claude: ['claude-opus-5', 'claude-sonnet-5'],
    codex: ['gpt-5-codex'],
    ollama: [],
  };

  it('returns no warnings when scopes are disjoint appends', () => {
    const warnings = computeGlobalInstructionOverlapWarnings(
      section('overall', [
        scoped({ id: 'a', harnesses: ['claude'] }),
        scoped({ id: 'b', harnesses: ['codex'] }),
      ]),
      modelsByHarness,
    );
    expect(warnings).toEqual([]);
  });

  it('returns no warnings for overlapping appends (append order is fine)', () => {
    const warnings = computeGlobalInstructionOverlapWarnings(
      section('overall', [
        scoped({ id: 'a', harnesses: ['claude'] }),
        scoped({ id: 'b', models: ['claude-opus-5'] }),
      ]),
      modelsByHarness,
    );
    expect(warnings).toEqual([]);
  });

  it('warns when an earlier replace suppresses a later replace, expanding harness to models', () => {
    const warnings = computeGlobalInstructionOverlapWarnings(
      section('overall', [
        scoped({ id: 'a', mode: 'replace', harnesses: ['claude'] }),
        scoped({ id: 'b', mode: 'replace', models: ['claude-opus-5'] }),
      ]),
      modelsByHarness,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      itemId: 'b',
      winnerId: 'a',
      itemIndex: 1,
      winnerIndex: 0,
    });
    expect(warnings[0].message).toContain('Replace #1');
    expect(warnings[0].message).toContain('claude-opus-5');
  });

  it('warns when a replace overrides an overlapping append regardless of order', () => {
    const warnings = computeGlobalInstructionOverlapWarnings(
      section('overall', [
        scoped({ id: 'a', harnesses: ['claude'] }),
        scoped({ id: 'b', mode: 'replace', models: ['claude-sonnet-5'] }),
      ]),
      modelsByHarness,
    );
    expect(warnings).toHaveLength(1);
    // The append (item a) loses wherever both apply.
    expect(warnings[0]).toMatchObject({ itemId: 'a', winnerId: 'b' });
  });

  it('attributes an overridden append only to the earliest effective replace', () => {
    const warnings = computeGlobalInstructionOverlapWarnings(
      section('overall', [
        scoped({ id: 'append', harnesses: ['claude'] }),
        scoped({ id: 'first-replace', mode: 'replace', harnesses: ['claude'] }),
        scoped({ id: 'later-replace', mode: 'replace', harnesses: ['claude'] }),
      ]),
      modelsByHarness,
    );

    expect(warnings).toEqual([
      expect.objectContaining({
        itemId: 'append',
        winnerId: 'first-replace',
      }),
      expect.objectContaining({
        itemId: 'later-replace',
        winnerId: 'first-replace',
      }),
    ]);
  });

  it('ignores blank replaces while preserving the effective winner priority', () => {
    const warnings = computeGlobalInstructionOverlapWarnings(
      section('overall', [
        scoped({ id: 'append', harnesses: ['claude'] }),
        scoped({
          id: 'blank-replace',
          text: '   ',
          mode: 'replace',
          harnesses: ['claude'],
        }),
        scoped({
          id: 'effective-replace',
          mode: 'replace',
          harnesses: ['claude'],
        }),
      ]),
      modelsByHarness,
    );

    expect(warnings).toEqual([
      expect.objectContaining({
        itemId: 'append',
        winnerId: 'effective-replace',
        winnerIndex: 2,
      }),
    ]);
    expect(warnings[0].message).toContain('Replace #3');
  });

  it('treats an unscoped replace as overlapping everything', () => {
    const warnings = computeGlobalInstructionOverlapWarnings(
      section('overall', [
        scoped({ id: 'a', mode: 'replace' }),
        scoped({ id: 'b', harnesses: ['codex'] }),
      ]),
      modelsByHarness,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ itemId: 'b', winnerId: 'a' });
  });

  it('detects cross-dimension overlap between workspace-type and model scopes', () => {
    const warnings = computeGlobalInstructionOverlapWarnings(
      section('overall', [
        scoped({ id: 'a', mode: 'replace', workspaceTypes: ['cowork'] }),
        scoped({ id: 'b', models: ['gpt-5-codex'] }),
      ]),
      modelsByHarness,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ itemId: 'b', winnerId: 'a' });
  });

  it('does not warn between two disjoint replaces', () => {
    const warnings = computeGlobalInstructionOverlapWarnings(
      section('overall', [
        scoped({ id: 'a', mode: 'replace', workspaceTypes: ['cowork'] }),
        scoped({ id: 'b', mode: 'replace', workspaceTypes: ['code'] }),
      ]),
      modelsByHarness,
    );
    expect(warnings).toEqual([]);
  });
});

describe('normalizeGlobalInstructionsConfig', () => {
  it('returns an empty config for invalid input', () => {
    expect(normalizeGlobalInstructionsConfig(undefined)).toEqual({
      chats: { overall: '', scoped: [] },
      pipelines: { overall: '', scoped: [] },
    });
    expect(normalizeGlobalInstructionsConfig('nope')).toEqual({
      chats: { overall: '', scoped: [] },
      pipelines: { overall: '', scoped: [] },
    });
  });

  it('drops malformed scoped entries and clamps enums', () => {
    const config = normalizeGlobalInstructionsConfig({
      chats: {
        overall: 42,
        scoped: [
          {
            id: 'ok',
            text: 'keep',
            mode: 'bogus',
            harnesses: ['claude', 'nope'],
            models: ['m1', 7],
            workspaceTypes: ['cowork', 'bad'],
          },
          { text: 'missing id' },
          'garbage',
        ],
      },
      pipelines: {
        overall: 'pipeline overall',
        scoped: [
          {
            id: 'p1',
            text: 'pipeline scoped',
            mode: 'replace',
            harnesses: [],
            models: [],
            // workspace types are chat-only; stripped for pipelines
            workspaceTypes: ['cowork'],
          },
        ],
      },
    });

    expect(config.chats.overall).toBe('');
    expect(config.chats.scoped).toHaveLength(1);
    expect(config.chats.scoped[0]).toEqual({
      id: 'ok',
      text: 'keep',
      mode: 'append',
      harnesses: ['claude'],
      models: ['m1'],
      workspaceTypes: ['cowork'],
    });
    expect(config.pipelines.overall).toBe('pipeline overall');
    expect(config.pipelines.scoped[0]).toEqual({
      id: 'p1',
      text: 'pipeline scoped',
      mode: 'replace',
      harnesses: [],
      models: [],
      workspaceTypes: [],
    });
  });
});

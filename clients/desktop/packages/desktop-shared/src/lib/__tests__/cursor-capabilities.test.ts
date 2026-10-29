import {
  assignCursorInvocationIds,
  cursorInvocationKey,
  expandLeadingCursorCommand,
  inheritedCursorEntryLabel,
  inheritedCursorRootLabel,
  renderCursorCommandMarkdown,
  sanitizeCursorInvocationSegment,
  sortCursorPluginMembers,
  type CursorInvocationSource,
} from '../cursor-capabilities';

describe('sanitizeCursorInvocationSegment', () => {
  it('lowercases and restricts to the characters the CLI matches in a /name token', () => {
    expect(sanitizeCursorInvocationSegment('My Skill:Beta')).toBe(
      'my-skill-beta',
    );
    expect(sanitizeCursorInvocationSegment('snake_case_ok')).toBe(
      'snake_case_ok',
    );
    expect(sanitizeCursorInvocationSegment('--trim--')).toBe('trim');
    expect(sanitizeCursorInvocationSegment('///')).toBe('');
    // The id pattern needs a leading alphanumeric; a leading underscore
    // would otherwise produce an id that can never load.
    expect(sanitizeCursorInvocationSegment('_internal')).toBe('internal');
    expect(sanitizeCursorInvocationSegment('__x__')).toBe('x');
  });
});

describe('sortCursorPluginMembers', () => {
  it('orders skills before commands and names by code point, independent of discovery order', () => {
    const members = [
      { kind: 'plugin_command' as const, name: 'alpha' },
      { kind: 'plugin_skill' as const, name: 'zeta' },
      { kind: 'plugin_skill' as const, name: 'Beta' },
      { kind: 'plugin_skill' as const, name: 'beta' },
      { kind: 'plugin_command' as const, name: 'Alpha' },
    ];
    expect(
      sortCursorPluginMembers(members).map((m) => `${m.kind}:${m.name}`),
    ).toEqual([
      'plugin_skill:Beta',
      'plugin_skill:beta',
      'plugin_skill:zeta',
      'plugin_command:Alpha',
      'plugin_command:alpha',
    ]);
    // Input untouched.
    expect(members[0]).toEqual({ kind: 'plugin_command', name: 'alpha' });
  });
});

describe('assignCursorInvocationIds', () => {
  const standalone = (skillName: string): CursorInvocationSource => ({
    kind: 'skill',
    sourceId: 'custom:local',
    skillName,
  });

  it('uses the skill name for standalone skills and plugin-member for plugin skills and commands', () => {
    const ids = assignCursorInvocationIds([
      standalone('review'),
      {
        kind: 'plugin_skill',
        marketplaceId: 'market',
        pluginName: 'Ship It',
        memberName: 'deploy',
      },
      {
        kind: 'plugin_command',
        marketplaceId: 'market',
        pluginName: 'ship-it',
        memberName: 'release notes',
      },
    ]);
    expect(ids.get(cursorInvocationKey(standalone('review')))).toBe('review');
    expect(
      ids.get(
        cursorInvocationKey({
          kind: 'plugin_skill',
          marketplaceId: 'market',
          pluginName: 'Ship It',
          memberName: 'deploy',
        }),
      ),
    ).toBe('ship-it-deploy');
    expect(
      ids.get(
        cursorInvocationKey({
          kind: 'plugin_command',
          marketplaceId: 'market',
          pluginName: 'ship-it',
          memberName: 'release notes',
        }),
      ),
    ).toBe('ship-it-release-notes');
  });

  it('suffixes later collisions in input order, across kinds', () => {
    const second: CursorInvocationSource = {
      kind: 'skill',
      sourceId: 'github:acme:skills',
      skillName: 'review',
    };
    const command: CursorInvocationSource = {
      kind: 'plugin_command',
      marketplaceId: 'market',
      pluginName: 'code',
      memberName: 'review',
    };
    const ids = assignCursorInvocationIds([
      standalone('review'),
      second,
      {
        kind: 'plugin_command',
        marketplaceId: 'm',
        pluginName: 'a',
        memberName: 'b',
      },
      command,
      { kind: 'skill', sourceId: 'x', skillName: 'code-review' },
    ]);
    expect(ids.get(cursorInvocationKey(standalone('review')))).toBe('review');
    expect(ids.get(cursorInvocationKey(second))).toBe('review-1');
    // `code` + `review` sanitizes to the same id as the standalone skill
    // `code-review`, and the plugin command came first.
    expect(ids.get(cursorInvocationKey(command))).toBe('code-review');
    expect(
      ids.get(
        cursorInvocationKey({
          kind: 'skill',
          sourceId: 'x',
          skillName: 'code-review',
        }),
      ),
    ).toBe('code-review-1');
  });

  it('falls back to a kind-named id when nothing survives sanitizing', () => {
    const ids = assignCursorInvocationIds([
      standalone('///'),
      {
        kind: 'plugin_command',
        marketplaceId: 'm',
        pluginName: '::',
        memberName: '',
      },
    ]);
    expect(ids.get(cursorInvocationKey(standalone('///')))).toBe('skill');
    expect(
      ids.get(
        cursorInvocationKey({
          kind: 'plugin_command',
          marketplaceId: 'm',
          pluginName: '::',
          memberName: '',
        }),
      ),
    ).toBe('command');
  });

  it('keys the same name from different sources apart', () => {
    expect(cursorInvocationKey(standalone('review'))).not.toBe(
      cursorInvocationKey({
        kind: 'skill',
        sourceId: 'other',
        skillName: 'review',
      }),
    );
  });

  it('keeps a selection on its base id and suffixes the inherited entries that collide with it', () => {
    const claudeReview: CursorInvocationSource = {
      kind: 'inherited_skill',
      origin: 'claude',
      name: 'review',
    };
    const cursorReview: CursorInvocationSource = {
      kind: 'inherited_skill',
      origin: 'cursor',
      name: 'review',
    };
    const shipIt: CursorInvocationSource = {
      kind: 'inherited_command',
      origin: 'claude',
      name: 'Ship It',
    };
    const ids = assignCursorInvocationIds([
      standalone('review'),
      claudeReview,
      cursorReview,
      shipIt,
    ]);
    expect(ids.get(cursorInvocationKey(standalone('review')))).toBe('review');
    expect(ids.get(cursorInvocationKey(claudeReview))).toBe('review-1');
    expect(ids.get(cursorInvocationKey(cursorReview))).toBe('review-2');
    expect(ids.get(cursorInvocationKey(shipIt))).toBe('ship-it');
    // Same name, different root: two distinct sources.
    expect(cursorInvocationKey(claudeReview)).not.toBe(
      cursorInvocationKey(cursorReview),
    );
  });
});

describe('inherited Cursor plugin members', () => {
  it('keys a member by its plugin, so two plugins can ship the same skill name', () => {
    const fromSuperpowers: CursorInvocationSource = {
      kind: 'inherited_skill',
      origin: 'cursor-plugin',
      plugin: 'cursor-public/superpowers',
      name: 'brainstorming',
    };
    const fromOther: CursorInvocationSource = {
      kind: 'inherited_skill',
      origin: 'cursor-plugin',
      plugin: 'cursor-public/other',
      name: 'brainstorming',
    };
    expect(cursorInvocationKey(fromSuperpowers)).not.toBe(
      cursorInvocationKey(fromOther),
    );
    const ids = assignCursorInvocationIds([fromSuperpowers, fromOther]);
    // Cursor ids a plugin skill by its skill name, not by its plugin.
    expect(ids.get(cursorInvocationKey(fromSuperpowers))).toBe('brainstorming');
    expect(ids.get(cursorInvocationKey(fromOther))).toBe('brainstorming-1');
  });

  it('labels a member by the cached plugin it came from', () => {
    expect(
      inheritedCursorRootLabel({
        kind: 'inherited_skill',
        origin: 'cursor-plugin',
        plugin: 'cursor-public/superpowers',
      }),
    ).toBe('~/.cursor/plugins/cursor-public/superpowers');
    expect(
      inheritedCursorEntryLabel({
        kind: 'inherited_command',
        origin: 'cursor-plugin',
        plugin: 'cursor-public/parallel',
        name: 'ship',
      }),
    ).toBe('~/.cursor/plugins/cursor-public/parallel/ship');
  });
});

describe('inherited entry labels', () => {
  it('name the home folder the entry came from, as the user knows it', () => {
    expect(
      inheritedCursorRootLabel({ kind: 'inherited_skill', origin: 'codex' }),
    ).toBe('~/.codex/skills');
    expect(
      inheritedCursorEntryLabel({
        kind: 'inherited_skill',
        origin: 'claude',
        name: 'review',
      }),
    ).toBe('~/.claude/skills/review');
    expect(
      inheritedCursorEntryLabel({
        kind: 'inherited_command',
        origin: 'cursor',
        name: 'ship',
      }),
    ).toBe('~/.cursor/commands/ship');
  });
});

describe('renderCursorCommandMarkdown', () => {
  it('leads with the description as a heading, which is the only metadata the CLI reads', () => {
    expect(
      renderCursorCommandMarkdown({
        id: 'ship',
        description: 'Ship the current branch',
        body: 'Open a PR for $ARGUMENTS.\n',
      }),
    ).toBe('# Ship the current branch\n\nOpen a PR for $ARGUMENTS.\n');
  });

  it('falls back to the id when there is no description and normalizes the body', () => {
    expect(
      renderCursorCommandMarkdown({
        id: 'ship',
        description: '  ',
        body: '\r\n\r\nDo it.\r\n\r\n',
      }),
    ).toBe('# ship\n\nDo it.\n');
  });

  it('keeps the heading on one line even for a multi-line description', () => {
    expect(
      renderCursorCommandMarkdown({
        id: 'ship',
        description: 'First line\nsecond line',
        body: 'x',
      }),
    ).toBe('# First line second line\n\nx\n');
  });
});

describe('expandLeadingCursorCommand', () => {
  const commands = [
    { id: 'ship', markdown: '# Ship\n\nRelease $ARGUMENTS now.\n' },
    { id: 'pair', markdown: '# Pair\n\nFirst $1, second $2, third $3.\n' },
    { id: 'plain', markdown: '# Plain\n\nJust do it.\n' },
  ];

  it('substitutes $ARGUMENTS with the whole argument string', () => {
    expect(expandLeadingCursorCommand('/ship v2 to prod', commands)).toBe(
      '# Ship\n\nRelease v2 to prod now.',
    );
  });

  it('substitutes positional $N placeholders and blanks the missing ones', () => {
    expect(expandLeadingCursorCommand('/pair a b', commands)).toBe(
      '# Pair\n\nFirst a, second b, third .',
    );
  });

  it('leaves a literal $0 alone: only $1 through $99 are placeholders', () => {
    expect(
      expandLeadingCursorCommand('/argv a b', [
        ...commands,
        { id: 'argv', markdown: '# Argv\n\nRun "$0" with $1 then $00.' },
      ]),
    ).toBe('# Argv\n\nRun "$0" with a then $00.');
  });

  it('appends the arguments when the command has no placeholders', () => {
    expect(expandLeadingCursorCommand('/plain now please', commands)).toBe(
      '# Plain\n\nJust do it.\n\nnow please',
    );
    expect(expandLeadingCursorCommand('/plain', commands)).toBe(
      '# Plain\n\nJust do it.',
    );
  });

  it('lets arguments span several lines', () => {
    expect(expandLeadingCursorCommand('/ship v2\nwith notes', commands)).toBe(
      '# Ship\n\nRelease v2\nwith notes now.',
    );
  });

  it('leaves text alone unless it starts with a known command', () => {
    expect(expandLeadingCursorCommand('please /ship v2', commands)).toBe(
      'please /ship v2',
    );
    expect(expandLeadingCursorCommand('/unknown v2', commands)).toBe(
      '/unknown v2',
    );
    expect(expandLeadingCursorCommand('/shipping v2', commands)).toBe(
      '/shipping v2',
    );
  });
});

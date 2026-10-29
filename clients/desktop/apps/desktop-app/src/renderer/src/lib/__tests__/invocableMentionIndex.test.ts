import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types';
import {
  buildInvocableMentionIndex,
  splitTextByInvocableMentions,
} from '../invocableMentionIndex';

describe('invocable mention index', () => {
  it('matches prefixed invocations and unprefixed plugin-qualified names', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'codex-plugin-skill',
        provider: 'codex',
        kind: 'plugin_skill',
        name: 'branch-naming',
        displayName: '$ud-git:branch-naming',
      }),
      entry({
        id: 'claude-command',
        provider: 'claude',
        kind: 'plugin_command',
        name: 'review',
        displayName: '/review',
      }),
    ]);

    expect(mentions('Use $ud-git:branch-naming', index)).toEqual([
      '$ud-git:branch-naming',
    ]);
    expect(mentions('Use ud-git:branch-naming', index)).toEqual([
      'ud-git:branch-naming',
    ]);
    expect(mentions('Use branch-naming', index)).toEqual([]);
    expect(mentions('Run /review then plugin:review', index)).toEqual([
      '/review',
      'plugin:review',
    ]);
    expect(mentions('Run review without a prefix', index)).toEqual([]);
  });

  it('matches aliases case-sensitively', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'codex-plugin-skill',
        provider: 'codex',
        kind: 'plugin_skill',
        name: 'Branch-Naming',
        displayName: '$Ud-Git:Branch-Naming',
      }),
    ]);

    expect(mentions('Use $Ud-Git:Branch-Naming', index)).toEqual([
      '$Ud-Git:Branch-Naming',
    ]);
    expect(mentions('Use $ud-git:branch-naming', index)).toEqual([]);
    expect(mentions('Use Ud-Git:Branch-Naming', index)).toEqual([
      'Ud-Git:Branch-Naming',
    ]);
    expect(mentions('Use ud-git:branch-naming', index)).toEqual([]);
  });

  it('matches command source names with spaces only when plugin-qualified', () => {
    const index = buildInvocableMentionIndex([
      {
        ...entry({
          id: 'codex-command',
          provider: 'codex',
          kind: 'plugin_command',
          name: 'run-report-2',
          displayName: '$compat-plugin:run-report-2',
        }),
        sourceName: 'run report',
      },
    ]);

    expect(mentions('Try run report today.', index)).toEqual([]);
    expect(mentions('Try plugin:run report today.', index)).toEqual([
      'plugin:run report',
    ]);
  });

  it('preserves surrounding text and handles boundary and adjacent mentions', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'review',
        provider: 'claude',
        kind: 'plugin_command',
        name: 'review',
        displayName: '/review',
      }),
      entry({
        id: 'test',
        provider: 'claude',
        kind: 'skill',
        name: 'test',
        displayName: '/test',
      }),
    ]);

    // Mention at the very start (lookbehind on position 0) and end of string.
    expect(pieceShapes('/review now', index)).toEqual([
      { type: 'mention', text: '/review' },
      { type: 'text', text: ' now' },
    ]);
    expect(pieceShapes('run /test', index)).toEqual([
      { type: 'text', text: 'run ' },
      { type: 'mention', text: '/test' },
    ]);
    // Text between two mentions is preserved as a single segment.
    expect(mentions('first /review then /test done', index)).toEqual([
      '/review',
      '/test',
    ]);
  });

  it('prefers the longest alias at a given position', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'short',
        provider: 'codex',
        kind: 'plugin_skill',
        name: 'run',
        displayName: '$plugin:run',
      }),
      entry({
        id: 'long',
        provider: 'codex',
        kind: 'plugin_command',
        name: 'run-report',
        displayName: '$plugin:run-report',
      }),
    ]);

    expect(mentions('use $plugin:run-report here', index)).toEqual([
      '$plugin:run-report',
    ]);
  });

  it('returns the memoized result for repeated text', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'review',
        provider: 'claude',
        kind: 'plugin_command',
        name: 'review',
        displayName: '/review',
      }),
    ]);

    const first = splitTextByInvocableMentions('run /review', index);
    const second = splitTextByInvocableMentions('run /review', index);
    expect(second).toBe(first);
  });

  it('skips the compiled alias matcher when prose has no invocation marker', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'review',
        provider: 'claude',
        kind: 'plugin_command',
        name: 'review',
        displayName: '/review',
      }),
      entry({
        id: 'plugin-skill',
        provider: 'codex',
        kind: 'plugin_skill',
        name: 'branch-naming',
        displayName: '$ud-git:branch-naming',
      }),
    ]);
    const matcher = index.matcher;
    expect(matcher).not.toBeNull();
    if (!matcher) throw new Error('Expected the invocable matcher to exist');
    const matcherSpy = jest.spyOn(matcher, 'exec');

    expect(
      splitTextByInvocableMentions(
        'A normal streaming response with no invocable references.',
        index,
      ),
    ).toEqual([
      {
        type: 'text',
        text: 'A normal streaming response with no invocable references.',
      },
    ]);
    expect(matcherSpy).not.toHaveBeenCalled();
  });

  it('does not treat a prose colon followed by whitespace as an invocation marker', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'plugin-skill',
        provider: 'codex',
        kind: 'plugin_skill',
        name: 'branch-naming',
        displayName: '$ud-git:branch-naming',
      }),
    ]);
    const matcher = index.matcher;
    expect(matcher).not.toBeNull();
    if (!matcher) throw new Error('Expected the invocable matcher to exist');
    const matcherSpy = jest.spyOn(matcher, 'exec');

    expect(
      splitTextByInvocableMentions(
        'Power-user transcript 12.3: persisted project context.',
        index,
      ),
    ).toEqual([
      {
        type: 'text',
        text: 'Power-user transcript 12.3: persisted project context.',
      },
    ]);
    expect(matcherSpy).not.toHaveBeenCalled();
  });

  it('matches plugin-qualified aliases with Unicode after the colon', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'unicode-plugin-skill',
        provider: 'codex',
        kind: 'plugin_skill',
        name: '分析',
        displayName: 'myplugin:分析',
      }),
    ]);

    expect(mentions('Use myplugin:分析 for this report.', index)).toEqual([
      'myplugin:分析',
    ]);
  });

  it('keeps matching when an inventory exposes an unmarked display alias', () => {
    const markedEntry = entry({
      id: 'review',
      provider: 'claude',
      kind: 'plugin_command',
      name: 'review',
      displayName: '/review',
    });
    const index = buildInvocableMentionIndex([
      {
        ...markedEntry,
        displayName: 'Review command',
      },
    ]);

    expect(mentions('Run the Review command now', index)).toEqual([
      'Review command',
    ]);
  });

  it('does not match inside larger tokens', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'skill',
        provider: 'claude',
        kind: 'skill',
        name: 'test',
        displayName: '/test',
      }),
    ]);

    expect(mentions('contest src/test-file.ts /test', index)).toEqual([
      '/test',
    ]);
  });

  it('isolates memoized results across inventory replacements', () => {
    const reviewIndex = buildInvocableMentionIndex([
      entry({
        id: 'review',
        provider: 'claude',
        kind: 'plugin_command',
        name: 'review',
        displayName: '/review',
      }),
    ]);
    const testIndex = buildInvocableMentionIndex([
      entry({
        id: 'test',
        provider: 'claude',
        kind: 'skill',
        name: 'test',
        displayName: '/test',
      }),
    ]);
    const text = 'run /review then /test';

    expect(mentions(text, reviewIndex)).toEqual(['/review']);
    expect(mentions(text, testIndex)).toEqual(['/test']);
  });

  it('preserves Unicode and whitespace around mentions', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'review',
        provider: 'claude',
        kind: 'plugin_command',
        name: 'review',
        displayName: '/review',
      }),
    ]);
    const text = 'Résumé 🚀\n\t/review\u00a0完了';

    expect(pieceShapes(text, index)).toEqual([
      { type: 'text', text: 'Résumé 🚀\n\t' },
      { type: 'mention', text: '/review' },
      { type: 'text', text: '\u00a0完了' },
    ]);
  });

  it('preserves a large message exactly while extracting sparse mentions', () => {
    const index = buildInvocableMentionIndex([
      entry({
        id: 'review',
        provider: 'claude',
        kind: 'plugin_command',
        name: 'review',
        displayName: '/review',
      }),
    ]);
    const text = `${'alpha '.repeat(20_000)}/review ${'omega '.repeat(20_000)}`;
    const pieces = splitTextByInvocableMentions(text, index);

    expect(pieces.map((piece) => piece.text).join('')).toBe(text);
    expect(
      pieces
        .filter((piece) => piece.type === 'mention')
        .map((piece) => piece.text),
    ).toEqual(['/review']);
  });
});

function mentions(
  text: string,
  index: ReturnType<typeof buildInvocableMentionIndex>,
): string[] {
  return splitTextByInvocableMentions(text, index)
    .filter((piece) => piece.type === 'mention')
    .map((piece) => piece.text);
}

function pieceShapes(
  text: string,
  index: ReturnType<typeof buildInvocableMentionIndex>,
): Array<{ type: string; text: string }> {
  return splitTextByInvocableMentions(text, index).map((piece) => ({
    type: piece.type,
    text: piece.text,
  }));
}

function entry(options: {
  id: string;
  provider: InvocableInventoryEntry['provider'];
  kind: InvocableInventoryEntry['kind'];
  name: string;
  displayName: string;
}): InvocableInventoryEntry {
  return {
    id: options.id,
    provider: options.provider,
    kind: options.kind,
    name: options.name,
    displayName: options.displayName,
    description: `${options.name} description`,
    insertText: `${options.displayName} `,
    invocationKey: options.displayName,
    enableRef:
      options.kind === 'skill'
        ? { kind: 'skill', sourceId: 'source', skillName: options.name }
        : { kind: 'plugin', marketplaceId: 'market', pluginName: 'plugin' },
  };
}

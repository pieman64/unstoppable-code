import { matchSlashCommand, searchSlashCommands } from '../commandSearch';
import {
  deriveSearchIdentities,
  isOneEditApart,
  normalizeSearchText,
  subsequenceSpan,
  tokenizeSearchQuery,
} from '../commandSearchIdentity';
import type { SlashCommandOption } from '../../types';

type Row = SlashCommandOption & { id: string };

function row(id: string, fields: Partial<SlashCommandOption> = {}): Row {
  return { id, name: id, ...fields };
}

function ids(rows: readonly Row[], query: string): string[] {
  return searchSlashCommands(rows, query).map((command) => command.id);
}

function tier(fields: SlashCommandOption, query: string): number | null {
  return matchSlashCommand(fields, query)?.tier ?? null;
}

describe('normalization', () => {
  it('trims, lowercases and strips one leading trigger', () => {
    expect(normalizeSearchText('  /Review ')).toBe('review');
    expect(normalizeSearchText('$ Review')).toBe('review');
    expect(normalizeSearchText('//review')).toBe('/review');
    expect(normalizeSearchText(undefined)).toBe('');
  });

  it('drops stopwords only when a meaningful token remains', () => {
    expect(tokenizeSearchQuery('review my pr')).toEqual(['review', 'pr']);
    expect(tokenizeSearchQuery('do it')).toEqual(['do', 'it']);
    expect(tokenizeSearchQuery('ecom_debugger')).toEqual(['ecom', 'debugger']);
  });

  it('returns a copy of the catalog order for empty or trigger-only queries', () => {
    const rows = [row('b'), row('a')];
    for (const query of ['', '   ', '/', '$', ' / ']) {
      const result = searchSlashCommands(rows, query);
      expect(result).toEqual(rows);
      expect(result).not.toBe(rows);
    }
  });

  it('does not let separator-only input match every row', () => {
    expect(ids([row('review'), row('deploy')], '--')).toEqual([]);
    expect(ids([row('review')], '::')).toEqual([]);
  });
});

describe('identity derivation', () => {
  it('derives member, qualified, plugin and display identities', () => {
    expect(
      deriveSearchIdentities({
        name: 'ecom-debugger',
        namespace: 'ud-ecom-debugger',
        displayName: '/Investigator',
      }).map(({ text, strength }) => [text, strength]),
    ).toEqual([
      ['ecom-debugger', 3],
      ['ud-ecom-debugger:ecom-debugger', 2],
      ['ud-ecom-debugger', 1],
      ['investigator', 3],
    ]);
  });

  it('infers plugin and member from a qualified name or display name', () => {
    expect(
      deriveSearchIdentities({ name: 'docs:write' }).map(({ text }) => text),
    ).toEqual(['write', 'docs:write', 'docs']);
    expect(
      deriveSearchIdentities({
        name: 'write',
        displayName: '/docs:write',
      }).map(({ text, strength }) => [text, strength]),
    ).toEqual([
      ['write', 3],
      ['docs:write', 2],
      ['docs', 1],
    ]);
  });

  it('prefers explicit metadata over inferred names', () => {
    expect(
      deriveSearchIdentities({
        name: 'other:review-deep-thing',
        namespace: 'code-review',
        memberName: 'review/deep:thing',
      }).map(({ text }) => text),
    ).toEqual([
      'review/deep:thing',
      'code-review:review/deep:thing',
      'code-review',
    ]);
  });

  it('finds a flattened plugin member by its plugin name', () => {
    const rows = [
      row('unrelated', { description: 'Mentions docs-plugin in passing' }),
      row('writing-docs', { namespace: 'docs-plugin' }),
    ];
    expect(ids(rows, 'docs-plugin')).toEqual(['writing-docs', 'unrelated']);
    expect(ids(rows, '/docs-plugin:writing')).toEqual(['writing-docs']);
  });

  it('handles rows without optional metadata', () => {
    expect(tier({ name: 'deploy' }, 'deploy')).toBe(1);
    expect(tier({ name: 'deploy' }, 'missing')).toBeNull();
  });
});

describe('tiers', () => {
  it.each([
    ['exact identity', { name: 'review' }, 'review', 1],
    [
      'exact plugin identity',
      { name: 'x', namespace: 'posthog' },
      'posthog',
      1,
    ],
    ['identity prefix', { name: 'review-loop' }, 'review-l', 2],
    ['identity substring', { name: 'code-review' }, 'de-rev', 3],
    ['token prefixes', { name: 'make-pr-green' }, 'make green', 3],
    ['typo', { name: 'ecom-debugger' }, 'ecomm-debugger', 4],
    [
      'identity plus description',
      { name: 'review', description: 'Reviews a pull request' },
      'review pull',
      null,
    ],
    ['category', { name: 'x', category: 'Repository scripts' }, 'repos', null],
    [
      'description words',
      { name: 'x', description: 'Debug a domain/order problem' },
      'domain order',
      5,
    ],
    ['single-token subsequences are excluded', { name: 'review' }, 'rvw', null],
  ])('%s', (_label, fields, query, expected) => {
    expect(tier(fields, query)).toBe(expected);
  });

  it('admits only exact and prefix matches for one-character queries', () => {
    expect(tier({ name: 'review' }, 'r')).toBe(2);
    expect(tier({ name: 'deploy', description: 'r' }, 'r')).toBeNull();
    expect(tier({ name: 'merge-rules' }, 'r')).toBeNull();
  });

  it('matches case, triggers and separators the same way', () => {
    const rows = [row('ecom-debugger')];
    for (const query of ['ECOM-DEBUGGER', '$ecom debugger', '/ecom_debugger']) {
      expect(ids(rows, query)).toEqual(['ecom-debugger']);
    }
  });

  it('pins description word boundaries', () => {
    const fields = { name: 'x', description: 'Debug a domain/order problem' };
    expect(tier(fields, 'domain/order')).toBe(5);
    expect(tier(fields, 'domain ord')).toBeNull();
    expect(tier(fields, 'dom')).toBeNull();
    // Scattered letters never match a description.
    expect(tier(fields, 'dbg')).toBeNull();
  });

  it('does not combine tokens from unrelated identities', () => {
    expect(tier({ name: 'alpha', namespace: 'beta' }, 'alpha beta')).toBe(3);
    expect(tier({ name: 'alpha', displayName: 'beta' }, 'alpha beta')).toBe(
      null,
    );
  });

  it('excludes category labels and uses single-word descriptions only as fallback', () => {
    const rows = [
      row('described', { description: 'Deploy production' }),
      row('categorized', { category: 'Deploy' }),
      row('deploy-now'),
    ];
    expect(ids(rows, 'deploy')).toEqual(['deploy-now']);
    expect(ids(rows, 'deploy pro')).toEqual([]);
    expect(ids([rows[0] ?? row('x')], 'deploy')).toEqual(['described']);
  });
});

describe('typo distance', () => {
  it.each([
    ['insertion', 'review', 'revieww'],
    ['deletion', 'review', 'reviw'],
    ['substitution', 'review', 'reviev'],
    ['adjacent transposition', 'review', 'reveiw'],
  ])('accepts one %s', (_label, word, query) => {
    expect(isOneEditApart(query, word)).toBe(true);
  });

  it('rejects two edits and identical text', () => {
    expect(isOneEditApart('revwie', 'review')).toBe(false);
    expect(isOneEditApart('review', 'review')).toBe(false);
  });

  it('requires four characters before allowing an edit', () => {
    expect(tier({ name: 'plan' }, 'plam')).toBe(4);
    expect(tier({ name: 'fix' }, 'fux')).toBeNull();
    expect(tier({ name: 'review' }, 'revwie')).toBeNull();
  });

  it('keeps single-token subsequences outside the edit limit', () => {
    expect(tier({ name: 'review' }, 'revw')).toBeNull();
    expect(subsequenceSpan('review', 'rvw')).toBe(6);
    expect(subsequenceSpan('a-review', 'rw')).toBe(6);
    expect(subsequenceSpan('review', 'xyz')).toBeNull();
  });
});

describe('ordering', () => {
  it('ranks an Available exact match above an enabled description match', () => {
    const rows = [
      row('enabled', { description: 'Runs the ecom-debugger flow' }),
      row('ecom-debugger', {
        namespace: 'ud-ecom-debugger',
        section: 'available',
      }),
    ];
    expect(ids(rows, 'ecom-debugger')).toEqual(['ecom-debugger', 'enabled']);
    expect(ids(rows, 'ecom debugger')).toEqual(['ecom-debugger', 'enabled']);
  });

  it('ranks plugin members above unrelated skills for a plugin query', () => {
    const rows = [
      row('code-reviewer-notes'),
      row('review', { namespace: 'ud-code-review', section: 'available' }),
      row('loop', { namespace: 'ud-code-review', section: 'available' }),
    ];
    expect(ids(rows, 'ud-code-review')).toEqual(['review', 'loop']);
  });

  it('prefers member over qualified over plugin identity strength', () => {
    const rows = [
      row('plugin', { name: 'other', namespace: 'deploy' }),
      row('member', { name: 'deploy' }),
    ];
    expect(ids(rows, 'deploy')).toEqual(['member', 'plugin']);
  });

  it('prefers more exact tokens, then preserves input order', () => {
    const rows = [row('review-hog-authoring'), row('reviewer'), row('review')];
    expect(ids(rows, 'review')).toEqual([
      'review',
      'review-hog-authoring',
      'reviewer',
    ]);
    expect(ids(rows, 'reveiw')).toEqual(['review', 'review-hog-authoring']);
  });

  it('breaks remaining ties by enabled first, then input order', () => {
    const rows = [
      row('a', { name: 'deploy', section: 'available' }),
      row('b', { name: 'deploy' }),
      row('c', { name: 'deploy', section: 'discovered' }),
    ];
    expect(ids(rows, 'deploy')).toEqual(['b', 'c', 'a']);
  });

  it('uses single-word descriptions only when no identity matches', () => {
    const rows = [
      row('described', { description: 'Plan the work' }),
      row('pln-alias', { name: 'p-l-a-n' }),
      row('plan'),
    ];
    expect(ids(rows, 'plan')).toEqual(['plan']);
    expect(ids([rows[0] ?? row('x')], 'plan')).toEqual(['described']);
  });

  it('does not mutate rows or the input array', () => {
    const rows = [row('b', { namespace: 'x' }), row('a')];
    const snapshot = JSON.stringify(rows);
    const result = searchSlashCommands(rows, 'a');
    expect(JSON.stringify(rows)).toBe(snapshot);
    expect(result[0]).toBe(rows[1]);
  });
});

// Refined-plan regressions: no extra identity-width tie-break or query compaction.
describe('refined search contract', () => {
  it('prefers full typo coverage before enablement', () => {
    expect(
      ids(
        [
          row('long', { name: 'review-hog-authoring' }),
          row('short', { name: 'review', section: 'available' }),
        ],
        'reveiw',
      ),
    ).toEqual(['short', 'long']);
  });
  it('uses the full query for subsequence comparisons', () => {
    expect(tier({ name: 'review' }, 'r v w')).toBeNull();
  });
  it('does not resurrect an inferred identity replaced by explicit metadata', () => {
    expect(
      tier(
        { name: 'old:projected', namespace: 'actual', memberName: 'source' },
        'old',
      ),
    ).toBeNull();
  });
});

describe('ranking recovery', () => {
  it('keeps whole-word multi-term description coverage beside identities', () => {
    expect(
      ids(
        [
          row('review-pr'),
          row('specialist', {
            description: 'Review code with GitHub PR automation',
          }),
          row('partial', { description: 'Reviews a pull request' }),
        ],
        'review my pr',
      ),
    ).toEqual(['review-pr', 'specialist']);
  });

  it('uses multi-token identity subsequences only when the primary tiers miss', () => {
    const fallback = row('fallback', { name: 'alpha-beta:alpha-beta' });
    expect(tier(fallback, 'alpha-bbet')).toBe(6);
    expect(ids([fallback], 'alpha-bbet')).toEqual(['fallback']);
    expect(
      ids([fallback, row('literal', { name: 'alpha-bbet' })], 'alpha-bbet'),
    ).toEqual(['literal']);
    expect(
      ids(
        [fallback, row('described', { description: 'alpha bbet' })],
        'alpha-bbet',
      ),
    ).toEqual(['described']);
  });
});

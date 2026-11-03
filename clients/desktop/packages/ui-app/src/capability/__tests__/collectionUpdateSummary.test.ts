import type {
  SharedCollectionDocument,
  SharedCollectionItem,
} from '@canopy/protocol/collections';
import {
  summarizeCollectionUpdate,
  type CollectionLocalMembers,
} from '../collectionUpdateSummary';

const SOURCE = { type: 'github', repo: 'acme/skills' } as const;

function skillItem(name: string): SharedCollectionItem {
  return { type: 'skill', source: SOURCE, skill_name: name };
}

function customSkillItem(name: string): SharedCollectionItem {
  return {
    type: 'custom_skill',
    skillId: `id-${name}`,
    skill_name: name,
    contentHash: `hash-${name}`,
  };
}

function pluginItem(name: string): SharedCollectionItem {
  return { type: 'claude_plugin', marketplace: SOURCE, plugin_name: name };
}

function live(items: SharedCollectionItem[]): SharedCollectionDocument {
  return { version: 1, name: 'Design review', description: '', items };
}

function members(
  skills: string[],
  plugins: string[] = [],
): CollectionLocalMembers {
  return {
    skills: skills.map((skillName) => ({
      sourceId: 'github:acme:skills',
      skillName,
    })),
    plugins: plugins.map((pluginName) => ({
      marketplaceId: 'acme/skills',
      pluginName,
    })),
  };
}

const counts = { skills: 2, plugins: 1 };

describe('summarizeCollectionUpdate', () => {
  it('names a single added skill', () => {
    expect(
      summarizeCollectionUpdate({
        localMembers: members(['review']),
        live: live([skillItem('review'), skillItem('figma-handoff')]),
        localCounts: counts,
        sharerName: 'Priya Shah',
      }),
    ).toBe('Priya Shah added the figma-handoff skill');
  });

  it('names a single removed plugin', () => {
    expect(
      summarizeCollectionUpdate({
        localMembers: members(['review'], ['Linter']),
        live: live([skillItem('review')]),
        localCounts: counts,
        sharerName: 'Priya Shah',
      }),
    ).toBe('Priya Shah removed the Linter plugin');
  });

  it('counts several changes by verb and kind', () => {
    expect(
      summarizeCollectionUpdate({
        localMembers: members(['review'], ['linter']),
        live: live([skillItem('review'), skillItem('a'), skillItem('b')]),
        localCounts: counts,
        sharerName: 'Priya Shah',
      }),
    ).toBe('Priya Shah added 2 skills and removed 1 plugin');
  });

  it('uses generic copy for noncanonical plugin names', () => {
    expect(
      summarizeCollectionUpdate({
        localMembers: members([], [' Linter ']),
        live: live([pluginItem('linter'), skillItem('new')]),
        localCounts: counts,
        sharerName: 'Priya Shah',
      }),
    ).toBe('Changed the collection');
  });

  it('does not invent custom-skill identity by stripping numeric suffixes', () => {
    expect(
      summarizeCollectionUpdate({
        localMembers: {
          skills: [{ sourceId: 'custom:app', skillName: 'helper-2' }],
          plugins: [],
        },
        live: live([customSkillItem('helper'), skillItem('figma-handoff')]),
        localCounts: counts,
        sharerName: 'Priya Shah',
      }),
    ).toBe('Changed the collection');
  });

  it('reads changed the collection when only MCP servers or the description changed', () => {
    expect(
      summarizeCollectionUpdate({
        localMembers: members(['review']),
        live: live([skillItem('review')]),
        localCounts: { skills: 1, plugins: 0 },
        liveCounts: { skills: 3, plugins: 0 },
        sharerName: 'Priya Shah',
      }),
    ).toBe('Changed the collection');
  });

  it('does not infer changed-item counts from list totals', () => {
    expect(
      summarizeCollectionUpdate({
        localCounts: { skills: 2, plugins: 1 },
        liveCounts: { skills: 3, plugins: 0 },
        sharerName: 'Priya Shah',
      }),
    ).toBe('Changed the collection');
    expect(
      summarizeCollectionUpdate({
        live: live([skillItem('a')]),
        localCounts: { skills: 2, plugins: 0 },
        liveCounts: { skills: 3, plugins: 0 },
        sharerName: 'Priya Shah',
      }),
    ).toBe('Changed the collection');
  });

  it('reads changed the collection when counts are equal or unknown', () => {
    expect(
      summarizeCollectionUpdate({
        localCounts: counts,
        liveCounts: counts,
        sharerName: 'Priya Shah',
      }),
    ).toBe('Changed the collection');
    expect(
      summarizeCollectionUpdate({ localCounts: counts, sharerName: 'Priya' }),
    ).toBe('Changed the collection');
  });

  it('capitalises the verb without a sharer name', () => {
    expect(
      summarizeCollectionUpdate({
        localMembers: members(['review']),
        live: live([skillItem('review'), skillItem('figma-handoff')]),
        localCounts: counts,
      }),
    ).toBe('Added the figma-handoff skill');
    expect(
      summarizeCollectionUpdate({
        localCounts: { skills: 1, plugins: 0 },
        liveCounts: { skills: 2, plugins: 0 },
        sharerName: '  ',
      }),
    ).toBe('Changed the collection');
    expect(summarizeCollectionUpdate({ localCounts: counts })).toBe(
      'Changed the collection',
    );
  });
});

it('counts repeated exact refs only once', () => {
  expect(
    summarizeCollectionUpdate({
      localMembers: members([]),
      live: live([skillItem('a'), skillItem('a')]),
      localCounts: counts,
    }),
  ).toBe('Added the a skill');
});
it('does not match same-name members from different sources', () => {
  expect(
    summarizeCollectionUpdate({
      localMembers: members(['review']),
      live: live([
        {
          type: 'skill',
          source: { type: 'github', repo: 'other/skills' },
          skill_name: 'review',
        },
      ]),
      localCounts: counts,
    }),
  ).toBe('Changed the collection');
});

it('describes a rename as observed removal and addition rather than guessing identity', () => {
  expect(
    summarizeCollectionUpdate({
      localMembers: members(['before']),
      live: live([skillItem('after')]),
      localCounts: counts,
    }),
  ).toBe('Added 1 skill and removed 1 skill');
});

it('matches installed builtin and Codex marketplace IDs without inventing source prefixes', () => {
  expect(
    summarizeCollectionUpdate({
      localMembers: {
        skills: [],
        plugins: [
          { marketplaceId: 'builtin/app', pluginName: 'review' },
          { marketplaceId: 'codex-official', pluginName: 'tools' },
        ],
      },
      live: live([
        {
          type: 'claude_plugin',
          marketplace: { type: 'builtin', id: 'app' },
          plugin_name: 'review',
        },
        {
          type: 'codex_plugin',
          marketplace: { type: 'codex-builtin', id: 'codex-official' },
          plugin_name: 'tools',
        },
        skillItem('new'),
      ]),
      localCounts: counts,
    }),
  ).toBe('Added the new skill');
});

it.each(['builtin', 'builtin/app', 'builtin:app'])(
  'compares the installed bundled source alias %s',
  (sourceId) => {
    expect(
      summarizeCollectionUpdate({
        localMembers: {
          skills: [{ sourceId, skillName: 'review' }],
          plugins: [],
        },
        live: live([
          {
            type: 'skill',
            source: { type: 'builtin', id: 'app' },
            skill_name: 'review',
          },
          {
            type: 'skill',
            source: { type: 'builtin', id: 'app' },
            skill_name: 'figma-handoff',
          },
        ]),
        localCounts: { skills: 1, plugins: 0 },
        sharerName: 'Priya Shah',
      }),
    ).toBe('Priya Shah added the figma-handoff skill');
  },
);

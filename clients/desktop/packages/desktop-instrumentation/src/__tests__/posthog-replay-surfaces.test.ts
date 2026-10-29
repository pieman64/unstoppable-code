import { PANEL_KINDS } from '@canopy/protocol/panels';
import {
  HOSTED_SETTINGS_PAGE_ROUTES,
  NAVIGATION_PAGE_ROUTES,
  SETTINGS_SECTION_ROUTES,
} from '../posthog-routes';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '../posthog-replay-privacy';
import {
  HOSTED_SETTINGS_PAGE_REPLAY_PRIVACY,
  NAVIGATION_PAGE_REPLAY_PRIVACY,
  PANEL_KIND_REPLAY_PRIVACY,
  SETTINGS_SECTION_REPLAY_PRIVACY,
  replayBlockClassFor,
} from '../posthog-replay-surfaces';

const PRIVACY_VALUES: readonly string[] = ['blocked', 'reviewed'];

// The `satisfies Record<Union, ReplaySurfacePrivacy>` clauses already fail
// type-checking when a union member is unclassified. These runtime checks pin
// the same coverage against the only complete runtime catalogs of each union,
// and reject extra keys.
describe.each([
  ['panel kinds', PANEL_KIND_REPLAY_PRIVACY, [...PANEL_KINDS]],
  [
    'navigation pages',
    NAVIGATION_PAGE_REPLAY_PRIVACY,
    Object.keys(NAVIGATION_PAGE_ROUTES),
  ],
  [
    'settings sections',
    SETTINGS_SECTION_REPLAY_PRIVACY,
    Object.keys(SETTINGS_SECTION_ROUTES),
  ],
  [
    'hosted settings pages',
    HOSTED_SETTINGS_PAGE_REPLAY_PRIVACY,
    Object.keys(HOSTED_SETTINGS_PAGE_ROUTES),
  ],
])('%s replay privacy map', (_name, map, catalog: readonly string[]) => {
  it('classifies every member of its union and nothing else', () => {
    expect(Object.keys(map).sort()).toEqual([...catalog].sort());
  });

  it('uses only blocked or reviewed', () => {
    for (const value of Object.values(map)) {
      expect(PRIVACY_VALUES).toContain(value);
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(map)).toBe(true);
  });
});

it('blocks only whole-content panels and records every page and section', () => {
  const blockedPanels = Object.entries(PANEL_KIND_REPLAY_PRIVACY)
    .filter(([, privacy]) => privacy === 'blocked')
    .map(([kind]) => kind)
    .sort();
  // A terminal or file-diff panel is entirely content; its tab title sits
  // outside the panel frame and stays recorded.
  expect(blockedPanels).toEqual(['file-diff', 'terminal']);
  expect(
    Object.values(NAVIGATION_PAGE_REPLAY_PRIVACY).every(
      (privacy) => privacy === 'reviewed',
    ),
  ).toBe(true);
  expect(
    Object.values(SETTINGS_SECTION_REPLAY_PRIVACY).every(
      (privacy) => privacy === 'reviewed',
    ),
  ).toBe(true);
});

it('blocks hosted pages whose body is work content or transcripts', () => {
  const blocked = Object.entries(HOSTED_SETTINGS_PAGE_REPLAY_PRIVACY)
    .filter(([, privacy]) => privacy === 'blocked')
    .map(([page]) => page)
    .sort();
  expect(blocked).toEqual([
    'account/digests',
    'organization/digests',
    'organization/feed',
    'organization/members',
    'organization/memory',
    'organization/statistics',
  ]);
});

describe('replayBlockClassFor', () => {
  it('returns the recorder block class for blocked surfaces', () => {
    expect(replayBlockClassFor('blocked')).toBe(POSTHOG_REPLAY_BLOCK_CLASS);
  });

  it('returns no class for reviewed surfaces', () => {
    expect(replayBlockClassFor('reviewed')).toBeUndefined();
  });
});

import type { RecommendedPluginItem } from '@canopy/desktop-shared/types';
import { hasVisibleRecommendedPluginItems } from '@/lib/recommendedPlugins';

const baseItem: RecommendedPluginItem = {
  key: 'skill:github:owner/repo:reviewer',
  kind: 'skill',
  displayName: 'reviewer',
  displaySource: 'owner/repo',
  ref: {
    type: 'skill',
    source: { type: 'github', repo: 'owner/repo' },
    skill_name: 'reviewer',
  },
  installed: true,
  selectedByDefault: false,
  optedOut: false,
  installState: 'installed',
  action: 'select',
};

function item(
  overrides: Partial<RecommendedPluginItem>,
): RecommendedPluginItem {
  return {
    ...baseItem,
    ...overrides,
  };
}

describe('hasVisibleRecommendedPluginItems', () => {
  it('hides opportunistic recommendation panels when every item is already selected by default', () => {
    expect(
      hasVisibleRecommendedPluginItems([
        item({ key: 'skill:github:owner/repo:a', selectedByDefault: true }),
        item({ key: 'skill:github:owner/repo:b', selectedByDefault: true }),
      ]),
    ).toBe(false);
  });

  it('keeps the panel visible when any recommendation still needs local action or attention', () => {
    expect(
      hasVisibleRecommendedPluginItems([
        item({ key: 'skill:github:owner/repo:a', selectedByDefault: true }),
        item({ key: 'skill:github:owner/repo:b', selectedByDefault: false }),
      ]),
    ).toBe(true);
  });
});

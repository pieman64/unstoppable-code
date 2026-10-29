import type { RecommendedPluginItem } from '@canopy/desktop-shared/types';

export function hasVisibleRecommendedPluginItems(
  items: readonly RecommendedPluginItem[],
): boolean {
  return items.some((item) => !item.selectedByDefault);
}

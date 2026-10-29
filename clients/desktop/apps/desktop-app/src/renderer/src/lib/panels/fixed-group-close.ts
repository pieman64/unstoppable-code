import {
  DEFAULT_EXTRAS_GROUP_ID,
  DEFAULT_TERMINAL_GROUP_ID,
} from '@/lib/panels/panel-group-ids';

type GroupTabs = Readonly<
  Record<string, { readonly tabs: readonly { readonly panelId: string }[] }>
>;

/**
 * Whether `panelId` is the only tab of a group Minimal keeps a tab in: every
 * group but the Side Panel and the bottom drawer (the panel layout store
 * refuses to close that tab under a fixed topology), so it offers no close.
 */
export function isLastTabOfFixedGroup(
  groups: GroupTabs | undefined,
  panelId: string,
): boolean {
  for (const [groupId, group] of Object.entries(groups ?? {})) {
    if (!group.tabs.some((tab) => tab.panelId === panelId)) continue;
    return (
      groupId !== DEFAULT_EXTRAS_GROUP_ID &&
      groupId !== DEFAULT_TERMINAL_GROUP_ID &&
      group.tabs.length === 1
    );
  }
  return false;
}

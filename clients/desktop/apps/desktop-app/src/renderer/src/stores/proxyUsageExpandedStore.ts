import { create } from 'zustand';

/**
 * Where each account-proxy account's open/folded card in the usage popover
 * is kept, so it survives a restart. A renderer-only UI choice, like the
 * other `canopy.*` keys.
 */
export const PROXY_USAGE_EXPANDED_STORAGE_KEY =
  'canopy.usagePopover.expandedProxyAccounts';

/** Whether the popover's whole Proxy accounts section is folded. */
export const PROXY_USAGE_SECTION_COLLAPSED_STORAGE_KEY =
  'canopy.usagePopover.proxyAccountsCollapsed';

/** The accounts shown open, by account-proxy account key. */
type ExpandedAccounts = Readonly<Record<string, true>>;

function readExpandedAccounts(): ExpandedAccounts {
  try {
    const raw = window.localStorage.getItem(PROXY_USAGE_EXPANDED_STORAGE_KEY);
    const parsed: unknown = raw === null ? null : JSON.parse(raw);
    if (!Array.isArray(parsed)) return {};
    const expanded: Record<string, true> = {};
    for (const key of parsed) {
      if (typeof key === 'string') expanded[key] = true;
    }
    return expanded;
  } catch {
    return {};
  }
}

function writeExpandedAccounts(expanded: ExpandedAccounts): void {
  try {
    window.localStorage.setItem(
      PROXY_USAGE_EXPANDED_STORAGE_KEY,
      JSON.stringify(Object.keys(expanded)),
    );
  } catch {
    // Storage full or unavailable: the choice still holds for this session.
  }
}

function readSectionCollapsed(): boolean {
  try {
    return (
      window.localStorage.getItem(PROXY_USAGE_SECTION_COLLAPSED_STORAGE_KEY) ===
      'true'
    );
  } catch {
    return false;
  }
}

function writeSectionCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) {
      window.localStorage.setItem(
        PROXY_USAGE_SECTION_COLLAPSED_STORAGE_KEY,
        'true',
      );
    } else {
      window.localStorage.removeItem(PROXY_USAGE_SECTION_COLLAPSED_STORAGE_KEY);
    }
  } catch {
    // Storage full or unavailable: the choice still holds for this session.
  }
}

interface ProxyUsageExpandedState {
  /** Accounts never toggled start folded to their lead meter. */
  readonly expanded: ExpandedAccounts;
  /** The section starts open. */
  readonly sectionCollapsed: boolean;
  readonly toggle: (accountKey: string) => void;
  readonly toggleSection: () => void;
}

export const useProxyUsageExpandedStore = create<ProxyUsageExpandedState>(
  (set) => ({
    expanded: readExpandedAccounts(),
    sectionCollapsed: readSectionCollapsed(),
    toggle: (accountKey): void =>
      set((state) => {
        const { [accountKey]: wasExpanded, ...rest } = state.expanded;
        const expanded: ExpandedAccounts = wasExpanded
          ? rest
          : { ...state.expanded, [accountKey]: true };
        writeExpandedAccounts(expanded);
        return { expanded };
      }),
    toggleSection: (): void =>
      set((state) => {
        const sectionCollapsed = !state.sectionCollapsed;
        writeSectionCollapsed(sectionCollapsed);
        return { sectionCollapsed };
      }),
  }),
);

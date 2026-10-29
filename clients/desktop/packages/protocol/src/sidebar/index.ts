/**
 * Persisted left-nav customization. `order` is the full ordered list of
 * customizable nav item keys (main-nav keys first, then More keys);
 * `moreStartIndex` is the index in `order` where the "More" section begins.
 *
 * Lives in the protocol package rather than `@canopy/desktop-shared` because
 * both the desktop sidebar and the web portal sidebar render from this one
 * model, and `apps/web` may not import desktop-shared. It stays a plain
 * serializable shape with pure helpers, per the protocol package contract.
 */
export interface SidebarNavLayout {
  order: string[];
  moreStartIndex: number;
}

/**
 * Every customizable nav item key, in default order. `remote-control` is
 * rendered by the web rail only; desktop hides it (see
 * `deriveSidebarNavRegions`), but it always participates in ordering so stored
 * layouts keep their positions.
 */
const SIDEBAR_NAV_ITEM_KEY_TUPLE = [
  'app-advisor',
  // One entry for the Automations, Pipelines and Watchers panels (CAN-3980).
  'workflows',
  'plugins',
  // The global Ledger Feed; shown only while the Ledger is on.
  'feed',
  'remote-control',
  // Overview through Audit Trail are Labs page experiments (CAN-3678): they
  // sit in main nav and render only while their experiment is on.
  'overview',
  'kanban',
  'statistics',
  'audit',
  'workers',
] as const;

/**
 * One canonical nav key. Derived from the tuple above so a key added there is
 * immediately required by every exhaustive `Record<SidebarNavItemKey, ...>`
 * (notably the shared label/icon registry in `@canopy/ui-app`).
 */
export type SidebarNavItemKey = (typeof SIDEBAR_NAV_ITEM_KEY_TUPLE)[number];

/**
 * Widened on purpose: callers hand these helpers persisted, user-ordered key
 * lists of unknown provenance, so the runtime surface stays `string[]` and
 * `reconcileSidebarNavLayout` is what narrows an untrusted list back down.
 */
export const SIDEBAR_NAV_ITEM_KEYS: readonly string[] =
  SIDEBAR_NAV_ITEM_KEY_TUPLE;

/**
 * Keys that persisted layouts may still carry after a nav entry was merged into
 * another. `reconcileSidebarNavLayout` maps each through this table before the
 * known-key check, so a stored position survives the rename instead of the
 * entry being dropped and re-appended at the default position.
 */
export const RETIRED_SIDEBAR_NAV_KEY_ALIASES: Readonly<
  Record<string, SidebarNavItemKey>
> = Object.freeze({
  automations: 'workflows',
  pipelines: 'workflows',
});

function resolveRetiredSidebarNavKey(key: string): string {
  return Object.prototype.hasOwnProperty.call(
    RETIRED_SIDEBAR_NAV_KEY_ALIASES,
    key,
  )
    ? RETIRED_SIDEBAR_NAV_KEY_ALIASES[key]
    : key;
}

/** All default items render in main nav; Environments lives in Settings. */
const DEFAULT_MORE_START_INDEX = SIDEBAR_NAV_ITEM_KEYS.length;

/** Default: matches the pre-customization arrangement. */
export const DEFAULT_SIDEBAR_NAV_LAYOUT: SidebarNavLayout = {
  order: [...SIDEBAR_NAV_ITEM_KEYS],
  moreStartIndex: DEFAULT_MORE_START_INDEX,
};

/**
 * Frozen snapshot of the pre-CAN-1082 default. NEVER regenerate this from
 * SIDEBAR_NAV_ITEM_KEYS — that array was reordered by CAN-1082, so deriving
 * this from it would make the migration's equality check always fail. Frozen
 * at runtime (and `readonly` at the type level) because it is load-bearing for
 * that equality check: a caller mutating it would silently break the migration
 * for every user.
 */
export const LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT: {
  readonly order: readonly string[];
  readonly moreStartIndex: number;
} = Object.freeze({
  order: Object.freeze([
    'app-advisor',
    'automations',
    'plugins',
    'pipelines',
    'overview',
    'kanban',
    'environments',
    'agents',
    'statistics',
    'remote-control',
    'audit',
    'workers',
  ]),
  moreStartIndex: 4,
});

/**
 * True when `layout` is still the pre-CAN-1082 default — i.e. the user never
 * customized their sidebar order.
 *
 * Deliberately compares only the keys the legacy snapshot knows about, and
 * counts only those keys on the main-nav side of the divider, rather than
 * requiring an exact whole-array match. Callers hand this the *reconciled*
 * layout (`normalizePreferences` runs `reconcileSidebarNavLayout` on read),
 * and reconcile injects any default key that is missing from the stored order.
 * So the moment a future change adds a key to `SIDEBAR_NAV_ITEM_KEYS`, an
 * un-migrated legacy user's stored layout reconciles to a longer array with a
 * shifted divider. An exact match would return false there, the migration
 * would mark itself done anyway, and those users would never be upgraded.
 */
export function isLegacyDefaultSidebarNavLayout(
  layout: SidebarNavLayout | undefined,
): boolean {
  if (!layout || !Array.isArray(layout.order)) return false;
  return (
    matchesLegacyLayout(layout, LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT) ||
    matchesLegacyLayout(layout, getProjectedLegacySidebarNavLayout())
  );
}

let projectedLegacySidebarNavLayout:
  | { readonly order: readonly string[]; readonly moreStartIndex: number }
  | undefined;

/**
 * The legacy default as `reconcileSidebarNavLayout` rewrites it once retired
 * keys are merged (CAN-3980 folds `automations` and `pipelines` into
 * `workflows`) and removed keys are dropped (CAN-4269 removes `environments`,
 * CAN-4266 removes `agents`).
 * Reconcile runs on read, so without this projection an un-migrated legacy
 * layout would no longer contain every legacy key and the detection above
 * would stop firing. Derived from the frozen snapshot rather than
 * hand-written so it can never disagree with it.
 */
function getProjectedLegacySidebarNavLayout(): {
  readonly order: readonly string[];
  readonly moreStartIndex: number;
} {
  if (!projectedLegacySidebarNavLayout) {
    const { keys, moreStartIndex } = collapseRetiredSidebarNavKeys(
      LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.order,
      LEGACY_DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex,
      (key) => SIDEBAR_NAV_ITEM_KEYS.includes(key),
    );
    projectedLegacySidebarNavLayout = Object.freeze({
      order: Object.freeze(keys),
      moreStartIndex,
    });
  }
  return projectedLegacySidebarNavLayout;
}

function matchesLegacyLayout(
  layout: SidebarNavLayout,
  legacy: {
    readonly order: readonly string[];
    readonly moreStartIndex: number;
  },
): boolean {
  const legacyKeys = new Set(legacy.order);
  const storedLegacyKeys = layout.order.filter((key) => legacyKeys.has(key));
  if (storedLegacyKeys.length !== legacy.order.length) {
    return false;
  }
  if (!storedLegacyKeys.every((key, index) => key === legacy.order[index])) {
    return false;
  }
  const legacyKeysBeforeDivider = layout.order
    .slice(0, layout.moreStartIndex)
    .filter((key) => legacyKeys.has(key)).length;
  return legacyKeysBeforeDivider === legacy.moreStartIndex;
}

/**
 * Factory for a fresh default layout. `DEFAULT_SIDEBAR_NAV_LAYOUT` is a
 * module-level singleton — assigning it by reference into a `PreferencesData`
 * literal that gets mutated in place (e.g. `.order` reordering) would corrupt
 * the shared default for the whole process. Use this factory anywhere a
 * default layout is assigned into a value callers may mutate.
 */
export function createDefaultSidebarNavLayout(): SidebarNavLayout {
  return {
    order: [...SIDEBAR_NAV_ITEM_KEYS],
    moreStartIndex: DEFAULT_MORE_START_INDEX,
  };
}

function normalizeDividerIndex(value: number): number {
  if (!Number.isFinite(value)) return Number.POSITIVE_INFINITY;
  return Math.floor(value);
}

/**
 * Map retired keys to their replacement, drop keys `isKnown` rejects, and
 * dedupe (first occurrence keeps its position). The divider becomes the number
 * of kept keys whose stored index was before it, so a key collapsed or dropped
 * on the main side cannot pull a More key across the divider.
 */
function collapseRetiredSidebarNavKeys(
  storedOrder: readonly unknown[],
  storedMoreStartIndex: number,
  isKnown: (key: string) => boolean,
): { keys: string[]; moreStartIndex: number } {
  const divider = normalizeDividerIndex(storedMoreStartIndex);
  const seen = new Set<string>();
  const keys: string[] = [];
  let moreStartIndex = 0;
  storedOrder.forEach((storedKey, storedIndex) => {
    if (typeof storedKey !== 'string') return;
    const key = resolveRetiredSidebarNavKey(storedKey);
    if (!isKnown(key) || seen.has(key)) return;
    seen.add(key);
    keys.push(key);
    if (storedIndex < divider) moreStartIndex += 1;
  });
  return { keys, moreStartIndex };
}

/**
 * Reconcile a persisted/partial layout against the current known key set:
 * map retired keys to their replacement, keep known keys in stored order,
 * repair missing default keys into the side of the divider they occupy in the
 * default layout, drop unknown keys, and keep `moreStartIndex` within
 * [0, order.length].
 */
export function reconcileSidebarNavLayout(
  stored: Partial<SidebarNavLayout> | undefined,
): SidebarNavLayout {
  const storedOrder = Array.isArray(stored?.order) ? stored.order : [];
  const rawIndex =
    typeof stored?.moreStartIndex === 'number'
      ? stored.moreStartIndex
      : DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex;
  const { keys: known, moreStartIndex: storedMoreStartIndex } =
    collapseRetiredSidebarNavKeys(storedOrder, rawIndex, (key) =>
      SIDEBAR_NAV_ITEM_KEYS.includes(key),
    );
  const knownMain = known.slice(0, storedMoreStartIndex);
  const knownMore = known.slice(storedMoreStartIndex);
  const seen = new Set(known);
  const missingDefaultMain = DEFAULT_SIDEBAR_NAV_LAYOUT.order
    .slice(0, DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex)
    .filter((key) => !seen.has(key));
  const missingDefaultMore = DEFAULT_SIDEBAR_NAV_LAYOUT.order
    .slice(DEFAULT_SIDEBAR_NAV_LAYOUT.moreStartIndex)
    .filter((key) => !seen.has(key));
  const mainNav = [...knownMain, ...missingDefaultMain];
  const more = [...knownMore, ...missingDefaultMore];
  return { order: [...mainNav, ...more], moreStartIndex: mainNav.length };
}

/**
 * Split a layout into its two regions on the stored divider. Pure structure —
 * which keys a given host actually renders is that host's policy and is
 * applied by the caller after this split (the desktop policy lives in
 * `@canopy/desktop-shared/lib/sidebar-nav-layout`).
 */
export function splitSidebarNavLayout(layout: SidebarNavLayout): {
  mainNav: string[];
  more: string[];
} {
  return {
    mainNav: layout.order.slice(0, layout.moreStartIndex),
    more: layout.order.slice(layout.moreStartIndex),
  };
}

export * from './sidebar-item-groups';

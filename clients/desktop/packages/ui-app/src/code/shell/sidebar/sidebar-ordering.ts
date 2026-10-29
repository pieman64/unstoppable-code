/**
 * Shared row ordering for the left nav (CAN-1074), used by the desktop rail
 * and the web portal so the two order the same rows the same way (CAN-3053).
 *
 * Adds pinning and an opt-in recency sort to drag-and-drop ordering at every
 * level of the sidebar hierarchy: the Projects list itself, the worktree rows inside
 * a code workspace, and the Work Entry rows inside a cowork workspace.
 *
 * The contract, per the ticket's governing decision:
 *
 * - **Pinned rows always sit above unpinned rows.** Pins are section scoped —
 *   nothing leaves its section for a global pinned area.
 * - **The pinned group is always manually ordered**, so drag-and-drop stays
 *   available inside it regardless of the section's sort mode.
 * - **The unpinned tail follows the section's {@link SidebarSortMode}.**
 *   `'manual'` (the default) keeps drag-and-drop ordering for the tail, so
 *   rows stay where the user put them; `'last-updated'` opts the section into
 *   most-recent-first ordering.
 *
 * Manual order is the *incoming array order*, so callers that persist an
 * explicit `order` field (the Projects list) must pre-sort by it before
 * calling in. Worktree and Work Entry rows already arrive in persisted manual
 * order.
 *
 * Pure and host-neutral: rows are typed structurally, so desktop's persisted
 * metadata and a portal-built row both fit without this package importing
 * either host's types.
 */

/**
 * A sidebar section's ordering mode. Structurally identical to desktop's
 * persisted `SidebarSortMode`, which this package may not import.
 */
export type SidebarSortMode = 'last-updated' | 'manual';

/** Default ordering mode for any section that has not opted into recency. */
export const DEFAULT_SIDEBAR_SORT_MODE: SidebarSortMode = 'manual';

/** Narrow a persisted/unknown value to a {@link SidebarSortMode}. */
export function resolveSidebarSortMode(
  mode: SidebarSortMode | undefined,
): SidebarSortMode {
  return mode === 'last-updated' ? 'last-updated' : DEFAULT_SIDEBAR_SORT_MODE;
}

/** Parse an ISO timestamp to epoch ms, or `undefined` when unusable. */
export function toRecencyMs(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export interface OrderSidebarRowsOptions<T> {
  /** Section ordering mode. Missing/unknown resolves to `'manual'`. */
  mode: SidebarSortMode | undefined;
  /** Whether the row is pinned to the top of its section. */
  isPinned: (row: T) => boolean;
  /**
   * Last-activity timestamp in epoch ms. Return `undefined` when the row has
   * no usable activity signal — such rows keep their manual slot rather than
   * sinking to the bottom of the section (see below).
   */
  recencyMs: (row: T) => number | undefined;
}

/**
 * Sort `rows` in place-preserving fashion for a sidebar section.
 *
 * Recency sorting deliberately only reshuffles the rows that actually have a
 * timestamp: rows with unknown recency keep the slot they occupied in the
 * incoming manual order, and the timestamped rows are redistributed into the
 * remaining slots most-recent-first. Ranking unknown rows as "infinitely old"
 * would sink every workspace that has no activity watermark yet (notably
 * cowork workspaces, which carry no workspace-level timestamp at all) to the
 * bottom of the nav, which is worse than leaving them where the user put them.
 */
export function orderSidebarRows<T>(
  rows: readonly T[],
  options: OrderSidebarRowsOptions<T>,
): T[] {
  const pinned: T[] = [];
  const unpinned: T[] = [];
  for (const row of rows) {
    if (options.isPinned(row)) {
      pinned.push(row);
    } else {
      unpinned.push(row);
    }
  }

  // The pinned group is always manually ordered, so drag-and-drop keeps
  // working inside it even while the tail is sorted by recency.
  return [...pinned, ...sortTail(unpinned, options)];
}

function sortTail<T>(rows: T[], options: OrderSidebarRowsOptions<T>): T[] {
  if (resolveSidebarSortMode(options.mode) === 'manual' || rows.length < 2) {
    return rows;
  }

  const timestamped: { row: T; recency: number }[] = [];
  for (const row of rows) {
    const recency = options.recencyMs(row);
    if (recency !== undefined) {
      timestamped.push({ row, recency });
    }
  }
  if (timestamped.length < 2) {
    return rows;
  }

  // Stable descending sort: equal timestamps keep their manual relative order.
  const sorted = timestamped
    .map((entry, index) => ({ ...entry, index }))
    .sort((left, right) =>
      right.recency === left.recency
        ? left.index - right.index
        : right.recency - left.recency,
    );

  let cursor = 0;
  return rows.map((row) =>
    options.recencyMs(row) === undefined ? row : (sorted[cursor++]?.row ?? row),
  );
}

/**
 * Whether a row in this section can be dragged. Drag-and-drop survives inside
 * the pinned group unconditionally, and in the unpinned tail only while the
 * section is in manual mode.
 */
export function canDragSidebarRow(
  mode: SidebarSortMode | undefined,
  pinned: boolean,
): boolean {
  return pinned || resolveSidebarSortMode(mode) === 'manual';
}

/**
 * The minimal shape a Work Entry row needs to be ordered: its pin and its
 * activity timestamps. Desktop's `CoworkWorkEntryMeta` and the portal's
 * grouped Chats rows both satisfy it.
 */
export interface SidebarWorkEntryOrderRow {
  pinned?: boolean;
  /** ISO-8601 latest message across the entry's chats. */
  lastMessageAt?: string;
  /** ISO-8601 durable activity watermark (rename, status, agent activity). */
  lastTouchedAt?: string;
  /** ISO-8601 creation time: the floor for an entry with no activity yet. */
  createdAt?: string;
}

/** Activity watermark for a Work Entry row: its newest usable timestamp. */
export function workEntryRecencyMs(
  entry: SidebarWorkEntryOrderRow,
): number | undefined {
  let latest: number | undefined;
  for (const timestamp of [
    entry.lastMessageAt,
    entry.lastTouchedAt,
    entry.createdAt,
  ]) {
    const recency = toRecencyMs(timestamp);
    if (recency !== undefined && (latest === undefined || recency > latest)) {
      latest = recency;
    }
  }
  return latest;
}

/** Order a section's Work Entry rows by pin state then the section's mode. */
export function orderWorkEntryRows<T extends SidebarWorkEntryOrderRow>(
  entries: readonly T[],
  mode: SidebarSortMode | undefined,
): T[] {
  return orderSidebarRows(entries, {
    mode,
    isPinned: (entry) => entry.pinned === true,
    recencyMs: workEntryRecencyMs,
  });
}

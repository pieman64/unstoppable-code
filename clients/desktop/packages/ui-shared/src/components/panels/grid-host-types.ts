import type { PanelCollapseEdge } from '../../panels/registry-types';
import type { Grid } from '../../panels/grid';
import type { PanelLeafView } from '../../panels/grid-leaf-adapter';

/**
 * The seam between the stateful layout owner (e.g. the desktop panel layout
 * store) and the controlled {@link PanelGridHost} display component.
 *
 * Ownership contract (binding design decision):
 * - The CONTROLLER (store) owns the {@link Grid} instance and performs every
 *   topology mutation: add/remove/move/maximize views, serialization, and
 *   wholesale grid rebuilds on restore (doc 04 F3 pattern).
 * - The HOST never mutates grid topology. It only (a) attaches
 *   {@link PanelGridController.grid}'s element into its own DOM, (b) drives
 *   `grid.layout(width, height)` from a ResizeObserver, (c) portals React
 *   group content into each leaf's element, and (d) emits intent callbacks.
 *
 * The host re-attaches and relayouts whenever the `grid` identity changes
 * (wholesale rebuild) or {@link PanelGridController.revision} changes
 * (in-place topology mutation on the same grid instance). The store must bump
 * `revision` after every mutation it wants the host to observe.
 */
export interface PanelGridController {
  /** The live grid instance. Owned and mutated exclusively by the store. */
  readonly grid: Grid<PanelLeafView>;
  /**
   * Monotonic counter the store bumps after each grid mutation. The host
   * relayouts (same grid) or re-attaches (new grid identity) in response.
   */
  readonly revision: number;
  /**
   * Resolves the stable leaf container element for a group id, or `null`
   * when the group has no live leaf (e.g. mid-rebuild). The host portals the
   * group's React content into this element; keeping the element identity
   * stable across mutations is what keeps group content from remounting.
   */
  getLeafElement(groupId: string): HTMLElement | null;
  /** Only maximal compact subtrees, resolved against the current engine tree. */
  getCollapsedBranches?(): readonly {
    groupIds: readonly string[];
    element: HTMLElement;
    edge: PanelCollapseEdge;
  }[];
}

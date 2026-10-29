/** Imperative search API a diagram panel exposes to the search controller. */
export interface DiagramSearchHandle {
  /**
   * Find matches for `query` in the currently-visible diagram. Applies a
   * "match" outline to all matched nodes, clears any active outline, and returns
   * matched node ids ordered top/left → bottom/right. Empty query clears.
   */
  search: (query: string) => string[];
  /** Center the viewport on `nodeId` and give it the active outline. '' clears the active outline. */
  reveal: (nodeId: string) => void;
  /** Remove all search outlines. */
  clear: () => void;
}

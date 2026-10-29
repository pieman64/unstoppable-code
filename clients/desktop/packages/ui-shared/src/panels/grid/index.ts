/**
 * Canopy panels grid engine, ported from VS Code OSS (commit c4632cac).
 *
 * The primary API is the model-oriented {@link Grid} / {@link SerializableGrid}
 * layer. The lower-level, index-addressed {@link GridView} is exported for
 * advanced use. Serialized shapes ({@link ISerializedGrid}) are engine-level
 * and unversioned; persist them wrapped in the versioned envelope defined in
 * `@canopy/protocol`.
 */

export {
  Direction,
  Grid,
  SerializableGrid,
  Sizing,
  createSerializedGrid,
  getRelativeLocation,
  isGridBranchNode,
  sanitizeGridNodeDescriptor,
  type AutoSizing,
  type DistributeSizing,
  type GridBranchNode,
  type GridBranchNodeDescriptor,
  type GridDescriptor,
  type GridLeafNode,
  type GridLeafNodeDescriptor,
  type GridNode,
  type GridNodeDescriptor,
  type IGridOptions,
  type IGridStyles,
  type ISerializableView,
  type ISerializedBranchNode,
  type ISerializedGrid,
  type ISerializedLeafNode,
  type ISerializedNode,
  type InvisibleSizing,
  type IView,
  type IViewDeserializer,
  type IViewSize,
  type SplitSizing,
} from './grid';

export { LayoutPriority, Orientation, orthogonal } from './grid';

export {
  GridView,
  Sizing as GridViewSizing,
  type Box,
  type GridLocation,
  type IGridViewOptions,
  type IGridViewStyles,
  type ISerializedGridView,
  type IView as IGridViewView,
} from './gridview';

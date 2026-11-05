// The recall block renderer moved to the shared package (CAN-5193) so the
// Cloud renders the same block for cloud sessions.
export {
  LOCAL_MEMORY_RECALL_BUDGET,
  renderLocalMemoryBlock,
  renderLocalMemoryRecall,
  type LocalMemoryRecallInput,
  type RenderedLocalMemoryRecall,
} from '@canopy/memory-consolidation/recall';

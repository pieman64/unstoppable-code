import type { ExecutionEvent } from '@canopy/execution-engine/types/pipeline';

export function getToastType(
  event: ExecutionEvent,
): 'success' | 'error' | 'warning' | null {
  if (event.state.parent_execution_id) {
    return null;
  }
  if (event.type === 'execution.paused') {
    return 'warning';
  }
  if (event.type === 'execution.failed') {
    return 'error';
  }
  if (event.type !== 'execution.completed') {
    return null;
  }
  if (event.state.status === 'success') {
    return 'success';
  }
  if (event.state.status === 'failure') {
    return 'error';
  }
  return null;
}

import { randomUUID } from 'node:crypto';
import type { ScriptActionsContext } from '@canopy/protocol/script-actions';
export interface ScriptActionsRepositoryAdd {
  projectId: string;
  repoIds: string[];
  operationId: string;
}
const addListeners = new Set<(event: ScriptActionsRepositoryAdd) => void>();
const closeListeners = new Set<(context: ScriptActionsContext) => void>();
/** Called only by successful host add services, never by rescan RPCs. */
export function notifyScriptActionsRepositoryAdd(
  projectId: string,
  repoIds: string[],
  operationId: string = randomUUID(),
): string {
  for (const listener of Array.from(addListeners))
    listener({ projectId, repoIds, operationId });
  return operationId;
}
export function onScriptActionsRepositoryAdd(
  listener: (event: ScriptActionsRepositoryAdd) => void,
): () => void {
  addListeners.add(listener);
  return () => {
    addListeners.delete(listener);
  };
}
export function notifyScriptActionsTargetClosed(
  context: ScriptActionsContext,
): void {
  for (const listener of Array.from(closeListeners)) listener(context);
}
export function onScriptActionsTargetClosed(
  listener: (context: ScriptActionsContext) => void,
): () => void {
  closeListeners.add(listener);
  return () => {
    closeListeners.delete(listener);
  };
}

/*
 * The Feed's **Run it as a workflow** asks the plan's chat to open its own
 * workflow picker, where the person chooses and starts the workflow exactly
 * as the chat's answer does. The chat may mount only after the Feed opens it,
 * so a request waits here for that chat's composer to take it, and expires if
 * none does (the plan was answered meanwhile).
 */

export interface PlanWorkflowRequestTarget {
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
}

/** Long enough for the chat to open and load; a later mount ignores it. */
export const PLAN_WORKFLOW_REQUEST_TTL_MS = 10_000;

const requestedAt = new Map<string, number>();
const listeners = new Set<() => void>();

function keyOf(target: PlanWorkflowRequestTarget): string {
  return `${target.projectId}/${target.worktreeId}/${target.chatId}`;
}

export function requestPlanWorkflow(
  target: PlanWorkflowRequestTarget,
  now: number = Date.now(),
): void {
  requestedAt.set(keyOf(target), now);
  for (const listener of Array.from(listeners)) listener();
}

/** True once, for a fresh request naming this chat. */
export function takePlanWorkflowRequest(
  target: PlanWorkflowRequestTarget,
  now: number = Date.now(),
): boolean {
  const key = keyOf(target);
  const at = requestedAt.get(key);
  if (at === undefined) return false;
  requestedAt.delete(key);
  return now - at <= PLAN_WORKFLOW_REQUEST_TTL_MS;
}

/** Withdraws a request whose chat could not be opened. */
export function cancelPlanWorkflowRequest(
  target: PlanWorkflowRequestTarget,
): void {
  requestedAt.delete(keyOf(target));
}

export function subscribePlanWorkflowRequests(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

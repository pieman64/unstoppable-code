interface PendingPlanExit {
  resolve: (approved: boolean) => void;
  reject: (reason: Error) => void;
  sessionKey: string;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingPlanExit>();

export function approvePlanExit(requestId: string): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(true);
}

export function denyPlanExit(requestId: string): void {
  const entry = pending.get(requestId);
  if (!entry) return;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  entry.resolve(false);
}

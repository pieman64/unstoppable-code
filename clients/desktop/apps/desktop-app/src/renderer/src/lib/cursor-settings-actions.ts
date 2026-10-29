import type { AppAdvisorAction } from '@canopy/desktop-shared/types';

type CursorSettingsAction = Extract<
  AppAdvisorAction,
  { type: 'cursor.connection' | 'cursor.approval_check' }
>;
type Handler = (operation: string) => boolean;
const handlers = new Map<CursorSettingsAction['type'], Handler>();

// Use the mounted panel's handlers so setup/diagnostic work retains the same
// window ownership, progress display, and unmount cancellation as button clicks.
export function registerCursorSettingsAction(
  type: CursorSettingsAction['type'],
  handler: Handler,
): () => void {
  handlers.set(type, handler);
  return () => {
    if (handlers.get(type) === handler) handlers.delete(type);
  };
}

export async function dispatchCursorSettingsAction(
  action: CursorSettingsAction,
): Promise<boolean> {
  // Opening Settings mounts the panel asynchronously. Bound the wait; a hidden
  // or unsupported panel never falls back to bypassing its lifecycle via IPC.
  for (let attempt = 0; attempt < 50; attempt++) {
    const handler = handlers.get(action.type);
    if (handler) return handler(action.operation);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 20));
  }
  return false;
}

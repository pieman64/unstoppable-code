import type { ClaudeTerminalRuntimeState } from '@canopy/desktop-shared/types';

/** Whether launching this chat's terminal reuses it instead of spawning one. */
export function isLiveClaudeTerminal(
  state: ClaudeTerminalRuntimeState | undefined,
): state is ClaudeTerminalRuntimeState & { terminalId: string } {
  return (
    state !== undefined &&
    Boolean(state.terminalId) &&
    (state.turnState === 'idle' || state.turnState === 'running')
  );
}

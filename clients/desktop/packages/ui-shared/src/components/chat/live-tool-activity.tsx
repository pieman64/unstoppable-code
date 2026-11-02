import type { JSX, ReactNode } from 'react';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
import { getToolDisplayInfo, type ToolDisplayScope } from './tool-display';
import type { ToolApprovalWait } from './tool-approval-wait';

/**
 * What a running turn's closed step line says it does now. `waiting` marks a
 * call held for approval: the line says so without shimmering.
 */
export interface ChatToolStepLive {
  readonly label: ReactNode;
  readonly icon: ReactNode;
  readonly waiting?: boolean;
}

/**
 * The live line for a call without a result, shared by every host so rows
 * and lines agree on what waits. Paths, commands and task text stay out of
 * session replay.
 */
export function liveToolCallActivity(
  call: {
    readonly toolUseId?: string;
    readonly toolName: string;
    readonly input: string;
  },
  approvalWait: ToolApprovalWait,
  scope?: ToolDisplayScope,
): ChatToolStepLive {
  const info = getToolDisplayInfo(call.toolName, call.input, scope);
  const label: JSX.Element = (
    <span className={REPLAY_BLOCK_CLASS}>{info.label}</span>
  );
  return approvalWait.isCallWaiting(call)
    ? { label, icon: info.icon, waiting: true }
    : { label, icon: info.icon };
}

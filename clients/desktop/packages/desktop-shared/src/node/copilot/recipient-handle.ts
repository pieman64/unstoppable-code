import type { CopilotClient } from '@github/copilot-sdk';
import type { CopilotAccount } from '../../types/copilot-connection';
import type { CopilotModelEntry } from '../../types/copilot-models';
import type { CopilotTurnRequest, CopilotTurnResult } from './turn-driver';

export type CopilotQuotaResult = Awaited<
  ReturnType<CopilotClient['rpc']['account']['getQuota']>
>;

/**
 * What a consumer holds for one admitted Copilot recipient: results, an
 * opaque conversation id and the lifecycle. The SDK client, leases, tokens
 * and token callbacks stay inside the recipient (CAN-4505 D-A).
 */
export interface CopilotRecipientHandle {
  readonly account: CopilotAccount | null;
  /** The account generation this recipient was admitted under. */
  readonly generation: number;
  /** Runs one turn and then closes the recipient. */
  runTurn(request: CopilotTurnRequest): Promise<CopilotTurnResult>;
  /** The account's policy-filtered catalog, admitted before it is returned. */
  listModels(signal: AbortSignal): Promise<CopilotModelEntry[]>;
  getQuota(signal: AbortSignal): Promise<CopilotQuotaResult>;
  close(): Promise<void>;
}

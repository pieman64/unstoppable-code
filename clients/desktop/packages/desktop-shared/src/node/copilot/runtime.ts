import { startCopilotRuntime as startRuntime } from '@canopy/copilot-recipient/runtime';
import type {
  CopilotRuntimeOptions,
  OwnedCopilotRuntime,
} from '@canopy/copilot-recipient/runtime';
import { copilotReceiptStorage } from './receipt-storage';

export * from '@canopy/copilot-recipient/runtime';

/** Compatibility composition retains the existing host-owned receipt writer. */
export function startCopilotRuntime(
  options: CopilotRuntimeOptions,
): Promise<OwnedCopilotRuntime> {
  return startRuntime({
    ...options,
    receiptStorage: options.receiptStorage ?? copilotReceiptStorage,
  });
}

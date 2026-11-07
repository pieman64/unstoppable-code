import {
  CopilotProcessReceipt as ProcessReceipt,
  reapCopilotProcessReceipts as reapReceipts,
} from '@canopy/copilot-recipient/process-receipts';
import { copilotReceiptStorage } from './receipt-storage';

export class CopilotProcessReceipt extends ProcessReceipt {
  constructor(directory: string) {
    super(directory, copilotReceiptStorage);
  }
}

export function reapCopilotProcessReceipts(directory: string): Promise<void> {
  return reapReceipts(directory, copilotReceiptStorage);
}

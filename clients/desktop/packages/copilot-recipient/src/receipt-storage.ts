/** Host-owned durable storage; receipts never select a canonical writer. */
export interface CopilotReceiptStorage {
  /** Atomically replace a private receipt (0600) and durably sync it. */
  write(path: string, contents: string): Promise<void>;
  syncDirectory(directory: string): Promise<void>;
}

import type { OpenCodeModelEntry } from './opencode-models';

export const OPENCODE_CONNECTION_TIMEOUT_MS = 10 * 60_000;

export interface OpenCodeConnectionStatus {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  version: string;
  phase:
    | 'idle'
    | 'downloading'
    | 'verifying'
    | 'installing'
    | 'discovering'
    | 'connected';
  percent?: number;
  archiveBytes?: number;
}

export interface OpenCodeConnectionApi {
  status(): Promise<OpenCodeConnectionStatus>;
  connect(operationId?: string): Promise<OpenCodeConnectionStatus>;
  cancel(operationId?: string): Promise<void>;
  disconnect(): Promise<void>;
  listModels(): Promise<OpenCodeModelEntry[]>;
  onProgress(callback: (status: OpenCodeConnectionStatus) => void): () => void;
}

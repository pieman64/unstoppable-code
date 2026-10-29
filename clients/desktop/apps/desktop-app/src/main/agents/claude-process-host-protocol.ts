export interface ClaudeProcessHostSpawnRequest {
  type: 'spawn';
  requestId: string;
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string | undefined>;
  captureStderr?: boolean;
}

export interface ClaudeProcessHostStdinRequest {
  type: 'stdin';
  requestId: string;
  dataBase64: string;
}

export interface ClaudeProcessHostStdinEndRequest {
  type: 'stdin-end';
  requestId: string;
}

export interface ClaudeProcessHostKillRequest {
  type: 'kill';
  requestId: string;
  signal: NodeJS.Signals;
}

export interface ClaudeProcessHostStdoutAckRequest {
  type: 'stdout-ack';
  requestId: string;
  bytes: number;
}

export interface ClaudeProcessHostShutdownRequest {
  type: 'shutdown';
}

export type ClaudeProcessHostRequest =
  | ClaudeProcessHostSpawnRequest
  | ClaudeProcessHostStdinRequest
  | ClaudeProcessHostStdinEndRequest
  | ClaudeProcessHostKillRequest
  | ClaudeProcessHostStdoutAckRequest
  | ClaudeProcessHostShutdownRequest;

export const CLAUDE_PROCESS_HOST_STDOUT_WINDOW_BYTES = 64 * 1024;

/**
 * What may arrive on a hosted Claude process's stdout while an event
 * admission is pending, when the session bounds in-flight bytes instead of
 * withholding credit per admission (group commit): four forwarding windows.
 * Past it, credit is withheld until the pending admissions settle.
 */
export const CLAUDE_STDOUT_IN_FLIGHT_LIMIT_BYTES =
  4 * CLAUDE_PROCESS_HOST_STDOUT_WINDOW_BYTES;

export type ClaudeProcessHostResponse =
  | { type: 'started'; requestId: string; pid: number }
  | { type: 'stdout'; requestId: string; dataBase64: string }
  | { type: 'stderr'; requestId: string; dataBase64: string }
  | {
      type: 'exit';
      requestId: string;
      code: number | null;
      signal: NodeJS.Signals | null;
    }
  | { type: 'error'; requestId: string; message: string }
  | { type: 'shutdown-complete' };

export type AcpErrorCode =
  | 'closed'
  | 'timeout'
  | 'cancelled'
  | 'unsupported'
  | 'busy'
  | 'invalid-session'
  | 'invalid-input'
  | 'stale-generation'
  | 'protocol'
  | 'provider';

/**
 * Deliberately excludes raw provider errors, prompts, and credential-bearing
 * data. A `provider` failure keeps the agent's bounded, redacted explanation
 * in `providerDetails`, separately from the authored display message.
 */
export class AcpClientError extends Error {
  /** JSON-RPC method that failed, when the failure came from a request. */
  readonly method?: string;
  /** Numeric JSON-RPC error code reported by the agent, when one was given. */
  readonly rpcCode?: number;
  /** Bounded, redacted agent text for Copy details, never a display headline. */
  readonly providerDetails?: string;

  constructor(
    readonly code: AcpErrorCode,
    message: string,
    details: {
      method?: string;
      rpcCode?: number;
      providerDetails?: string;
    } = {},
  ) {
    super(message);
    this.name = 'AcpClientError';
    if (details.method !== undefined) this.method = details.method;
    if (details.rpcCode !== undefined) this.rpcCode = details.rpcCode;
    if (details.providerDetails !== undefined)
      this.providerDetails = details.providerDetails;
  }
}

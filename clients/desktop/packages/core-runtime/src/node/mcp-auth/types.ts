/** `mcpc1_` + 22 base64url characters (16 random bytes). */
export const MCP_CREDENTIAL_ID_PATTERN = /^mcpc1_[A-Za-z0-9_-]{22}$/;
export const MCP_AUTHORIZATION_PURPOSES = ['mcp.upstream.forward'] as const;
export type McpAuthorizationPurpose =
  (typeof MCP_AUTHORIZATION_PURPOSES)[number];
/** How long an authorization handle may wait before delivery. */
export const MCP_AUTHORIZATION_TTL_MS = 60_000;
export const MCP_CREDENTIAL_BINDINGS_MAX = 8_192;

/** An opaque per-route capability the owner minted. Holds no secret and names no server. */
export interface McpCredentialRef {
  readonly credentialId: string;
}

export interface McpAuthorizationRequest {
  readonly credential: McpCredentialRef;
  readonly purpose: McpAuthorizationPurpose;
  /** The route's upstream URL; a rejection is bound to it. */
  readonly upstreamUrl: string;
  readonly signal?: AbortSignal;
}

/**
 * One-shot presentation of one credential to one upstream request (CAN-4126).
 * It never exposes the token: it can only write the header once, or report
 * that the upstream rejected what it wrote.
 */
export interface McpUpstreamAuthorization {
  /**
   * Writes `Authorization: Bearer <token>` into `headers` and returns
   * 'applied', once. Returns 'stale' and leaves `headers` untouched when the
   * credential was released, its scope was revoked, the handle is older than
   * MCP_AUTHORIZATION_TTL_MS, or it was already applied. Never throws.
   */
  apply(headers: Record<string, string>): 'applied' | 'stale';
  /**
   * The upstream answered 401 to the applied token. Asks the owner to
   * invalidate exactly that token and resolves after it did. Does nothing
   * unless apply returned 'applied'; runs at most once. Never rejects.
   */
  rejected(): Promise<void>;
}

export type McpAuthorizationOutcome =
  | { readonly status: 'none' }
  | {
      readonly status: 'authorized';
      readonly authorization: McpUpstreamAuthorization;
    };

/** What a worker-side connection may ask for. */
export interface McpUpstreamAuthorizer {
  /** Throws McpAuthorizationUnavailableError when the owner cannot decide now. */
  authorize(request: McpAuthorizationRequest): Promise<McpAuthorizationOutcome>;
}

/** The port a worker-side connection service receives: authorize and give back, never bind. */
export interface McpConnectionCredentials extends McpUpstreamAuthorizer {
  /** Idempotent. Outstanding handles of the credential go stale. */
  release(credential: McpCredentialRef): void;
}

/** The credential owner's side; Electron main implements it until V6 composes the vault. */
export interface McpCredentialOwner<TSubject> {
  /** Revocation scope; subjects with equal scopes share one epoch. */
  scopeOf(subject: TSubject): string;
  /** A usable access token, refreshing first when needed; null when none is usable. Throws on a transient failure. */
  resolve(
    subject: TSubject,
    signal: AbortSignal | undefined,
  ): Promise<string | null>;
  /** Marks exactly this token rejected for this upstream. Must not throw; it reports its own failures. */
  invalidate(
    subject: TSubject,
    token: string,
    upstreamUrl: string,
  ): Promise<void>;
}

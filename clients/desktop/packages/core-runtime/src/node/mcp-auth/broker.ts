import { randomBytes } from 'node:crypto';
import {
  McpAuthorizationUnavailableError,
  McpCredentialCapacityError,
} from './errors';
import {
  MCP_AUTHORIZATION_PURPOSES,
  MCP_AUTHORIZATION_TTL_MS,
  MCP_CREDENTIAL_BINDINGS_MAX,
  MCP_CREDENTIAL_ID_PATTERN,
  type McpAuthorizationOutcome,
  type McpAuthorizationRequest,
  type McpConnectionCredentials,
  type McpCredentialOwner,
  type McpCredentialRef,
  type McpUpstreamAuthorization,
} from './types';

interface Binding<TSubject> {
  readonly subject: TSubject;
  readonly scope: string;
}

const NONE: McpAuthorizationOutcome = Object.freeze({ status: 'none' });
const PURPOSES: readonly string[] = MCP_AUTHORIZATION_PURPOSES;

function mintCredentialId(): string {
  return `mcpc1_${randomBytes(16).toString('base64url')}`;
}

export class McpCredentialBroker<TSubject> implements McpConnectionCredentials {
  private readonly bindings = new Map<string, Binding<TSubject>>();
  private readonly epochs = new Map<string, number>();
  private closed = false;
  private readonly owner: McpCredentialOwner<TSubject>;
  private readonly ttlMs: number;
  private readonly maxBindings: number;
  private readonly now: () => number;
  private readonly newCredentialId: () => string;
  constructor(options: {
    owner: McpCredentialOwner<TSubject>;
    /** Default MCP_AUTHORIZATION_TTL_MS. */
    ttlMs?: number;
    /** Default MCP_CREDENTIAL_BINDINGS_MAX. */
    maxBindings?: number;
    /** Monotonic milliseconds; default performance.now. */
    now?: () => number;
    /** Default: 'mcpc1_' + randomBytes(16).toString('base64url'). */
    newCredentialId?: () => string;
  }) {
    this.owner = options.owner;
    this.ttlMs = options.ttlMs ?? MCP_AUTHORIZATION_TTL_MS;
    this.maxBindings = options.maxBindings ?? MCP_CREDENTIAL_BINDINGS_MAX;
    this.now = options.now ?? ((): number => performance.now());
    this.newCredentialId = options.newCredentialId ?? mintCredentialId;
  }
  /** Owner side only. Throws McpCredentialCapacityError at the cap and Error('MCP credential broker closed.') after close. */
  bind(subject: TSubject): McpCredentialRef {
    if (this.closed) throw new Error('MCP credential broker closed.');
    if (this.bindings.size >= this.maxBindings)
      throw new McpCredentialCapacityError();
    let credentialId: string | undefined;
    for (let draw = 0; draw < 3 && credentialId === undefined; draw += 1) {
      const candidate = this.newCredentialId();
      if (!this.bindings.has(candidate)) credentialId = candidate;
    }
    if (credentialId === undefined)
      throw new Error('Could not mint an MCP credential id.');
    this.bindings.set(credentialId, {
      subject,
      scope: this.owner.scopeOf(subject),
    });
    return Object.freeze({ credentialId });
  }
  release(credential: McpCredentialRef): void {
    const credentialId: unknown = credential?.credentialId;
    if (typeof credentialId === 'string') this.bindings.delete(credentialId);
  }
  /** Owner side only: a revocation committed for this scope. */
  revokeScope(scope: string): void {
    this.epochs.set(scope, this.epoch(scope) + 1);
  }
  async authorize(
    request: McpAuthorizationRequest,
  ): Promise<McpAuthorizationOutcome> {
    const credentialId: unknown = request.credential?.credentialId;
    if (
      this.closed ||
      typeof credentialId !== 'string' ||
      !MCP_CREDENTIAL_ID_PATTERN.test(credentialId) ||
      !PURPOSES.includes(request.purpose)
    )
      return NONE;
    const binding = this.bindings.get(credentialId);
    if (!binding) return NONE;
    const { subject, scope } = binding;
    let epoch = this.epoch(scope);
    let token: string | null = null;
    for (let read = 1; ; read += 1) {
      epoch = this.epoch(scope);
      try {
        token = await this.owner.resolve(subject, request.signal);
      } catch {
        throw new McpAuthorizationUnavailableError();
      }
      if (this.bindings.get(credentialId) !== binding) return NONE;
      if (this.epoch(scope) === epoch) break;
      if (read === 2) return NONE;
    }
    if (!token) return NONE;
    const upstreamUrl = request.upstreamUrl;
    const issuedAt = this.now();
    let state: 'issued' | 'applied' | 'done' = 'issued';
    let held: string | null = token;
    const apply = (headers: Record<string, string>): 'applied' | 'stale' => {
      if (state !== 'issued') return 'stale';
      if (
        this.bindings.get(credentialId) !== binding ||
        this.epoch(scope) !== epoch ||
        this.now() - issuedAt > this.ttlMs
      ) {
        state = 'done';
        held = null;
        return 'stale';
      }
      headers.Authorization = `Bearer ${held}`;
      state = 'applied';
      return 'applied';
    };
    const rejected = async (): Promise<void> => {
      if (state !== 'applied' || held === null) return;
      const presented = held;
      held = null;
      state = 'done';
      try {
        await this.owner.invalidate(subject, presented, upstreamUrl);
      } catch {
        // The owner reports its own failures.
      }
    };
    const authorization: McpUpstreamAuthorization = Object.freeze({
      apply,
      rejected,
    });
    return Object.freeze({ status: 'authorized', authorization });
  }
  /** Releases every binding; later authorizations are 'none' and bind throws. */
  close(): void {
    this.closed = true;
    this.bindings.clear();
  }
  /** Live bindings. */
  get size(): number {
    return this.bindings.size;
  }
  private epoch(scope: string): number {
    return this.epochs.get(scope) ?? 0;
  }
}

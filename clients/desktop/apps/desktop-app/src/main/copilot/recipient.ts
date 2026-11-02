import { randomUUID } from 'node:crypto';
import type {
  GitHubTokenProvider,
  GitHubTokenProviderResult,
} from '@github/copilot-sdk';
import type { CopilotRuntimeAuth } from '@canopy/desktop-shared/node/copilot/runtime-auth';
import type { CopilotRecipientIdentity } from '@canopy/desktop-shared/node/copilot/runtime';
import {
  CopilotSignInChangedError,
  REFRESH_THRESHOLD_MS,
  untilAborted,
} from './credential-broker';
import type { CopilotAccountEpoch } from './grant-authority';

export type CopilotLeasePurpose =
  | 'session'
  | 'models'
  | 'quota'
  | 'thinking-levels'
  | 'setup-probe';

export interface CopilotRecipientLease extends CopilotRuntimeAuth {
  readonly accountEpoch: Readonly<CopilotAccountEpoch>;
  readonly generation: number;
  readonly recipient: Readonly<CopilotRecipientIdentity>;
  readonly purpose: CopilotLeasePurpose;
  readonly audience: string | undefined;
  /** Host-monotonic deadline; reduced to the delivered token's expiry. */
  readonly expiry: number;
}

interface RecipientOptions {
  accountEpoch: CopilotAccountEpoch;
  generation: number;
  recipient: CopilotRecipientIdentity;
  signal: AbortSignal;
  binding(): Promise<CopilotAccountEpoch>;
  access(
    signal: AbortSignal,
    admit?: () => Promise<void>,
  ): Promise<{ accessToken: string; expiresAt: number }>;
  assertGeneration(generation: number): void;
  isClosed(): boolean;
  now?: () => number;
}

interface Admission {
  audience: string | undefined;
  deadline: number;
  used: boolean;
}

function purposeOf(purpose: string): CopilotLeasePurpose {
  switch (purpose) {
    case 'session':
    case 'models':
    case 'quota':
    case 'thinking-levels':
    case 'setup-probe':
      return purpose;
    default:
      throw new Error('Copilot lease purpose is not admitted.');
  }
}

function origin(host: string): string | undefined {
  try {
    const url = new URL(host.includes('://') ? host : `https://${host}`);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** In-process recipient enforcement, not confidentiality against Electron main. */
export class CopilotRecipient {
  private readonly leases = new WeakMap<CopilotRecipientLease, Admission>();
  private readonly now: () => number;
  private readonly epoch: Readonly<CopilotAccountEpoch>;
  private readonly identity: Readonly<CopilotRecipientIdentity>;
  private revoked = false;
  private readonly abort = new AbortController();

  constructor(private readonly options: RecipientOptions) {
    if (
      !options.recipient.runtimeId ||
      !Number.isSafeInteger(options.recipient.pid) ||
      options.recipient.pid <= 0 ||
      !Number.isFinite(options.recipient.started)
    )
      throw new Error('Copilot process identity is missing.');
    this.now = options.now ?? ((): number => performance.now());
    this.epoch = Object.freeze({ ...options.accountEpoch });
    this.identity = Object.freeze({ ...options.recipient });
  }

  revoke(): void {
    this.revoked = true;
    this.abort.abort(new Error('Copilot connection was revoked.'));
  }

  revokeLease(lease: CopilotRecipientLease): void {
    this.leases.delete(lease);
  }

  issue(purpose: string, audience?: string): CopilotRecipientLease {
    const admittedPurpose = purposeOf(purpose);
    this.assertLive();
    if (audience !== undefined && !audience.trim())
      throw new Error('Copilot session audience is missing.');
    const state: Admission = {
      audience: admittedPurpose === 'session' ? audience : randomUUID(),
      // The first delivery narrows this ceiling, never extends it.
      deadline: this.now() + 8 * 60 * 60_000,
      used: false,
    };
    const lease: CopilotRecipientLease = Object.freeze({
      accountEpoch: this.epoch,
      generation: this.options.generation,
      recipient: this.identity,
      purpose: admittedPurpose,
      get audience(): string | undefined {
        return state.audience;
      },
      get expiry(): number {
        return state.deadline;
      },
      token: async (signal: AbortSignal): Promise<string> => {
        const grant = await this.deliver(lease, signal);
        signal.throwIfAborted();
        this.assertAdmitted(lease, admittedPurpose);
        return grant.accessToken;
      },
      tokenProvider: async ({
        host,
        sessionId,
      }: Parameters<GitHubTokenProvider>[0]): Promise<GitHubTokenProviderResult> => {
        if (
          admittedPurpose !== 'session' ||
          !sessionId?.trim() ||
          !origin(host) ||
          origin(host) !== origin(this.epoch.host)
        )
          throw new Error('Copilot token request is not admitted.');
        if (state.audience !== undefined && state.audience !== sessionId)
          throw new Error('Copilot session audience changed.');
        state.audience ??= sessionId;
        const signal = AbortSignal.timeout(30_000);
        const grant = await this.deliver(lease, signal);
        signal.throwIfAborted();
        const remaining = grant.expiresAt - Date.now();
        if (remaining <= REFRESH_THRESHOLD_MS)
          throw new Error(
            "Couldn't refresh the Copilot sign-in. Check your connection and try again.",
          );
        this.assertAdmitted(lease, 'session', sessionId);
        return {
          kind: 'token',
          accessToken: grant.accessToken,
          expiresIn: Math.floor(remaining / 1000),
        };
      },
    });
    this.leases.set(lease, state);
    return lease;
  }

  private assertLive(): void {
    if (this.revoked || this.options.signal.aborted || this.options.isClosed())
      throw new Error('Copilot connection was revoked.');
    this.options.assertGeneration(this.options.generation);
  }

  private assertAdmitted(
    lease: CopilotRecipientLease,
    purpose: string,
    audience?: string,
  ): void {
    const state = this.leases.get(lease);
    this.assertLive();
    if (
      !state ||
      lease.purpose !== purposeOf(purpose) ||
      (audience !== undefined && state.audience !== audience) ||
      this.now() >= state.deadline
    )
      throw new Error('Copilot lease is not admitted.');
  }

  async admit(
    lease: CopilotRecipientLease,
    purpose: string,
    audience?: string,
    requestSignal: AbortSignal = this.options.signal,
  ): Promise<void> {
    this.assertAdmitted(lease, purpose, audience);
    const signal = AbortSignal.any([
      requestSignal,
      this.options.signal,
      this.abort.signal,
    ]);
    signal.throwIfAborted();
    let binding: CopilotAccountEpoch;
    try {
      binding = await untilAborted(this.options.binding(), signal);
    } catch (error) {
      this.assertLive();
      signal.throwIfAborted();
      if (error instanceof CopilotSignInChangedError)
        throw new Error('Copilot connection was revoked.');
      throw error;
    }
    signal.throwIfAborted();
    this.assertAdmitted(lease, purpose, audience);
    if (
      binding.host !== this.epoch.host ||
      binding.id !== this.epoch.id ||
      binding.entryId !== this.epoch.entryId
    )
      throw new Error('Copilot connection was revoked.');
  }

  private async deliver(
    lease: CopilotRecipientLease,
    signal: AbortSignal,
  ): Promise<{ accessToken: string; expiresAt: number }> {
    this.assertAdmitted(lease, lease.purpose);
    signal = AbortSignal.any([signal, this.options.signal, this.abort.signal]);
    signal.throwIfAborted();
    await this.admit(lease, lease.purpose, undefined, signal);
    signal.throwIfAborted();
    const state = this.leases.get(lease);
    if (!state || (lease.purpose !== 'session' && state.used))
      throw new Error('Copilot operation token was already delivered.');
    state.used = true;
    this.assertAdmitted(lease, lease.purpose);
    let grant: { accessToken: string; expiresAt: number };
    try {
      grant = await this.options.access(signal, () =>
        this.admit(lease, lease.purpose, undefined, signal),
      );
    } catch (error) {
      this.assertLive();
      throw error;
    }
    if (!Number.isFinite(grant.expiresAt))
      throw new Error('Copilot token expiry is invalid.');
    // A wall-clock change cannot extend a lease that was already admitted.
    state.deadline = Math.min(
      state.deadline,
      this.now() + grant.expiresAt - Date.now(),
    );
    this.assertAdmitted(lease, lease.purpose);
    signal.throwIfAborted();
    await this.admit(lease, lease.purpose, undefined, signal);
    signal.throwIfAborted();
    this.assertAdmitted(lease, lease.purpose);
    return grant;
  }
}

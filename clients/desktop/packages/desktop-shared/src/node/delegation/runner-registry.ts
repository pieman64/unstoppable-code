import type { AgentDelegationResult } from '@canopy/protocol/delegation';
import type { AgentRunnerAdapter, ResolvedAgentRouteSnapshot } from './types';

export interface AgentRunnerRegistration {
  readonly apiVersion: 1;
  readonly registrationId: string;
  readonly adapter: AgentRunnerAdapter;
}

export interface AgentRunnerLease {
  readonly adapter: AgentRunnerAdapter;
  release(): void;
}

interface RegistryEntry {
  readonly registration: AgentRunnerRegistration;
  enabled: boolean;
  leases: number;
}

/** Registration is host configuration; no provider-priority fallback exists. */
export class AgentRunnerRegistry {
  private readonly entries = new Map<string, RegistryEntry>();

  register(registration: AgentRunnerRegistration): void {
    if (registration.apiVersion !== 1 || !registration.registrationId.trim())
      throw new Error('Unsupported delegation runner registration');
    if (this.entries.has(registration.registrationId))
      throw new Error('Delegation runner registration is already retained');
    for (const entry of Array.from(this.entries.values())) {
      if (
        entry.enabled &&
        entry.registration.adapter.harnessId ===
          registration.adapter.harnessId &&
        entry.registration.adapter.runtimeKind ===
          registration.adapter.runtimeKind
      )
        throw new Error('Ambiguous delegation runner mode');
    }
    this.entries.set(registration.registrationId, {
      registration: Object.freeze({ ...registration }),
      enabled: true,
      leases: 0,
    });
  }

  unregister(registrationId: string): void {
    const entry = this.entries.get(registrationId);
    if (!entry) return;
    entry.enabled = false;
    if (entry.leases === 0) this.entries.delete(registrationId);
  }

  acquire(
    route: ResolvedAgentRouteSnapshot,
  ): AgentDelegationResult<AgentRunnerLease> {
    const entry = this.entries.get(route.runnerRegistrationId);
    const adapter = entry?.registration.adapter;
    if (
      !entry?.enabled ||
      !adapter ||
      adapter.harnessId !== route.harnessId ||
      adapter.runtimeKind !== route.runtimeKind ||
      adapter.adapterVersion !== route.adapterVersion
    )
      return {
        ok: false,
        error: {
          code: 'route_unavailable',
          message: 'The selected delegation runner is unavailable.',
          retryable: false,
        },
      };
    entry.leases += 1;
    let released = false;
    return {
      ok: true,
      value: {
        adapter,
        release: (): void => {
          if (released) return;
          released = true;
          entry.leases -= 1;
          if (!entry.enabled && entry.leases === 0)
            this.entries.delete(entry.registration.registrationId);
        },
      },
    };
  }
}

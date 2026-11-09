import { isGuestAccount } from '@canopy/desktop-shared/lib/guest-account';
import type { CanopyCloudAccountEntry } from '../lib/canopy-cloud-account-store';

/** Process-local fences. Neither these tokens nor credentials cross IPC. */
export interface CanopyCloudSessionProbe {
  readonly generation: number;
  readonly sequence: number;
}

type Credential = Pick<
  CanopyCloudAccountEntry,
  'apiKey' | 'authMode' | 'credentialSource' | 'serverApiKeyId'
> & { accountId?: string };

let generation = 0;
let sequence = 0;
let lastResult = 0;
let rejected: Credential | null = null;
const listeners = new Set<() => void>();

function matches(entry: CanopyCloudAccountEntry | null): boolean {
  return (
    rejected !== null &&
    entry !== null &&
    entry.apiKey.trim().length > 0 &&
    !isGuestAccount(entry) &&
    rejected.apiKey === entry.apiKey &&
    rejected.authMode === entry.authMode &&
    rejected.credentialSource === entry.credentialSource &&
    rejected.serverApiKeyId === entry.serverApiKeyId &&
    rejected.accountId === entry.account?.id
  );
}

function notify(): void {
  listeners.forEach((listener): void => {
    try {
      listener();
    } catch {
      // A window/subscriber failure must not fail a credential write.
    }
  });
}

export function beginCanopyCloudSessionProbe(): CanopyCloudSessionProbe {
  return { generation, sequence: ++sequence };
}

export function isCurrentCanopyCloudSessionProbe(
  probe: CanopyCloudSessionProbe,
): boolean {
  return probe.generation === generation && probe.sequence > lastResult;
}

export function isCanopyCloudSessionProbeSuperseded(
  probe: CanopyCloudSessionProbe,
): boolean {
  return probe.generation !== generation || probe.sequence < lastResult;
}

/** Called only inside the account store's matched, serialized boundary. */
export function recordCanopyCloudSessionProbe(
  probe: CanopyCloudSessionProbe,
  entry: CanopyCloudAccountEntry,
  outcome: 'accepted' | 'rejected',
): void {
  if (
    !isCurrentCanopyCloudSessionProbe(probe) ||
    !entry.apiKey.trim() ||
    isGuestAccount(entry)
  )
    return;
  lastResult = probe.sequence;
  const wasExpired = matches(entry);
  if (outcome === 'rejected') {
    rejected = {
      apiKey: entry.apiKey,
      authMode: entry.authMode,
      credentialSource: entry.credentialSource,
      serverApiKeyId: entry.serverApiKeyId,
      accountId: entry.account?.id,
    };
  } else if (wasExpired) {
    rejected = null;
  }
  if (wasExpired !== matches(entry)) notify();
}

/** After readable credential state changes, including same-key replacement. */
export function resetCanopyCloudSessionCredential(): void {
  generation++;
  const changed = rejected !== null;
  rejected = null;
  if (changed) notify();
}

export function isCanopyCloudSessionExpired(
  entry: CanopyCloudAccountEntry | null,
): boolean {
  return matches(entry);
}

export function subscribeCanopyCloudSessionStatus(
  listener: () => void,
): () => void {
  listeners.add(listener);
  return (): void => {
    listeners.delete(listener);
  };
}

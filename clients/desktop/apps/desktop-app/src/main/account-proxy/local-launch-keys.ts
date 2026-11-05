// The keys of one proxy process on this device (CAN-4406). Each launch gets
// a new client key and management key; nothing stores them, and they stop
// working when that process exits. Callers hold opaque handles. Only the
// management client and the two client-key senders reveal a value, and only
// while its launch is open, so a key is never sent to a later process that
// would count it as a wrong key. See
// docs/planning/2026-11-02-can-4406-account-proxy-key-handoff/README.md.

import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** A key of one launch. It carries no secret; reveal it to send it. */
export interface LocalAccountProxyKey {
  readonly kind: 'management' | 'client';
  readonly epoch: string;
  /** Names the key in logs and broker callbacks without revealing it. */
  readonly fingerprint: string;
}

export interface LocalAccountProxyLaunchKeys {
  readonly epoch: string;
  readonly management: LocalAccountProxyKey;
  readonly client: LocalAccountProxyKey;
}

/** What the runtime writes into the proxy's config for a new launch. */
export interface MintedLocalAccountProxyKeys {
  readonly keys: LocalAccountProxyLaunchKeys;
  readonly managementKey: string;
  readonly clientKey: string;
}

const secrets = new WeakMap<LocalAccountProxyKey, string>();
const openEpochs = new Set<string>();

function fingerprintOf(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function keyOf(
  kind: LocalAccountProxyKey['kind'],
  epoch: string,
  value: string,
): LocalAccountProxyKey {
  const key = Object.freeze({ kind, epoch, fingerprint: fingerprintOf(value) });
  secrets.set(key, value);
  return key;
}

/**
 * New keys for a launch, open until {@link closeLocalAccountProxyLaunchKeys}.
 * The management key stays under bcrypt's 72-byte limit.
 */
export function mintLocalAccountProxyLaunchKeys(): MintedLocalAccountProxyKeys {
  const epoch = randomUUID();
  const managementKey = `canopy-mk-${randomBytes(24).toString('hex')}`;
  const clientKey = `canopy-${randomBytes(24).toString('hex')}`;
  openEpochs.add(epoch);
  return {
    keys: Object.freeze({
      epoch,
      management: keyOf('management', epoch, managementKey),
      client: keyOf('client', epoch, clientKey),
    }),
    managementKey,
    clientKey,
  };
}

/** Ends a launch: its keys reveal nothing from now on. Idempotent. */
export function closeLocalAccountProxyLaunchKeys(
  keys: LocalAccountProxyLaunchKeys,
): void {
  openEpochs.delete(keys.epoch);
  secrets.delete(keys.management);
  secrets.delete(keys.client);
}

/** The value to send, or null once its launch has closed. */
export function revealLocalAccountProxyKey(
  key: LocalAccountProxyKey,
): string | null {
  if (!openEpochs.has(key.epoch)) return null;
  return secrets.get(key) ?? null;
}
